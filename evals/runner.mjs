// evals/runner.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGrader } from './graders/index.mjs';
import { findLatestReport, findReportByTimestamp, diffReports } from './baseline.mjs';

async function loadSuite(suiteName, suiteDir) {
  const suitePath = path.join(suiteDir, `${suiteName}.json`);
  const text = await fs.readFile(suitePath, 'utf8');
  return { ...JSON.parse(text), _dir: path.dirname(suitePath) };
}

async function loadFleetScript(scriptPath, suiteDir) {
  const resolved = path.resolve(suiteDir, scriptPath);
  const text = await fs.readFile(resolved, 'utf8');
  return JSON.parse(text);
}

async function createFleet(suiteFleet, caseFleet, suiteDir) {
  if (suiteFleet === 'live') {
    const { ensureApralabs } = await import('../transport/ensure-apralabs.mjs');
    ensureApralabs();
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    return spawnFleet();
  }
  const scriptPath = caseFleet?.script;
  if (!scriptPath) throw new Error('scripted suite requires fleet.script on each case');
  const script = await loadFleetScript(scriptPath, suiteDir);
  const { createScriptedFleetApi } = await import('../tests/helpers/scripted-fleet.mjs');
  return { fleetApi: createScriptedFleetApi(script), stop: async () => {} };
}

async function runCase(testCase, suite, { configDir, parallel }) {
  const start = Date.now();
  const timeout = testCase.timeout ?? suite.defaults?.timeout ?? 30000;
  const strategy = testCase.strategy ?? suite.defaults?.strategy ?? undefined;
  const suiteDir = suite._dir;

  let fleet;
  try {
    fleet = await createFleet(suite.fleet, testCase.fleet, suiteDir);
  } catch (err) {
    const errorScores = {};
    for (const s of testCase.scorers) {
      errorScores[s.name] = { pass: false, score: 0, grader: s.grader, reason: `fleet error: ${err.message}` };
    }
    return {
      id: testCase.id, description: testCase.description ?? '', tags: testCase.tags ?? [],
      status: 'failed', durationMs: Date.now() - start, cost: 0, scores: errorScores,
    };
  }

  const api = fleet.fleetApi ?? fleet;
  let actual;
  let caseWorkdir;
  try {
    const { createWorkerDispatcher } = await import('../pool/index.mjs');
    const { extendRegistry } = await import('../host/tools/registry.mjs');
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const { loadConfig } = await import('../host/config.mjs');

    const dispatcherEnv = { ...process.env, NODE_ENV: 'test' };
    if (parallel) {
      caseWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-case-'));
      dispatcherEnv.WORKER_POOL_ROOT = caseWorkdir;
    }
    const dispatcher = await createWorkerDispatcher({ fleetApi: api, env: dispatcherEnv });
    let timer;
    try {
      const ac = new AbortController();
      timer = setTimeout(() => ac.abort('timeout'), timeout);
      const config = await loadConfig(configDir ?? '.', { ...process.env, NODE_ENV: 'test' });
      const toolRegistry = extendRegistry();
      const runLoopConfig = {
        ...(config.modules?.runLoop ?? {}),
        enabled: true,
        ...(strategy ? { strategy } : {}),
        agentName: config.name ?? 'eval-agent',
        agentDescription: config.agentDescription ?? '',
      };
      const routerConfig = config.modules?.router ?? { enabled: false };
      const budgetsConfig = config.modules?.budgets ?? null;

      actual = await executeHostedTask(
        { id: testCase.id, ...testCase.task, ...(strategy ? { strategy } : {}) },
        { api, activeDispatcher: dispatcher, toolRegistry, runLoopConfig, routerConfig, budgetsConfig, guardrailsMod: null, jobs: null, signal: ac.signal },
      );
    } finally {
      clearTimeout(timer);
      await dispatcher.close();
    }
  } catch (err) {
    // A throw is not a gradeable actual. Synthetic { status: 'failed', budget: null }
    // still passes exact-match (expected status failed) and budget-check (null budget).
    const errorScores = {};
    for (const s of testCase.scorers) {
      errorScores[s.name] = { pass: false, score: 0, grader: s.grader, reason: `task error: ${err.message}` };
    }
    return {
      id: testCase.id, description: testCase.description ?? '', tags: testCase.tags ?? [],
      status: 'failed', durationMs: Date.now() - start, cost: 0, scores: errorScores,
    };
  } finally {
    if (caseWorkdir) await fs.rm(caseWorkdir, { recursive: true, force: true }).catch(() => {});
    await fleet.stop?.();
  }

  const scores = {};
  for (const scorer of testCase.scorers) {
    const scorerInput = {
      ...scorer,
      ...(scorer.expected ?? {}),
      _task: testCase.task,
      _fleetApi: api,
    };
    try {
      const graderFn = resolveGrader(scorer.grader, { suiteDir });
      const result = await graderFn(scorerInput, actual);
      scores[scorer.name] = { ...result, grader: scorer.grader };
    } catch (err) {
      scores[scorer.name] = { pass: false, score: 0, grader: scorer.grader, reason: `grader error: ${err.message}` };
    }
  }

  return {
    id: testCase.id, description: testCase.description ?? '', tags: testCase.tags ?? [],
    status: actual.status, durationMs: Date.now() - start,
    cost: actual.budget?.estimatedCost ?? actual.budget?.estimatedCostUsd ?? 0, scores,
  };
}

function buildSummary(results) {
  const passed = results.filter(r => Object.values(r.scores).every(s => s.pass)).length;
  const failed = results.length - passed;
  const cost = results.reduce((sum, r) => sum + r.cost, 0);
  const wallMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  const byTag = {};
  for (const r of results) {
    const casePassed = Object.values(r.scores).every(s => s.pass);
    for (const tag of r.tags) {
      if (!byTag[tag]) byTag[tag] = { total: 0, passed: 0 };
      byTag[tag].total++;
      if (casePassed) byTag[tag].passed++;
    }
  }
  return { total: results.length, passed, failed, cost: Math.round(cost * 1000) / 1000, wallMs, byTag };
}

async function readEvalsConfig(configDir) {
  const dir = configDir ?? '.';
  const mjsPath = path.join(dir, 'host.config.mjs');
  try {
    const mod = await import(pathToFileURL(mjsPath).href);
    const evals = mod.default?.modules?.evals;
    return evals && typeof evals === 'object' ? evals : {};
  } catch (err) {
    const missing = err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message ?? '');
    if (!missing) return {};
  }
  try {
    const text = await fs.readFile(path.join(dir, 'host.config.json'), 'utf8');
    const evals = JSON.parse(text)?.modules?.evals;
    return evals && typeof evals === 'object' ? evals : {};
  } catch {
    return {};
  }
}

function configPath(value, fallback) {
  if (typeof value === 'string' && value.length > 0) return path.resolve(value);
  return fallback;
}

// CLI and explicit options win. Missing host config falls back to the hardcoded dirs.
async function resolveEvalDefaults(options = {}) {
  const needConfig = options.suiteDir === undefined
    || options.reportDir === undefined
    || options.parallel === undefined;
  const evals = needConfig ? await readEvalsConfig(options.configDir) : {};

  const suiteDir = options.suiteDir ?? configPath(evals.suiteDir, path.resolve('.', 'evals', 'suites'));
  const reportDir = options.reportDir === null
    ? null
    : (options.reportDir !== undefined
      ? options.reportDir
      : configPath(evals.reportDir, path.resolve('.', 'evals', 'reports')));
  const parallel = options.parallel !== undefined
    ? options.parallel
    : (typeof evals.parallel === 'boolean' ? evals.parallel : false);

  return { suiteDir, reportDir, parallel };
}

export async function runSuite(suiteName, options = {}) {
  const { tags, configDir } = options;
  const {
    suiteDir: effectiveSuiteDir,
    reportDir: effectiveReportDir,
    parallel: effectiveParallel,
  } = await resolveEvalDefaults(options);
  const suite = await loadSuite(suiteName, effectiveSuiteDir);
  let cases = suite.cases;
  if (tags && tags.length > 0) {
    const tagSet = new Set(tags);
    cases = cases.filter(c => (c.tags ?? []).some(t => tagSet.has(t)));
  }

  let results;
  if (effectiveParallel) {
    results = await Promise.all(cases.map(c => runCase(c, suite, { configDir, parallel: true })));
  } else {
    results = [];
    for (const c of cases) {
      results.push(await runCase(c, suite, { configDir, parallel: false }));
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    suite: suite.suite,
    fleet: suite.fleet,
    results,
    summary: buildSummary(results),
  };

  if (effectiveReportDir) {
    await fs.mkdir(effectiveReportDir, { recursive: true });
    const filename = `${suite.suite}-${report.timestamp.replace(/[:.]/g, '-')}.json`;
    await fs.writeFile(path.join(effectiveReportDir, filename), JSON.stringify(report, null, 2));
  }

  return report;
}

export async function runAllSuites(options = {}) {
  const resolved = await resolveEvalDefaults(options);
  const files = await fs.readdir(resolved.suiteDir);
  const suiteNames = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  const reports = [];
  for (const name of suiteNames) {
    reports.push(await runSuite(name, {
      ...options,
      suiteDir: resolved.suiteDir,
      reportDir: resolved.reportDir,
      parallel: resolved.parallel,
    }));
  }
  return reports;
}

// `--flag value` and `--flag=value` (npm run eval -- --suite=demo --baseline=latest).
function flagValue(args, flag) {
  const prefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// CLI entry point
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => flagValue(args, flag);
  const has = (flag) => args.includes(flag);

  const suiteName = get('--suite');
  const tag = get('--tag');
  const baselineArg = get('--baseline');
  const resolved = await resolveEvalDefaults({
    parallel: has('--parallel') ? true : undefined,
  });
  const runOptions = {
    tags: tag ? [tag] : undefined,
    parallel: resolved.parallel,
    baseline: baselineArg,
    suiteDir: resolved.suiteDir,
    reportDir: resolved.reportDir,
  };

  try {
    if (suiteName) {
      const report = await runSuite(suiteName, runOptions);
      printReport(report);
      if (baselineArg) await printBaseline(report, baselineArg, resolved.reportDir);
      process.exit(report.summary.failed > 0 ? 1 : 0);
    } else {
      const reports = await runAllSuites(runOptions);
      for (const report of reports) {
        printReport(report);
        if (baselineArg) await printBaseline(report, baselineArg, resolved.reportDir);
      }
      const anyFailed = reports.some(r => r.summary.failed > 0);
      process.exit(anyFailed ? 1 : 0);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function printReport(report) {
  const { suite, timestamp, fleet, results, summary } = report;
  console.log(`\nfleet-agent-kit eval — ${suite} — ${timestamp} (${fleet})\n`);
  for (const r of results) {
    const allPass = Object.values(r.scores).every(s => s.pass);
    const icon = allPass ? '✓' : '✗';
    const scoreParts = Object.entries(r.scores).map(([name, s]) => `${name}:${s.pass ? '✓' : '✗'}`).join(' ');
    const time = (r.durationMs / 1000).toFixed(1) + 's';
    const cost = r.cost > 0 ? `$${r.cost.toFixed(3)}` : '';
    console.log(`  ${icon} ${r.id}  ${r.description}  ${scoreParts}  ${time}  ${cost}`);
    if (!allPass) {
      for (const [name, s] of Object.entries(r.scores)) {
        if (!s.pass) console.log(`    ${name}: ${s.reason}`);
      }
    }
  }
  console.log(`\n  ${summary.passed}/${summary.total} passed · ${summary.failed} failed · $${summary.cost.toFixed(2)} total · ${(summary.wallMs / 1000).toFixed(0)}s wall`);
  if (Object.keys(summary.byTag).length > 0) {
    console.log('\n  By tag:');
    for (const [tag, data] of Object.entries(summary.byTag)) {
      const pct = data.total > 0 ? Math.round(data.passed / data.total * 100) : 0;
      console.log(`    ${tag.padEnd(20)} ${data.passed}/${data.total}  ${pct}%`);
    }
  }
  console.log('');
}

async function printBaseline(report, baselineArg, reportDir = path.resolve('.', 'evals', 'reports')) {
  if (!reportDir) { console.log('  No baseline found.\n'); return; }
  const baseline = baselineArg === 'latest'
    ? await findLatestReport(report.suite, reportDir, { excludeTimestamp: report.timestamp })
    : await findReportByTimestamp(report.suite, baselineArg, reportDir);
  if (!baseline) { console.log('  No baseline found.\n'); return; }

  const diff = diffReports(baseline, report);
  console.log(`  Baseline: ${baseline.timestamp}\n`);
  for (const f of diff.fixed) console.log(`  ${f.id}  FIXED`);
  for (const r of diff.regressions) console.log(`  ${r.id}  REGRESSION`);
  for (const s of diff.scoreChanges) console.log(`  ${s.id}  ${s.scorer} ${s.from}→${s.to}`);
  for (const a of diff.added) console.log(`  ${a.id}  NEW`);
  for (const r of diff.removed) console.log(`  ${r.id}  REMOVED`);

  const bSummary = baseline.summary ?? {};
  console.log(`\n  ${report.summary.passed}/${report.summary.total} passed (was ${bSummary.passed ?? '?'}/${bSummary.total ?? '?'}) · ${diff.fixed.length} fixed · ${diff.regressions.length} regressions\n`);
}
