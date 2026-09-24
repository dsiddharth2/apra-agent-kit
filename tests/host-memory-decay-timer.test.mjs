// tests/host-memory-decay-timer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDecayPass, createDecayTimer } from '../host/memory/decay/timer.mjs';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

async function inMemoryStore() {
  const entries = new Map();
  return {
    async open() {},
    async close() {},
    async store(e) { entries.set(e.id, { ...e }); },
    async get(id) { const e = entries.get(id); return e ? { ...e } : null; },
    async update(id, patch) { const e = entries.get(id); const n = { ...e, ...patch }; entries.set(id, n); return n; },
    async remove(id) { entries.delete(id); },
    async query({ kinds, tags, states } = {}) {
      let r = [...entries.values()];
      if (kinds?.length) r = r.filter(e => kinds.includes(e.kind));
      if (states?.length) r = r.filter(e => states.includes(e.state));
      return r;
    },
    async purge({ states, olderThan } = {}) {
      let n = 0;
      for (const [id, e] of entries) {
        if (states?.includes(e.state) && (!olderThan || e.createdAt < olderThan)) { entries.delete(id); n++; }
      }
      return n;
    },
    async count() { return entries.size; },
  };
}

test('runDecayPass updates retrievalStrength for stale entries', async () => {
  const store = await inMemoryStore();
  await store.open();
  const entry = createMemoryEntry({ kind: 'domain', text: 'Stale fact', tags: ['a'] });
  entry.lastPromotedAt = new Date(Date.now() - 30 * 86400000).toISOString();
  await store.store(entry);
  const result = await runDecayPass(store);
  assert.equal(result.updated, 1);
  const updated = await store.get(entry.id);
  assert.ok(updated.retrievalStrength < 0.5);
});

test('runDecayPass skips rules', async () => {
  const store = await inMemoryStore();
  await store.open();
  const rule = createMemoryEntry({ kind: 'rule', text: 'Never delete', tags: ['safety'] });
  rule.lastPromotedAt = new Date(Date.now() - 90 * 86400000).toISOString();
  await store.store(rule);
  const result = await runDecayPass(store);
  assert.equal(result.updated, 0);
  const got = await store.get(rule.id);
  assert.equal(got.retrievalStrength, 1.0);
  assert.equal(got.state, 'active');
});

test('runDecayPass purges unavailable entries when enabled', async () => {
  const store = await inMemoryStore();
  await store.open();
  const old = createMemoryEntry({ kind: 'domain', text: 'Very old', tags: ['a'] });
  old.state = 'unavailable';
  old.retrievalStrength = 0.01;
  old.createdAt = new Date(Date.now() - 180 * 86400000).toISOString();
  await store.store(old);
  const result = await runDecayPass(store, { purgeOnDecay: true, purgeAfterDays: 90 });
  assert.equal(result.purged, 1);
});

test('createDecayTimer tick runs a pass', async () => {
  const store = await inMemoryStore();
  await store.open();
  const entry = createMemoryEntry({ kind: 'domain', text: 'Fact', tags: ['a'] });
  entry.lastPromotedAt = new Date(Date.now() - 14 * 86400000).toISOString();
  await store.store(entry);
  const timer = createDecayTimer(store, { logger: { info() {}, warn() {} } });
  const result = await timer.tick();
  assert.ok(result.updated >= 1);
  timer.stop();
});
