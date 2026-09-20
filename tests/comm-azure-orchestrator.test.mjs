// tests/comm-azure-orchestrator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');

function fakeContext({ instanceId = 'job-1', input }) {
  const statuses = [];
  const mk = (kind, name, inp) => ({ kind, name, input: inp, done: false, result: undefined });
  const df = {
    instanceId,
    getInput: () => input,
    setCustomStatus: (s) => statuses.push(structuredClone(s)),
    callActivity: (name, inp) => mk('activity', name, inp),
    currentUtcDateTime: new Date('2026-09-17T10:00:00.000Z'),
  };
  return { df, statuses };
}

const input = {
  task: { id: 'job-1', goal: 'g' }, record: { id: 'job-1' }, callbackUrl: null, metadata: {},
  queuedEvent: { type: 'queued', jobId: 'job-1', at: 't0', position: 1 },
};

test('orchestrator emits queued+started, yields one activity, and settles from the output', () => {
  const ctx = fakeContext({ input });
  const gen = buildOrchestrator()(ctx);
  const step1 = gen.next();

  assert.equal(step1.done, false);
  assert.equal(step1.value.kind, 'activity');
  assert.equal(step1.value.name, 'runTaskActivity');
  assert.equal(step1.value.input.jobId, 'job-1');

  const published = ctx.statuses.at(-1);
  assert.equal(published.status, 'processing');
  assert.ok(published.startedAt);
  assert.deepEqual(published.events.map(e => e.type), ['queued', 'started']);
  assert.equal(published.events[0].seq, 1);
  assert.equal(published.events[1].seq, 2);

  const output = { status: 'completed', result: 'ok', error: null, history: [1], budget: null };
  const step2 = gen.next(output);
  assert.equal(step2.done, true);
  assert.deepEqual(step2.value, output);

  const final = ctx.statuses.at(-1);
  assert.equal(final.status, 'completed');
  assert.equal(final.events.at(-1).type, 'settled');
  assert.equal(final.events.at(-1).result, 'ok');
  assert.ok(final.finishedAt);
});

test('failed activity output is recorded correctly', () => {
  const ctx = fakeContext({ input });
  const gen = buildOrchestrator()(ctx);
  gen.next();

  const output = { status: 'failed', result: null, error: { code: 'run_failed', message: 'x' }, history: [], budget: null };
  const step = gen.next(output);
  assert.equal(step.done, true);
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'settled']);
  assert.equal(ctx.statuses.at(-1).status, 'failed');
});

test('only one activity is yielded (no replay fan-out)', () => {
  const ctx = fakeContext({ input });
  const gen = buildOrchestrator()(ctx);
  const step1 = gen.next();
  assert.equal(step1.done, false, 'first yield is the activity');

  const step2 = gen.next({ status: 'completed', result: null });
  assert.equal(step2.done, true, 'generator finishes after one activity');
});
