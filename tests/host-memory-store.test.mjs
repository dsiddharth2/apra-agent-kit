// tests/host-memory-store.test.mjs
// Backends are added here as they're implemented in later tasks.
// For now, this file exists to hold the contract-test wiring.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMemoryStoreContract } from './helpers/memory-store-contract.mjs';

const { createFilesystemStore } = await import('../host/memory/store/filesystem.mjs');
runMemoryStoreContract('filesystem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-fs-'));
  return createFilesystemStore({ dir });
});
