import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { adotConfigYaml } from './collector.js';
import { provisioningChunks, provisioningWriterScript } from '../grafana/bundle.js';
import { readCatalog } from '../grafana/catalog.js';
import {
  buildProvisioningFiles,
  ERRORS_QUERY,
  ERRORS_QUERY_NAME,
  TRACE_QUERY,
  TRACE_QUERY_NAME,
} from '../grafana/provision.js';
import { receiverScript } from '../grafana/receiver.js';
import {
  ADOT_LOG_GROUP,
  ALERT_LOG_GROUP,
  allInterfacesHost,
  FAULTS_PARAMETER_NAME,
  GRAFANA_LOG_GROUP,
  LOADGEN_NAME,
  SERVICE_PORTS,
  SERVICES,
  serviceLogGroup,
  type ServiceName,
} from '../names.js';

const ALERTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../observability/alerts.yml',
);
const ADOT_IMAGE = 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0';
const GRAFANA_IMAGE = 'grafana/grafana:11.6.16';
const NODE_IMAGE = 'public.ecr.aws/docker/library/node:22-alpine';
const TASK_CPU = 256;
const TASK_MEMORY = 512;

export class DemoStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const domain = new CfnParameter(this, 'GrafanaDomainName', {
      type: 'String',
      default: 'otel-demo.ronklein.co.il',
      description:
        'Grafana hostname. Ron creates the ACM validation record and the hostname record by hand.',
      allowedPattern: '^[a-z0-9.-]+$',
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'otel-demo',
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'otel-demo.local',
      vpc,
    });
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'otel-demo',
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const faults = new ssm.StringParameter(this, 'FaultsEnabled', {
      parameterName: FAULTS_PARAMETER_NAME,
      stringValue: 'off',
      description: 'Kill switch for fault injection. off leaves injection disabled.',
    });
    faults.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [faults.parameterArn],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'otel-demo' } },
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );

    const adotLogs = logGroup(this, 'AdotLogs', ADOT_LOG_GROUP);
    adotLogs.grantWrite(taskRole);

    const groups = new Map<string, ec2.SecurityGroup>();
    const loadgenSg = namedGroup(
      this,
      vpc,
      'Loadgen',
      'otel-demo-loadgen',
      'Load generator. No inbound.',
    );
    const shopAlbSg = namedGroup(
      this,
      vpc,
      'ShopAlb',
      'otel-demo-shop-alb',
      'Internal shop load balancer. Inbound only from the load generator.',
    );
    shopAlbSg.addIngressRule(loadgenSg, ec2.Port.tcp(80), 'loadgen to shop');
    const grafanaAlbSg = namedGroup(
      this,
      vpc,
      'GrafanaAlb',
      'otel-demo-grafana-alb',
      'Grafana load balancer. No inbound rules. Ron adds his address on 443 after deploy.',
    );
    for (const name of SERVICES) {
      groups.set(
        name,
        namedGroup(
          this,
          vpc,
          title(name),
          `otel-demo-${name}`,
          `${name} tasks. Inbound only from the load balancer or from shop.`,
        ),
      );
    }
    const shopSg = groups.get('shop');
    const inventorySg = groups.get('inventory');
    const paymentSg = groups.get('payment');
    const deliverySg = groups.get('delivery');
    if (!shopSg || !inventorySg || !paymentSg || !deliverySg) {
      throw new Error('service security groups were not created');
    }
    shopSg.addIngressRule(shopAlbSg, ec2.Port.tcp(SERVICE_PORTS.shop), 'shop load balancer');
    inventorySg.addIngressRule(shopSg, ec2.Port.tcp(SERVICE_PORTS.inventory), 'shop to inventory');
    paymentSg.addIngressRule(shopSg, ec2.Port.tcp(SERVICE_PORTS.payment), 'shop to payment');
    deliverySg.addIngressRule(shopSg, ec2.Port.tcp(SERVICE_PORTS.delivery), 'shop to delivery');
    const grafanaTaskSg = namedGroup(
      this,
      vpc,
      'GrafanaTask',
      'otel-demo-grafana',
      'Grafana task. Inbound only from its load balancer.',
    );
    grafanaTaskSg.addIngressRule(grafanaAlbSg, ec2.Port.tcp(3000), 'Grafana load balancer');

    const repositories = new Map<string, ecr.Repository>();
    const serviceLogs = new Map<string, logs.LogGroup>();
    for (const name of [...SERVICES, LOADGEN_NAME]) {
      repositories.set(
        name,
        new ecr.Repository(this, `${title(name)}Repo`, {
          repositoryName: `otel-demo/${name}`,
          emptyOnDelete: true,
          removalPolicy: RemovalPolicy.DESTROY,
          imageScanOnPush: false,
        }),
      );
      serviceLogs.set(name, logGroup(this, `${title(name)}Logs`, serviceLogGroup(name)));
    }
    const grafanaLogs = logGroup(this, 'GrafanaLogs', GRAFANA_LOG_GROUP);
    const alertLogs = logGroup(this, 'AlertLogs', ALERT_LOG_GROUP);

    const databases = new Map<ServiceName, rds.DatabaseInstance>();
    for (const name of SERVICES) {
      const sg = groups.get(name);
      if (!sg) {
        throw new Error(`missing security group for ${name}`);
      }
      const dbSg = namedGroup(
        this,
        vpc,
        `${title(name)}Db`,
        `otel-demo-${name}-db`,
        `${name} database. Inbound only from its service.`,
      );
      dbSg.addIngressRule(sg, ec2.Port.tcp(5432), `${name} tasks`);
      const instance = database(this, name, vpc, dbSg);
      databases.set(name, instance);
      instance.secret?.grantRead(executionRole);
    }

    const shopAlb = new elbv2.ApplicationLoadBalancer(this, 'ShopAlb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: shopAlbSg,
      loadBalancerName: 'otel-demo-shop',
    });
    const shopTargets = new elbv2.ApplicationTargetGroup(this, 'ShopTargets', {
      vpc,
      port: SERVICE_PORTS.shop,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'otel-demo-shop',
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(10),
    });
    shopAlb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [shopTargets],
      open: false,
    });

    const adotConfig = adotConfigYaml();
    const shopService = this.workload(cluster, executionRole, taskRole, adotLogs, adotConfig, {
      name: 'shop',
      repository: required(repositories, 'shop'),
      logGroup: required(serviceLogs, 'shop'),
      securityGroup: shopSg,
      port: SERVICE_PORTS.shop,
      command: ['node', 'services/shop/dist/index.js'],
      environment: {
        ...serviceEnv('shop', requiredDb(databases, 'shop')),
        INVENTORY_URL: `http://inventory.otel-demo.local:${SERVICE_PORTS.inventory}`,
        PAYMENT_URL: `http://payment.otel-demo.local:${SERVICE_PORTS.payment}`,
        DELIVERY_URL: `http://delivery.otel-demo.local:${SERVICE_PORTS.delivery}`,
      },
      secrets: dbSecrets(requiredDb(databases, 'shop')),
      namespace,
    });
    shopTargets.addTarget(
      shopService.loadBalancerTarget({
        containerName: 'app',
        containerPort: SERVICE_PORTS.shop,
      }),
    );

    for (const name of ['inventory', 'payment', 'delivery'] as const) {
      this.workload(cluster, executionRole, taskRole, adotLogs, adotConfig, {
        name,
        repository: required(repositories, name),
        logGroup: required(serviceLogs, name),
        securityGroup: required(groups, name),
        port: SERVICE_PORTS[name],
        command: ['node', `services/${name}/dist/index.js`],
        environment: serviceEnv(name, requiredDb(databases, name)),
        secrets: dbSecrets(requiredDb(databases, name)),
        namespace,
      });
    }

    this.workload(cluster, executionRole, taskRole, adotLogs, adotConfig, {
      name: LOADGEN_NAME,
      repository: required(repositories, LOADGEN_NAME),
      logGroup: required(serviceLogs, LOADGEN_NAME),
      securityGroup: loadgenSg,
      command: [
        'node',
        '--eval',
        'import("./loadgen/dist/main.js").then(() => setInterval(() => {}, 3600000))',
      ],
      environment: {
        ...baseEnv(LOADGEN_NAME),
        SHOP_URL: `http://${shopAlb.loadBalancerDnsName}`,
      },
    });

    this.grafana(
      cluster,
      executionRole,
      grafanaTaskSg,
      grafanaAlbSg,
      grafanaLogs,
      alertLogs,
      [...serviceLogs.values(), adotLogs],
      vpc,
      domain,
    );

    const queryGroups = [...serviceLogs.values(), alertLogs, grafanaLogs];
    savedQuery(this, 'TraceLines', TRACE_QUERY_NAME, TRACE_QUERY, queryGroups);
    savedQuery(this, 'ErrorsByService', ERRORS_QUERY_NAME, ERRORS_QUERY, queryGroups);

    new CfnOutput(this, 'ShopAlbDnsName', {
      description: 'Internal shop load balancer. No public address.',
      value: shopAlb.loadBalancerDnsName,
    });
    new CfnOutput(this, 'GrafanaHostname', {
      description: 'Create a DNS record from this hostname to GrafanaAlbDnsName by hand.',
      value: domain.valueAsString,
    });
    new CfnOutput(this, 'GrafanaAlbSecurityGroupId', {
      description:
        'No inbound rules. Add your address on 443 after every deploy. Grafana being unreachable is not data loss.',
      value: grafanaAlbSg.securityGroupId,
    });
  }

  private workload(
    cluster: ecs.Cluster,
    executionRole: iam.IRole,
    taskRole: iam.IRole,
    adotLogs: logs.ILogGroup,
    adotConfig: string,
    options: WorkloadOptions,
  ): ecs.FargateService {
    const task = new ecs.FargateTaskDefinition(this, `${title(options.name)}Task`, {
      family: `otel-demo-${options.name}`,
      cpu: TASK_CPU,
      memoryLimitMiB: TASK_MEMORY,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole,
      taskRole,
    });
    const app = task.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(options.repository, 'demo'),
      essential: true,
      entryPoint: ['node', '/opt/fault-switch/fault-switch.cjs'],
      command: options.command,
      environment: options.environment,
      secrets: options.secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: options.logGroup, streamPrefix: options.name }),
      ...(options.port === undefined ? {} : { portMappings: [{ containerPort: options.port }] }),
    });
    task.addContainer('adot', {
      image: ecs.ContainerImage.fromRegistry(ADOT_IMAGE),
      essential: true,
      command: ['--config=env:AOT_CONFIG_CONTENT'],
      environment: { AOT_CONFIG_CONTENT: adotConfig, AWS_REGION: 'eu-central-1' },
      logging: ecs.LogDrivers.awsLogs({ logGroup: adotLogs, streamPrefix: options.name }),
    });
    return new ecs.FargateService(this, `${title(options.name)}Service`, {
      serviceName: `otel-demo-${options.name}`,
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [options.securityGroup],
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      cloudMapOptions: options.namespace
        ? {
            name: options.name,
            cloudMapNamespace: options.namespace,
            dnsRecordType: servicediscovery.DnsRecordType.A,
            dnsTtl: Duration.seconds(10),
            container: app,
            containerPort: options.port,
          }
        : undefined,
    });
  }

  private grafana(
    cluster: ecs.Cluster,
    executionRole: iam.IRole,
    taskSg: ec2.SecurityGroup,
    albSg: ec2.SecurityGroup,
    grafanaLogs: logs.LogGroup,
    alertLogs: logs.LogGroup,
    serviceLogs: logs.ILogGroup[],
    vpc: ec2.IVpc,
    domain: CfnParameter,
  ): void {
    const admin = new secretsmanager.Secret(this, 'GrafanaAdmin', {
      secretName: 'otel-demo/grafana-admin',
      description: 'Grafana admin password. Generated at deploy. Never printed.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    admin.grantRead(executionRole);

    const grafanaRole = new iam.Role(this, 'GrafanaTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    grafanaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
        ],
        resources: ['*'],
      }),
    );
    grafanaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: ['*'],
      }),
    );
    for (const group of [grafanaLogs, alertLogs, ...serviceLogs]) {
      group.grant(
        grafanaRole,
        'logs:StartQuery',
        'logs:GetQueryResults',
        'logs:StopQuery',
        'logs:FilterLogEvents',
        'logs:GetLogEvents',
        'logs:DescribeLogStreams',
      );
    }
    grafanaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:GetTraceSummaries',
          'xray:BatchGetTraces',
          'xray:GetServiceGraph',
          'xray:GetTraceGraph',
        ],
        resources: ['*'],
      }),
    );

    const certificate = new acm.Certificate(this, 'GrafanaCert', {
      domainName: domain.valueAsString,
      validation: acm.CertificateValidation.fromDns(),
    });
    certificate.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const alb = new elbv2.ApplicationLoadBalancer(this, 'GrafanaAlb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
      loadBalancerName: 'otel-demo-grafana',
    });
    const targets = new elbv2.ApplicationTargetGroup(this, 'GrafanaTargets', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'otel-demo-grafana',
      healthCheck: { path: '/api/health', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(10),
    });
    alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [targets],
      open: false,
    });

    const task = new ecs.FargateTaskDefinition(this, 'GrafanaTask', {
      family: 'otel-demo-grafana',
      cpu: TASK_CPU,
      memoryLimitMiB: TASK_MEMORY,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole,
      taskRole: grafanaRole,
    });
    task.addVolume({ name: 'provisioning' });
    const chunks = provisioningChunks(buildProvisioningFiles(readCatalog(ALERTS_PATH)));
    const payload: Record<string, string> = {};
    chunks.forEach((chunk, index) => {
      payload[`P${index}`] = chunk;
    });
    const writer = task.addContainer('provisioning', {
      image: ecs.ContainerImage.fromRegistry(NODE_IMAGE),
      essential: false,
      command: ['node', '-e', provisioningWriterScript()],
      environment: payload,
      logging: ecs.LogDrivers.awsLogs({ logGroup: grafanaLogs, streamPrefix: 'provisioning' }),
    });
    writer.addMountPoints({
      sourceVolume: 'provisioning',
      containerPath: '/provisioning',
      readOnly: false,
    });
    const grafana = task.addContainer('grafana', {
      image: ecs.ContainerImage.fromRegistry(GRAFANA_IMAGE),
      essential: true,
      environment: {
        GF_SERVER_HTTP_PORT: '3000',
        GF_SERVER_ROOT_URL: `https://${domain.valueAsString}`,
        GF_USERS_ALLOW_SIGN_UP: 'false',
        GF_AUTH_ANONYMOUS_ENABLED: 'false',
        GF_LOG_LEVEL: 'info',
        GF_INSTALL_PLUGINS: 'grafana-x-ray-datasource',
        AWS_REGION: 'eu-central-1',
      },
      secrets: {
        GF_SECURITY_ADMIN_USER: ecs.Secret.fromSecretsManager(admin, 'username'),
        GF_SECURITY_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(admin, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: grafanaLogs, streamPrefix: 'grafana' }),
      portMappings: [{ containerPort: 3000 }],
    });
    grafana.addMountPoints({
      sourceVolume: 'provisioning',
      containerPath: '/etc/grafana/provisioning',
      readOnly: true,
    });
    grafana.addContainerDependencies({
      container: writer,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });
    task.addContainer('alerts', {
      image: ecs.ContainerImage.fromRegistry(NODE_IMAGE),
      essential: true,
      command: ['node', '-e', receiverScript()],
      logging: ecs.LogDrivers.awsLogs({ logGroup: alertLogs, streamPrefix: 'state' }),
    });

    const service = new ecs.FargateService(this, 'GrafanaService', {
      serviceName: 'otel-demo-grafana',
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSg],
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });
    targets.addTarget(
      service.loadBalancerTarget({ containerName: 'grafana', containerPort: 3000 }),
    );

    const records = new cr.AwsCustomResource(this, 'GrafanaCertRecords', {
      onCreate: {
        service: 'ACM',
        action: 'describeCertificate',
        parameters: { CertificateArn: certificate.certificateArn },
        physicalResourceId: cr.PhysicalResourceId.of('otel-demo-grafana-cert-records'),
      },
      onUpdate: {
        service: 'ACM',
        action: 'describeCertificate',
        parameters: { CertificateArn: certificate.certificateArn },
        physicalResourceId: cr.PhysicalResourceId.of('otel-demo-grafana-cert-records'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [certificate.certificateArn],
      }),
      installLatestAwsSdk: false,
    });
    records.node.addDependency(certificate);
    new CfnOutput(this, 'GrafanaAlbDnsName', {
      description: 'Point the Grafana hostname at this name with a DNS record Ron adds by hand.',
      value: alb.loadBalancerDnsName,
    });
    new CfnOutput(this, 'GrafanaCertValidationRecordName', {
      description:
        'ACM DNS validation record name. The same name is on the pending certificate while the stack is creating.',
      value: records.getResponseField('Certificate.DomainValidationOptions.0.ResourceRecord.Name'),
    });
    new CfnOutput(this, 'GrafanaCertValidationRecordType', {
      description: 'ACM DNS validation record type.',
      value: records.getResponseField('Certificate.DomainValidationOptions.0.ResourceRecord.Type'),
    });
    new CfnOutput(this, 'GrafanaCertValidationRecordValue', {
      description:
        'ACM DNS validation record value. Ron adds this record by hand. It is also shown on the pending certificate.',
      value: records.getResponseField('Certificate.DomainValidationOptions.0.ResourceRecord.Value'),
    });
  }
}

interface WorkloadOptions {
  name: string;
  repository: ecr.IRepository;
  logGroup: logs.ILogGroup;
  securityGroup: ec2.ISecurityGroup;
  command: string[];
  environment: Record<string, string>;
  secrets?: Record<string, ecs.Secret>;
  port?: number;
  namespace?: servicediscovery.INamespace;
}

function savedQuery(
  scope: Construct,
  id: string,
  name: string,
  queryString: string,
  groups: logs.ILogGroup[],
): void {
  const query = new logs.CfnQueryDefinition(scope, id, {
    name,
    queryString,
    logGroupNames: groups.map((group) => group.logGroupName),
  });
  for (const group of groups) {
    query.node.addDependency(group);
  }
}

function database(
  scope: Construct,
  name: ServiceName,
  vpc: ec2.IVpc,
  securityGroup: ec2.ISecurityGroup,
): rds.DatabaseInstance {
  const instance = new rds.DatabaseInstance(scope, `${title(name)}Db`, {
    instanceIdentifier: `otel-demo-${name}`,
    engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [securityGroup],
    publiclyAccessible: false,
    storageEncrypted: true,
    allocatedStorage: 20,
    storageType: rds.StorageType.GP3,
    multiAz: false,
    backupRetention: Duration.days(0),
    deletionProtection: false,
    removalPolicy: RemovalPolicy.DESTROY,
    deleteAutomatedBackups: true,
    copyTagsToSnapshot: true,
    enablePerformanceInsights: false,
    databaseName: name,
    credentials: rds.Credentials.fromGeneratedSecret('oteldemo', {
      secretName: `otel-demo/${name}-db`,
    }),
  });
  const cfn = instance.node.defaultChild as rds.CfnDBInstance;
  cfn.backupRetentionPeriod = 0;
  cfn.deletionProtection = false;
  cfn.publiclyAccessible = false;
  cfn.storageEncrypted = true;
  cfn.applyRemovalPolicy(RemovalPolicy.DESTROY);
  instance.secret?.applyRemovalPolicy(RemovalPolicy.DESTROY);
  return instance;
}

function logGroup(scope: Construct, id: string, logGroupName: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

function namedGroup(
  scope: Construct,
  vpc: ec2.IVpc,
  id: string,
  securityGroupName: string,
  description: string,
): ec2.SecurityGroup {
  return new ec2.SecurityGroup(scope, `${id}Sg`, {
    vpc,
    securityGroupName,
    description,
    allowAllOutbound: true,
  });
}

function baseEnv(service: string): Record<string, string> {
  return {
    HOST: allInterfacesHost(),
    LOG_LEVEL: 'info',
    OTEL_LOG_LEVEL: 'error',
    OTEL_SERVICE_NAME: service,
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    OTEL_DEMO_FAULTS_PARAMETER: FAULTS_PARAMETER_NAME,
    AWS_REGION: 'eu-central-1',
  };
}

function serviceEnv(name: ServiceName, instance: rds.DatabaseInstance): Record<string, string> {
  return {
    ...baseEnv(name),
    PORT: String(SERVICE_PORTS[name]),
    DB_HOST: instance.dbInstanceEndpointAddress,
    DB_PORT: instance.dbInstanceEndpointPort,
    DB_NAME: name,
  };
}

function dbSecrets(instance: rds.DatabaseInstance): Record<string, ecs.Secret> {
  const secret = instance.secret;
  if (!secret) {
    throw new Error('database credentials secret was not created');
  }
  return {
    DB_USER: ecs.Secret.fromSecretsManager(secret, 'username'),
    DB_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'password'),
  };
}

function required<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function requiredDb(
  map: Map<ServiceName, rds.DatabaseInstance>,
  name: ServiceName,
): rds.DatabaseInstance {
  return required(map, name);
}

function title(name: string): string {
  return name.slice(0, 1).toUpperCase() + name.slice(1);
}
