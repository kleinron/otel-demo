import { context, isSpanContextValid, TraceFlags, trace } from '@opentelemetry/api';
import { Writable } from 'node:stream';
import pino, { type DestinationStream, type Logger } from 'pino';
import { exportLogLine, logsExportEnabled } from './log-export.js';
import {
  GCP_SPAN_ID_FIELD,
  GCP_TRACE_FIELD,
  GCP_TRACE_SAMPLED_FIELD,
  gcpTraceField,
  resolveCloudProvider,
  resolveGcpProjectId,
  resolveLogFormat,
  type CloudProvider,
  type LogFormat,
} from './cloud.js';
import {
  currentCustomerHash,
  currentFaultFlags,
  currentOrderId,
  ORDER_ID_FIELD,
} from './context.js';
import { redactLogEntry, redactLogValue, redactSensitiveText } from './redact.js';
import { currentCartId } from './cart.js';
import { toXrayTraceId } from './xray.js';

export interface LoggerOptions {
  service: string;
  destination?: DestinationStream;
  level?: string;
  /** Overrides `LOG_FORMAT`. Unset reads the environment when the logger is created. */
  format?: LogFormat;
  /** Overrides `CLOUD_PROVIDER`. Unset reads the environment when the logger is created. */
  cloudProvider?: CloudProvider;
  /** Overrides `GCP_PROJECT_ID` for the Cloud Logging trace field. */
  gcpProjectId?: string;
}

const REDACT_PATHS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'access_key',
  'secretAccessKey',
  'secret_access_key',
  'authorization',
  'cookie',
  'credentials',
  'privateKey',
  'private_key',
  'clientSecret',
  'client_secret',
  'sessionToken',
  'session_token',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.cookie',
  '*.credentials',
  '*.accessToken',
  '*.secretAccessKey',
  '*.clientSecret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

const GCP_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * JSON logger. Each line includes `service`, active `trace_id` / `span_id`,
 * the X-Ray encoding of the trace id, and `orderId` when the call or the
 * active context has one. A customer hash and fault flags are added when the
 * request context has them. Emails, phone numbers, and secret fields are
 * redacted in the logger before the line is written.
 *
 * `level` is read from `LOG_LEVEL` when the process creates the logger
 * (default `info`). Debug lines such as `about to …` stay off until the
 * environment sets `LOG_LEVEL=debug`. No image rebuild is required.
 *
 * `LOG_FORMAT=gcp` renames fields for Cloud Logging: `severity` (the name,
 * not a number), `message`, `logging.googleapis.com/trace`, and
 * `logging.googleapis.com/spanId`. `service` and `orderId` stay. Unset
 * `LOG_FORMAT` keeps this default shape. `CLOUD_PROVIDER=gcp` drops
 * `xray_trace_id` on the default shape. Unset `CLOUD_PROVIDER` keeps it.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const env = process.env;
  const format = options.format ?? resolveLogFormat(env);
  const cloudProvider = options.cloudProvider ?? resolveCloudProvider(env);
  const projectId = resolveGcpProjectId({
    GCP_PROJECT_ID: options.gcpProjectId ?? env.GCP_PROJECT_ID,
  });
  const destination = logsExportEnabled()
    ? teeLogDestination(options.destination)
    : options.destination;
  if (format === 'gcp') {
    return pino(gcpOptions(options.service, level, projectId), destination);
  }
  return pino(defaultOptions(options.service, level, cloudProvider), destination);
}

/**
 * Stdout (or the caller's stream) stays the log line. A second write copies
 * the same JSON to the OTLP logger, including `trace_id` and `span_id`.
 */
function teeLogDestination(inner: DestinationStream | undefined): DestinationStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        if (inner) {
          inner.write(text);
        } else {
          process.stdout.write(text);
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      try {
        exportLogLine(text);
      } catch {
        // A collector outage must not drop the stdout line.
      }
      callback();
    },
  });
}

function sharedRedact(): {
  redact: { paths: string[]; censor: string };
  formatters: {
    bindings(bindings: Record<string, unknown>): Record<string, unknown>;
    log(object: Record<string, unknown>): Record<string, unknown>;
  };
  hooks: {
    logMethod(this: Logger, args: unknown[], method: (...methodArgs: never[]) => void): void;
    streamWrite(line: string): string;
  };
} {
  return {
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    formatters: {
      bindings(bindings) {
        return redactLogValue(bindings) as Record<string, unknown>;
      },
      log(object) {
        return redactLogEntry(object, currentCartId());
      },
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((arg) => redactLogValue(arg));
        method.apply(this, redacted as Parameters<typeof method>);
      },
      streamWrite(line) {
        return redactSensitiveText(line);
      },
    },
  };
}

function defaultOptions(service: string, level: string, cloudProvider: CloudProvider) {
  const shared = sharedRedact();
  return {
    level,
    base: { service },
    redact: shared.redact,
    mixin() {
      return traceMixin(cloudProvider);
    },
    mixinMergeStrategy(mergeObject: object, mixinObject: object) {
      return { ...mixinObject, ...mergeObject };
    },
    formatters: {
      ...shared.formatters,
      level(label: string) {
        return { level: label };
      },
    },
    hooks: shared.hooks,
  };
}

function gcpOptions(service: string, level: string, projectId: string | undefined) {
  const shared = sharedRedact();
  return {
    level,
    messageKey: 'message',
    base: { service },
    redact: shared.redact,
    mixin() {
      return gcpTraceMixin(projectId, service);
    },
    mixinMergeStrategy(mergeObject: object, mixinObject: object) {
      return { ...mixinObject, ...mergeObject };
    },
    formatters: {
      ...shared.formatters,
      level(label: string) {
        return { severity: GCP_SEVERITY[label] ?? label.toUpperCase() };
      },
    },
    hooks: shared.hooks,
  };
}

function traceMixin(cloudProvider: CloudProvider): Record<string, string | true> {
  const fields: Record<string, string | true> = {};
  const span = trace.getSpan(context.active());
  if (span && isSpanContextValid(span.spanContext())) {
    const spanContext = span.spanContext();
    fields.trace_id = spanContext.traceId;
    fields.span_id = spanContext.spanId;
    if (cloudProvider === 'aws') {
      fields.xray_trace_id = toXrayTraceId(spanContext.traceId);
    }
  }
  appendContextFields(fields);
  return fields;
}

function gcpTraceMixin(
  projectId: string | undefined,
  service: string,
): Record<string, string | boolean | Record<string, string>> {
  const fields: Record<string, string | boolean> = {};
  const span = trace.getSpan(context.active());
  if (span && isSpanContextValid(span.spanContext())) {
    const spanContext = span.spanContext();
    if (projectId) {
      fields[GCP_TRACE_FIELD] = gcpTraceField(projectId, spanContext.traceId);
    }
    fields[GCP_SPAN_ID_FIELD] = spanContext.spanId;
    fields[GCP_TRACE_SAMPLED_FIELD] =
      (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
  }
  appendContextFields(fields);
  // Cloud Logging lifts this into LogEntry.labels, and Error Reporting reads serviceContext.
  return {
    ...fields,
    [GCP_LABELS_FIELD]: { service },
    serviceContext: { service },
  };
}

const GCP_LABELS_FIELD = 'logging.googleapis.com/labels';

function appendContextFields(fields: Record<string, string | boolean>): void {
  const orderId = currentOrderId();
  if (orderId) {
    fields[ORDER_ID_FIELD] = orderId;
  }
  const customerHashValue = currentCustomerHash();
  if (customerHashValue) {
    fields.customer_hash = customerHashValue;
  }
  const flags = currentFaultFlags();
  if (flags['fault.configured']) {
    fields['fault.configured'] = true;
  }
  if (flags['fault.injected']) {
    fields['fault.injected'] = true;
  }
}
