import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  createFaultSwitch as createAwsFaultSwitch,
  type SsmParameterClient,
} from '@otel-demo/infra-aws/fault-switch';

/** `true` = all faults, `false` = none, a list = only those fault ids. */
export type FaultSwitchValue = boolean | readonly string[];

/** Same reader shape the services already poll. */
export interface FaultSwitchReader {
  read(): Promise<FaultSwitchValue>;
}

export type FaultSwitchProviderName = 'aws-ssm' | 'gcp-secret' | 'gcp-config';

export interface SecretAccessor {
  /** Returns the secret payload, or `undefined` when the version has no data. */
  access(resource: string): Promise<string | undefined>;
}

export interface FaultSwitchClients {
  /** Used when the provider is `aws-ssm`. Omit it and the AWS reader builds an SSM client. */
  ssm?: SsmParameterClient;
  /** Used when the provider reads Secret Manager. Omit it and the GCP reader calls the API. */
  secrets?: SecretAccessor;
}

export interface SecretFetch {
  (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface SecretManagerClientOptions {
  fetch?: SecretFetch;
  /** Access token. When omitted, the client reads the instance metadata server. */
  token?: () => Promise<string>;
}

const DEFAULT_GCP_SECRET = 'otel-demo-faults-enabled';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * Kill switch provider. `FAULT_SWITCH_PROVIDER` selects it.
 * Unset means `aws-ssm`, the existing SSM reader. `gcp` reads Secret Manager
 * unless `GCP_FAULT_SWITCH_SOURCE=config`, which reads `GCP_FAULT_SWITCH_VALUE`
 * and does not call a cloud API.
 *
 * `CLOUD_PROVIDER` does not select this provider. Trace ids and the kill switch
 * stay independent so a GCP trace setting cannot change the AWS switch.
 */
export function createFaultSwitch(
  env: Record<string, string | undefined> = process.env,
  clients?: FaultSwitchClients,
): FaultSwitchReader {
  const provider = resolveFaultSwitchProvider(env);
  if (provider === 'aws-ssm') {
    return createAwsFaultSwitch(env, clients?.ssm);
  }
  if (provider === 'gcp-config') {
    return createConfigFaultSwitch(env);
  }
  return createSecretFaultSwitch(env, clients?.secrets);
}

export function resolveFaultSwitchProvider(
  env: Record<string, string | undefined>,
): FaultSwitchProviderName {
  const raw = (env.FAULT_SWITCH_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'aws-ssm' || raw === 'aws') {
    return 'aws-ssm';
  }
  if (raw === 'gcp-config') {
    return 'gcp-config';
  }
  if (raw === 'gcp' || raw === 'gcp-secret') {
    const source = (env.GCP_FAULT_SWITCH_SOURCE ?? '').trim().toLowerCase();
    if (source === '' || source === 'secret') {
      return 'gcp-secret';
    }
    if (source === 'config') {
      return 'gcp-config';
    }
    throw new Error(`Unknown GCP_FAULT_SWITCH_SOURCE ${source}`);
  }
  throw new Error(`Unknown FAULT_SWITCH_PROVIDER ${raw}`);
}

/** Secret version resource name. A full `projects/...` id is used as given. */
export function secretVersionResource(projectId: string | undefined, secretId: string): string {
  const trimmed = secretId.trim();
  if (trimmed.startsWith('projects/')) {
    return trimmed;
  }
  const project = projectId?.trim() ?? '';
  if (project === '') {
    throw new Error('GCP_PROJECT_ID is required to read the fault switch secret');
  }
  if (trimmed === '') {
    throw new Error('GCP_FAULT_SWITCH_SECRET is empty');
  }
  return `projects/${project}/secrets/${trimmed}/versions/latest`;
}

/**
 * Secret Manager REST client. Tests pass `fetch` and `token` so nothing
 * leaves the process. The default token source is the GCE metadata server,
 * which Cloud Run exposes to the attached service account.
 */
export function createSecretManagerClient(
  options: SecretManagerClientOptions = {},
): SecretAccessor {
  const fetchImpl = options.fetch ?? defaultFetch;
  const token = options.token ?? (() => readMetadataAccessToken(fetchImpl));
  return {
    access(resource: string) {
      // Background polls (no active span) are not traced; the startup read is.
      if (!trace.getActiveSpan()) {
        return accessOnce(resource);
      }
      // Own client span so the Secret Manager read and its log lines are traced.
      return trace.getTracer('fault-switch').startActiveSpan(
        'secretmanager AccessSecretVersion',
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'rpc.system': 'http',
            'rpc.service': 'secretmanager',
            'gcp.secret': resource,
          },
        },
        async (span) => {
          try {
            return await accessOnce(resource);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },
  };

  async function accessOnce(resource: string): Promise<string | undefined> {
    {
      const bearer = await token();
      const response = await fetchImpl(
        `https://secretmanager.googleapis.com/v1/${resource}:access`,
        {
          headers: { Authorization: `Bearer ${bearer}` },
        },
      );
      if (!response.ok) {
        throw new Error(`secret manager read failed: ${response.status}`);
      }
      const body = await response.json();
      return decodeSecretPayload(body);
    }
  }
}

function createConfigFaultSwitch(env: Record<string, string | undefined>): FaultSwitchReader {
  return {
    async read() {
      const value = env.GCP_FAULT_SWITCH_VALUE;
      if (value === undefined || value.trim() === '') {
        throw new Error('gcp fault switch config is empty');
      }
      return parseSwitch(value);
    },
  };
}

function createSecretFaultSwitch(
  env: Record<string, string | undefined>,
  client?: SecretAccessor,
): FaultSwitchReader {
  const secretId = env.GCP_FAULT_SWITCH_SECRET?.trim() || DEFAULT_GCP_SECRET;
  let cached = client;
  return {
    async read() {
      const accessor = cached ?? (cached = createSecretManagerClient());
      const resource = secretVersionResource(env.GCP_PROJECT_ID, secretId);
      const value = await accessor.access(resource);
      if (value === undefined || value.trim() === '') {
        throw new Error('secret manager value is empty');
      }
      return parseSwitch(value);
    },
  };
}

async function readMetadataAccessToken(fetchImpl: SecretFetch): Promise<string> {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!response.ok) {
    throw new Error(`metadata token read failed: ${response.status}`);
  }
  const body = await response.json();
  if (!isRecord(body) || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error('metadata token read failed');
  }
  return body.access_token;
}

function decodeSecretPayload(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.payload)) {
    return undefined;
  }
  const data = body.payload.data;
  if (typeof data !== 'string' || data === '') {
    return undefined;
  }
  return Buffer.from(data, 'base64').toString('utf8');
}

function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return fetch(url, { headers: init?.headers });
}

/**
 * true/1/on/all enable every fault and false/0/off/none disable them (the AWS
 * tokens plus all/none). Anything else is a comma-separated list of fault ids,
 * such as `payment-delay`, so one fault can be rehearsed alone.
 */
export function parseSwitch(value: string): FaultSwitchValue {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'all') {
    return true;
  }
  if (
    normalized === 'false' ||
    normalized === '0' ||
    normalized === 'off' ||
    normalized === 'none'
  ) {
    return false;
  }
  const ids = normalized
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length > 0 && ids.every((id) => /^[a-z0-9][a-z0-9-]*$/.test(id))) {
    return ids;
  }
  throw new Error('fault switch value is unreadable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
