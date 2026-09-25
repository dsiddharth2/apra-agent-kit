// tests/eval-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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
  const correctness = s001.scores.correctness;
  assert.ok(correctness, JSON.stringify(s001.scores));
  assert.equal(correctness.pass, true, JSON.stringify(correctness));
  assert.equal(correctness.score, 1);
  // Vacuous exact-match (expected.status never applied) uses this exact reason.
  assert.notEqual(correctness.reason, 'status matched, no result check');
  assert.match(correctness.reason, /status/);
  assert.match(correctness.reason, /completed/);
  // Host snapshots store estimatedCostUsd, not estimatedCost.
  assert.equal(typeof s001.cost, 'number');
  assert.ok(s001.cost > 0, `cost should use estimatedCostUsd, got ${s001.cost}`);

  const s002 = report.results.find((r) => r.id === 's-002');
  assert.ok(s002);
  const content = s002.scores.content;
  assert.equal(content.pass, true, JSON.stringify(content));
  assert.equal(content.score, 1);
  assert.match(content.reason, /substrings found/);
  assert.match(content.reason, /hello/);
  assert.doesNotMatch(content.reason, /no substrings to check/);
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

test('runner: thrown execution is not graded as a failed actual', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-throw-'));
  const script = path.join(fixtureDir, 'scripts', 'simple-happy.json');
  await fs.writeFile(path.join(root, 'throw.json'), JSON.stringify({
    suite: 'throw',
    fleet: 'scripted',
    defaults: { timeout: 5000, strategy: 'open-ended' },
    cases: [{
      id: 't-001',
      description: 'execution throws before grading',
      tags: ['throw'],
      task: { goal: 'Say hello' },
      fleet: { script },
      scorers: [
        { name: 'correctness', grader: 'exact-match', expected: { status: 'failed' } },
        { name: 'efficiency', grader: 'budget-check', maxCost: 1 },
      ],
    }],
  }));

  // Invalid pool size throws inside the execution try, before graders run.
  // A synthetic { status: 'failed', budget: null } would pass both scorers.
  const prev = process.env.WORKER_POOL_SIZE;
  process.env.WORKER_POOL_SIZE = 'nope';
  try {
    const report = await runSuite('throw', {
      suiteDir: root,
      reportDir: null,
      configDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    });
    assert.equal(report.summary.passed, 0);
    assert.equal(report.summary.failed, 1);
    const r = report.results[0];
    assert.equal(r.status, 'failed');
    assert.equal(typeof r.durationMs, 'number');
    assert.equal(r.cost, 0);
    for (const name of ['correctness', 'efficiency']) {
      const s = r.scores[name];
      assert.equal(s.pass, false, JSON.stringify(s));
      assert.equal(s.score, 0);
      assert.match(s.reason, /^task error: /);
      assert.match(s.reason, /WORKER_POOL_SIZE/);
      assert.match(s.reason, /nope/);
    }
    assert.equal(r.scores.correctness.grader, 'exact-match');
    assert.equal(r.scores.efficiency.grader, 'budget-check');
  } finally {
    if (prev === undefined) delete process.env.WORKER_POOL_SIZE;
    else process.env.WORKER_POOL_SIZE = prev;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runner: unknown grader is a scorer error, not a rejected case', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-grader-'));
  const script = path.join(fixtureDir, 'scripts', 'simple-happy.json');
  await fs.writeFile(path.join(root, 'bad-grader.json'), JSON.stringify({
    suite: 'bad-grader',
    fleet: 'scripted',
    defaults: { timeout: 5000, strategy: 'open-ended' },
    cases: [{
      id: 'g-001',
      description: 'unknown grader',
      tags: ['grader'],
      task: { goal: 'Say hello' },
      fleet: { script },
      scorers: [
        { name: 'correctness', grader: 'exact-match', expected: { status: 'completed' } },
        { name: 'mystery', grader: 'not-a-grader' },
      ],
    }],
  }));
  try {
    const report = await runSuite('bad-grader', {
      suiteDir: root,
      reportDir: null,
      parallel: false,
      configDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    });
    assert.equal(report.summary.failed, 1);
    assert.equal(report.results[0].status, 'completed');
    assert.equal(report.results[0].scores.correctness.pass, true);
    const mystery = report.results[0].scores.mystery;
    assert.equal(mystery.pass, false);
    assert.equal(mystery.score, 0);
    assert.match(mystery.reason, /grader error: unknown grader/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runner: modules.evals defaults apply and explicit options win', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-cfg-'));
  const configDir = path.join(root, 'cfg');
  const reportDir = path.join(root, 'reports');
  const blockedReportDir = path.join(root, 'should-not-write');
  const overrideConfigDir = path.join(root, 'cfg-override');
  await fs.mkdir(configDir);
  await fs.mkdir(overrideConfigDir);
  const hostShell = (evals) => `export default {
    name: 'eval-defaults',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { evals: ${JSON.stringify(evals)} },
  };\n`;
  await fs.writeFile(path.join(configDir, 'host.config.mjs'), hostShell({
    suiteDir: fixtureDir,
    reportDir,
    parallel: true,
  }));
  await fs.writeFile(path.join(overrideConfigDir, 'host.config.mjs'), hostShell({
    suiteDir: path.join(root, 'missing-suites'),
    reportDir: blockedReportDir,
    parallel: true,
  }));
  try {
    const fromConfig = await runSuite('simple', { configDir });
    assert.equal(fromConfig.results.length, 2);
    assert.equal(fromConfig.summary.passed, 2);
    const written = await fs.readdir(reportDir);
    assert.equal(written.length, 1);
    assert.match(written[0], /^simple-/);

    const overridden = await runSuite('simple', {
      configDir: overrideConfigDir,
      suiteDir: fixtureDir,
      reportDir: null,
    });
    assert.equal(overridden.results.length, 2);
    await assert.rejects(fs.access(blockedReportDir));

    const missing = await runSuite('simple', {
      configDir: path.join(root, 'absent'),
      suiteDir: fixtureDir,
      reportDir: null,
    });
    assert.equal(missing.summary.total, 2);
    assert.match(missing.results[0].scores.correctness.reason, /task error:/);
    assert.match(missing.results[0].scores.correctness.reason, /host\.config/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
