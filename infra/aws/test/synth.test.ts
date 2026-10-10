import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..');

interface TemplateResource {
  Type: string;
  DeletionPolicy?: string;
  Properties?: Record<string, unknown>;
}

interface Template {
  Parameters?: Record<string, { Default?: string }>;
  Outputs?: Record<string, { Value?: unknown }>;
  Resources: Record<string, TemplateResource>;
}

function synthesize(overrides?: Record<string, string | undefined>): Template {
  const outdir = mkdtempSync(join(tmpdir(), 'otel-demo-synth-'));
  const binary = [
    join(INFRA, 'node_modules', '.bin', 'cdk'),
    join(INFRA, '..', '..', 'node_modules', '.bin', 'cdk'),
  ].find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error('cdk binary was not installed');
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LOADGEN_START_UTC;
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
  execFileSync(binary, ['synth', '--quiet', '-o', outdir], {
    cwd: INFRA,
    env,
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(join(outdir, 'otel-demo.template.json'), 'utf8')) as Template;
}

interface AppContainer {
  family: string;
  environment: { Name?: string; Value?: string }[];
}

function appContainers(template: Template): AppContainer[] {
  return ofType(template, 'AWS::ECS::TaskDefinition').flatMap((task) => {
    const containers = task.Properties?.ContainerDefinitions as {
      Name?: string;
      Environment?: { Name?: string; Value?: string }[];
    }[];
    return containers
      .filter((container) => container.Name === 'app')
      .map((container) => ({
        family: String(task.Properties?.Family ?? ''),
        environment: container.Environment ?? [],
      }));
  });
}

function otherContainers(
  template: Template,
): { environment: { Name?: string; Value?: string }[] }[] {
  return ofType(template, 'AWS::ECS::TaskDefinition').flatMap((task) => {
    const containers = task.Properties?.ContainerDefinitions as {
      Name?: string;
      Environment?: { Name?: string; Value?: string }[];
    }[];
    return containers
      .filter((container) => container.Name !== 'app')
      .map((container) => ({ environment: container.Environment ?? [] }));
  });
}

function envValue(
  environment: { Name?: string; Value?: string }[],
  name: string,
): string | undefined {
  return environment.find((item) => item.Name === name)?.Value;
}

function ofType(template: Template, type: string): TemplateResource[] {
  return Object.values(template.Resources).filter((resource) => resource.Type === type);
}

function statements(resource: TemplateResource): Record<string, unknown>[] {
  const document = resource.Properties?.PolicyDocument as { Statement?: unknown } | undefined;
  const statement = document?.Statement;
  if (!statement) {
    return [];
  }
  return Array.isArray(statement)
    ? statement.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [statement as Record<string, unknown>];
}

describe('cdk synth', () => {
  const template = synthesize();

  it('builds a destroyable demo without NAT gateways or CloudWatch alarms', () => {
    expect(ofType(template, 'AWS::EC2::NatGateway')).toEqual([]);
    expect(ofType(template, 'AWS::CloudWatch::Alarm')).toEqual([]);
    expect(ofType(template, 'AWS::RDS::DBInstance')).toHaveLength(4);
    for (const database of ofType(template, 'AWS::RDS::DBInstance')) {
      expect(database.Properties).toMatchObject({
        DBInstanceClass: 'db.t4g.micro',
        Engine: 'postgres',
        AllocatedStorage: '20',
        StorageType: 'gp3',
        BackupRetentionPeriod: 0,
        DeletionProtection: false,
        PubliclyAccessible: false,
        StorageEncrypted: true,
      });
      expect(database.DeletionPolicy).toBe('Delete');
    }
    expect(ofType(template, 'AWS::ECR::Repository')).toHaveLength(5);
    for (const repository of ofType(template, 'AWS::ECR::Repository')) {
      expect(repository.Properties?.EmptyOnDelete).toBe(true);
      expect(repository.DeletionPolicy).toBe('Delete');
    }
    const logGroups = ofType(template, 'AWS::Logs::LogGroup');
    expect(logGroups.length).toBeGreaterThanOrEqual(8);
    expect(logGroups.map((group) => group.Properties?.LogGroupName)).toContain(
      '/otel-demo/metrics',
    );
    for (const group of ofType(template, 'AWS::Logs::LogGroup')) {
      expect(group.Properties?.RetentionInDays).toBe(7);
      expect(group.DeletionPolicy).toBe('Delete');
    }
  });

  it('defines six small public ARM tasks, leaves the load generator stopped, and keeps shop traffic internal', () => {
    const tasks = ofType(template, 'AWS::ECS::TaskDefinition');
    expect(tasks).toHaveLength(6);
    for (const task of tasks) {
      expect(task.Properties).toMatchObject({
        Cpu: '256',
        Memory: '512',
        RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      });
    }
    const services = ofType(template, 'AWS::ECS::Service');
    expect(services).toHaveLength(6);
    for (const service of services) {
      const serviceName = service.Properties?.ServiceName;
      expect(service.Properties?.DesiredCount).toBe(serviceName === 'otel-demo-loadgen' ? 0 : 1);
      const network = service.Properties?.NetworkConfiguration as {
        AwsvpcConfiguration?: { AssignPublicIp?: string };
      };
      expect(network.AwsvpcConfiguration?.AssignPublicIp).toBe('ENABLED');
    }
    const balancers = ofType(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    expect(balancers).toHaveLength(1);
    expect(balancers[0]?.Properties).toMatchObject({ Name: 'otel-demo-shop', Scheme: 'internal' });
    const listeners = ofType(template, 'AWS::ElasticLoadBalancingV2::Listener');
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.Properties).toMatchObject({ Port: 80, Protocol: 'HTTP' });
    const grafanaGroupId = Object.entries(template.Resources).find(
      ([, resource]) => resource.Properties?.GroupName === 'otel-demo-grafana',
    )?.[0];
    expect(grafanaGroupId).toBeDefined();
    const grafanaGroup = template.Resources[grafanaGroupId ?? ''];
    expect(grafanaGroup?.Properties?.SecurityGroupIngress ?? []).toEqual([]);
    const inbound = ofType(template, 'AWS::EC2::SecurityGroupIngress').filter((rule) => {
      const group = rule.Properties?.GroupId as { Ref?: string } | undefined;
      return group?.Ref === grafanaGroupId;
    });
    expect(inbound).toEqual([]);
    for (const rule of ofType(template, 'AWS::EC2::SecurityGroupIngress')) {
      expect(rule.Properties).not.toHaveProperty('CidrIp');
      expect(rule.Properties).not.toHaveProperty('CidrIpv6');
    }
  });

  it('limits task-role SSM access to the faults switch and keeps Grafana on plain HTTP', () => {
    const parameter = ofType(template, 'AWS::SSM::Parameter');
    expect(parameter).toHaveLength(1);
    expect(parameter[0]?.Properties).toMatchObject({
      Name: '/otel-demo/faults-enabled',
      Value: 'off',
    });
    expect(parameter[0]?.DeletionPolicy).toBe('Delete');
    const parameterId = Object.entries(template.Resources).find(
      ([, resource]) => resource.Type === 'AWS::SSM::Parameter',
    )?.[0];
    const ssmActions: string[] = [];
    for (const policy of ofType(template, 'AWS::IAM::Policy')) {
      for (const statement of statements(policy)) {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : [actions];
        for (const action of list) {
          if (typeof action === 'string' && action.startsWith('ssm:')) {
            ssmActions.push(action);
            expect(JSON.stringify(statement.Resource)).toContain(parameterId);
          }
        }
      }
    }
    expect(ssmActions).toEqual(['ssm:GetParameter']);
    expect(template.Parameters?.GrafanaDomainName).toBeUndefined();
    expect(template.Outputs?.GrafanaSecurityGroupId).toBeDefined();
    expect(template.Outputs?.ShopAlbDnsName).toBeDefined();
    for (const name of [
      'GrafanaAlbDnsName',
      'GrafanaHostname',
      'GrafanaAlbSecurityGroupId',
      'GrafanaCertValidationRecordName',
      'GrafanaCertValidationRecordType',
      'GrafanaCertValidationRecordValue',
    ]) {
      expect(template.Outputs?.[name]).toBeUndefined();
    }
    expect(ofType(template, 'AWS::CertificateManager::Certificate')).toEqual([]);
    const grafanaTask = ofType(template, 'AWS::ECS::TaskDefinition').find(
      (task) => task.Properties?.Family === 'otel-demo-grafana',
    );
    const containers = grafanaTask?.Properties?.ContainerDefinitions as {
      Name?: string;
      Environment?: { Name?: string; Value?: string }[];
      Secrets?: { Name?: string }[];
      PortMappings?: { ContainerPort?: number }[];
    }[];
    const grafana = containers.find((container) => container.Name === 'grafana');
    expect(grafana?.PortMappings).toEqual([expect.objectContaining({ ContainerPort: 3000 })]);
    expect(grafana?.Environment).toEqual(
      expect.arrayContaining([
        { Name: 'GF_SERVER_PROTOCOL', Value: 'http' },
        { Name: 'GF_AUTH_ANONYMOUS_ENABLED', Value: 'false' },
        { Name: 'GF_USERS_ALLOW_SIGN_UP', Value: 'false' },
      ]),
    );
    expect(grafana?.Environment?.some((item) => item.Name === 'GF_SECURITY_ADMIN_PASSWORD')).toBe(
      false,
    );
    expect(grafana?.Secrets?.map((item) => item.Name).sort()).toEqual([
      'GF_SECURITY_ADMIN_PASSWORD',
      'GF_SECURITY_ADMIN_USER',
    ]);
    const tagged = Object.values(template.Resources).filter((resource) =>
      Array.isArray(resource.Properties?.Tags),
    );
    expect(tagged.length).toBeGreaterThan(10);
    for (const resource of tagged) {
      expect(resource.Properties?.Tags).toEqual(
        expect.arrayContaining([{ Key: 'experiment', Value: 'otel-demo' }]),
      );
    }
    const text = JSON.stringify(template);
    expect(text).not.toContain('tail_sampling');
    expect(text).not.toContain('sampling_percentage');
    expect(text).toContain('exporters: [awsxray]');
    expect(text).toContain('otel-demo-all-lines-for-a-trace-id');
    expect(text).toContain('otel-demo-errors-by-service-last-15m');
    expect(text).toContain('"Name":"OTEL_LOG_LEVEL","Value":"error"');
    const apps = appContainers(template);
    expect(apps).toHaveLength(5);
    for (const app of apps) {
      expect(app.environment).toEqual(
        expect.arrayContaining([{ Name: 'LOG_LEVEL', Value: 'info' }]),
      );
    }
  });

  it('points every service at the image schedule and leaves the experiment start on the file', () => {
    const apps = appContainers(template);
    expect(apps.map((app) => app.family).sort()).toEqual([
      'otel-demo-delivery',
      'otel-demo-inventory',
      'otel-demo-loadgen',
      'otel-demo-payment',
      'otel-demo-shop',
    ]);
    const services = apps.filter((app) => app.family !== 'otel-demo-loadgen');
    expect(services).toHaveLength(4);
    for (const app of services) {
      expect(envValue(app.environment, 'OTEL_DEMO_LOAD_SCHEDULE_FILE')).toBe(
        '/app/loadgen/schedule.json',
      );
    }
    const loadgen = apps.find((app) => app.family === 'otel-demo-loadgen');
    expect(envValue(loadgen?.environment ?? [], 'OTEL_DEMO_LOAD_SCHEDULE_FILE')).toBeUndefined();
    for (const app of apps) {
      expect(envValue(app.environment, 'LOADGEN_START_UTC')).toBeUndefined();
    }
    expect(JSON.stringify(template)).not.toContain('LOADGEN_START_UTC');
    for (const container of otherContainers(template)) {
      expect(envValue(container.environment, 'OTEL_DEMO_LOAD_SCHEDULE_FILE')).toBeUndefined();
      expect(envValue(container.environment, 'LOADGEN_START_UTC')).toBeUndefined();
    }
  });

  it('copies LOADGEN_START_UTC from the deploy environment onto services and the load generator', () => {
    const start = '2030-01-02T03:04:05.000Z';
    const deployed = synthesize({ LOADGEN_START_UTC: start });
    const apps = appContainers(deployed);
    expect(apps).toHaveLength(5);
    for (const app of apps) {
      expect(envValue(app.environment, 'LOADGEN_START_UTC')).toBe(start);
    }
    const services = apps.filter((app) => app.family !== 'otel-demo-loadgen');
    expect(services).toHaveLength(4);
    for (const app of services) {
      expect(envValue(app.environment, 'OTEL_DEMO_LOAD_SCHEDULE_FILE')).toBe(
        '/app/loadgen/schedule.json',
      );
    }
    expect(
      envValue(
        apps.find((app) => app.family === 'otel-demo-loadgen')?.environment ?? [],
        'OTEL_DEMO_LOAD_SCHEDULE_FILE',
      ),
    ).toBeUndefined();
  });
});
