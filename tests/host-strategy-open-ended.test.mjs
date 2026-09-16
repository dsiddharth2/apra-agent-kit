// tests/host-strategy-open-ended.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createOpenEndedStrategy } = await import('../host/strategies/open-ended.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15', city: 'London' }) },
  ];
}

function makeFleetApi(responses) {
  return createMockFleetApi({ members: rosterNames(1), promptResponses: responses });
}

test('single tool_call then done completes', async () => {
  const api = makeFleetApi([
    'Let me check.\n\n```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
    'Got it.\n\n```done\n{"result": "15°C in London", "summary": "Done"}\n```',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const types = events.map(e => e.type);
  assert.ok(types.includes('action'));
  assert.ok(types.includes('observation'));
  assert.ok(types.includes('done'));
});

test('thinking turns increment no-action counter', async () => {
  const api = makeFleetApi([
    'Hmm let me think...',
    'Still thinking...',
    'Still thinking more...',
    'Still thinking even more...',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const last = events[events.length - 1];
  assert.equal(last.type, 'error');
  assert.ok(last.reason.includes('no_action'));
});

test('unknown tool name yields error observation', async () => {
  const api = makeFleetApi([
    '```tool_call\n{"tool": "nonexistent", "args": {}}\n```',
    '```done\n{"result": "gave up", "summary": "done"}\n```',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const errObs = events.find(e => e.type === 'observation' && e.error);
  assert.ok(errObs);
  assert.ok(errObs.error.includes('not found'));
});

test('history accumulates observations', async () => {
  const api = makeFleetApi([
    '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
    '```done\n{"result": "done", "summary": "done"}\n```',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  assert.ok(strategy.history().length > 0);
});
