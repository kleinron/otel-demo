import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';
import { currentOrderId, ORDER_ID_FIELD } from './context.js';
import { redactLogValue, redactSensitiveText } from './redact.js';
import { toXrayTraceId } from './xray.js';

export interface LoggerOptions {
  service: string;
  destination?: DestinationStream;
  level?: string;
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

/**
 * JSON logger. Each line includes `service`, active `trace_id` / `span_id`,
 * the X-Ray encoding of the trace id, and `orderId` when the call or the
 * active context has one. Emails, phone numbers, and secret fields are
 * redacted in the logger before the line is written.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  return pino(
    {
      level,
      base: { service: options.service },
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      mixin() {
        return traceMixin();
      },
      mixinMergeStrategy(mergeObject, mixinObject) {
        return { ...mixinObject, ...mergeObject };
      },
      formatters: {
        level(label) {
          return { level: label };
        },
        bindings(bindings) {
          return redactLogValue(bindings) as Record<string, unknown>;
        },
        log(object) {
          return redactLogValue(object) as Record<string, unknown>;
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
    },
    options.destination,
  );
}

function traceMixin(): Record<string, string> {
  const fields: Record<string, string> = {};
  const span = trace.getSpan(context.active());
  if (span && isSpanContextValid(span.spanContext())) {
    const spanContext = span.spanContext();
    fields.trace_id = spanContext.traceId;
    fields.span_id = spanContext.spanId;
    fields.xray_trace_id = toXrayTraceId(spanContext.traceId);
  }
  const orderId = currentOrderId();
  if (orderId) {
    fields[ORDER_ID_FIELD] = orderId;
  }
  return fields;
}
