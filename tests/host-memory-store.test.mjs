// tests/host-memory-store.test.mjs
// Backends are added here as they're implemented in later tasks.
// For now, this file exists to hold the contract-test wiring.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryStoreContract } from './helpers/memory-store-contract.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

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
