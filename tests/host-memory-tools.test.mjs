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
  assert.equal(tool.inputSchema.safeParse({}).success, false);
  const result = await tool.run({ args: { text: 'Test fact', kind: 'domain', tags: ['a'] } });
  assert.equal(result.ok, true);
});

test('remember tool returns ok false when the store rejects the entry', async () => {
  const ltm = mockLtm();
  ltm.store = async () => ({ action: 'rejected', reason: 'max_entries' });
  const tool = withMemoryTools([], ltm).find(t => t.name === 'remember');
  const result = await tool.run({ args: { text: 'Test fact', kind: 'domain' } });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'max_entries');
});

test('recall tool emits memory:recall:tool', async () => {
  const emitted = [];
  const ltm = mockLtm();
  await ltm.store({ id: 'mem-1', text: 'Fact', kind: 'domain' });
  const events = { emit(type, payload) { emitted.push({ type, payload }); } };
  const tool = withMemoryTools([], ltm, events).find(t => t.name === 'recall');
  const result = await tool.run({ args: { tags: ['a'] } });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'memory:recall:tool');
  assert.equal(emitted[0].payload.count, 1);
  assert.equal(emitted[0].payload.facts.length, 1);
});

test('withMemoryTools returns original registry when ltm is null', () => {
  const base = [{ name: 'other' }];
  const registry = withMemoryTools(base, null);
  assert.equal(registry.length, 1);
});
