import './setup-fleet-modules.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

describe('quick-weather workflow', () => {
  test('calls weather and forecast tools then composes via agent', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: (opts) => {
        if (opts.command.includes('weather.py')) return '{"ok":true,"temp":"25C","condition":"sunny"}';
        if (opts.command.includes('forecast.py')) return '{"ok":true,"days":[{"high":26,"low":18}]}';
        return '{}';
      },
      promptResponses: () => 'Sunny in Tokyo, 25C today with highs of 26C tomorrow.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'quick-weather');
    assert.ok(wf, 'quick-weather should be in registry');

    const result = await wf.run({ fleetApi, args: { city: 'Tokyo' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 2, 'should call at least 2 tools');
    assert.ok(fleetApi.promptCalls.length >= 1, 'should call agent to compose');
    assert.ok(typeof result === 'string' || (typeof result === 'object' && result !== null));
  });
});

describe('destination-overview workflow', () => {
  test('calls wikipedia-summary and places-of-interest then composes', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: (opts) => {
        if (opts.command.includes('wikipedia_summary.py')) return '{"ok":true,"title":"Port Blair","extract":"Capital of Andaman"}';
        if (opts.command.includes('places_of_interest.py')) return '{"ok":true,"places":[{"title":"Cellular Jail"}]}';
        return '{}';
      },
      promptResponses: () => 'Port Blair is the capital of Andaman. Visit Cellular Jail.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'destination-overview');
    assert.ok(wf);
    const result = await wf.run({ fleetApi, args: { destination: 'Port Blair' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 2);
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});

describe('travel-prep workflow', () => {
  test('calls country-info, travel-advisory, currency, public-holidays then composes', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: () => '{"ok":true}',
      promptResponses: () => 'Japan travel prep: visa required, use JPY.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'travel-prep');
    assert.ok(wf);
    const result = await wf.run({ fleetApi, args: { country: 'Japan' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 4, 'should call 4 tools');
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});

describe('route-check workflow', () => {
  test('calls route-distance then composes', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: () => '{"ok":true,"distance_km":530,"duration_hours":10.5}',
      promptResponses: () => 'Delhi to Manali is 530km, about 10.5 hours driving.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'route-check');
    assert.ok(wf);
    const result = await wf.run({ fleetApi, args: { from: 'Delhi', to: 'Manali' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 1);
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});
