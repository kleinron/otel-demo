import { rehearsalMain } from '../infra/aws/src/cli.js';

const code = await rehearsalMain(process.argv.slice(2), process.env);
process.exit(code);
