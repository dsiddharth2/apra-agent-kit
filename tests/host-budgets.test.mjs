// tests/host-budgets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createBudgets } = await import('../host/budgets.mjs');

test('fresh budget check returns ok', () => {
  const b = createBudgets({ maxIterations: 10 });
  assert.deepEqual(b.check(), { ok: true });
});

test('maxIterations triggers after N records', () => {
  const b = createBudgets({ maxIterations: 3 });
  b.record({ inputTokens: 100, outputTokens: 50 });
  b.record({ inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(b.check(), { ok: true });
  b.record({ inputTokens: 100, outputTokens: 50 });
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_iterations');
});

test('maxTokens triggers when total exceeds cap', () => {
  const b = createBudgets({ maxTokens: 500 });
  b.record({ inputTokens: 200, outputTokens: 100 });
  assert.deepEqual(b.check(), { ok: true });
  b.record({ inputTokens: 150, outputTokens: 100 });
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_tokens');
});

test('maxCostUsd triggers based on pricing', () => {
  const b = createBudgets({
    maxCostUsd: 0.01,
    pricing: { inputPer1k: 1.00, outputPer1k: 1.00 },
  });
  b.record({ inputTokens: 5, outputTokens: 5 });
  assert.deepEqual(b.check(), { ok: true });
  b.record({ inputTokens: 5, outputTokens: 5 });
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_cost');
});

test('timeoutMs triggers based on elapsed time', async () => {
  const b = createBudgets({ timeoutMs: 50 });
  assert.deepEqual(b.check(), { ok: true });
  await new Promise(r => setTimeout(r, 60));
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('snapshot returns accumulated values', () => {
  const b = createBudgets({ maxIterations: 100 });
  b.record({ inputTokens: 100, outputTokens: 50 });
  b.record({ inputTokens: 200, outputTokens: 100 });
  const snap = b.snapshot();
  assert.equal(snap.iterations, 2);
  assert.equal(snap.totalInputTokens, 300);
  assert.equal(snap.totalOutputTokens, 150);
  assert.equal(snap.totalTokens, 450);
  assert.equal(typeof snap.estimatedCostUsd, 'number');
  assert.equal(typeof snap.elapsedMs, 'number');
  assert.ok(snap.elapsedMs >= 0);
});

test('uses default pricing when none provided', () => {
  const b = createBudgets({ maxCostUsd: 100 });
  b.record({ inputTokens: 1000, outputTokens: 1000 });
  const snap = b.snapshot();
  assert.ok(snap.estimatedCostUsd > 0);
});

test('unconfigured caps are not enforced', () => {
  const b = createBudgets({});
  for (let i = 0; i < 100; i++) {
    b.record({ inputTokens: 10000, outputTokens: 10000 });
  }
  assert.deepEqual(b.check(), { ok: true });
});

test('estimates tokens from chars when counts are missing', () => {
  const b = createBudgets({ maxTokens: 100 });
  b.record({ responseChars: 200 });
  const snap = b.snapshot();
  assert.equal(snap.totalInputTokens, 0);
  assert.equal(snap.totalOutputTokens, 50);
  assert.equal(snap.totalTokens, 50);
});
