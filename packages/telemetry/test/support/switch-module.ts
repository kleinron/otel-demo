import type { FaultSwitchReader } from '../../src/fault-control.js';

export function createFaultSwitch(): FaultSwitchReader {
  return {
    async read() {
      return true;
    },
  };
}
