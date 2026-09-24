import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunState } from '../host/memory/run-state.mjs';
import { createFilesystemStore } from '../host/memory/store/filesystem.mjs';

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-rs-'));
  const store = createFilesystemStore({ dir });
  await store.open();
  return store;
}

test('save and load checkpoint', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  await rs.save('task-1', { stepIndex: 3, plan: { steps: ['a', 'b', 'c'] }, idempotencyKeys: ['k1'] });
  const loaded = await rs.load('task-1');
  assert.equal(loaded.stepIndex, 3);
  assert.deepEqual(loaded.idempotencyKeys, ['k1']);
  await store.close();
});

test('load returns null when no checkpoint', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  assert.equal(await rs.load('nonexistent'), null);
  await store.close();
});

test('clear removes checkpoint', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  await rs.save('task-2', { stepIndex: 1 });
  await rs.clear('task-2');
  assert.equal(await rs.load('task-2'), null);
  await store.close();
});

test('save failure logs warning and continues', async () => {
  const warnings = [];
  const failStore = {
    get: async () => null,
    store: async () => { throw new Error('disk full'); },
    update: async () => { throw new Error('disk full'); },
  };
  const rs = createRunState({ store: failStore, logger: { warn: (m) => warnings.push(m), error: () => {} } });
  await rs.save('task-3', { stepIndex: 1 });
  assert.ok(warnings.length > 0);
});

test('idempotency key tracking', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  await rs.save('task-4', { stepIndex: 2, idempotencyKeys: ['k1'] });
  assert.ok(await rs.hasIdempotencyKey('task-4', 'k1'));
  assert.ok(!(await rs.hasIdempotencyKey('task-4', 'k2')));
  await rs.addIdempotencyKey('task-4', 'k2');
  assert.ok(await rs.hasIdempotencyKey('task-4', 'k2'));
  await store.close();
});
