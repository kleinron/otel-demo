import { describe, expect, it } from 'vitest';
import {
  checkCartId,
  checkLogs,
  checkNoOrphans,
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
        spanId: '1',
        parentSpanId: '99',
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
  it('passes a complete open-cart trace with the Cloud Run front-end gap', () => {
    const trace = cartTrace();
    expect(checkSpanTree([trace]).pass).toBe(true);
    expect(checkNoOrphans([trace]).pass).toBe(true);
    expect(checkCartId([trace]).pass).toBe(true);
    expect(checkSpanNames([trace]).pass).toBe(true);
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
