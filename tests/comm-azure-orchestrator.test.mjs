// tests/comm-azure-orchestrator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');

// Replay-free driver for a Durable orchestrator generator: the test resolves
// whichever task in the yielded Task.any list it wants to "win".
function fakeContext({ instanceId = 'job-1', input }) {
  const statuses = [];
  const mk = (kind, name, inp) => ({ kind, name, input: inp, done: false, result: undefined });
  const df = {
    instanceId,
    getInput: () => input,
    setCustomStatus: (s) => statuses.push(structuredClone(s)),
    callActivity: (name, inp) => mk('activity', name, inp),
    waitForExternalEvent: (name) => mk('event', name),
    Task: { any: (list) => ({ kind: 'any', list }) },
    currentUtcDateTime: new Date('2026-09-17T10:00:00.000Z'),
  };
  return { df, statuses };
}

function drive(gen) {
  let step = gen.next();
  return {
    get pending() { return step.value?.list ?? []; },
    resolve(pred, result) {
      const t = step.value.list.find(pred);
      t.done = true; t.result = result;
      step = gen.next(t);
      return step;
    },
    get done() { return step.done; },
    get value() { return step.value; },
  };
}

const input = {
  task: { id: 'job-1', goal: 'g' }, record: { id: 'job-1' }, callbackUrl: null, metadata: {},
  queuedEvent: { type: 'queued', jobId: 'job-1', at: 't0', position: 1 },
};
const isProgress = t => t.kind === 'event' && t.name === 'progress';
const isCancel = t => t.kind === 'event' && t.name === 'cancel';
const isActivity = t => t.kind === 'activity';

test('orchestrator records queued, forwards started + rich progress, and settles from the activity output', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  assert.equal(ctx.statuses[0].status, 'queued');
  assert.deepEqual(ctx.statuses[0].events.map(e => e.type), ['queued']);
  assert.equal(ctx.statuses[0].events[0].seq, 1);
  assert.equal(d.pending.find(isActivity).name, 'runTaskActivity');
  assert.equal(d.pending.find(isActivity).input.jobId, 'job-1');

  d.resolve(isProgress, { type: 'started', jobId: 'job-1', at: 't1' });
  assert.equal(ctx.statuses.at(-1).status, 'processing');
  assert.equal(ctx.statuses.at(-1).startedAt, 't1');
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started']);

  d.resolve(isProgress, { type: 'progress', jobId: 'job-1', at: 't2', iteration: 1, message: 'starting: weather', kind: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' } });
  const last = ctx.statuses.at(-1);
  assert.deepEqual(last.events.map(e => e.type), ['queued', 'started', 'progress']);
  assert.equal(last.events.at(-1).kind, 'step_started');
  assert.equal(last.events.at(-1).seq, 3);
  assert.deepEqual(last.progress, { iteration: 1, message: 'starting: weather', at: 't2' });

  const output = { status: 'completed', result: 'ok', error: null, history: [1], budget: null };
  d.resolve(isActivity, output);
  assert.equal(d.done, true);
  assert.deepEqual(d.value, output);
  assert.equal(ctx.statuses.at(-1).status, 'completed');
  assert.equal(ctx.statuses.at(-1).events.at(-1).type, 'settled');
  assert.equal(ctx.statuses.at(-1).events.at(-1).result, 'ok');
  assert.ok(ctx.statuses.at(-1).finishedAt);
});

test('a progress event before any started event marks the job started', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isProgress, { type: 'progress', jobId: 'job-1', at: 't1', iteration: 1, message: 'm', kind: 'plan' });
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'progress']);
  assert.equal(ctx.statuses.at(-1).startedAt, 't1');
});

test('orchestrator sets cancelRequested on cancel and keeps waiting for the activity', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isCancel, {});
  assert.equal(ctx.statuses.at(-1).cancelRequested, true);
  assert.ok(d.pending.some(isActivity), 'activity still awaited');
  d.resolve(isActivity, { status: 'cancelled', result: null, error: null, history: [], budget: null });
  assert.equal(ctx.statuses.at(-1).status, 'cancelled');
  assert.equal(ctx.statuses.at(-1).events.at(-1).status, 'cancelled');
});

test('activity finishing with no prior events still yields started + settled', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isActivity, { status: 'failed', result: null, error: { code: 'run_failed', message: 'x' }, history: [], budget: null });
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'settled']);
  assert.equal(ctx.statuses.at(-1).status, 'failed');
});

test('orchestrator ring keeps at most 50 events, never drops queued/started, and keeps seq stable', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isProgress, { type: 'started', jobId: 'job-1', at: 't1' });
  for (let i = 1; i <= 70; i++) {
    d.resolve(isProgress, { type: 'progress', jobId: 'job-1', at: 't', iteration: i, message: `m${i}`, kind: 'step_completed' });
  }
  const events = ctx.statuses.at(-1).events;
  assert.equal(events.length, 50);
  assert.deepEqual(events.slice(0, 2).map(e => [e.seq, e.type]), [[1, 'queued'], [2, 'started']]);
  assert.equal(events.at(-1).seq, 72); // 1 queued + 1 started + 70 progress
  assert.equal(events[2].seq, 72 - 48 + 1); // oldest surviving progress
});
