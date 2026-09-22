import './setup-fleet-modules.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

function commandScripts(fleetApi) {
  return fleetApi.commandCalls.map(c => c.command);
}

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
    const commands = commandScripts(fleetApi);
    assert.ok(commands.some(c => c.includes('weather.py')), 'should call weather.py');
    assert.ok(commands.some(c => c.includes('forecast.py')), 'should call forecast.py');
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
    const commands = commandScripts(fleetApi);
    assert.ok(commands.some(c => c.includes('wikipedia_summary.py')), 'should call wikipedia_summary.py');
    assert.ok(commands.some(c => c.includes('places_of_interest.py')), 'should call places_of_interest.py');
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
    const commands = commandScripts(fleetApi);
    assert.ok(commands.some(c => c.includes('country_info.py')), 'should call country_info.py');
    assert.ok(commands.some(c => c.includes('travel_advisory.py') && /\bJP\b/.test(c)),
      `travel_advisory.py should use ISO code JP, got: ${commands.filter(c => c.includes('travel_advisory')).join(' | ')}`);
    assert.ok(commands.some(c => c.includes('currency.py') && /\bJPY\b/.test(c)),
      `currency.py should use JPY, got: ${commands.filter(c => c.includes('currency.py')).join(' | ')}`);
    assert.ok(commands.some(c => c.includes('public_holidays.py') && /\bJP\b/.test(c)),
      `public_holidays.py should use ISO code JP, got: ${commands.filter(c => c.includes('public_holidays')).join(' | ')}`);
    assert.ok(!commands.some(c => c.includes('travel_advisory.py') && c.includes('Japan')),
      'travel-advisory must not use the bare country name');
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
    const commands = commandScripts(fleetApi);
    assert.ok(commands.some(c => c.includes('route_distance.py')), 'should call route_distance.py');
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});

describe('engine scripts shell-escape interpolated args', () => {
  test('quick-weather escapes quotes in the city argument', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: () => '{"ok":true}',
      promptResponses: () => 'ok',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'quick-weather');
    await wf.run({
      fleetApi,
      args: { city: 'Tokyo"; rm -rf /' },
      workspace: { doer: { name: 'DOER' } },
    });
    for (const cmd of commandScripts(fleetApi)) {
      assert.doesNotMatch(cmd, /Tokyo";/);
      assert.match(cmd, /Tokyo\\";/);
    }
  });
});

describe('engine scripts report human phase strings', () => {
  test('quick-weather reportPhase receives a human string per phase', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: () => '{"ok":true}',
      promptResponses: () => 'Sunny.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'quick-weather');
    const phases = [];
    await wf.run({
      fleetApi,
      args: { city: 'Tokyo' },
      workspace: { doer: { name: 'DOER' } },
      reportPhase: (message) => phases.push(message),
    });
    assert.ok(phases.length >= 1, 'reportPhase should be called');
    assert.ok(phases.every(p => typeof p === 'string' && p.length > 0), 'each phase should be a human string');
  });
});

describe('executeWorkflow shipped call shape', () => {
  test('runs a registry workflow through executeWorkflow', async () => {
    const { executeWorkflow } = await import('../host/router.mjs');
    const { extendRegistry } = await import('../host/tools/registry.mjs');
    const fleetApi = createMockFleetApi({
      commandPayload: (opts) => {
        if (opts.command.includes('weather.py')) return '{"ok":true,"temp":"25C"}';
        if (opts.command.includes('forecast.py')) return '{"ok":true,"days":[]}';
        return '{}';
      },
      promptResponses: () => 'Sunny in Tokyo.',
    });
    const result = await executeWorkflow('quick-weather', { city: 'Tokyo' }, {
      fleetApi,
      toolRegistry: extendRegistry(),
      workspace: { doer: { name: 'DOER' } },
      signal: null,
      onProgress: () => {},
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.result, 'Sunny in Tokyo.');
    assert.ok(commandScripts(fleetApi).some(c => c.includes('weather.py')));
    assert.ok(commandScripts(fleetApi).some(c => c.includes('forecast.py')));
  });
});
