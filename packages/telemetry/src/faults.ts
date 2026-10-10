import { type Span } from '@opentelemetry/api';

export const FAULT_TYPES = ['delay', 'error', 'drop'] as const;

export type FaultType = (typeof FAULT_TYPES)[number];

export interface FaultSpec {
  id: string;
  type: FaultType;
  service?: string;
  operation?: string;
  /** Stored for a later phase. The skeleton does not roll this probability. */
  probability?: number;
}

export interface FaultInjectionConfig {
  enabled: boolean;
  faults: readonly FaultSpec[];
}

export interface FaultTarget {
  service: string;
  operation: string;
}

export const FAULT_INJECTED_ATTRIBUTE = 'fault.injected';
export const FAULT_ID_ATTRIBUTE = 'fault.id';
export const FAULT_TYPE_ATTRIBUTE = 'fault.type';

/**
 * Fault injection is off unless OTEL_DEMO_FAULTS_ENABLED=true.
 * When it is off, OTEL_DEMO_FAULTS is ignored.
 */
export function loadFaultInjectionConfig(
  env: Record<string, string | undefined>,
): FaultInjectionConfig {
  if (!isEnabled(env.OTEL_DEMO_FAULTS_ENABLED)) {
    return { enabled: false, faults: [] };
  }
  const raw = env.OTEL_DEMO_FAULTS;
  if (raw === undefined || raw.trim() === '') {
    return { enabled: true, faults: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('OTEL_DEMO_FAULTS must be a JSON array');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OTEL_DEMO_FAULTS must be a JSON array');
  }
  return { enabled: true, faults: parsed.map((entry, index) => parseFault(entry, index)) };
}

/**
 * Select every configured fault that matches the target and record each one
 * on the span. This does not delay, fail, or drop the call.
 */
export function noteConfiguredFault(
  config: FaultInjectionConfig,
  target: FaultTarget,
  span: Span,
): readonly FaultSpec[] {
  if (!config.enabled) {
    return [];
  }
  const matched = config.faults.filter((fault) => matches(fault, target));
  if (matched.length === 0) {
    return [];
  }
  span.setAttribute(FAULT_INJECTED_ATTRIBUTE, true);
  span.setAttribute(
    FAULT_ID_ATTRIBUTE,
    matched.map((fault) => fault.id),
  );
  span.setAttribute(
    FAULT_TYPE_ATTRIBUTE,
    matched.map((fault) => fault.type),
  );
  return matched;
}

function matches(fault: FaultSpec, target: FaultTarget): boolean {
  if (fault.service !== undefined && fault.service !== target.service) {
    return false;
  }
  if (fault.operation !== undefined && fault.operation !== target.operation) {
    return false;
  }
  return true;
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'on';
}

function parseFault(value: unknown, index: number): FaultSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OTEL_DEMO_FAULTS[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, index, 'id');
  const type = requiredString(record.type, index, 'type');
  if (!isFaultType(type)) {
    throw new Error(`OTEL_DEMO_FAULTS[${index}].type must be one of ${FAULT_TYPES.join(', ')}`);
  }
  const fault: FaultSpec = { id, type };
  if (record.service !== undefined) {
    fault.service = requiredString(record.service, index, 'service');
  }
  if (record.operation !== undefined) {
    fault.operation = requiredString(record.operation, index, 'operation');
  }
  if (record.probability !== undefined) {
    if (
      typeof record.probability !== 'number' ||
      Number.isNaN(record.probability) ||
      record.probability < 0 ||
      record.probability > 1
    ) {
      throw new Error(`OTEL_DEMO_FAULTS[${index}].probability must be between 0 and 1`);
    }
    fault.probability = record.probability;
  }
  return fault;
}

function requiredString(value: unknown, index: number, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`OTEL_DEMO_FAULTS[${index}].${field} must be a non-empty string`);
  }
  return value;
}

function isFaultType(value: string): value is FaultType {
  return (FAULT_TYPES as readonly string[]).includes(value);
}
