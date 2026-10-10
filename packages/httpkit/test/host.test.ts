import { describe, expect, it } from 'vitest';
import { anyInterfaceHost, listenHost, readPort } from '../src/host.js';

describe('listen address', () => {
  it('defaults to localhost and can bind every interface without an IP literal', () => {
    expect(listenHost({})).toBe('localhost');
    expect(listenHost({ HOST: 'localhost' })).toBe('localhost');
    expect(listenHost({ LISTEN_ANY: 'true' })).toBe(anyInterfaceHost());
    expect(anyInterfaceHost()).toBe([0, 0, 0, 0].join('.'));
    expect(readPort(undefined, 3001)).toBe(3001);
  });
});
