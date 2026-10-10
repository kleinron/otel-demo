import { CHECKOUT_HOPS } from './names.js';
import { asRecord, asString } from './text.js';

export const CHECKOUT_TRACE_FILTERS = [
  'annotation.operation = "checkout"',
  'annotation.fault.injected = "true"',
  'error = true',
  'http.status = 409',
] as const;

export interface ShapedTrace {
  id: string;
  missingHops: string[];
  hops: string[];
  segments: unknown[];
}

/** A checkout trace is complete only when shop, inventory, payment, and delivery are present. */
export function shapeTrace(id: string, segments: readonly unknown[]): ShapedTrace {
  const hops = new Set<string>();
  const parsed = segments.map((segment) => {
    const record = asRecord(segment);
    const raw = asString(record.Document);
    let document: unknown = record;
    if (raw) {
      try {
        document = JSON.parse(raw) as unknown;
      } catch {
        document = raw;
      }
    }
    collectHops(document, hops);
    return document;
  });
  return {
    id,
    hops: CHECKOUT_HOPS.filter((hop) => hops.has(hop)),
    missingHops: CHECKOUT_HOPS.filter((hop) => !hops.has(hop)),
    segments: parsed,
  };
}

function collectHops(value: unknown, hops: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHops(item, hops);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  noteHop(asString(record.name), hops);
  const annotations = asRecord(record.annotations);
  noteHop(asString(annotations.service), hops);
  noteHop(asString(annotations['service.name']), hops);
  collectHops(record.subsegments, hops);
}

function noteHop(name: string | undefined, hops: Set<string>): void {
  if (!name) {
    return;
  }
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/);
  for (const hop of CHECKOUT_HOPS) {
    if (tokens.includes(hop)) {
      hops.add(hop);
    }
  }
}
