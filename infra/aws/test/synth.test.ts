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

function synthesize(): Template {
  const outdir = mkdtempSync(join(tmpdir(), 'otel-demo-synth-'));
  const binary = [
    join(INFRA, 'node_modules', '.bin', 'cdk'),
    join(INFRA, '..', '..', 'node_modules', '.bin', 'cdk'),
  ].find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error('cdk binary was not installed');
  }
  execFileSync(binary, ['synth', '--quiet', '-o', outdir], {
    cwd: INFRA,
    env: process.env,
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(join(outdir, 'otel-demo.template.json'), 'utf8')) as Template;
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
    expect(ofType(template, 'AWS::Logs::LogGroup').length).toBeGreaterThanOrEqual(8);
    for (const group of ofType(template, 'AWS::Logs::LogGroup')) {
      expect(group.Properties?.RetentionInDays).toBe(7);
      expect(group.DeletionPolicy).toBe('Delete');
    }
  });

  it('runs six small public ARM tasks and keeps shop traffic on an internal load balancer', () => {
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
      expect(service.Properties?.DesiredCount).toBe(1);
      const network = service.Properties?.NetworkConfiguration as {
        AwsvpcConfiguration?: { AssignPublicIp?: string };
      };
      expect(network.AwsvpcConfiguration?.AssignPublicIp).toBe('ENABLED');
    }
    const balancers = ofType(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const shop = balancers.find((balancer) => balancer.Properties?.Name === 'otel-demo-shop');
    const grafana = balancers.find((balancer) => balancer.Properties?.Name === 'otel-demo-grafana');
    expect(shop?.Properties?.Scheme).toBe('internal');
    expect(grafana?.Properties?.Scheme).toBe('internet-facing');
    const grafanaGroupId = Object.entries(template.Resources).find(
      ([, resource]) => resource.Properties?.GroupName === 'otel-demo-grafana-alb',
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

  it('limits task-role SSM access to the faults switch and publishes the DNS records to add by hand', () => {
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
    expect(template.Parameters?.GrafanaDomainName?.Default).toBe('otel-demo.ronklein.co.il');
    for (const name of [
      'GrafanaAlbDnsName',
      'GrafanaHostname',
      'GrafanaAlbSecurityGroupId',
      'GrafanaCertValidationRecordName',
      'GrafanaCertValidationRecordType',
      'GrafanaCertValidationRecordValue',
    ]) {
      expect(template.Outputs?.[name]).toBeDefined();
    }
    const certificate = ofType(template, 'AWS::CertificateManager::Certificate');
    expect(certificate).toHaveLength(1);
    expect(certificate[0]?.Properties?.ValidationMethod).toBe('DNS');
    expect(certificate[0]?.DeletionPolicy).toBe('Delete');
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
    expect(text).toContain('tail_sampling');
    expect(text).toContain('sampling_percentage');
    expect(text).toContain('otel-demo-all-lines-for-a-trace-id');
    expect(text).toContain('otel-demo-errors-by-service-last-15m');
    expect(text).toContain('"Name":"LOG_LEVEL","Value":"info"');
    expect(text).toContain('"Name":"OTEL_LOG_LEVEL","Value":"error"');
  });
});
