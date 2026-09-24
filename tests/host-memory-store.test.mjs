// tests/host-memory-store.test.mjs
// Backends are added here as they're implemented in later tasks.
// For now, this file exists to hold the contract-test wiring.

import fs from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryStoreContract } from './helpers/memory-store-contract.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

// Redirect @azure/cosmos before the cosmos store opens. See mock-azure-cosmos-hooks.mjs.
await register(new URL('./helpers/mock-azure-cosmos-hooks.mjs', import.meta.url), import.meta.url);

const { createFilesystemStore } = await import('../host/memory/store/filesystem.mjs');
runMemoryStoreContract('filesystem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-fs-'));
  return createFilesystemStore({ dir });
});

const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
runMemoryStoreContract('sqlite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-sqlite-'));
  return createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
});

const { createCosmosStore } = await import('../host/memory/store/cosmos.mjs');
runMemoryStoreContract('cosmos', async () => {
  return createCosmosStore({
    endpoint: 'https://mock.documents.azure.com',
    key: 'mock-key',
    database: 'memory',
    container: 'entries',
  });
});

test('sqlite: entries survive close and reopen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-sqlite-persist-'));
  const dbPath = path.join(dir, 'memory.db');
  const a = createSqliteStore({ dbPath }); await a.open();
  await a.store(createMemoryEntry({ kind: 'rule', text: 'Persist me', tags: ['test'] }));
  await a.close();
  const b = createSqliteStore({ dbPath }); await b.open();
  try {
    const results = await b.query({ kinds: ['rule'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].text, 'Persist me');
  } finally { await b.close(); }
});
