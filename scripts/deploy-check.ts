import { deployCheckMain } from '../infra/aws/src/cli.js';

const code = await deployCheckMain(process.argv.slice(2), process.env);
process.exit(code);
