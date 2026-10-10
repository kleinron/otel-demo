const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Map a W3C trace id to the X-Ray encoding `1-{8 hex}-{24 hex}`.
 * This is a field format only. The process still exports OTLP, not X-Ray.
 */
export function toXrayTraceId(traceId: string): string {
  if (!TRACE_ID_PATTERN.test(traceId)) {
    throw new Error('Trace id must be 32 lowercase hex characters');
  }
  return `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
}
