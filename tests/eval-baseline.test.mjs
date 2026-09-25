// tests/eval-baseline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffReports, findLatestReport } from '../evals/baseline.mjs';

test('diffReports: detects fixed case', () => {
  const baseline = { results: [{ id: 'c-1', scores: { correctness: { pass: false, score: 0 } } }] };
  const current = { results: [{ id: 'c-1', scores: { correctness: { pass: true, score: 1 } } }] };
  const diff = diffReports(baseline, current);
  assert.equal(diff.fixed.length, 1);
  assert.equal(diff.fixed[0].id, 'c-1');
});

test('diffReports: detects regression', () => {
  const baseline = { results: [{ id: 'c-1', scores: { correctness: { pass: true, score: 1 } } }] };
  const current = { results: [{ id: 'c-1', scores: { correctness: { pass: false, score: 0 } } }] };
  const diff = diffReports(baseline, current);
  assert.equal(diff.regressions.length, 1);
});

test('diffReports: detects new case', () => {
  const baseline = { results: [] };
  const current = { results: [{ id: 'c-1', scores: { correctness: { pass: true, score: 1 } } }] };
  const diff = diffReports(baseline, current);
  assert.equal(diff.added.length, 1);
});

test('diffReports: detects removed case', () => {
  const baseline = { results: [{ id: 'c-1', scores: { correctness: { pass: true, score: 1 } } }] };
  const current = { results: [] };
  const diff = diffReports(baseline, current);
  assert.equal(diff.removed.length, 1);
});

test('diffReports: detects score change without pass change', () => {
  const baseline = { results: [{ id: 'c-1', scores: { eff: { pass: true, score: 0.9 } } }], summary: { passed: 1 } };
  const current = { results: [{ id: 'c-1', scores: { eff: { pass: true, score: 0.5 } } }], summary: { passed: 1 } };
  const diff = diffReports(baseline, current);
  assert.equal(diff.scoreChanges.length, 1);
});
