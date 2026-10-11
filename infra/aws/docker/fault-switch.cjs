'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_PARAMETER = '/otel-demo/faults-enabled';

// ECS injects DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD (the password comes from
// Secrets Manager). The services read one DATABASE_URL, so build it here, in memory only.
// RDS PostgreSQL 16 requires TLS. The CA bundle is not in the image, so skip verification.
function buildDatabaseUrl(env) {
  if (env.DATABASE_URL || !env.DB_HOST) {
    return;
  }
  const user = encodeURIComponent(env.DB_USER || '');
  const password = encodeURIComponent(env.DB_PASSWORD || '');
  const port = env.DB_PORT || '5432';
  env.DATABASE_URL = `postgres://${user}:${password}@${env.DB_HOST}:${port}/${env.DB_NAME}?sslmode=no-verify`;
}

function parameterName(env) {
  const named = (env.FAULT_SWITCH_SSM_PARAMETER || env.OTEL_DEMO_FAULTS_PARAMETER || '').trim();
  return named || DEFAULT_PARAMETER;
}

/**
 * Polled by the service when FAULT_SWITCH_SOURCE=module. A one-shot read in this
 * process would freeze the kill switch at task start, so the service calls read()
 * on its own interval. `client` is optional and exists for tests.
 */
function createFaultSwitch(env, client) {
  const source = env || process.env;
  const name = parameterName(source);
  let cached = client;
  return {
    async read() {
      const sender = cached || (cached = createClient(source));
      const response = await sender.send(getParameter(name));
      const value = response && response.Parameter ? response.Parameter.Value : undefined;
      if (value === undefined || String(value).trim() === '') {
        throw new Error('ssm parameter has no value');
      }
      return parseSwitch(String(value));
    },
  };
}

function getParameter(name) {
  const { GetParameterCommand } = require('@aws-sdk/client-ssm');
  return new GetParameterCommand({ Name: name });
}

function createClient(env) {
  const { SSMClient } = require('@aws-sdk/client-ssm');
  const region = (env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim();
  if (!region) {
    throw new Error('AWS region is not set');
  }
  return new SSMClient({ region });
}

function parseSwitch(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'off') {
    return false;
  }
  throw new Error('fault switch value is unreadable');
}

async function main() {
  buildDatabaseUrl(process.env);
  // Env-switch fallback for a task that has not set FAULT_SWITCH_SOURCE=module.
  // A module task polls SSM itself, so a later change to the parameter is seen.
  try {
    const enabled = await createFaultSwitch(process.env).read();
    process.env.OTEL_DEMO_FAULTS_ENABLED = enabled ? 'true' : 'off';
  } catch (error) {
    process.stderr.write(
      `fault switch startup read failed: ${error instanceof Error ? error.message : 'unreadable'}\n`,
    );
  }
  const command = process.argv[2];
  if (!command) {
    throw new Error('fault switch needs a command');
  }
  const child = spawn(command, process.argv.slice(3), { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'fault switch failed'}\n`);
    process.exit(1);
  });
}

module.exports = { buildDatabaseUrl, createFaultSwitch };
