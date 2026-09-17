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
