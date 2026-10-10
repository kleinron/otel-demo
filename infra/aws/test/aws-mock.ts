import type { SdkClient, TeardownClients } from '../src/types.js';
import { asRecord } from '../src/text.js';

export interface RecordedCall {
  name: string;
  input: Record<string, unknown>;
}

export type Handler = (input: Record<string, unknown>) => unknown;

export function fakeAccount(): string {
  return '8'.repeat(12);
}

export function fakeArn(
  service: string,
  region: string,
  account: string,
  resource: string,
): string {
  return ['arn', 'aws', service, region, account, resource].join(':');
}

export function experimentTag(): { Key: string; Value: string }[] {
  return [{ Key: 'experiment', Value: 'otel-demo' }];
}

export function recordingClient(
  handlers: Record<string, Handler> = {},
  options: { rejectMutations?: boolean } = {},
): { client: SdkClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      async send(command) {
        const name = command.constructor.name;
        const input = asRecord(command.input);
        calls.push({ name, input });
        if (options.rejectMutations && /^(Delete|Release|Abort|Terminate)/.test(name)) {
          throw new Error(`mutation ${name}`);
        }
        const handler = handlers[name];
        if (!handler) {
          return {};
        }
        return handler(input);
      },
    },
  };
}

export interface MockAws {
  clients: TeardownClients;
  calls: Record<keyof TeardownClients, RecordedCall[]>;
}

export function mockAws(
  handlers: Partial<Record<keyof TeardownClients, Record<string, Handler>>> = {},
  options: { rejectMutations?: boolean; accountId?: string } = {},
): MockAws {
  const accountId = options.accountId ?? fakeAccount();
  const names: (keyof TeardownClients)[] = [
    'sts',
    'tagging',
    'cloudwatch',
    'logs',
    'rds',
    'ec2',
    'elbv2',
    'elb',
    'ecr',
    'ecs',
    's3',
    'cloudformation',
    'budgets',
    'serviceQuotas',
    'secretsManager',
    'kms',
    'elasticache',
    'opensearch',
  ];
  const calls = {} as MockAws['calls'];
  const clients = {} as TeardownClients;
  for (const name of names) {
    const base =
      name === 'sts'
        ? {
            GetCallerIdentityCommand: () => ({ Account: accountId, UserId: 'tester' }),
            ...(handlers.sts ?? {}),
          }
        : (handlers[name] ?? {});
    const recorded = recordingClient(base, options);
    clients[name] = recorded.client;
    calls[name] = recorded.calls;
  }
  return { clients, calls };
}

export function commandNames(calls: RecordedCall[]): string[] {
  return calls.map((call) => call.name);
}

export function exportEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    EXPERIMENT_LOAD_PROFILE: 'baseline',
    EXPERIMENT_STARTED_AT: '2026-10-10T00:00:00Z',
    EXPERIMENT_ENDED_AT: '2026-10-10T01:00:00Z',
    EXPERIMENT_RUN_ID: 'run-test',
    EXPERIMENT_DATABASE_TIMEOUTS: 'off',
    EXPERIMENT_PAYMENT_DELAYS: 'off',
    ...extra,
  };
}

export function happyExportHandlers(description?: string): {
  cloudwatch: Record<string, Handler>;
  logs: Record<string, Handler>;
} {
  return {
    cloudwatch: {
      DescribeAlarmsCommand: (input) => ({
        MetricAlarms: (Array.isArray(input.AlarmNames) ? input.AlarmNames : []).map(
          (alarmName) => ({
            AlarmName: alarmName,
            StateValue: 'OK',
            Threshold: 1,
            AlarmDescription: description,
          }),
        ),
      }),
      DescribeAlarmHistoryCommand: () => ({ AlarmHistoryItems: [] }),
    },
    logs: {
      DescribeQueryDefinitionsCommand: () => ({
        queryDefinitions: [
          {
            name: 'otel-demo-errors',
            queryString: 'fields @timestamp, @message | limit 20',
            logGroupNames: ['/otel-demo/shop'],
          },
        ],
      }),
      StartQueryCommand: () => ({ queryId: 'q-test' }),
      GetQueryResultsCommand: () => ({ status: 'Complete', results: [] }),
      FilterLogEventsCommand: () => ({ events: [] }),
    },
  };
}
