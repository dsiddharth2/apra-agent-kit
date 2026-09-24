// tests/host-memory-decay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';
import { assertDecayEngine } from '../host/memory/decay/interface.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

const engine = createFsrs6Engine();

test('createFsrs6Engine passes assertDecayEngine', () => {
  assertDecayEngine(engine);
});

test('retrievability is 1.0 at time of promote', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const r = engine.computeRetrievability(entry, new Date(entry.lastPromotedAt));
  assert.ok(Math.abs(r - 1.0) < 0.01);
});

test('retrievability decays over 7 days', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const sevenDaysLater = new Date(new Date(entry.createdAt).getTime() + 7 * 86400000);
  const r = engine.computeRetrievability(entry, sevenDaysLater);
  assert.ok(r < 0.8, `expected < 0.8, got ${r}`);
  assert.ok(r > 0.3, `expected > 0.3, got ${r}`);
});

test('retrievability is substantially lower at 90 days', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const sevenDaysLater = new Date(new Date(entry.createdAt).getTime() + 7 * 86400000);
  const ninetyDaysLater = new Date(new Date(entry.createdAt).getTime() + 90 * 86400000);
  const r7 = engine.computeRetrievability(entry, sevenDaysLater);
  const r90 = engine.computeRetrievability(entry, ninetyDaysLater);
  assert.ok(r90 < 0.25, `expected < 0.25, got ${r90}`);
  assert.ok(r90 < r7, `expected 90-day r (${r90}) < 7-day r (${r7})`);
});

test('computeState maps thresholds correctly', () => {
  assert.equal(engine.computeState(0.9), 'active');
  assert.equal(engine.computeState(0.7), 'active');
  assert.equal(engine.computeState(0.5), 'dormant');
  assert.equal(engine.computeState(0.3), 'silent');
  assert.equal(engine.computeState(0.05), 'unavailable');
});

test('processReview restores retrievalStrength to 1.0', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  entry.retrievalStrength = 0.4;
  const updated = engine.processReview(entry, 3);
  assert.equal(updated.retrievalStrength, 1.0);
  assert.equal(updated.state, 'active');
});

test('processReview increases stability', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const original = entry.stability;
  const updated = engine.processReview(entry, 3);
  assert.ok(updated.stability > original, `stability should increase: ${updated.stability} > ${original}`);
});

test('processReview with rating 1 (Again) reduces stability', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  entry.stability = 5.0;
  const updated = engine.processReview(entry, 1);
  assert.ok(updated.stability < 5.0);
  assert.equal(updated.lapses, 1);
});

test('shouldProcess returns false for rules', () => {
  const rule = createMemoryEntry({ kind: 'rule', text: 'Never delete', tags: ['safety'] });
  assert.equal(engine.shouldProcess(rule), false);
});

test('shouldProcess returns true for domain facts', () => {
  const fact = createMemoryEntry({ kind: 'domain', text: 'DB on port 5432', tags: ['db'] });
  assert.equal(engine.shouldProcess(fact), true);
});

test('numeric stability: zero elapsed time', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const r = engine.computeRetrievability(entry, new Date(entry.createdAt));
  assert.ok(Number.isFinite(r));
});

test('numeric stability: very large elapsed time', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const farFuture = new Date(new Date(entry.createdAt).getTime() + 365 * 10 * 86400000);
  const r = engine.computeRetrievability(entry, farFuture);
  assert.ok(Number.isFinite(r));
  assert.ok(r >= 0 && r <= 1);
});
