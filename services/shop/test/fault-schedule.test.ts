import { createServer } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { FAULT_ID_ATTRIBUTE, FAULT_INJECTED_ATTRIBUTE } from '@otel-demo/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startShop } from '../src/index.js';

const SCHEDULE = fileURLToPath(new URL('../../../loadgen/schedule.json', import.meta.url));
const CHECKOUT_OPEN = '2026-10-12T12:05:00.000Z';

describe('shop entrypoint fault schedule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the windowed controller from loadgen/schedule.json for shop operations', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(CHECKOUT_OPEN));
    const handle = await boot('on');
    try {
      expect(handle.faults.isActive()).toBe(true);
      const checkout = span();
      const started = performance.now();
      await handle.faults.apply({ service: 'shop', operation: 'checkout' }, checkout);
      expect(performance.now() - started).toBeGreaterThanOrEqual(2_900);
      expect(checkout.attributes[FAULT_INJECTED_ATTRIBUTE]).toBe(true);
      expect(checkout.attributes[FAULT_ID_ATTRIBUTE]).toEqual([
        expect.stringMatching(/^checkout-delay:/),
      ]);

      const inventory = span();
      await handle.faults.apply({ service: 'inventory', operation: 'database' }, inventory);
      expect(inventory.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();

      const cart = span();
      await handle.faults.apply({ service: 'shop', operation: 'add-to-cart' }, cart);
      expect(cart.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
    } finally {
      await handle.close();
    }
  }, 20_000);

  it('does not inject the schedule while the kill switch is off', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(CHECKOUT_OPEN));
    const handle = await boot('off');
    try {
      expect(handle.faults.isActive()).toBe(false);
      const checkout = span();
      const started = performance.now();
      await handle.faults.apply({ service: 'shop', operation: 'checkout' }, checkout);
      expect(performance.now() - started).toBeLessThan(500);
      expect(checkout.attributes[FAULT_INJECTED_ATTRIBUTE]).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});

async function boot(switchValue: 'on' | 'off') {
  const directory = await mkdtemp(join(tmpdir(), 'shop-fault-'));
  const switchFile = join(directory, 'switch');
  await writeFile(switchFile, `${switchValue}\n`);
  return startShop(
    {
      PORT: String(await freePort()),
      DATABASE_URL: 'postgres://otel@localhost/shop',
      INVENTORY_URL: 'http://inventory.test',
      PAYMENT_URL: 'http://payment.test',
      DELIVERY_URL: 'http://delivery.test',
      OTEL_SDK_DISABLED: 'true',
      LOG_LEVEL: 'error',
      OTEL_DEMO_LOAD_SCHEDULE_FILE: SCHEDULE,
      LOADGEN_START_UTC: '2026-10-12T08:30:00.000Z',
      FAULT_SWITCH_SOURCE: 'file',
      FAULT_SWITCH_FILE: switchFile,
      OTEL_DEMO_FAULTS: JSON.stringify([
        { id: 'decoy', type: 'error', service: 'shop', operation: 'checkout' },
      ]),
    },
    {
      connect: async (_url, options) => createTestSql(options),
    },
  );
}

function span() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return provider.getTracer('shop-fault-test').startSpan('call');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, 'localhost', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('port missing'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    server.on('error', reject);
  });
}
