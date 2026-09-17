// tests/host-jobs-store.test.mjs
import { runStoreContract } from './helpers/store-contract.mjs';

const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
runStoreContract('memory', async () => createMemoryStore());
