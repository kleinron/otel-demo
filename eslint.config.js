import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const cloudSdkRestriction = {
  patterns: [
    {
      group: [
        '@aws-sdk/*',
        'aws-sdk',
        'aws-sdk/*',
        '@opentelemetry/exporter-trace-otlp-grpc',
        '@opentelemetry/exporter-metrics-otlp-grpc',
        '@opentelemetry/exporter-zipkin',
        '@opentelemetry/exporter-prometheus',
        '@opentelemetry/propagator-b3',
        '@opentelemetry/propagator-jaeger',
      ],
      message:
        'Application code stays provider-neutral and exports OTLP over HTTP. Cloud-specific code belongs under infra/<provider>.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/cdk.out/**',
      'package-lock.json',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/**/*.ts', 'services/**/*.ts', 'loadgen/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', cloudSdkRestriction],
    },
  },
);
