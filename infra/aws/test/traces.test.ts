import { describe, expect, it } from 'vitest';
import { shapeTrace } from '../src/traces.js';

function segment(name: string): { Document: string } {
  return { Document: JSON.stringify({ name, annotations: { 'service.name': name } }) };
}

describe('checkout traces', () => {
  it('records a missing hop instead of treating a partial checkout as complete', () => {
    const shaped = shapeTrace('trace-1', [
      segment('shop'),
      segment('inventory'),
      segment('payment'),
    ]);
    expect(shaped.hops).toEqual(['shop', 'inventory', 'payment']);
    expect(shaped.missingHops).toEqual(['delivery']);
  });

  it('keeps a checkout that visited every service', () => {
    const shaped = shapeTrace('trace-2', [
      segment('shop'),
      segment('inventory'),
      segment('payment'),
      segment('delivery'),
    ]);
    expect(shaped.missingHops).toEqual([]);
    expect(shaped.hops).toEqual(['shop', 'inventory', 'payment', 'delivery']);
  });
});
