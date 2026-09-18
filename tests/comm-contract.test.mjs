import { runCommContract } from './helpers/comm-contract.mjs';

const { createExpressAdapter } = await import('../comm/express.mjs');
const { createRawHttpAdapter } = await import('../comm/raw-http.mjs');

runCommContract('express', createExpressAdapter);
runCommContract('raw-http', createRawHttpAdapter);
