import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessJobs } = await import('../host/jobs/in-process.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
const { JobQueueFullError, JobsClosedError } = await import('../host/jobs/interface.mjs');
const { createRecord } = await import('../host/jobs/record.mjs');

const BASE = { maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000, retentionMs: 86_400_000, drainMs: 500, capacity: 2 };

// A controllable runJob: resolves when the test says so, reports progress, honours abort.
function makeRunner() {
  const pending = new Map(); // taskId → { resolve, onProgress, signal }
  const runJob = (task, { signal, onProgress }) => new Promise((resolve) => {
    pending.set(task.id, { resolve, onProgress, signal });
    signal.addEventListener('abort', () => {
      pending.delete(task.id);
      resolve({ status: 'cancelled', result: null, history: [], budget: null });
    }, { once: true });
  });
  return {
    runJob,
    pending,
    async finish(id, result = { status: 'completed', result: 'ok', history: [{ x: 1 }], budget: { iterations: 1 } }) {
      const p = pending.get(id); pending.delete(id); p.resolve(result);
      await sleep(5);
    },
    async progress(id, iteration, message) { await pending.get(id).onProgress({ iteration, message }); },
    async waitFor(id) { while (!pending.has(id)) await sleep(2); },
  };
}

async function setup(overrides = {}, runner = makeRunner()) {
  const store = createMemoryStore();
  const published = [];
  const jobs = createInProcessJobs({
    store, runJob: runner.runJob,
    notifier: { publish: (e, ctx) => published.push({ e, ctx }) },
    config: { ...BASE, ...overrides }, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  return { jobs, store, runner, published };
}

test('submit returns queued job with position and processes FIFO', async () => {
  const { jobs, runner } = await setup();
  try {
    const a = await jobs.submit({ goal: 'a' });
    const b = await jobs.submit({ goal: 'b' });
    assert.equal(a.status, 'queued'); assert.equal(a.position, 1); assert.equal(b.position, 2);
    await runner.waitFor(a.jobId);
    assert.equal((await jobs.get(a.jobId)).status, 'processing');
    assert.equal((await jobs.get(b.jobId)).status, 'queued');
    await runner.finish(a.jobId);
    const ra = await jobs.get(a.jobId);
    assert.equal(ra.status, 'completed'); assert.equal(ra.result, 'ok');
    assert.deepEqual(ra.history, [{ x: 1 }]); assert.ok(ra.finishedAt);
    await runner.waitFor(b.jobId);
    assert.equal((await jobs.get(b.jobId)).status, 'processing');
    await runner.finish(b.jobId);
  } finally { await jobs.stop(); }
});

test('submit throws JobQueueFullError at maxQueueSize', async () => {
  const { jobs, runner } = await setup({ maxQueueSize: 1 });
  try {
    const a = await jobs.submit({ goal: 'a' });
    await runner.waitFor(a.jobId);                 // a is processing, queue is empty
    await jobs.submit({ goal: 'b' });              // queue has 1
    await assert.rejects(() => jobs.submit({ goal: 'c' }), JobQueueFullError);
    assert.deepEqual(jobs.stats(), { queued: 1, processing: 1, capacity: 1, maxQueueSize: 1 });
  } finally { await jobs.stop(); }
});

test('events and progress are recorded and published', async () => {
  const { jobs, runner, published } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' }, { callbackUrl: 'https://cb.test/h' });
    await runner.waitFor(jobId);
    await runner.progress(jobId, 1, 'calling weather');
    await runner.finish(jobId);
    const events = await jobs.events(jobId);
    assert.deepEqual(events.map(e => e.type), ['queued', 'started', 'progress', 'settled']);
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
    assert.equal((await jobs.get(jobId)).progress.iteration, 1);
    assert.equal(published.length, 4);
    assert.equal(published[3].ctx.callbackUrl, 'https://cb.test/h');
    assert.deepEqual(await jobs.events(jobId, { afterSeq: 3 }).then(l => l.map(e => e.type)), ['settled']);
  } finally { await jobs.stop(); }
});

test('subscribe receives live events and unsubscribe stops them', async () => {
  const { jobs, runner } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    const seen = [];
    const unsub = jobs.subscribe(jobId, (e) => seen.push(e.type));
    await runner.waitFor(jobId);
    await runner.progress(jobId, 1, 'p');
    unsub();
    await runner.finish(jobId);
    assert.deepEqual(seen, ['started', 'progress']);
  } finally { await jobs.stop(); }
});

test('cancel on queued removes from queue; cancel on processing aborts', async () => {
  const { jobs, runner } = await setup();
  try {
    const a = await jobs.submit({ goal: 'a' });
    const b = await jobs.submit({ goal: 'b' });
    await runner.waitFor(a.jobId);
    assert.deepEqual(await jobs.cancel(b.jobId), { ok: true, status: 'cancelled' });
    assert.equal((await jobs.get(b.jobId)).status, 'cancelled');
    const c = await jobs.cancel(a.jobId);
    assert.equal(c.ok, true); assert.equal(c.status, 'cancelling');
    await sleep(20);
    assert.equal((await jobs.get(a.jobId)).status, 'cancelled');
    assert.deepEqual(await jobs.cancel(a.jobId), { ok: false, status: 'cancelled' });
    assert.deepEqual(await jobs.cancel('nope'), { ok: false, status: null });
  } finally { await jobs.stop(); }
});

test('runJob budget_exceeded settles as budget_exceeded', async () => {
  const { jobs, runner } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    await runner.waitFor(jobId);
    await runner.finish(jobId, { status: 'budget_exceeded', result: { budgetReason: 'max_iterations' }, history: [], budget: { iterations: 2 } });
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'budget_exceeded');
    assert.deepEqual(r.result, { budgetReason: 'max_iterations' });
    assert.equal(r.error, null);
    assert.deepEqual(r.budget, { iterations: 2 });
  } finally { await jobs.stop(); }
});

test('runJob failed result settles as failed with run_failed error', async () => {
  const { jobs, runner } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    await runner.waitFor(jobId);
    await runner.finish(jobId, { status: 'failed', result: { error: 'no_action', message: 'stuck' }, history: [], budget: null });
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.error, { code: 'run_failed', message: 'no_action: stuck' });
  } finally { await jobs.stop(); }
});

test('runJob throwing settles as failed rather than crashing the loop', async () => {
  const store = createMemoryStore();
  const jobs = createInProcessJobs({
    store, runJob: async () => { throw new Error('kaboom'); }, notifier: null,
    config: BASE, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    await sleep(20);
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'run_failed');
    assert.match(r.error.message, /kaboom/);
  } finally { await jobs.stop(); }
});

test('start re-enqueues queued rows and marks processing rows interrupted', async () => {
  const store = createMemoryStore(); await store.open();
  await store.insert({ ...createRecord({ goal: 'was-running' }, { id: 'job-run' }), status: 'processing', startedAt: new Date().toISOString() });
  await store.insert(createRecord({ goal: 'was-queued' }, { id: 'job-q' }));
  const runner = makeRunner();
  const jobs = createInProcessJobs({ store, runJob: runner.runJob, notifier: null, config: BASE, logger: { warn() {}, info() {} } });
  await jobs.start();
  try {
    const interrupted = await jobs.get('job-run');
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error.code, 'interrupted');
    assert.equal((await jobs.events('job-run')).at(-1).type, 'settled');
    await runner.waitFor('job-q');
    assert.equal((await jobs.get('job-q')).status, 'processing');
    await runner.finish('job-q');
  } finally { await jobs.stop(); }
});

test('lease timeout aborts a stuck job and settles lease_expired', async () => {
  let clock = Date.now();
  const runner = makeRunner();
  const store = createMemoryStore();
  const jobs = createInProcessJobs({
    store, runJob: runner.runJob, notifier: null,
    config: { ...BASE, leaseTimeoutMs: 1000, sweepIntervalMs: 20 },
    logger: { warn() {}, info() {} }, now: () => new Date(clock),
  });
  await jobs.start();
  try {
    const { jobId } = await jobs.submit({ goal: 'slow' });
    await runner.waitFor(jobId);
    clock += 2000;
    await sleep(60);
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'lease_expired');
  } finally { await jobs.stop(); }
});

test('concurrency is clamped to capacity and runs jobs in parallel', async () => {
  const { jobs, runner } = await setup({ concurrency: 5, capacity: 2 });
  try {
    const ids = [];
    for (const g of ['a', 'b', 'c']) ids.push((await jobs.submit({ goal: g })).jobId);
    await runner.waitFor(ids[0]); await runner.waitFor(ids[1]);
    assert.equal(jobs.stats().processing, 2);
    assert.equal(jobs.stats().capacity, 2);
    assert.equal((await jobs.get(ids[2])).status, 'queued');
    for (const id of ids) { await runner.waitFor(id); await runner.finish(id); }
  } finally { await jobs.stop(); }
});

test('stop drains then aborts; queued jobs stay queued; submit after stop rejects', async () => {
  const { jobs, runner, store } = await setup({ drainMs: 50 });
  const a = await jobs.submit({ goal: 'a' });
  const b = await jobs.submit({ goal: 'b' });
  await runner.waitFor(a.jobId);
  await jobs.stop();
  assert.equal((await store.get(a.jobId)).status, 'failed');
  assert.equal((await store.get(a.jobId)).error.code, 'interrupted');
  assert.equal((await store.get(b.jobId)).status, 'queued');
  await assert.rejects(() => jobs.submit({ goal: 'c' }), JobsClosedError);
});
