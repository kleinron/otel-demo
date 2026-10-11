import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@otel-demo/telemetry': fileURLToPath(
        new URL('./packages/telemetry/src/index.ts', import.meta.url),
      ),
      '@otel-demo/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@otel-demo/httpkit': fileURLToPath(
        new URL('./packages/httpkit/src/index.ts', import.meta.url),
      ),
      '@otel-demo/infra-aws/fault-switch': fileURLToPath(
        new URL('./infra/aws/src/fault-switch.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'services/**/test/**/*.test.ts',
      'loadgen/test/**/*.test.ts',
      'infra/**/test/**/*.test.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
