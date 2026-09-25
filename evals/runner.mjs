// evals/runner.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGrader } from './graders/index.mjs';

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

async function runCase(testCase, suite, { configDir }) {
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
  try {
    const { createWorkerDispatcher } = await import('../pool/index.mjs');
    const { extendRegistry } = await import('../host/tools/registry.mjs');
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const { loadConfig } = await import('../host/config.mjs');

    const dispatcher = await createWorkerDispatcher({ fleetApi: api, env: { ...process.env, NODE_ENV: 'test' } });
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

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), timeout);
    try {
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
    await fleet.stop?.();
  }

  const scores = {};
  for (const scorer of testCase.scorers) {
    const graderFn = resolveGrader(scorer.grader, { suiteDir });
    const scorerInput = {
      ...scorer,
      ...(scorer.expected ?? {}),
      _task: testCase.task,
      _fleetApi: api,
    };
    try {
      const result = await graderFn(scorerInput, actual);
      scores[scorer.name] = { ...result, grader: scorer.grader };
    } catch (err) {
      scores[scorer.name] = { pass: false, score: 0, grader: scorer.grader, reason: `grader error: ${err.message}` };
    }
  }

  return {
    id: testCase.id, description: testCase.description ?? '', tags: testCase.tags ?? [],
    status: actual.status, durationMs: Date.now() - start,
    cost: actual.budget?.estimatedCost ?? 0, scores,
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

export async function runSuite(suiteName, {
  tags, parallel = false, configDir, baseline, suiteDir, reportDir,
} = {}) {
  const effectiveSuiteDir = suiteDir ?? path.resolve('.', 'evals', 'suites');
  const effectiveReportDir = reportDir === null ? null : (reportDir ?? path.resolve('.', 'evals', 'reports'));
  const suite = await loadSuite(suiteName, effectiveSuiteDir);
  let cases = suite.cases;
  if (tags && tags.length > 0) {
    const tagSet = new Set(tags);
    cases = cases.filter(c => (c.tags ?? []).some(t => tagSet.has(t)));
  }

  let results;
  if (parallel) {
    results = await Promise.all(cases.map(c => runCase(c, suite, { configDir })));
  } else {
    results = [];
    for (const c of cases) {
      results.push(await runCase(c, suite, { configDir }));
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
  const suiteDir = options.suiteDir ?? path.resolve('.', 'evals', 'suites');
  const files = await fs.readdir(suiteDir);
  const suiteNames = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  const reports = [];
  for (const name of suiteNames) {
    reports.push(await runSuite(name, { ...options, suiteDir }));
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
  const parallel = has('--parallel');
  const baselineArg = get('--baseline');

  try {
    if (suiteName) {
      const report = await runSuite(suiteName, { tags: tag ? [tag] : undefined, parallel, baseline: baselineArg });
      printReport(report);
      if (baselineArg) await printBaseline(report, baselineArg);
      process.exit(report.summary.failed > 0 ? 1 : 0);
    } else {
      const reports = await runAllSuites({ tags: tag ? [tag] : undefined, parallel, baseline: baselineArg });
      for (const report of reports) {
        printReport(report);
        if (baselineArg) await printBaseline(report, baselineArg);
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

async function printBaseline(report, baselineArg) {
  // Baseline comparison — implemented in Task 9
}
