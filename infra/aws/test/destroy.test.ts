import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTeardown } from '../src/teardown.js';
import { commandNames, exportEnv, mockAws } from './aws-mock.js';

describe('stack destroy', () => {
  it('invokes cdk destroy for experiment stacks and never for CDKToolkit', async () => {
    let listed = 0;
    const args: string[][] = [];
    const aws = mockAws({
      cloudformation: {
        ListStacksCommand: () => {
          listed += 1;
          if (listed === 1) {
            return {
              StackSummaries: [
                { StackName: 'otel-demo-services', StackStatus: 'CREATE_COMPLETE' },
                { StackName: 'CDKToolkit', StackStatus: 'CREATE_COMPLETE' },
              ],
            };
          }
          return { StackSummaries: [] };
        },
        DescribeStacksCommand: () => {
          throw Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
        },
      },
    });
    const result = await runTeardown({
      env: exportEnv(),
      region: 'eu-central-1',
      skipExport: true,
      acknowledgeNoExport: true,
      cdkAppPresent: true,
      now: new Date('2026-10-10T00:00:00Z'),
      clients: aws.clients,
      resultsRoot: mkdtempSync(join(tmpdir(), 'otel-demo-results-')),
      waitAttempts: 1,
      waitIntervalMs: 0,
      sleep: async () => undefined,
      loadExpiration: async () => undefined,
      runProcess: async (_command, argv) => {
        args.push(argv);
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(args).toEqual([
      ['cdk', 'destroy', 'otel-demo-services', '--force', '--region', 'eu-central-1'],
    ]);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
    expect(result.report).toMatch(/VERIFY OK/);
  });
});
