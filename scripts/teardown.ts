import { teardownMain } from '../infra/aws/src/cli.js';

const code = await teardownMain(process.argv.slice(2), process.env);
process.exit(code);
