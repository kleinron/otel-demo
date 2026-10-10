'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { spawn } = require('node:child_process');

async function main() {
  const name = process.env.OTEL_DEMO_FAULTS_PARAMETER;
  if (!name) {
    throw new Error('OTEL_DEMO_FAULTS_PARAMETER is not set');
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const client = new SSMClient({ region });
  const result = await client.send(new GetParameterCommand({ Name: name }));
  const value = String(result.Parameter && result.Parameter.Value ? result.Parameter.Value : 'off')
    .trim()
    .toLowerCase();
  const enabled = value === 'true' || value === '1' || value === 'on';
  process.env.OTEL_DEMO_FAULTS_ENABLED = enabled ? 'true' : 'off';
  const command = process.argv[2];
  if (!command) {
    throw new Error('fault switch needs a command');
  }
  const child = spawn(command, process.argv.slice(3), { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'fault switch failed'}\n`);
  process.exit(1);
});
