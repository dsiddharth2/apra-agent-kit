import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const { buildClassifierPrompt, parseClassifierResponse, classify, executeWorkflow } =
  await import('../host/router.mjs');

describe('buildClassifierPrompt', () => {
  test('includes workflow names and descriptions from routing blocks', () => {
    const registry = [
      { name: 'quick-weather', routing: { description: 'weather for a city', args: { city: { extract: 'city name' } } } },
      { name: 'weather', description: 'raw weather tool' },
    ];
    const prompt = buildClassifierPrompt('weather in Tokyo', registry);
    assert.ok(prompt.includes('quick-weather'), 'should include routable workflow');
    assert.ok(prompt.includes('weather for a city'), 'should include routing description');
    assert.ok(!prompt.includes('raw weather tool'), 'should NOT include non-routable tool description');
    assert.ok(prompt.includes('weather in Tokyo'), 'should include user goal');
    assert.ok(prompt.includes('open-ended'), 'should mention open-ended strategy');
    assert.ok(prompt.includes('plan-execute'), 'should mention plan-execute strategy');
  });

  test('returns minimal prompt when no routable workflows exist', () => {
    const prompt = buildClassifierPrompt('hello', []);
    assert.ok(prompt.includes('hello'));
    assert.ok(prompt.includes('open-ended'));
    assert.ok(prompt.includes('plan-execute'));
  });
});

describe('parseClassifierResponse', () => {
  const routableNames = new Set(['quick-weather', 'city-briefing']);

  test('parses valid workflow response', () => {
    const result = parseClassifierResponse(
      '{"path":"workflow","workflow":"quick-weather","args":{"city":"Tokyo"}}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'workflow', workflow: 'quick-weather', args: { city: 'Tokyo' } });
  });

  test('parses valid open-ended response', () => {
    const result = parseClassifierResponse(
      '{"path":"open-ended"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });

  test('parses valid plan-execute response', () => {
    const result = parseClassifierResponse(
      '{"path":"plan-execute"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'plan-execute' });
  });

  test('strips markdown fences before parsing', () => {
    const result = parseClassifierResponse(
      '```json\n{"path":"workflow","workflow":"quick-weather","args":{"city":"London"}}\n```',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.equal(result.path, 'workflow');
    assert.equal(result.workflow, 'quick-weather');
  });

  test('falls back on invalid JSON', () => {
    const result = parseClassifierResponse(
      'I think you should use the weather tool',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });

  test('falls back on unknown workflow name', () => {
    const result = parseClassifierResponse(
      '{"path":"workflow","workflow":"nonexistent","args":{}}',
      { routableNames, fallbackStrategy: 'plan-execute' },
    );
    assert.deepEqual(result, { path: 'plan-execute' });
  });

  test('falls back on invalid path value', () => {
    const result = parseClassifierResponse(
      '{"path":"something-else"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });

  test('falls back when path is workflow but workflow field is missing', () => {
    const result = parseClassifierResponse(
      '{"path":"workflow"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });
});

import { createMockFleetApi } from './helpers/mock-fleet.mjs';

describe('classify', () => {
  test('sends classifier prompt to doer and returns parsed route', async () => {
    const fleetApi = createMockFleetApi({
      promptResponses: () => '{"path":"workflow","workflow":"quick-weather","args":{"city":"Tokyo"}}',
    });
    const registry = [
      { name: 'quick-weather', routing: { description: 'weather for a city', args: { city: { extract: 'city name' } } } },
    ];
    const result = await classify('weather in Tokyo', {
      fleetApi, registry, fallbackStrategy: 'open-ended',
    });
    assert.equal(result.path, 'workflow');
    assert.equal(result.workflow, 'quick-weather');
    assert.deepEqual(result.args, { city: 'Tokyo' });
    assert.equal(fleetApi.promptCalls.length, 1);
    assert.equal(fleetApi.promptCalls[0].member_name, 'doer');
  });

  test('returns fallback when doer returns invalid JSON', async () => {
    const fleetApi = createMockFleetApi({
      promptResponses: () => 'I am not sure what to do',
    });
    const result = await classify('something weird', {
      fleetApi, registry: [], fallbackStrategy: 'plan-execute',
    });
    assert.deepEqual(result, { path: 'plan-execute' });
  });
});

describe('executeWorkflow', () => {
  test('runs the named workflow and returns completed result', async () => {
    const registry = [
      {
        name: 'test-wf',
        routing: { description: 'test', args: {} },
        async run({ args }) { return { answer: `hello ${args.city}` }; },
      },
    ];
    const result = await executeWorkflow('test-wf', { city: 'Tokyo' }, {
      fleetApi: {}, toolRegistry: registry, signal: null, onProgress: null,
    });
    assert.equal(result.status, 'completed');
    assert.ok(result.result.includes('Tokyo'));
  });

  test('returns failed for unknown workflow', async () => {
    const result = await executeWorkflow('nonexistent', {}, {
      fleetApi: {}, toolRegistry: [], signal: null, onProgress: null,
    });
    assert.equal(result.status, 'failed');
  });

  test('returns cancelled when workflow throws AbortError', async () => {
    const registry = [
      {
        name: 'abort-wf',
        routing: { description: 'test', args: {} },
        async run() { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      },
    ];
    const result = await executeWorkflow('abort-wf', {}, {
      fleetApi: {}, toolRegistry: registry, signal: null, onProgress: null,
    });
    assert.equal(result.status, 'cancelled');
  });
});
