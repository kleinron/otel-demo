import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import {
  applyMatchedFault,
  clampPollInterval,
  createFaultController,
  createFaultSwitchReader,
  createFileFaultSwitch,
  FaultInjectedError,
  FAULT_INJECTED_ATTRIBUTE,
  FAULT_TYPE_ATTRIBUTE,
  loadFaultSchedule,
  type FaultControlLog,
} from '../src/index.js';

describe('fault schedule and poll interval', () => {
  it('clamps the kill-switch poll into the 5 to 10 second band', () => {
    expect(clampPollInterval(1_000)).toBe(5_000);
    expect(clampPollInterval(7_500)).toBe(7_500);
    expect(clampPollInterval(30_000)).toBe(10_000);
  });

  it('reads a startup schedule from the environment without consulting the kill switch', () => {
    const schedule = loadFaultSchedule({
      OTEL_DEMO_FAULTS: JSON.stringify([
        { id: 'pay-delay', type: 'delay', service: 'payment', operation: 'charge', delayMs: 25 },
      ]),
      OTEL_DEMO_FAULT_WINDOW_START: '2026-10-10T00:00:00.000Z',
      OTEL_DEMO_FAULT_WINDOW_END: '2026-10-10T01:00:00.000Z',
    });
    expect(schedule.faults[0]?.id).toBe('pay-delay');
    expect(schedule.windowStartMs).toBe(Date.parse('2026-10-10T00:00:00.000Z'));
    expect(schedule.windowEndMs).toBe(Date.parse('2026-10-10T01:00:00.000Z'));
  });
});

describe('fault controller', () => {
  it('logs the window start in UTC and injects an error fault', async () => {
    const messages: string[] = [];
    const fields: Record<string, unknown>[] = [];
    let enabled = true;
    const start = Date.parse('2026-10-10T12:00:00.000Z');
    const controller = createFaultController({
      schedule: {
        faults: [
          {
            id: 'inventory-reserve-error',
            type: 'error',
            service: 'inventory',
            operation: 'reserve',
          },
        ],
        windowStartMs: start,
        windowEndMs: start + 60_000,
      },
      reader: {
        async read() {
          return enabled;
        },
      },
      log: capture(messages, fields),
      wallClock: () => start + 1_000,
    });

    await controller.pollOnce();
    expect(controller.isActive()).toBe(true);
    expect(messages).toContain('fault window start');
    expect(fields[0]?.at).toBe('2026-10-10T12:00:01.000Z');

    const finished = await captureSpan(async (span) => {
      await expect(
        controller.apply({ service: 'inventory', operation: 'reserve' }, span),
      ).rejects.toBeInstanceOf(FaultInjectedError);
    });
    expect(finished.attributes[FAULT_INJECTED_ATTRIBUTE]).toBe(true);
    expect(finished.attributes[FAULT_TYPE_ATTRIBUTE]).toEqual(['error']);
    expect(finished.status.code).toBe(SpanStatusCode.ERROR);

    enabled = false;
    await controller.pollOnce();
    expect(controller.isActive()).toBe(false);
    expect(messages).toContain('faults off by operator');
    expect(messages).not.toContain('faults off by fail-safe');
  });

  it('keeps the last known value for 60s and turns faults off only after several failed reads', async () => {
    const messages: string[] = [];
    let now = 0;
    let fail = false;
    const controller = createFaultController({
      schedule: {
        faults: [
          { id: 'delay', type: 'delay', service: 'payment', operation: 'charge', delayMs: 0 },
        ],
      },
      reader: {
        async read() {
          if (fail) {
            throw new Error('unreadable');
          }
          return true;
        },
      },
      log: capture(messages, []),
      wallClock: () => now,
      failureLimit: 3,
      lastKnownTtlMs: 60_000,
    });

    await controller.pollOnce();
    expect(controller.isActive()).toBe(true);

    fail = true;
    now = 15_000;
    await controller.pollOnce();
    await controller.pollOnce();
    await controller.pollOnce();
    expect(controller.isActive()).toBe(true);
    expect(messages).not.toContain('faults off by fail-safe');

    now = 60_000;
    await controller.pollOnce();
    expect(controller.isActive()).toBe(false);
    expect(messages).toContain('faults off by fail-safe');
    expect(messages).not.toContain('faults off by operator');
  });

  it('stops faults at the window end and logs the end marker in UTC', async () => {
    const messages: string[] = [];
    const fields: Record<string, unknown>[] = [];
    const start = Date.parse('2026-10-10T15:00:00.000Z');
    const end = Date.parse('2026-10-10T16:00:00.000Z');
    let now = start + 5_000;
    const controller = createFaultController({
      schedule: {
        faults: [{ id: 'drop-it', type: 'timeout', service: 'delivery', operation: 'handoff' }],
        windowStartMs: start,
        windowEndMs: end,
      },
      reader: {
        async read() {
          return true;
        },
      },
      log: capture(messages, fields),
      wallClock: () => now,
    });
    await controller.pollOnce();
    expect(controller.isActive()).toBe(true);

    now = end;
    await controller.pollOnce();
    expect(controller.isActive()).toBe(false);
    expect(messages).toContain('fault window end');
    const endIndex = messages.lastIndexOf('fault window end');
    expect(fields[endIndex]?.at).toBe('2026-10-10T16:00:00.000Z');

    const finished = await captureSpan(async (span) => {
      await controller.apply({ service: 'delivery', operation: 'handoff' }, span);
    });
    expect(finished.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
  });

  it('reads a file kill switch and a module kill switch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fault-switch-'));
    const path = join(directory, 'switch');
    await writeFile(path, 'on\n');
    const fileReader = createFileFaultSwitch(path);
    await expect(fileReader.read()).resolves.toBe(true);
    await writeFile(path, 'off\n');
    await expect(fileReader.read()).resolves.toBe(false);

    const reader = await createFaultSwitchReader({
      FAULT_SWITCH_SOURCE: 'module',
      FAULT_SWITCH_MODULE: pathToFileURL(
        join(dirname(fileURLToPath(import.meta.url)), 'support', 'switch-module.ts'),
      ).href,
    });
    await expect(reader.read()).resolves.toBe(true);
    await expect(createFaultSwitchReader({ FAULT_SWITCH_SOURCE: 'ssm' })).rejects.toThrow(
      /application code/,
    );
  });
});

describe('applyMatchedFault', () => {
  it('delays without marking the span failed, and a timeout marks it failed', async () => {
    const delayed = await captureSpan(async (span) => {
      const started = Date.now();
      await applyMatchedFault(
        [{ id: 'slow', type: 'delay', service: 'payment', operation: 'charge', delayMs: 20 }],
        { service: 'payment', operation: 'charge' },
        span,
        () => 0,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    });
    expect(delayed.attributes[FAULT_INJECTED_ATTRIBUTE]).toBe(true);
    expect(delayed.status.code).toBe(SpanStatusCode.UNSET);

    const timedOut = await captureSpan(async (span) => {
      await expect(
        applyMatchedFault(
          [{ id: 'hung', type: 'timeout', service: 'payment', operation: 'charge' }],
          { service: 'payment', operation: 'charge' },
          span,
          () => 0,
        ),
      ).rejects.toBeInstanceOf(FaultInjectedError);
    });
    expect(timedOut.status.code).toBe(SpanStatusCode.ERROR);
    expect(timedOut.attributes[FAULT_TYPE_ATTRIBUTE]).toEqual(['timeout']);
  });
});

function capture(messages: string[], fields: Record<string, unknown>[]): FaultControlLog {
  return {
    info(message, extra) {
      messages.push(message);
      if (extra) {
        fields.push(extra);
      }
    },
    warn(message, extra) {
      messages.push(message);
      if (extra) {
        fields.push(extra);
      }
    },
  };
}

async function captureSpan(run: (span: Span) => Promise<void>) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const span = provider.getTracer('faults').startSpan('operation');
  try {
    await run(span);
  } finally {
    span.end();
  }
  const finished = exporter.getFinishedSpans()[0];
  if (!finished) {
    throw new Error('span was not exported');
  }
  return finished;
}
