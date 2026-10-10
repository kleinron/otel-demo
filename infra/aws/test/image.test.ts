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
});
