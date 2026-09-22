// tests/host-tasks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { executeHostedTask, mergeBudgetConfig, describeEvent } = await import('../host/tasks.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

test('mergeBudgetConfig picks the stricter value', () => {
  const merged = mergeBudgetConfig({ maxIterations: 25, timeoutMs: 600000, maxCostUsd: 5 }, {
    constraints: { maxIterations: 10, timeoutMs: 900000 }, budget: { maxCostUsd: 1 },
  });
  assert.deepEqual(merged, { maxIterations: 10, timeoutMs: 600000, maxCostUsd: 1 });
});

test('describeEvent renders each progress event type', () => {
  assert.equal(describeEvent({ type: 'action', tool: 'weather' }), 'calling weather');
  assert.equal(describeEvent({ type: 'observation', tool: 'weather' }), 'observed weather');
  assert.equal(describeEvent({ type: 'observation', stepType: 'reason' }), 'observed reason');
  assert.equal(describeEvent({ type: 'plan', plan: { steps: [1, 2, 3] } }), 'plan with 3 steps');
  assert.equal(describeEvent({ type: 'review', approved: true }), 'plan review approved');
  assert.equal(describeEvent({ type: 'step_review', approved: false, step: 'weather' }), 'step review rejected: weather');
  assert.equal(describeEvent({ kind: 'step_started', stepIndex: 0, step: { tool: 'weather' } }), 'starting step 0: weather');
  assert.equal(describeEvent({ kind: 'step_completed', stepIndex: 1, step: { tool: 'geocode' } }), 'completed step 1: geocode');
  assert.equal(describeEvent({ kind: 'step_failed', stepIndex: 2, error: 'timeout' }), 'step 2 failed: timeout');
  assert.equal(describeEvent({ kind: 'replan', plan: { steps: [1, 2] } }), 'revised plan with 2 steps');
});

test('executeHostedTask runs a task and forwards progress', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const progress = [];
  try {
    const out = await executeHostedTask({ goal: 'inspect' }, {
      api, activeDispatcher: dispatcher, toolRegistry: extendRegistry(),
      runLoopConfig: { strategy: 'open-ended' }, budgetsConfig: null, guardrailsMod: null,
      onProgress: (p) => progress.push(p),
    });
    assert.equal(out.status, 'completed');
    assert.match(out.taskId, /^t-/);
    assert.equal(progress[0].kind, 'routed');
    assert.equal(progress[0].routedTo, 'open-ended');
    assert.equal(progress.length, 3);
  } finally { await dispatcher.close(); }
});

test('executeHostedTask returns dispatch_failed as a value', async () => {
  const api = createMockFleetApi({ members: rosterNames(1) });
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => { throw new Error('queue overflow'); };
  const out = await executeHostedTask({ id: 'fixed', goal: 'x' }, {
    api, activeDispatcher: dispatcher, toolRegistry: [], runLoopConfig: { strategy: 'open-ended' },
    budgetsConfig: null, guardrailsMod: null,
  });
  assert.equal(out.taskId, 'fixed');
  assert.equal(out.status, 'failed');
  assert.equal(out.result.error, 'dispatch_failed');
});
