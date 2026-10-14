/** OTLP/HTTP default from the OpenTelemetry specification. */
export const DEFAULT_OTLP_HTTP_ENDPOINT = 'http://localhost:4318';

export const OTLP_HTTP_PROTOCOL = 'http/protobuf';

export interface OtlpEndpoints {
  tracesUrl: string;
  metricsUrl: string;
  logsUrl: string;
  tracesHeaders: Record<string, string>;
  metricsHeaders: Record<string, string>;
  logsHeaders: Record<string, string>;
}

export function parseKeyValueList(input: string | undefined): Record<string, string> {
  if (!input || input.trim() === '') {
    return {};
  }
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '\\' && next !== undefined) {
      current += next;
      index += 1;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char ?? '';
  }
  parts.push(current);

  const pairs: Record<string, string> = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (key === '') {
      continue;
    }
    pairs[key] = decodeHeaderValue(rawValue);
  }
  return pairs;
}

export function resolveOtlpEndpoints(env: Record<string, string | undefined>): OtlpEndpoints {
  assertProtocol(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'OTEL_EXPORTER_OTLP_PROTOCOL');
  assertProtocol(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL');
  assertProtocol(env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL');
  assertProtocol(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL');

  const base = normalizeBase(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_HTTP_ENDPOINT);
  const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ? assertHttpUrl(
        env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      ).toString()
    : joinSignal(base, '/v1/traces');
  const metricsUrl = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ? assertHttpUrl(
        env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
        'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      ).toString()
    : joinSignal(base, '/v1/metrics');
  const logsUrl = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    ? assertHttpUrl(
        env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      ).toString()
    : joinSignal(base, '/v1/logs');

  const sharedHeaders = parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS);
  return {
    tracesUrl,
    metricsUrl,
    logsUrl,
    tracesHeaders: {
      ...sharedHeaders,
      ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    },
    metricsHeaders: {
      ...sharedHeaders,
      ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
    },
    logsHeaders: {
      ...sharedHeaders,
      ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
    },
  };
}

function assertProtocol(value: string | undefined, name: string): void {
  if (value === undefined || value.trim() === '') {
    return;
  }
  if (value !== OTLP_HTTP_PROTOCOL) {
    throw new Error(`${name} must be ${OTLP_HTTP_PROTOCOL} (received ${value})`);
  }
}

function normalizeBase(value: string): URL {
  return assertHttpUrl(value, 'OTEL_EXPORTER_OTLP_ENDPOINT');
}

function assertHttpUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return parsed;
}

function joinSignal(base: URL, signalPath: string): string {
  const url = new URL(base.toString());
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path}${signalPath}`;
  return url.toString();
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
