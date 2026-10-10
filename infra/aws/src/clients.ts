import { ACMClient } from '@aws-sdk/client-acm';
import { BudgetsClient } from '@aws-sdk/client-budgets';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECRClient } from '@aws-sdk/client-ecr';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingClient } from '@aws-sdk/client-elastic-load-balancing';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { KMSClient } from '@aws-sdk/client-kms';
import { OpenSearchClient } from '@aws-sdk/client-opensearch';
import { RDSClient } from '@aws-sdk/client-rds';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { XRayClient } from '@aws-sdk/client-xray';
import type { SdkClient, SdkCommand, TeardownClients } from './types.js';

const USER_AGENT = 'otel-demo-safety';

function asSdk(client: object): SdkClient {
  const sender = client as { send: (command: SdkCommand) => Promise<unknown> };
  return {
    send: (command) => sender.send(command),
  };
}

export function createClients(region: string, budgetsRegion: string): TeardownClients {
  const settings = { region, customUserAgent: USER_AGENT };
  return {
    sts: asSdk(new STSClient(settings)),
    tagging: asSdk(new ResourceGroupsTaggingAPIClient(settings)),
    cloudwatch: asSdk(new CloudWatchClient(settings)),
    logs: asSdk(new CloudWatchLogsClient(settings)),
    rds: asSdk(new RDSClient(settings)),
    ec2: asSdk(new EC2Client(settings)),
    elbv2: asSdk(new ElasticLoadBalancingV2Client(settings)),
    elb: asSdk(new ElasticLoadBalancingClient(settings)),
    ecr: asSdk(new ECRClient(settings)),
    ecs: asSdk(new ECSClient(settings)),
    s3: asSdk(new S3Client(settings)),
    cloudformation: asSdk(new CloudFormationClient(settings)),
    budgets: asSdk(new BudgetsClient({ region: budgetsRegion, customUserAgent: USER_AGENT })),
    serviceQuotas: asSdk(new ServiceQuotasClient(settings)),
    secretsManager: asSdk(new SecretsManagerClient(settings)),
    ssm: asSdk(new SSMClient(settings)),
    acm: asSdk(new ACMClient(settings)),
    xray: asSdk(new XRayClient(settings)),
    kms: asSdk(new KMSClient(settings)),
    elasticache: asSdk(new ElastiCacheClient(settings)),
    opensearch: asSdk(new OpenSearchClient(settings)),
  };
}
