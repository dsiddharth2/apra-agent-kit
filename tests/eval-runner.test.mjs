// tests/eval-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from '../evals/runner.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval-suites');

test('runner: loads suite and runs all cases', async () => {
  const report = await runSuite('simple', {
    suiteDir: fixtureDir,
    reportDir: null, // don't write report file
    configDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  assert.equal(report.suite, 'simple');
  assert.equal(report.results.length, 2);
  assert.equal(report.summary.total, 2);

  const s001 = report.results.find((r) => r.id === 's-001');
  assert.ok(s001);
  assert.ok(
    Object.values(s001.scores).every((s) => s.pass),
    `s-001 scorers: ${JSON.stringify(s001.scores)}`,
  );

  const s002 = report.results.find((r) => r.id === 's-002');
  assert.ok(s002);
  assert.equal(s002.scores.content.pass, true, JSON.stringify(s002.scores.content));
});

test('runner: report has correct structure', async () => {
  const report = await runSuite('simple', {
    suiteDir: fixtureDir,
    reportDir: null,
    configDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  const r = report.results[0];
  assert.ok(r.id);
  assert.ok(r.scores);
  assert.ok(typeof r.durationMs === 'number');
  assert.ok(report.summary.byTag);
});

test('runner: filters by tag', async () => {
  const report = await runSuite('simple', {
    suiteDir: fixtureDir,
    reportDir: null,
    tags: ['output-check'],
    configDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].id, 's-002');
});
