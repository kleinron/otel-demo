import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@otel-demo/telemetry': fileURLToPath(
        new URL('./packages/telemetry/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'services/**/test/**/*.test.ts',
      'loadgen/test/**/*.test.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
