import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRegistry } from '../mcp/registry.mjs';

test('routable workflows have routing.description and routing.args', () => {
  const routable = defaultRegistry.filter(t => t.routing);
  assert.ok(routable.length >= 5, `expected at least 5 routable workflows, got ${routable.length}`);
  for (const entry of routable) {
    assert.ok(typeof entry.routing.description === 'string' && entry.routing.description.length > 0,
      `${entry.name} missing routing.description`);
    assert.ok(typeof entry.routing.args === 'object',
      `${entry.name} missing routing.args`);
  }
});

test('non-routable tools do not have routing blocks', () => {
  const nonRoutable = defaultRegistry.filter(t => !t.routing);
  const toolNames = nonRoutable.map(t => t.name);
  assert.ok(toolNames.includes('weather'), 'weather tool should not be routable');
  assert.ok(toolNames.includes('timezone'), 'timezone tool should not be routable');
  assert.ok(toolNames.includes('demo'), 'demo should not be routable');
});

test('each routable workflow has a run function', () => {
  const routable = defaultRegistry.filter(t => t.routing);
  for (const entry of routable) {
    assert.equal(typeof entry.run, 'function', `${entry.name} missing run()`);
  }
});
