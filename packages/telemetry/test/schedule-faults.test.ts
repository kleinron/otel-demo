import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { fileURLToPath } from 'node:url';
import { createSql, DbTimeoutError, type QueryExecutor, type SqlRows } from '@otel-demo/db';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlan,
  databaseFaultHook,
  FAULT_INJECTED_ATTRIBUTE,
  parseLoadSchedule,
  createWindowedFaultController,
  startServiceFaultControl,
  type FaultControlLog,
} from '../src/index.js';

const plan = buildPlan(
  parseLoadSchedule({
    seed: 7,
    curve: {
      zone: 'Asia/Jerusalem',
      peakLocalHour: 16,
      amplitude: 0.5,
      cartActivitiesPerDay: 1000,
      checkoutsPerDay: 100,
      browsePerDay: 1000,
      orderStatusPerDay: 100,
    },
    experiment: { start: '2026-10-12T08:30:00.000Z', zone: 'UTC', durationHours: 48 },
    warmup: { minutes: 5, zone: 'UTC' },
    caps: { maxArrivalsPerSecond: 50, maxDurationHours: 72, zone: 'UTC' },
    saturation: { spike: 'checkout-delay', dayOffset: 1, zone: 'UTC' },
    paymentTimeoutMs: 2000,
    customers: { count: 1000 },
    skus: ['phone-aurora'],
    outOfStock: { sku: 'powerbank-dead-sea', qty: 2, fraction: 0.1 },
    spikes: [
      {
        name: 'add-to-cart-delay',
        at: '10:00',
        zone: 'UTC',
        durationMinutes: 20,
        multiplier: 2,
        fault: {
          service: 'shop',
          operation: 'add-to-cart',
          type: 'error',
          sizeMs: 1,
          startOffsetMinutes: 2,
          durationMinutes: 15,
          zone: 'UTC',
        },
      },
      {
        name: 'checkout-delay',
        at: '12:00',
        zone: 'UTC',
        durationMinutes: 20,
        multiplier: 2,
        saturationMultiplier: 4,
        fault: {
          service: 'shop',
          operation: 'checkout',
          type: 'delay',
          sizeMs: 1,
          startOffsetMinutes: 2,
          durationMinutes: 20,
          zone: 'UTC',
        },
      },
      {
        name: 'inventory-db-timeout',
        at: '14:00',
        zone: 'UTC',
        durationMinutes: 20,
        multiplier: 2,
        fault: {
          service: 'inventory',
          operation: 'database',
          type: 'timeout',
          sizeMs: 1,
          startOffsetMinutes: 2,
          durationMinutes: 15,
          zone: 'UTC',
        },
      },
    ],
  }),
);

const CHECKED_IN_SCHEDULE = fileURLToPath(
  new URL('../../../loadgen/schedule.json', import.meta.url),
);

describe('schedule fault windows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a service on the checked-in schedule and ignores other services', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-12T14:05:00.000Z'));
    const messages: string[] = [];
    const fields: Record<string, unknown>[] = [];
    const env = {
      OTEL_DEMO_LOAD_SCHEDULE_FILE: CHECKED_IN_SCHEDULE,
      LOADGEN_START_UTC: '2026-10-12T08:30:00.000Z',
      OTEL_DEMO_FAULTS_ENABLED: 'on',
      OTEL_DEMO_FAULTS: JSON.stringify([
        { id: 'decoy', type: 'error', service: 'shop', operation: 'checkout' },
      ]),
    };
    const inventory = await startServiceFaultControl('inventory', env, capture(messages, fields));
    expect(inventory.isActive()).toBe(true);
    expect(messages).toContain('fault schedule loaded');
    expect(fields.at(-1)).toMatchObject({
      service: 'inventory',
      schedule: CHECKED_IN_SCHEDULE,
      operations: ['database'],
    });
    inventory.stop();

    const shop = await startServiceFaultControl('shop', env, capture(messages, fields));
    expect(shop.isActive()).toBe(false);
    expect(fields.at(-1)).toMatchObject({
      service: 'shop',
      operations: ['add-to-cart', 'checkout'],
    });
    shop.stop();
  });

  it('stays inactive while the kill switch is off', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-12T12:05:00.000Z'));
    const controller = await startServiceFaultControl('shop', {
      OTEL_DEMO_LOAD_SCHEDULE_FILE: CHECKED_IN_SCHEDULE,
      LOADGEN_START_UTC: '2026-10-12T08:30:00.000Z',
      OTEL_DEMO_FAULTS_ENABLED: 'off',
    });
    expect(controller.isActive()).toBe(false);
    const provider = tracer();
    const span = provider.span();
    await controller.apply({ service: 'shop', operation: 'checkout' }, span);
    span.end();
    expect(provider.finished()[0]?.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
    controller.stop();
  });

  it('fails startup when the schedule file cannot be read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'missing-schedule-'));
    const missing = join(directory, 'schedule.json');
    await expect(
      startServiceFaultControl('shop', {
        OTEL_DEMO_LOAD_SCHEDULE_FILE: missing,
        OTEL_DEMO_FAULTS_ENABLED: 'on',
      }),
    ).rejects.toThrow(`fault schedule ${missing} is unreadable`);
    await writeFile(missing, '{', 'utf8');
    await expect(
      startServiceFaultControl('payment', { OTEL_DEMO_LOAD_SCHEDULE_FILE: missing }),
    ).rejects.toThrow(`fault schedule ${missing} is unreadable`);
  });

  it('applies a fault only inside its window and only while the kill switch is on', async () => {
    let enabled = false;
    const now = Date.parse('2026-10-12T12:05:00.000Z');
    const messages: string[] = [];
    const controller = createWindowedFaultController({
      plan,
      reader: {
        async read() {
          return enabled;
        },
      },
      log: capture(messages),
      wallClock: () => now,
    });

    await controller.pollOnce();
    expect(controller.isActive()).toBe(false);
    expect(messages).not.toContain('fault window start');
    const provider = tracer();
    const idle = provider.span();
    await controller.apply({ service: 'shop', operation: 'checkout' }, idle);
    idle.end();
    expect(provider.finished()[0]?.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();

    enabled = true;
    await controller.pollOnce();
    expect(controller.isActive()).toBe(true);
    expect(messages).toContain('fault window start');
    const live = provider.span();
    await controller.apply({ service: 'shop', operation: 'checkout' }, live);
    live.end();
    expect(provider.finished()[1]?.attributes[FAULT_INJECTED_ATTRIBUTE]).toBe(true);

    enabled = false;
    await controller.pollOnce();
    expect(messages).toContain('faults off by operator');
    expect(controller.isActive()).toBe(false);
  });

  it('does not replay a fault start when the process joins inside the window', async () => {
    const messages: string[] = [];
    const fields: Record<string, unknown>[] = [];
    let now = Date.parse('2026-10-12T12:10:00.000Z');
    const controller = createWindowedFaultController({
      plan,
      reader: {
        async read() {
          return true;
        },
      },
      log: capture(messages, fields),
      wallClock: () => now,
    });
    await controller.pollOnce();
    expect(messages).not.toContain('fault window start');
    expect(controller.isActive()).toBe(true);

    now = Date.parse('2026-10-12T12:22:00.000Z');
    await controller.pollOnce();
    expect(messages).toEqual(['fault window end']);
    expect(fields[0]).toMatchObject({ at: '2026-10-12T12:22:00.000Z', operation: 'checkout' });
  });

  it('turns an inventory database fault into a SQL timeout', async () => {
    let now = Date.parse('2026-10-12T14:05:00.000Z');
    const controller = createWindowedFaultController({
      plan,
      reader: {
        async read() {
          return true;
        },
      },
      wallClock: () => now,
    });
    await controller.pollOnce();
    const events: string[] = [];
    let queries = 0;
    const sql = createSql(
      fakeExecutor(() => {
        queries += 1;
      }),
      {
        beforeQuery: databaseFaultHook(controller, 'inventory'),
        onCall(event) {
          events.push(event.outcome);
        },
      },
    );
    await expect(sql.query('SELECT 1', [], 'stock.read')).rejects.toBeInstanceOf(DbTimeoutError);
    expect(queries).toBe(0);
    expect(events).toEqual(['timeout']);

    now = Date.parse('2026-10-12T14:20:00.000Z');
    await controller.pollOnce();
    await expect(sql.query('SELECT 1', [], 'stock.read')).resolves.toEqual({ rows: [] });
    expect(queries).toBe(1);
  });
});

function capture(messages: string[], fields: Record<string, unknown>[] = []): FaultControlLog {
  return {
    info(message, extra) {
      messages.push(message);
      fields.push(extra ?? {});
    },
    warn(message, extra) {
      messages.push(message);
      fields.push(extra ?? {});
    },
  };
}

function tracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {
    span() {
      return provider.getTracer('test').startSpan('call');
    },
    finished() {
      return exporter.getFinishedSpans();
    },
  };
}

function fakeExecutor(onQuery: () => void): QueryExecutor {
  return {
    async query<T extends Record<string, unknown>>(): Promise<SqlRows<T>> {
      onQuery();
      return { rows: [] as T[] };
    },
    async transaction(fn) {
      return fn(this);
    },
    async close() {},
  };
}
