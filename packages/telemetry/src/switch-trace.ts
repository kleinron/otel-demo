import { metrics, trace } from '@opentelemetry/api';
import type { FaultControlLog, FaultSwitchReader, FaultSwitchValue } from './fault-control.js';
import { inChildSpan, inRootSpanSync } from './trace-helpers.js';

const TRACER = 'fault-control';

/**
 * Read the switch. Inside a span (the startup read) the read gets its own
 * child span; the background poll has no active span and is not traced.
 */
export function readSwitch(reader: FaultSwitchReader): Promise<FaultSwitchValue> {
  if (trace.getActiveSpan()) {
    return inChildSpan(TRACER, 'fault-switch read', () => reader.read());
  }
  return reader.read();
}

/**
 * Logs from the poll run in the active span when there is one, otherwise in a
 * short root span, so every line still carries trace and span ids. Polls only
 * log on a change, so this is rare.
 */
export function tracedLog(log: FaultControlLog): FaultControlLog {
  const run = (fn: () => void): void => {
    if (trace.getActiveSpan()) {
      fn();
      return;
    }
    inRootSpanSync(TRACER, 'fault-switch change', () => fn());
  };
  return {
    info: (message, fields) => run(() => log.info(message, fields)),
    warn: (message, fields) => run(() => log.warn(message, fields)),
  };
}

let changes: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | undefined;

/** One log line and one counter increment when the switch value changes (or is first read). */
export function noteSwitchValue(
  previous: FaultSwitchValue | undefined,
  next: FaultSwitchValue,
  log: FaultControlLog,
): void {
  if (previous !== undefined && switchLabel(previous) === switchLabel(next)) {
    return;
  }
  changes ??= metrics
    .getMeter(TRACER)
    .createCounter('fault_switch.changes', { description: 'Fault switch value changes seen' });
  changes.add(1, { 'fault_switch.value': switchLabel(next) });
  log.info(previous === undefined ? 'fault switch read' : 'fault switch changed', {
    from: previous === undefined ? null : switchLabel(previous),
    to: switchLabel(next),
  });
}

/** `on`, `off`, or the selected fault ids joined by commas. */
export function switchLabel(value: FaultSwitchValue): string {
  if (value === true) {
    return 'on';
  }
  if (value === false || value.length === 0) {
    return 'off';
  }
  return [...value].sort().join(',');
}
