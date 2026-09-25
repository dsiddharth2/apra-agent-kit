// tests/eval-baseline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test('findLatestReport: skips current report and returns previous', async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-baseline-'));
  const suiteName = 'demo';

  const previous = {
    timestamp: '2026-01-01T10:00:00.000Z',
    suite: suiteName,
    results: [],
    summary: { passed: 0, total: 0 },
  };
  const current = {
    timestamp: '2026-01-02T10:00:00.000Z',
    suite: suiteName,
    results: [],
    summary: { passed: 1, total: 1 },
  };

  await fs.writeFile(
    path.join(reportDir, `${suiteName}-${previous.timestamp.replace(/[:.]/g, '-')}.json`),
    JSON.stringify(previous),
  );
  await fs.writeFile(
    path.join(reportDir, `${suiteName}-${current.timestamp.replace(/[:.]/g, '-')}.json`),
    JSON.stringify(current),
  );

  const latest = await findLatestReport(suiteName, reportDir, { excludeTimestamp: current.timestamp });
  assert.equal(latest.timestamp, previous.timestamp);

  await fs.rm(reportDir, { recursive: true, force: true });
});
