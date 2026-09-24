// tests/host-memory-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMemoryTools } from '../host/tools/memory-tools.mjs';

function mockLtm() {
  const entries = new Map();
  return {
    store: async (e) => { entries.set(e.id ?? 'test-id', e); return { action: 'created', entry: e }; },
    query: async () => [...entries.values()],
    remove: async (id) => entries.delete(id),
    promote: async (id) => ({ id, retrievalStrength: 1.0 }),
  };
}

test('withMemoryTools adds 4 tools', () => {
  const registry = withMemoryTools([], mockLtm());
  assert.equal(registry.length, 4);
  assert.ok(registry.find(t => t.name === 'remember'));
  assert.ok(registry.find(t => t.name === 'recall'));
  assert.ok(registry.find(t => t.name === 'forget'));
  assert.ok(registry.find(t => t.name === 'promote'));
});

test('remember tool stores with source human', async () => {
  const ltm = mockLtm();
  const registry = withMemoryTools([], ltm);
  const tool = registry.find(t => t.name === 'remember');
  const result = await tool.execute({ args: { text: 'Test fact', kind: 'domain', tags: ['a'] } });
  assert.equal(result.ok, true);
});

test('withMemoryTools returns original registry when ltm is null', () => {
  const base = [{ name: 'other' }];
  const registry = withMemoryTools(base, null);
  assert.equal(registry.length, 1);
});
