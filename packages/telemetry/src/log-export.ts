import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
  type Context,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { GCP_SPAN_ID_FIELD, GCP_TRACE_FIELD } from './cloud.js';
import { logsExportRequested } from './config.js';

/**
 * True when this process should copy each JSON log line to the OTLP logs
 * endpoint. Unset `OTEL_LOGS_EXPORTER` keeps the stdout logger unchanged.
 * `OTEL_SDK_DISABLED=true` skips export as well.
 */
export function logsExportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') {
    return false;
  }
  return logsExportRequested(env);
}

/**
 * Forward one pino JSON line to the global OTel logger. The record's span
 * context is the active span when there is one, otherwise the `trace_id` and
 * `span_id` on the line (or the Cloud Logging trace and span fields). Export
 * failures must not break the stdout line.
 */
export function exportLogLine(chunk: string): void {
  if (!logsExportEnabled()) {
    return;
  }
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    emitRecord(parsed as Record<string, unknown>);
  }
}

function emitRecord(record: Record<string, unknown>): void {
  const ids = correlationIds(record);
  const severityText = severityTextOf(record);
  const body = bodyOf(record);
  const attributes = primitiveAttributes(record);
  if (ids) {
    attributes.trace_id = ids.traceId;
    attributes.span_id = ids.spanId;
  }
  const timestamp = timestampOf(record);
  logs.getLogger('otel-demo').emit({
    severityNumber: severityNumberOf(severityText),
    severityText,
    body,
    attributes,
    ...(timestamp === undefined ? {} : { timestamp }),
    context: contextFor(record, ids),
  });
}

function contextFor(
  record: Record<string, unknown>,
  ids: { traceId: string; spanId: string } | undefined,
): Context {
  const active = context.active();
  const span = trace.getSpan(active);
  if (span && isSpanContextValid(span.spanContext())) {
    return active;
  }
  if (!ids) {
    return active;
  }
  const sampled = record[GCP_TRACE_SAMPLED] !== false;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: ids.traceId,
    spanId: ids.spanId,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: false,
  });
}

const GCP_TRACE_SAMPLED = 'logging.googleapis.com/trace_sampled';

function correlationIds(
  record: Record<string, unknown>,
): { traceId: string; spanId: string } | undefined {
  const traceId = hexId(record.trace_id, 32) ?? gcpTraceId(record[GCP_TRACE_FIELD]);
  const spanId = hexId(record.span_id, 16) ?? hexId(record[GCP_SPAN_ID_FIELD], 16);
  if (!traceId || !spanId) {
    return undefined;
  }
  return { traceId, spanId };
}

function gcpTraceId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return hexId(value.split('/').pop(), 32);
}

function hexId(value: unknown, length: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim().toLowerCase();
  if (text.length !== length || !/^[0-9a-f]+$/.test(text)) {
    return undefined;
  }
  return text;
}

function bodyOf(record: Record<string, unknown>): string {
  if (typeof record.msg === 'string') {
    return record.msg;
  }
  if (typeof record.message === 'string') {
    return record.message;
  }
  return '';
}

function severityTextOf(record: Record<string, unknown>): string {
  if (typeof record.level === 'string' && record.level.trim() !== '') {
    return record.level;
  }
  if (typeof record.severity === 'string' && record.severity.trim() !== '') {
    return record.severity;
  }
  return 'info';
}

function severityNumberOf(label: string): SeverityNumber {
  switch (label.trim().toLowerCase()) {
    case 'trace':
      return SeverityNumber.TRACE;
    case 'debug':
      return SeverityNumber.DEBUG;
    case 'info':
      return SeverityNumber.INFO;
    case 'warn':
    case 'warning':
      return SeverityNumber.WARN;
    case 'error':
      return SeverityNumber.ERROR;
    case 'fatal':
    case 'critical':
      return SeverityNumber.FATAL;
    default:
      return SeverityNumber.UNSPECIFIED;
  }
}

function primitiveAttributes(
  record: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'msg' || key === 'message' || key === 'time') {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value;
    }
  }
  return attributes;
}

function timestampOf(record: Record<string, unknown>): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) {
    return record.time;
  }
  if (typeof record.time === 'string') {
    const parsed = Date.parse(record.time);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
