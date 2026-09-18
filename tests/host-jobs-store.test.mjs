// tests/host-jobs-store.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStoreContract } from './helpers/store-contract.mjs';
import { createRecord } from '../host/jobs/record.mjs';

const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
runStoreContract('memory', async () => createMemoryStore());

const { createSqliteStore } = await import('../host/jobs/store/sqlite.mjs');
runStoreContract('sqlite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-sqlite-'));
  return createSqliteStore({ dbPath: path.join(dir, 'jobs.db') });
});

test('sqlite: records survive close and reopen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-sqlite-'));
  const dbPath = path.join(dir, 'jobs.db');
  const a = createSqliteStore({ dbPath }); await a.open();
  await a.insert(createRecord({ goal: 'persist' }, { id: 'job-p' }));
  await a.appendEvent('job-p', { type: 'started', jobId: 'job-p', at: new Date().toISOString() });
  await a.close();
  const b = createSqliteStore({ dbPath }); await b.open();
  try {
    assert.equal((await b.get('job-p')).task.goal, 'persist');
    assert.equal((await b.events('job-p')).length, 1);
  } finally { await b.close(); }
});

async function fdsFor(filePath) {
  try {
    const real = await fs.realpath(filePath);
    const names = await fs.readdir('/proc/self/fd');
    const hits = [];
    for (const n of names) {
      try {
        if (await fs.readlink(path.join('/proc/self/fd', n)) === real) hits.push(n);
      } catch { /* stale fd */ }
    }
    return hits;
  } catch {
    return [];
  }
}

test('sqlite: open closes the handle if schema or prepare fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-sqlite-bad-'));
  const dbPath = path.join(dir, 'jobs.db');
  await fs.writeFile(dbPath, 'not a sqlite database');
  const store = createSqliteStore({ dbPath });
  await assert.rejects(() => store.open(), /not a database/i);
  await assert.rejects(() => store.open(), /not a database/i);
  await assert.rejects(() => store.get('job-x'), /not open/i);
  assert.equal((await fdsFor(dbPath)).length, 0, 'sqlite handle must not leak after a failed open');
});
