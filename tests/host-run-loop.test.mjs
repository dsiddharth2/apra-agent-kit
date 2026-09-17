// tests/host-run-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runTask } = await import('../host/run-loop.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15' }) },
  ];
}

test('open-ended: completes a simple task', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather in London' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.result, '15°C');
  assert.ok(result.history.length > 0);
});

test('plan-execute: completes with plan and review', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "x", "review": false}]}\n```',
      '```review\n{"approved": true}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'plan-execute', tools: makeTools(), fleetApi: api },
  );
  assert.equal(result.status, 'completed');
});

test('budget exceeded stops the run', async () => {
  const { createBudgets } = await import('../host/budgets.mjs');
  const budgets = createBudgets({ maxIterations: 1 });
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```tool_call\n{"tool": "weather", "args": {"city": "Paris"}}\n```',
      '```done\n{"result": "done", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, budgets },
  );
  assert.equal(result.status, 'budget_exceeded');
  assert.ok(result.budget);
  assert.equal(result.budget.iterations, 1);
});

test('signal cancellation stops the run', async () => {
  const ac = new AbortController();
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: (opts) => {
      ac.abort();
      return '```tool_call\n{"tool": "weather", "args": {}}\n```';
    },
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, signal: ac.signal },
  );
  assert.equal(result.status, 'cancelled');
});

test('failed strategy returns failed status', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['thinking...', 'still thinking...', 'more thinking...', 'yet more...'],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, maxNoActionTurns: 3 },
  );
  assert.equal(result.status, 'failed');
});

test('guardrails are passed to strategy', async () => {
  const { createGuardrails } = await import('../host/guardrails.mjs');
  const { executeTool } = await import('../host/tools/executor.mjs');
  const guardrails = createGuardrails(
    { defaultPolicy: 'allow', policies: { weather: 'deny' } },
    [],
    executeTool,
  );
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "denied", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, guardrails },
  );
  assert.equal(result.status, 'completed');
  const denied = result.history.find(o => o.error === 'guardrail_denied');
  assert.ok(denied);
});
