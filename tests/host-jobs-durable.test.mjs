// tests/host-jobs-durable.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createDurableJobs, mapDurableStatus, ORCHESTRATOR_NAME } = await import('../host/jobs/durable.mjs');
const { JobQueueFullError } = await import('../host/jobs/interface.mjs');

function fakeClient({ instances = {} } = {}) {
  const calls = { startNew: [], raiseEvent: [], terminate: [] };
  return {
    calls, instances,
    async startNew(name, { instanceId, input }) {
      calls.startNew.push({ name, instanceId, input });
      instances[instanceId] = { instanceId, runtimeStatus: 'Pending', input, customStatus: null, output: null, createdTime: '2026-09-17T10:00:00.000Z', lastUpdatedTime: '2026-09-17T10:00:00.000Z' };
      return instanceId;
    },
    async getStatus(id) { return instances[id] ?? null; },
    async raiseEvent(id, name, data) { calls.raiseEvent.push({ id, name, data }); },
    async terminate(id, reason) { calls.terminate.push({ id, reason }); instances[id].runtimeStatus = 'Terminated'; },
    async getStatusBy({ runtimeStatus }) { return Object.values(instances).filter(i => runtimeStatus.includes(i.runtimeStatus)); },
  };
}
const cfg = { maxQueueSize: 2, durable: { taskHub: 'hub', pollMs: 5, maxActivityMs: 1000 }, retentionMs: 1 };
const quiet = { warn() {}, info() {} };

test('submit starts an orchestration with the job id and task input', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  await jobs.start();
  const out = await jobs.submit({ goal: 'g', inputs: { a: 1 } }, { callbackUrl: 'https://cb.test/h' });
  assert.equal(out.status, 'queued');
  assert.match(out.jobId, /^job-/);
  assert.equal(out.position, 1);
  const call = client.calls.startNew[0];
  assert.equal(call.name, ORCHESTRATOR_NAME);
  assert.equal(call.instanceId, out.jobId);
  assert.equal(call.input.task.goal, 'g');
  assert.equal(call.input.task.id, out.jobId);
  assert.equal(call.input.callbackUrl, 'https://cb.test/h');
  assert.equal(call.input.record.status, 'queued');
  assert.equal(call.input.queuedEvent.type, 'queued');
});

test('submit rejects a missing goal and a plain-http callback by default', async () => {
  const jobs = createDurableJobs({ client: fakeClient(), config: cfg, notifier: null, logger: quiet });
  await assert.rejects(() => jobs.submit({ goal: '' }), TypeError);
  await assert.rejects(() => jobs.submit({ goal: 'g' }, { callbackUrl: 'http://cb.test/h' }), /https/);
});

test('submit enforces maxQueueSize over Pending + Running', async () => {
  const client = fakeClient({ instances: { a: { runtimeStatus: 'Pending' }, b: { runtimeStatus: 'Running' } } });
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  await assert.rejects(() => jobs.submit({ goal: 'g' }), JobQueueFullError);
});

test('mapDurableStatus maps runtime statuses and merges customStatus + output', () => {
  const record = { id: 'job-1', status: 'queued', task: { goal: 'g', inputs: {}, constraints: {}, budget: {} }, submittedAt: 't0', startedAt: null, finishedAt: null, attempts: 1, result: null, history: [], budget: null, progress: { iteration: 0, message: null, at: null }, callbackUrl: null, metadata: {}, error: null };
  const base = { instanceId: 'job-1', input: { record }, lastUpdatedTime: 'tL' };
  assert.equal(mapDurableStatus({ ...base, runtimeStatus: 'Pending' }).status, 'queued');
  const running = mapDurableStatus({ ...base, runtimeStatus: 'Running', customStatus: { status: 'processing', startedAt: 't1', progress: { iteration: 3, message: 'm', at: 't2' } } });
  assert.equal(running.status, 'processing');
  assert.equal(running.startedAt, 't1');
  assert.equal(running.progress.iteration, 3);
  const done = mapDurableStatus({ ...base, runtimeStatus: 'Completed', customStatus: { status: 'budget_exceeded', finishedAt: 't3' }, output: { status: 'budget_exceeded', result: { r: 1 }, error: null, history: [1], budget: { iterations: 6 } } });
  assert.equal(done.status, 'budget_exceeded');
  assert.deepEqual(done.result, { r: 1 });
  assert.deepEqual(done.history, [1]);
  assert.equal(done.finishedAt, 't3');
  const failed = mapDurableStatus({ ...base, runtimeStatus: 'Failed', output: 'boom' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'activity_failed');
  assert.equal(failed.finishedAt, 'tL');
  assert.equal(mapDurableStatus({ ...base, runtimeStatus: 'Terminated' }).status, 'cancelled');
  assert.equal(mapDurableStatus(null), null);
});

test('get returns the mapped record or null', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  assert.equal((await jobs.get(jobId)).status, 'queued');
  assert.equal((await jobs.get(jobId)).task.goal, 'g');
  assert.equal(await jobs.get('nope'), null);
});

test('cancel: Pending → terminate; Running → raiseEvent cancel; terminal → not ok; unknown → null', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const a = await jobs.submit({ goal: 'a' });
  assert.deepEqual(await jobs.cancel(a.jobId), { ok: true, status: 'cancelled' });
  assert.equal(client.calls.terminate.length, 1);
  const b = await jobs.submit({ goal: 'b' });
  client.instances[b.jobId].runtimeStatus = 'Running';
  assert.deepEqual(await jobs.cancel(b.jobId), { ok: true, status: 'cancelling' });
  assert.deepEqual(client.calls.raiseEvent[0], { id: b.jobId, name: 'cancel', data: {} });
  client.instances[b.jobId].runtimeStatus = 'Completed';
  client.instances[b.jobId].output = { status: 'completed' };
  assert.deepEqual(await jobs.cancel(b.jobId), { ok: false, status: 'completed' });
  assert.deepEqual(await jobs.cancel('nope'), { ok: false, status: null });
});

test('events reads customStatus.events preferring stored seq; subscribe polls and emits only new events', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  const inst = client.instances[jobId];
  const E = (seq, type, extra = {}) => ({ seq, type, jobId, at: 't', ...extra });
  inst.customStatus = { status: 'processing', events: [E(1, 'queued', { position: 1 }), E(2, 'started')] };
  assert.deepEqual((await jobs.events(jobId)).map(e => [e.seq, e.type]), [[1, 'queued'], [2, 'started']]);
  assert.deepEqual((await jobs.events(jobId, { afterSeq: 1 })).map(e => e.seq), [2]);
  const seen = [];
  const unsub = jobs.subscribe(jobId, e => seen.push(e.seq));
  await sleep(15);
  inst.customStatus = { status: 'processing', events: [...inst.customStatus.events, E(3, 'progress', { iteration: 1, message: 'm', kind: 'step_started' })] };
  await sleep(15);
  inst.runtimeStatus = 'Completed';
  inst.output = { status: 'completed', result: 1 };
  inst.customStatus = { status: 'completed', events: [...inst.customStatus.events, E(4, 'settled', { status: 'completed' })] };
  await sleep(20);
  unsub();
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('events after a ring truncation keep their original seq', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  client.instances[jobId].customStatus = { status: 'processing', events: [{ seq: 1, type: 'queued' }, { seq: 2, type: 'started' }, { seq: 40, type: 'progress' }, { seq: 41, type: 'progress' }] };
  assert.deepEqual((await jobs.events(jobId, { afterSeq: 2 })).map(e => e.seq), [40, 41]);
});

test('stats counts pending and running after refreshStats', async () => {
  const client = fakeClient({ instances: { a: { runtimeStatus: 'Pending' }, b: { runtimeStatus: 'Running' }, c: { runtimeStatus: 'Completed' } } });
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  await jobs.refreshStats();
  assert.deepEqual(jobs.stats(), { queued: 1, processing: 1, capacity: 1, maxQueueSize: 2 });
});

test('submit after stop throws JobsClosedError and stop clears pollers', async () => {
  const { JobsClosedError } = await import('../host/jobs/interface.mjs');
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  jobs.subscribe(jobId, () => {});
  await jobs.stop();
  await assert.rejects(() => jobs.submit({ goal: 'g' }), JobsClosedError);
});

test('overlapping getClient identities cannot clobber each other', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage();
  const jobs = createDurableJobs({ getClient: () => als.getStore(), config: cfg, notifier: null, logger: quiet });
  const clientA = fakeClient();
  const clientB = fakeClient();
  const [outA, outB] = await Promise.all([
    als.run(clientA, () => jobs.submit({ goal: 'from-a' })),
    als.run(clientB, () => jobs.submit({ goal: 'from-b' })),
  ]);
  assert.equal(clientA.calls.startNew.length, 1);
  assert.equal(clientB.calls.startNew.length, 1);
  assert.equal(clientA.calls.startNew[0].input.task.goal, 'from-a');
  assert.equal(clientB.calls.startNew[0].input.task.goal, 'from-b');
  const [recA, recB] = await Promise.all([
    als.run(clientA, () => jobs.get(outA.jobId)),
    als.run(clientB, () => jobs.get(outB.jobId)),
  ]);
  assert.equal(recA.task.goal, 'from-a');
  assert.equal(recB.task.goal, 'from-b');
  assert.equal(await als.run(clientA, () => jobs.get(outB.jobId)), null);
  assert.equal(await als.run(clientB, () => jobs.get(outA.jobId)), null);
});

test('startPoller snapshots getClient once so later ticks ignore a flipped factory', async () => {
  const clientA = fakeClient();
  const clientB = fakeClient();
  let current = clientA;
  const jobs = createDurableJobs({ getClient: () => current, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  const instA = clientA.instances[jobId];
  const E = (seq, type) => ({ seq, type, jobId, at: 't' });
  instA.customStatus = { status: 'processing', events: [E(1, 'queued')] };
  const seen = [];
  const unsub = jobs.subscribe(jobId, e => seen.push(e.seq));
  current = clientB;
  await sleep(15);
  instA.customStatus = { status: 'processing', events: [...instA.customStatus.events, E(2, 'started')] };
  await sleep(15);
  unsub();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(clientB.calls.startNew.length, 0);
  assert.equal(Object.keys(clientB.instances).length, 0);
});
