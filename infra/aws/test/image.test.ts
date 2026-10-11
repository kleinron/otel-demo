import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('service image', () => {
  const dockerfile = readFileSync(join(ROOT, 'infra/aws/docker/service.Dockerfile'), 'utf8');

  it('builds the runtime workspaces and leaves the CDK app out of the image', () => {
    expect(dockerfile).toContain('COPY infra/aws/docker/fault-switch.cjs');
    expect(dockerfile).not.toContain('COPY infra/aws/src');
    expect(dockerfile).not.toContain('COPY infra/aws ');
    expect(dockerfile).toContain(
      'npx tsc -b services/shop services/inventory services/payment services/delivery loadgen',
    );
    expect(dockerfile).toContain('ENV LOG_LEVEL=info');
  });

  it('ignores TypeScript build info at any depth', () => {
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    expect(ignore).toContain('**/*.tsbuildinfo');
  });

  it('ships loadgen/schedule.json at the path services read', () => {
    expect(dockerfile).toContain('COPY loadgen/schedule.json /app/loadgen/schedule.json');
    expect(dockerfile).toContain('test -f /app/loadgen/schedule.json');
    const entry = readFileSync(join(ROOT, 'infra/aws/docker/fault-switch.cjs'), 'utf8');
    expect(entry).toContain('function createFaultSwitch');
    expect(entry).toContain('OTEL_DEMO_FAULTS_PARAMETER');
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(ignore.some((line) => line.includes('schedule.json') || line === 'loadgen')).toBe(false);
    const schedule = readFileSync(join(ROOT, 'loadgen/schedule.json'), 'utf8');
    expect(schedule).toContain('"start"');
  });

  it('keeps the schedule in the local service images', () => {
    for (const path of [
      'services/shop/Dockerfile',
      'services/inventory/Dockerfile',
      'services/payment/Dockerfile',
      'services/delivery/Dockerfile',
      'loadgen/Dockerfile',
    ]) {
      expect(readFileSync(join(ROOT, path), 'utf8')).toContain('COPY . .');
    }
  });

  it('requires a linux/arm64 build for the Fargate image', () => {
    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain('"$TARGETARCH" != "arm64"');
    const script = readFileSync(join(ROOT, 'scripts/build-service-image.sh'), 'utf8');
    expect(script).toContain('--platform linux/arm64');
    expect(script).toContain('infra/aws/docker/service.Dockerfile');
    expect(script).not.toMatch(/\d{12}/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['image:build']).toBe('bash scripts/build-service-image.sh');
  });
});
