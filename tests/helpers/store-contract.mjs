// tests/helpers/store-contract.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, progressEvent } from '../../host/jobs/record.mjs';

export function runStoreContract(name, makeStore) {
  const T0 = new Date('2026-09-17T10:00:00.000Z');
  const T1 = new Date('2026-09-17T10:00:01.000Z');

  test(`${name}: insert then get round-trips a record`, async () => {
    const store = await makeStore(); await store.open();
    try {
      const r = createRecord({ goal: 'g' }, { id: 'job-a', now: T0 });
      await store.insert(r);
      assert.deepEqual(await store.get('job-a'), r);
      assert.equal(await store.get('nope'), null);
    } finally { await store.close(); }
  });

  test(`${name}: insert rejects duplicate id`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      await assert.rejects(() => store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 })), /exists/);
    } finally { await store.close(); }
  });

  test(`${name}: update merges and returns the record`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      const out = await store.update('job-a', { status: 'processing', startedAt: T1.toISOString() });
      assert.equal(out.status, 'processing');
      assert.equal((await store.get('job-a')).startedAt, T1.toISOString());
      await assert.rejects(() => store.update('nope', {}), /not found/);
    } finally { await store.close(); }
  });

  test(`${name}: claim is atomic and only succeeds once`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      assert.equal(await store.claim('job-a', T1.toISOString()), true);
      assert.equal(await store.claim('job-a', T1.toISOString()), false);
      const r = await store.get('job-a');
      assert.equal(r.status, 'processing');
      assert.equal(r.startedAt, T1.toISOString());
    } finally { await store.close(); }
  });

  test(`${name}: listByStatus orders by submittedAt`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'b' }, { id: 'job-b', now: T1 }));
      await store.insert(createRecord({ goal: 'a' }, { id: 'job-a', now: T0 }));
      await store.insert({ ...createRecord({ goal: 'c' }, { id: 'job-c', now: T0 }), status: 'completed' });
      assert.deepEqual((await store.listByStatus('queued')).map(r => r.id), ['job-a', 'job-b']);
      assert.deepEqual(await store.countByStatus(), { queued: 2, completed: 1 });
    } finally { await store.close(); }
  });

  test(`${name}: events append with per-job seq and replay after seq`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-b', now: T0 }));
      assert.equal(await store.appendEvent('job-a', progressEvent('job-a', 1, 'one', T0)), 1);
      assert.equal(await store.appendEvent('job-a', progressEvent('job-a', 2, 'two', T0)), 2);
      assert.equal(await store.appendEvent('job-b', progressEvent('job-b', 1, 'b1', T0)), 1);
      const all = await store.events('job-a');
      assert.deepEqual(all.map(e => [e.seq, e.message]), [[1, 'one'], [2, 'two']]);
      const after = await store.events('job-a', { afterSeq: 1 });
      assert.deepEqual(after.map(e => e.seq), [2]);
    } finally { await store.close(); }
  });

  test(`${name}: purgeFinishedBefore removes old terminal records and their events`, async () => {
    const store = await makeStore(); await store.open();
    try {
      const old = { ...createRecord({ goal: 'g' }, { id: 'job-old', now: T0 }), status: 'completed', finishedAt: T0.toISOString() };
      const fresh = { ...createRecord({ goal: 'g' }, { id: 'job-new', now: T0 }), status: 'completed', finishedAt: T1.toISOString() };
      const running = { ...createRecord({ goal: 'g' }, { id: 'job-run', now: T0 }), status: 'processing' };
      for (const r of [old, fresh, running]) await store.insert(r);
      await store.appendEvent('job-old', progressEvent('job-old', 1, 'x', T0));
      const n = await store.purgeFinishedBefore(new Date('2026-09-17T10:00:00.500Z').toISOString());
      assert.equal(n, 1);
      assert.equal(await store.get('job-old'), null);
      assert.deepEqual(await store.events('job-old'), []);
      assert.ok(await store.get('job-new'));
      assert.ok(await store.get('job-run'));
    } finally { await store.close(); }
  });
}
