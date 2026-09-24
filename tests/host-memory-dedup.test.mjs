import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trigramSimilarity } from '../host/memory/dedup/trigram.mjs';
import { createDedupGate } from '../host/memory/dedup/index.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';

test('trigramSimilarity: identical strings → 1.0', () => {
  assert.equal(trigramSimilarity('hello world', 'hello world'), 1.0);
});

test('trigramSimilarity: completely different → near 0', () => {
  const score = trigramSimilarity('the quick brown fox', 'xyz abc def ghi');
  assert.ok(score < 0.2, `expected < 0.2, got ${score}`);
});

test('trigramSimilarity: near-duplicate → > 0.9', () => {
  const score = trigramSimilarity(
    'The staging DB resets every Sunday at 2am',
    'The staging DB resets every Sunday at 2am UTC',
  );
  assert.ok(score > 0.9, `expected > 0.9, got ${score}`);
});

test('trigramSimilarity: partial overlap → 0.5-0.9', () => {
  const score = trigramSimilarity(
    'The staging DB resets weekly',
    'The staging database resets every Sunday at 2am',
  );
  assert.ok(score > 0.3 && score < 0.9, `expected 0.3-0.9, got ${score}`);
});

test('dedup gate: creates new entry when no match', async () => {
  const store = { entries: new Map() };
  store.query = async () => [];
  store.store = async (e) => store.entries.set(e.id, e);
  const gate = createDedupGate({ store });
  const entry = createMemoryEntry({ kind: 'domain', text: 'Brand new fact', tags: ['new'] });
  const result = await gate.process(entry);
  assert.equal(result.action, 'created');
});

test('dedup gate: reinforces on >92% match', async () => {
  const existing = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am', tags: ['db'] });
  const store = {
    query: async () => [existing],
    update: async (id, patch) => ({ ...existing, ...patch }),
    store: async () => {},
  };
  const engine = createFsrs6Engine();
  const gate = createDedupGate({ store, engine });
  const incoming = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets every Sunday at 2AM', tags: ['db'] });
  const result = await gate.process(incoming);
  assert.equal(result.action, 'reinforced');
});

test('dedup gate: merges on 75-92% match, human text wins over agent', async () => {
  const existing = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am', tags: ['db'], source: 'agent' });
  existing.source = 'agent';
  let updatedPatch = null;
  const store = {
    query: async () => [existing],
    update: async (id, patch) => { updatedPatch = patch; return { ...existing, ...patch }; },
    store: async () => {},
  };
  const engine = createFsrs6Engine();
  const gate = createDedupGate({ store, engine });
  const incoming = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am UTC', tags: ['db'], source: 'human' });
  const result = await gate.process(incoming);
  assert.equal(result.action, 'merged');
  assert.equal(updatedPatch.text, incoming.text);
});

test('dedup gate: creates when tags do not overlap despite identical text', async () => {
  const existing = createMemoryEntry({ kind: 'domain', text: 'use UTC always', tags: ['timezone'] });
  const store = {
    query: async () => [existing],
    update: async () => { throw new Error('should not update'); },
    store: async (e) => e,
  };
  const engine = createFsrs6Engine();
  const gate = createDedupGate({ store, engine });
  const incoming = createMemoryEntry({ kind: 'domain', text: 'use UTC always', tags: ['scheduling'] });
  const result = await gate.process(incoming);
  assert.equal(result.action, 'created');
});
