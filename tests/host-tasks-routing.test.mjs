import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

describe('executeHostedTask routing', () => {
  function makeMockDispatcher(fleetApi) {
    return {
      capacity: 1,
      async dispatch({ members } = {}) {
        const doerOnly = Array.isArray(members) && members.length === 1 && members[0] === 'doer';
        return {
          workerId: 'test-worker',
          doer: { name: 'TEST-DOER' },
          reviewer: doerOnly ? null : { name: 'TEST-REVIEWER' },
          signal: null,
          release: async () => {},
          upgradeToReviewer: async () => {},
        };
      },
    };
  }

  test('routes to workflow when classifier returns workflow path', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: (opts) => {
        if (opts.prompt.includes('task router')) {
          return '{"path":"workflow","workflow":"test-wf","args":{"city":"Tokyo"}}';
        }
        return '```done\nresult: hello Tokyo\n```';
      },
    });
    const registry = [{
      name: 'test-wf',
      routing: { description: 'test workflow', args: { city: { extract: 'city' } } },
      async run({ args }) { return { answer: `hello ${args.city}` }; },
    }];
    const result = await executeHostedTask(
      { goal: 'weather in Tokyo' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: registry,
        runLoopConfig: { strategy: 'plan-execute' },
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.routedTo, 'workflow:test-wf');
  });

  test('task.strategy override bypasses router', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: () => '```done\nresult: direct\n```',
    });
    const result = await executeHostedTask(
      { goal: 'anything', strategy: 'open-ended' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: [],
        runLoopConfig: { strategy: 'plan-execute' },
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.routedTo, 'open-ended');
    const classifierCalls = fleetApi.promptCalls.filter(c => c.prompt?.includes('task router'));
    assert.equal(classifierCalls.length, 0, 'classifier should not be called when strategy is explicit');
  });

  test('router.enabled: false falls back to runLoopConfig.strategy', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: () => '```done\nresult: planned\n```',
    });
    const result = await executeHostedTask(
      { goal: 'plan something' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: [],
        runLoopConfig: { strategy: 'open-ended' },
        routerConfig: { enabled: false, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.routedTo, 'open-ended');
  });

  test('upgradeToReviewer throw becomes a structured failed result', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: (opts) => {
        if (opts.prompt.includes('task router')) return '{"path":"plan-execute"}';
        return '```done\nresult: should not run\n```';
      },
    });
    const dispatcher = {
      capacity: 1,
      async dispatch() {
        return {
          workerId: 'test-worker',
          doer: { name: 'TEST-DOER' },
          reviewer: null,
          signal: null,
          release: async () => {},
          upgradeToReviewer: async () => { throw new Error('no reviewer capacity'); },
        };
      },
    };
    const result = await executeHostedTask(
      { goal: 'plan a complex multi-city itinerary' },
      {
        api: fleetApi, activeDispatcher: dispatcher,
        toolRegistry: [],
        runLoopConfig: { strategy: 'open-ended' },
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.status, 'failed');
    assert.ok(result.result?.error, 'failed result should include an error code');
  });

  test('classify is not prompted when the task signal is already aborted', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: () => '{"path":"plan-execute"}',
    });
    const ac = new AbortController();
    ac.abort();
    const result = await executeHostedTask(
      { goal: 'weather in Tokyo' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: [],
        runLoopConfig: { strategy: 'open-ended' },
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
        signal: ac.signal,
      },
    );
    const classifierCalls = fleetApi.promptCalls.filter(c => c.prompt?.includes('task router'));
    assert.equal(classifierCalls.length, 0, 'classifier must not prompt after abort');
    assert.ok(result.status === 'cancelled' || result.routedTo === 'open-ended');
  });
});
