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
import { createLongTermMemory } from '../host/memory/long-term.mjs';

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

test('filesystem rejects ids that are not a single safe path segment', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-fs-escape-'));
  const dir = path.join(parent, 'mem');
  const store = createFilesystemStore({ dir });
  await store.open();
  const outside = path.join(parent, 'outside.json');
  const entry = createMemoryEntry({ kind: 'domain', text: 'stay inside', tags: ['a'] });
  try {
    await assert.rejects(() => store.store({ ...entry, id: '../outside' }), /unsafe memory id/);
    await assert.rejects(() => store.get('../outside'), /unsafe memory id/);
    await assert.rejects(() => store.get('nested/evil'), /unsafe memory id/);
    await assert.rejects(() => store.get('nested\\evil'), /unsafe memory id/);
    await assert.rejects(() => store.update('../outside', { text: 'nope' }), /unsafe memory id/);
    await assert.rejects(() => store.remove('..'), /unsafe memory id/);
    await store.store(entry);
    await assert.rejects(() => store.update(entry.id, { id: '../outside', text: 'rewritten' }), /unsafe memory id/);
    assert.equal((await store.get(entry.id)).text, 'stay inside');
    await assert.rejects(() => fs.access(outside), { code: 'ENOENT' });
    assert.throws(
      () => createMemoryEntry({ id: '../outside', kind: 'domain', text: 'caller id' }),
      /unsafe memory id/,
    );

    const ltm = createLongTermMemory({
      store,
      decayConfig: { mode: 'manual' },
      dedupConfig: { enabled: false },
      logger: { warn() {} },
    });
    await assert.rejects(() => ltm.store({
      ...entry,
      id: '../outside',
      text: 'posted escape',
    }), /unsafe memory id/);
    await assert.rejects(() => fs.access(outside), { code: 'ENOENT' });
  } finally {
    await store.close();
  }
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
