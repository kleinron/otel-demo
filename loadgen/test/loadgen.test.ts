import { describe, expect, it } from 'vitest';
import { describeLoadgen, LOADGEN_STATUS } from '../src/index.js';

describe('loadgen', () => {
  it('is a placeholder', () => {
    expect(LOADGEN_STATUS).toBe('placeholder');
    expect(describeLoadgen()).toMatch(/placeholder/);
  });
});
