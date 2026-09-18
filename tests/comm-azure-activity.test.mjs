// tests/comm-azure-activity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createRunTaskActivity, setHostContextFactory, getHostContext } = await import('../comm/azure-functions/activity.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}
function fakeClient({ cancelAfterPolls = Infinity } = {}) {
  const calls = { raiseEvent: [], getStatus: 0 };
  return {
    calls,
    async raiseEvent(id, name, data) { calls.raiseEvent.push({ id, name, data }); },
    async getStatus() { calls.getStatus += 1; return { customStatus: { cancelRequested: calls.getStatus > cancelAfterPolls } }; },
  };
}
function hostCtx(api, dispatcher, extra = {}) {
  return { api, activeDispatcher: dispatcher, toolRegistry: extendRegistry(), runLoopConfig: { strategy: 'open-ended' }, budgetsConfig: null, guardrailsMod: null, notifier: null, ...extra };
}

test('activity raises started, forwards rich progress, returns the settled result, and posts the webhook', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```tool_call\n{"tool": "inspect-members", "args": {}}\n```', '```done\n{"result": "done", "summary": "s"}\n```'],
  });
  const dispatcher = await makeDispatcher();
  const client = fakeClient();
  const published = [];
  const notifier = { publish: async (event, ctx) => { published.push({ event, ctx }); } };
  try {
    const activity = createRunTaskActivity({ getClient: () => client, pollMs: 50, getContext: async () => hostCtx(api, dispatcher, { notifier }) });
    const out = await activity({ jobId: 'job-1', task: { goal: 'inspect' }, callbackUrl: 'https://cb.test/h' }, { warn() {} });
    assert.equal(out.status, 'completed');
    assert.equal(out.result, 'done');
    assert.ok(Array.isArray(out.history));
    const raised = client.calls.raiseEvent;
    assert.equal(raised[0].name, 'progress');
    assert.equal(raised[0].data.type, 'started');
    assert.equal(raised[0].id, 'job-1');
    const progress = raised.filter(r => r.data.type === 'progress');
    assert.equal(progress.length, 2);
    assert.deepEqual(progress.map(p => p.data.kind), ['step_started', 'step_completed']);
    assert.equal(progress[0].data.iteration, 1);
    assert.ok(progress[0].data.at);
    assert.equal(published.length, 1);
    assert.equal(published[0].event.type, 'settled');
    assert.equal(published[0].event.status, 'completed');
    assert.equal(published[0].ctx.callbackUrl, 'https://cb.test/h');
  } finally { await dispatcher.close(); }
});

test('activity aborts when customStatus.cancelRequested appears and settles cancelled', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return '```tool_call\n{"tool": "inspect-members", "args": {}}\n```';
    },
  });
  const dispatcher = await makeDispatcher();
  const client = fakeClient({ cancelAfterPolls: 1 });
  try {
    const activity = createRunTaskActivity({ getClient: () => client, pollMs: 30, getContext: async () => hostCtx(api, dispatcher) });
    const start = Date.now();
    const out = await activity({ jobId: 'job-2', task: { goal: 'slow' }, callbackUrl: null }, { warn() {} });
    const elapsed = Date.now() - start;
    assert.equal(out.status, 'cancelled');
    assert.ok(elapsed < 500, `expected cancel without waiting for hung prompt (${elapsed}ms)`);
    await new Promise((r) => setTimeout(r, 2100));
  } finally { await dispatcher.close(); }
});

test('activity returns failed / dispatch_failed as a value when no lease is available', async () => {
  const api = createMockFleetApi({ members: rosterNames(1) });
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => { throw new Error('queue overflow'); };
  try {
    const activity = createRunTaskActivity({ getClient: () => fakeClient(), pollMs: 50, getContext: async () => hostCtx(api, dispatcher) });
    const out = await activity({ jobId: 'job-3', task: { goal: 'x' }, callbackUrl: null }, { warn() {} });
    assert.equal(out.status, 'failed');
    assert.equal(out.error.code, 'dispatch_failed');
  } finally { await dispatcher.close(); }
});

test('getHostContext memoises the factory and throws before one is set', async () => {
  setHostContextFactory(null);
  await assert.rejects(() => getHostContext(), /host context factory/);
  let calls = 0;
  setHostContextFactory(async () => { calls += 1; return { api: 'a' }; });
  assert.equal((await getHostContext()).api, 'a');
  await getHostContext();
  assert.equal(calls, 1);
});
