import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFaultController } from '../src/fault-control.js';
import { inRootSpan } from '../src/trace-helpers.js';

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

describe('fault switch tracing', () => {
  it('traces only the startup read and logs once per change, in a span', async () => {
    let value = false;
    const lines: { message: string; traced: boolean }[] = [];
    const record = (message: string) =>
      lines.push({ message, traced: trace.getActiveSpan() !== undefined });
    const controller = createFaultController({
      schedule: { faults: [] },
      reader: { read: async () => value },
      log: { info: record, warn: record },
    });
    await inRootSpan('test', 'startup', () => controller.pollOnce());
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      'fault-switch read',
      'startup',
    ]);

    exporter.reset();
    await controller.pollOnce();
    await controller.pollOnce();
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    value = true;
    await controller.pollOnce();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['fault-switch change']);
    expect(lines.map((l) => l.message)).toEqual(['fault switch read', 'fault switch changed']);
    expect(lines.every((l) => l.traced)).toBe(true);
  });
});
