import { describe, expect, it } from 'vitest';
import {
  checkCartId,
  checkCollector,
  checkLogs,
  checkNoOrphans,
  checkRequestRoots,
  checkSpanNames,
  checkSpanTree,
  checkSql,
  hexSpanId,
  type Trace,
} from './checks.js';

const CART = '0162f9ee-c52b-458b-8686-9ca884a222b2';
const base = { 'service.name': 'shop', 'cart.id': CART };

function cartTrace(extra: Trace['spans'] = []): Trace {
  return {
    traceId: 't1',
    spans: [
      {
        spanId: '0',
        name: 'cart open-cart',
        kind: 'RPC_CLIENT',
        labels: { 'service.name': 'loadgen', 'cart.id': CART, 'cart.step': 'open-cart' },
      },
      {
        spanId: '1',
        parentSpanId: '0',
        name: 'POST /carts',
        kind: 'RPC_SERVER',
        labels: { ...base, 'http.route': '/carts', 'http.response.status_code': '201' },
      },
      {
        spanId: '2',
        parentSpanId: '1',
        name: 'INSERT cart.write',
        kind: 'RPC_CLIENT',
        labels: {
          ...base,
          'db.system.name': 'postgresql',
          'db.query.text': 'INSERT INTO carts VALUES ($1)',
        },
      },
      {
        spanId: '3',
        parentSpanId: '2',
        name: 'db pool connect',
        kind: 'RPC_CLIENT',
        labels: { ...base, 'db.system.name': 'postgresql' },
      },
      ...extra,
    ],
  };
}

describe('verify-traces checks', () => {
  it('passes a complete loadgen-rooted open-cart trace with zero orphans', () => {
    const trace = cartTrace();
    expect(checkSpanTree([trace]).pass).toBe(true);
    expect(checkNoOrphans([trace]).pass).toBe(true);
    expect(checkCartId([trace]).pass).toBe(true);
    expect(checkSpanNames([trace]).pass).toBe(true);
    const roots = checkRequestRoots([trace]);
    expect(roots.failures.filter((f) => !f.startsWith('no "cart'))).toEqual([]);
  });

  it('rejects a shop span whose parent is the Cloud Run front end', () => {
    const trace = cartTrace();
    trace.spans = trace.spans.filter((s) => s.spanId !== '0');
    expect(checkNoOrphans([trace]).pass).toBe(false);
    expect(checkRequestRoots([trace]).pass).toBe(false);
  });

  it('flags an orphan, a missing cart.id, a raw path, and a literal in SQL', () => {
    const trace = cartTrace([
      {
        spanId: '4',
        parentSpanId: '77',
        name: 'GET /skus/abc-1',
        kind: 'RPC_SERVER',
        labels: { 'service.name': 'inventory' },
      },
      {
        spanId: '5',
        parentSpanId: '1',
        name: 'SELECT x',
        labels: {
          ...base,
          'db.system.name': 'postgresql',
          'db.query.text': "SELECT 1 WHERE a = 'bob'",
        },
      },
    ]);
    expect(checkNoOrphans([trace]).pass).toBe(false);
    expect(checkCartId([trace]).pass).toBe(false);
    expect(checkSql([trace]).pass).toBe(false);
    expect(checkSpanTree([trace]).pass).toBe(false);
  });

  it('requires trace and span ids on log lines', () => {
    expect(checkLogs([{ jsonPayload: { message: 'listening' } }]).pass).toBe(false);
    expect(
      checkLogs([{ trace: `projects/p/traces/${'a'.repeat(32)}`, spanId: 'b'.repeat(16) }]).pass,
    ).toBe(true);
  });

  it('converts decimal span ids', () => {
    expect(hexSpanId('255')).toBe('00000000000000ff');
  });
});

describe('checkCollector', () => {
  const line = (ts: string, sendFailedSpans: number, instanceId = 'i1') => ({
    timestamp: ts,
    labels: { instanceId },
    jsonPayload: { collector: { sendFailedSpans, droppedSpans: 0 } },
  });
  const start = Date.parse('2026-10-13T12:00:00Z');

  it('passes when a non-zero lifetime counter does not increase', () => {
    const r = checkCollector(
      [line('2026-10-13T11:59:30Z', 69), line('2026-10-13T12:05:00Z', 69)],
      start,
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('sendFailedSpans start=69 end=69 increase=0');
  });

  it('fails when the counter increases in the window', () => {
    const r = checkCollector(
      [line('2026-10-13T11:59:30Z', 69), line('2026-10-13T12:05:00Z', 72)],
      start,
    );
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toContain('start=69 end=72 increase=3');
  });

  it('treats a counter reset as a restart and counts the end value', () => {
    const r = checkCollector(
      [line('2026-10-13T11:59:30Z', 69), line('2026-10-13T12:05:00Z', 2)],
      start,
    );
    expect(r.pass).toBe(false);
  });

  it('fails without any self-metrics line', () => {
    expect(checkCollector([], start).pass).toBe(false);
  });
});
