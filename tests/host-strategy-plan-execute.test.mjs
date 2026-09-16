// tests/host-strategy-plan-execute.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createPlanExecuteStrategy } = await import('../host/strategies/plan-execute.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async ({ args }) => ({ temp_c: '15', city: args.city ?? 'London' }) },
    { name: 'textstats', description: 'Text stats', reversible: true, timeout: 5000,
      run: async ({ args }) => ({ word_count: 5, text: args.text ?? '' }) },
  ];
}

test('simple plan: one tool step, review approved, done', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}\n```',
      // reviewer: approve plan
      '```review\n{"approved": true}\n```',
      // doer: done after execution
      '```done\n{"result": "London is 15°C", "summary": "Done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const types = events.map(e => e.type);
  assert.ok(types.includes('plan'));
  assert.ok(types.includes('review'));
  assert.ok(types.includes('observation'));
  assert.ok(types.includes('done'));
});

test('reviewer rejects plan, doer replans', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: first plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {}, "reason": "bad plan", "review": false}]}\n```',
      // reviewer: reject
      '```review\n{"approved": false, "feedback": "Missing city arg"}\n```',
      // doer: revised plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "fixed", "review": false}]}\n```',
      // reviewer: approve
      '```review\n{"approved": true}\n```',
      // doer: done
      '```done\n{"result": "15°C", "summary": "Done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Weather' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const reviews = events.filter(e => e.type === 'review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].approved, false);
  assert.equal(reviews[1].approved, true);
});

test('reason step records observation from doer', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan with reason step
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "data", "review": false}, {"type": "reason", "prompt": "Compose briefing", "review": false}]}\n```',
      // reviewer: approve
      '```review\n{"approved": true}\n```',
      // doer: reason step response (plain text, no block)
      'London is 15°C and cloudy. A light jacket is recommended.',
      // doer: done
      '```done\n{"result": "briefing complete", "summary": "done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Briefing' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const reasonObs = events.find(e => e.type === 'observation' && e.stepType === 'reason');
  assert.ok(reasonObs);
  assert.ok(reasonObs.text.includes('15°C'));
});

test('dynamic args: doer resolves empty args at execution time', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan with empty args on step 2
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "data", "review": false}, {"type": "tool", "tool": "textstats", "args": {}, "reason": "analyze", "review": false}]}\n```',
      // reviewer: approve
      '```review\n{"approved": true}\n```',
      // doer: resolve args for textstats
      '```tool_call\n{"tool": "textstats", "args": {"text": "London is 15 degrees"}}\n```',
      // doer: done
      '```done\n{"result": "done", "summary": "done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const observations = events.filter(e => e.type === 'observation');
  assert.ok(observations.length >= 2);
});

test('step review: reviewer rejects step, doer retries', async () => {
  const callCount = { weather: 0 };
  const tools = [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async ({ args }) => {
        callCount.weather++;
        return { temp_c: callCount.weather === 1 ? 'WRONG' : '15', city: args.city };
      },
    },
  ];
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "Paris"}, "reason": "data", "review": true}]}\n```',
      // reviewer: approve plan
      '```review\n{"approved": true}\n```',
      // reviewer: reject step result
      '```step_review\n{"approved": false, "feedback": "Result says WRONG"}\n```',
      // doer: retry tool call
      '```tool_call\n{"tool": "weather", "args": {"city": "Paris"}}\n```',
      // reviewer: approve step result
      '```step_review\n{"approved": true}\n```',
      // doer: done
      '```done\n{"result": "Paris is 15°C", "summary": "done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Paris weather' },
    tools,
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  assert.equal(callCount.weather, 2);
  const stepReviews = events.filter(e => e.type === 'step_review');
  assert.equal(stepReviews.length, 2);
});

test('history returns all observations', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "x", "review": false}]}\n```',
      '```review\n{"approved": true}\n```',
      '```done\n{"result": "ok", "summary": "ok"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  for await (const _ of strategy.iterate()) { /* drain */ }
  assert.ok(strategy.history().length > 0);
});
