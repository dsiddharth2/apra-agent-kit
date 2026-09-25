# Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone eval harness for Fleet Agent Kit that grades agent output using multiple scorers, compares against baselines, and ships with the create template.

**Architecture:** Standalone `evals/` directory that imports `executeHostedTask()` from the host and `createScriptedFleetApi()` from test helpers. Seven graders (exact-match, contains, pattern, trajectory-match, budget-check, llm-judge, custom) resolved by a factory. Runner loads JSON suites, executes cases, writes JSON reports, and diffs against baselines. Template integration ships eval scaffolding with every new agent.

**Tech Stack:** Node.js 22+, `node:test` for harness tests, `node:assert/strict` for assertions, `node:fs/promises` for I/O, existing `createScriptedFleetApi`/`createMockFleetApi`/`createWorkerDispatcher` from kit.

**Spec:** `docs/specs/eval-harness-spec.md`

---

### Task 1: exact-match grader

**Files:**
- Create: `evals/graders/exact-match.mjs`
- Test: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/eval-graders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import exactMatch from '../evals/graders/exact-match.mjs';

test('exact-match: passes when result matches', () => {
  const expected = { result: { count: 3 } };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('exact-match: fails when result differs', () => {
  const expected = { result: { count: 3 } };
  const actual = { status: 'completed', result: { count: 5 }, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
});

test('exact-match: checks status when expected.status present', () => {
  const expected = { status: 'completed', result: { count: 3 } };
  const actual = { status: 'failed', result: { count: 3 }, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, false);
});

test('exact-match: passes with status match', () => {
  const expected = { status: 'budget_exceeded' };
  const actual = { status: 'budget_exceeded', result: null, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: FAIL — module `../evals/graders/exact-match.mjs` not found

- [ ] **Step 3: Write the implementation**

```js
// evals/graders/exact-match.mjs
import { deepStrictEqual } from 'node:assert';

export default function exactMatch(expected, actual) {
  if (expected.status && actual.status !== expected.status) {
    return { pass: false, score: 0, reason: `status: expected "${expected.status}", got "${actual.status}"` };
  }
  if (expected.result === undefined) {
    return { pass: true, score: 1, reason: 'status matched, no result check' };
  }
  try {
    deepStrictEqual(actual.result, expected.result);
    return { pass: true, score: 1, reason: 'result matched' };
  } catch {
    return {
      pass: false, score: 0,
      reason: `expected: ${JSON.stringify(expected.result)}, got: ${JSON.stringify(actual.result)}`,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add evals/graders/exact-match.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add exact-match grader with tests"
```

---

### Task 2: contains grader

**Files:**
- Create: `evals/graders/contains.mjs`
- Modify: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/eval-graders.test.mjs`:

```js
import contains from '../evals/graders/contains.mjs';

test('contains: passes when all substrings found', () => {
  const expected = { substrings: ['invoice', 'mismatch'] };
  const actual = { status: 'completed', result: 'Found invoice mismatch in ledger', history: [], budget: null };
  const r = contains(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('contains: fails with partial match', () => {
  const expected = { substrings: ['invoice', 'mismatch', 'total'] };
  const actual = { status: 'completed', result: 'Found invoice in ledger', history: [], budget: null };
  const r = contains(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.score > 0.3 && r.score < 0.4); // 1/3
  assert.ok(r.reason.includes('mismatch'));
  assert.ok(r.reason.includes('total'));
});

test('contains: stringifies non-string result', () => {
  const expected = { substrings: ['count', '3'] };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = contains(expected, actual);
  assert.equal(r.pass, true);
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 3 new tests FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// evals/graders/contains.mjs
export default function contains(expected, actual) {
  const text = typeof actual.result === 'string'
    ? actual.result
    : JSON.stringify(actual.result ?? '');
  const subs = expected.substrings ?? [];
  if (subs.length === 0) return { pass: true, score: 1, reason: 'no substrings to check' };
  const missing = subs.filter(s => !text.includes(s));
  const found = subs.length - missing.length;
  const score = found / subs.length;
  if (missing.length === 0) {
    return { pass: true, score: 1, reason: `all ${subs.length} substrings found` };
  }
  return {
    pass: false,
    score: Math.round(score * 100) / 100,
    reason: `missing: ${missing.map(s => `'${s}'`).join(', ')}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add evals/graders/contains.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add contains grader with tests"
```

---

### Task 3: pattern grader

**Files:**
- Create: `evals/graders/pattern.mjs`
- Modify: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/eval-graders.test.mjs`:

```js
import pattern from '../evals/graders/pattern.mjs';

test('pattern: passes when regex matches', () => {
  const expected = { pattern: 'found \\d+ mismatches' };
  const actual = { status: 'completed', result: 'found 3 mismatches in ledger', history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('pattern: fails when regex does not match', () => {
  const expected = { pattern: 'found \\d+ mismatches' };
  const actual = { status: 'completed', result: 'no issues found', history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
});

test('pattern: respects flags', () => {
  const expected = { pattern: 'HELLO', flags: 'i' };
  const actual = { status: 'completed', result: 'hello world', history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, true);
});

test('pattern: stringifies non-string result', () => {
  const expected = { pattern: '"count":3' };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, true);
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 4 new tests FAIL

- [ ] **Step 3: Write the implementation**

```js
// evals/graders/pattern.mjs
export default function pattern(expected, actual) {
  const text = typeof actual.result === 'string'
    ? actual.result
    : JSON.stringify(actual.result ?? '');
  const re = new RegExp(expected.pattern, expected.flags ?? '');
  const matched = re.test(text);
  return {
    pass: matched,
    score: matched ? 1 : 0,
    reason: matched ? `matched /${expected.pattern}/` : `no match for /${expected.pattern}/`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add evals/graders/pattern.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add pattern grader with tests"
```

---

### Task 4: trajectory-match grader

**Files:**
- Create: `evals/graders/trajectory-match.mjs`
- Modify: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/eval-graders.test.mjs`:

```js
import trajectoryMatch from '../evals/graders/trajectory-match.mjs';

const historyWith = (...tools) => tools.map(tool => ({ type: 'action', tool }));

test('trajectory-match: strict passes with exact order', () => {
  const expected = { mode: 'strict', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather', 'forecast'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: strict fails with wrong order', () => {
  const expected = { mode: 'strict', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('forecast', 'weather'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, false);
});

test('trajectory-match: unordered passes regardless of order', () => {
  const expected = { mode: 'unordered', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('forecast', 'weather'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: unordered fails with missing tool', () => {
  const expected = { mode: 'unordered', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather'), budget: null };
  const r = trajectoryMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('forecast'));
});

test('trajectory-match: subset passes when no extra tools', () => {
  const expected = { mode: 'subset', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: subset fails with unexpected tool', () => {
  const expected = { mode: 'subset', trajectory: [{ tool: 'weather' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather', 'delete-all'), budget: null };
  const r = trajectoryMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('delete-all'));
});

test('trajectory-match: superset (default) passes with extra tools', () => {
  const expected = { trajectory: [{ tool: 'weather' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather', 'forecast', 'geocode'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: superset fails when expected tool missing', () => {
  const expected = { trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather'), budget: null };
  const r = trajectoryMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('forecast'));
});

test('trajectory-match: ignores non-action history entries', () => {
  const expected = { trajectory: [{ tool: 'weather' }] };
  const history = [{ type: 'observation', tool: 'weather' }, { type: 'action', tool: 'weather' }, { type: 'plan' }];
  const actual = { status: 'completed', result: null, history, budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 9 new tests FAIL

- [ ] **Step 3: Write the implementation**

```js
// evals/graders/trajectory-match.mjs
export default function trajectoryMatch(expected, actual) {
  const expectedTools = (expected.trajectory ?? []).map(t => t.tool);
  const actualTools = (actual.history ?? [])
    .filter(h => h.type === 'action')
    .map(h => h.tool);
  const mode = expected.mode ?? 'superset';

  switch (mode) {
    case 'strict': {
      if (actualTools.length !== expectedTools.length) {
        return { pass: false, score: 0, reason: `expected ${expectedTools.length} tools, got ${actualTools.length}` };
      }
      for (let i = 0; i < expectedTools.length; i++) {
        if (actualTools[i] !== expectedTools[i]) {
          return { pass: false, score: 0, reason: `step ${i}: expected "${expectedTools[i]}", got "${actualTools[i]}"` };
        }
      }
      return { pass: true, score: 1, reason: `${expectedTools.length} tools in exact order` };
    }
    case 'unordered': {
      const missing = expectedTools.filter(t => !actualTools.includes(t));
      const extra = actualTools.filter(t => !expectedTools.includes(t));
      if (missing.length > 0 || extra.length > 0) {
        const parts = [];
        if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
        if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
        return { pass: false, score: 0, reason: parts.join('; ') };
      }
      return { pass: true, score: 1, reason: `all ${expectedTools.length} tools called` };
    }
    case 'subset': {
      const allowed = new Set(expectedTools);
      const unexpected = actualTools.filter(t => !allowed.has(t));
      if (unexpected.length > 0) {
        return { pass: false, score: 0, reason: `unexpected tools: ${unexpected.join(', ')}` };
      }
      return { pass: true, score: 1, reason: `all tools within allowed set` };
    }
    case 'superset': {
      const actualSet = new Set(actualTools);
      const missing = expectedTools.filter(t => !actualSet.has(t));
      if (missing.length > 0) {
        return { pass: false, score: 0, reason: `missing tools: ${missing.join(', ')}` };
      }
      return { pass: true, score: 1, reason: `all ${expectedTools.length} expected tools called` };
    }
    default:
      return { pass: false, score: 0, reason: `unknown mode: "${mode}"` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add evals/graders/trajectory-match.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add trajectory-match grader with tests"
```

---

### Task 5: budget-check grader

**Files:**
- Create: `evals/graders/budget-check.mjs`
- Modify: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/eval-graders.test.mjs`:

```js
import budgetCheck from '../evals/graders/budget-check.mjs';

test('budget-check: passes within cost limit', () => {
  const expected = { maxCost: 0.10 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.03, iterations: 3 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, true);
  assert.ok(r.score > 0.5);
});

test('budget-check: fails over cost limit', () => {
  const expected = { maxCost: 0.05 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.08, iterations: 3 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, false);
});

test('budget-check: checks iterations when maxIterations set', () => {
  const expected = { maxCost: 1.00, maxIterations: 3 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.01, iterations: 5 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('iterations'));
});

test('budget-check: passes when both within limits', () => {
  const expected = { maxCost: 0.50, maxIterations: 10 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.20, iterations: 5 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, true);
});

test('budget-check: passes with warning when budget is null', () => {
  const expected = { maxCost: 0.10 };
  const actual = { status: 'completed', result: null, history: [], budget: null };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, true);
  assert.ok(r.reason.includes('no budget data'));
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 5 new tests FAIL

- [ ] **Step 3: Write the implementation**

```js
// evals/graders/budget-check.mjs
export default function budgetCheck(expected, actual) {
  if (!actual.budget) {
    return { pass: true, score: 1, reason: 'no budget data (budgets module disabled)' };
  }
  const { estimatedCost = 0, iterations = 0 } = actual.budget;
  const parts = [];
  let pass = true;

  if (typeof expected.maxCost === 'number') {
    if (estimatedCost > expected.maxCost) pass = false;
    parts.push(`$${estimatedCost.toFixed(3)} of $${expected.maxCost.toFixed(3)} budget`);
  }
  if (typeof expected.maxIterations === 'number') {
    if (iterations > expected.maxIterations) pass = false;
    parts.push(`${iterations} of ${expected.maxIterations} iterations`);
  }

  const costScore = typeof expected.maxCost === 'number' && expected.maxCost > 0
    ? Math.max(0, 1 - estimatedCost / expected.maxCost)
    : 1;
  const iterScore = typeof expected.maxIterations === 'number' && expected.maxIterations > 0
    ? Math.max(0, 1 - iterations / expected.maxIterations)
    : 1;
  const score = Math.round(Math.min(costScore, iterScore) * 100) / 100;

  return { pass, score, reason: parts.join(', ') || 'no limits specified' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add evals/graders/budget-check.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add budget-check grader with tests"
```

---

### Task 6: llm-judge grader

**Files:**
- Create: `evals/graders/llm-judge.mjs`
- Modify: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/eval-graders.test.mjs`:

```js
import llmJudge from '../evals/graders/llm-judge.mjs';

test('llm-judge: passes with positive judgment', async () => {
  const fakeFleet = {
    async executePrompt() {
      return { content: [{ type: 'text', text: '{"pass": true, "score": 0.9, "reason": "correct"}' }] };
    },
  };
  const expected = { rubric: 'Should return correct count', _task: { goal: 'Count items' }, _fleetApi: fakeFleet };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = await llmJudge(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 0.9);
});

test('llm-judge: fails with negative judgment', async () => {
  const fakeFleet = {
    async executePrompt() {
      return { content: [{ type: 'text', text: '{"pass": false, "score": 0.2, "reason": "wrong format"}' }] };
    },
  };
  const expected = { rubric: 'Should return structured data', _task: { goal: 'Format data' }, _fleetApi: fakeFleet };
  const actual = { status: 'completed', result: 'just text', history: [], budget: null };
  const r = await llmJudge(expected, actual);
  assert.equal(r.pass, false);
  assert.equal(r.score, 0.2);
});

test('llm-judge: handles unparseable response gracefully', async () => {
  const fakeFleet = {
    async executePrompt() {
      return { content: [{ type: 'text', text: 'I think this is good' }] };
    },
  };
  const expected = { rubric: 'test', _task: { goal: 'test' }, _fleetApi: fakeFleet };
  const actual = { status: 'completed', result: null, history: [], budget: null };
  const r = await llmJudge(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('parse'));
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 3 new tests FAIL

- [ ] **Step 3: Write the implementation**

```js
// evals/graders/llm-judge.mjs
export default async function llmJudge(expected, actual) {
  const fleetApi = expected._fleetApi;
  if (!fleetApi) return { pass: false, score: 0, reason: 'llm-judge requires _fleetApi on expected' };

  const task = expected._task ?? {};
  const prompt = `You are an eval judge. Grade the agent's output against the rubric.

Task goal: ${task.goal ?? 'unknown'}
Rubric: ${expected.rubric ?? 'no rubric provided'}
Agent output: ${JSON.stringify(actual.result)}
Agent status: ${actual.status}

Think step by step, then respond with JSON:
{ "pass": true/false, "score": 0.0-1.0, "reason": "your reasoning" }`;

  try {
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const text = response?.content?.[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*"pass"[\s\S]*\}/);
    if (!jsonMatch) {
      return { pass: false, score: 0, reason: `could not parse judge response` };
    }
    const verdict = JSON.parse(jsonMatch[0]);
    let score = typeof verdict.score === 'number' ? verdict.score : (verdict.pass ? 1 : 0);
    if (expected.scoreScale && typeof expected.scoreScale === 'number') {
      score = score / expected.scoreScale;
    }
    score = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
    const pass = verdict.pass ?? (score >= 0.6);
    return { pass, score, reason: verdict.reason ?? 'no reason given' };
  } catch (err) {
    return { pass: false, score: 0, reason: `llm-judge error: ${err.message}` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add evals/graders/llm-judge.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add llm-judge grader with tests"
```

---

### Task 7: custom grader loader + grader factory

**Files:**
- Create: `evals/graders/custom.mjs`
- Create: `evals/graders/index.mjs`
- Modify: `tests/eval-graders.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/eval-graders.test.mjs`:

```js
import { resolveGrader } from '../evals/graders/index.mjs';

test('resolveGrader: resolves all built-in graders by name', () => {
  const names = ['exact-match', 'contains', 'pattern', 'trajectory-match', 'budget-check', 'llm-judge'];
  for (const name of names) {
    const grader = resolveGrader(name);
    assert.equal(typeof grader, 'function', `${name} should resolve to a function`);
  }
});

test('resolveGrader: throws on unknown name', () => {
  assert.throws(() => resolveGrader('nonexistent'), /unknown grader/);
});

test('resolveGrader: treats ./ prefix as custom path', async () => {
  // loadCustom returns an async import — test that the factory detects the pattern
  // We can't easily test a real file load here, but we verify the factory branches correctly
  assert.throws(() => resolveGrader('./does-not-exist.mjs', { suiteDir: '/tmp' }), /Cannot find module|ENOENT|ERR_MODULE_NOT_FOUND/);
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test tests/eval-graders.test.mjs`
Expected: 3 new tests FAIL

- [ ] **Step 3: Write custom.mjs**

```js
// evals/graders/custom.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function loadCustom(graderPath, suiteDir) {
  const resolved = path.resolve(suiteDir ?? '.', graderPath);
  let mod;
  try {
    // Dynamic import is async but resolveGrader must return a function.
    // Return a wrapper that lazy-loads on first call.
    let loaded = null;
    const wrapper = async (expected, actual) => {
      if (!loaded) {
        const m = await import(pathToFileURL(resolved).href);
        loaded = m.default ?? m;
      }
      return loaded(expected, actual);
    };
    return wrapper;
  } catch (err) {
    throw new Error(`failed to load custom grader from ${resolved}: ${err.message}`);
  }
}
```

- [ ] **Step 4: Write index.mjs (grader factory)**

```js
// evals/graders/index.mjs
import exactMatch from './exact-match.mjs';
import contains from './contains.mjs';
import pattern from './pattern.mjs';
import trajectoryMatch from './trajectory-match.mjs';
import budgetCheck from './budget-check.mjs';
import llmJudge from './llm-judge.mjs';
import { loadCustom } from './custom.mjs';

const BUILT_IN = {
  'exact-match': exactMatch,
  'contains': contains,
  'pattern': pattern,
  'trajectory-match': trajectoryMatch,
  'budget-check': budgetCheck,
  'llm-judge': llmJudge,
};

export function resolveGrader(name, { suiteDir } = {}) {
  if (BUILT_IN[name]) return BUILT_IN[name];
  if (name.startsWith('./') || name.endsWith('.mjs')) {
    return loadCustom(name, suiteDir);
  }
  throw new Error(`unknown grader: "${name}"`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/eval-graders.test.mjs`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add evals/graders/custom.mjs evals/graders/index.mjs tests/eval-graders.test.mjs
git commit -m "feat(evals): add custom grader loader and grader factory"
```

---

### Task 8: Runner core — suite loading and case execution

**Files:**
- Create: `evals/runner.mjs`
- Create: `tests/eval-runner.test.mjs`
- Create: `tests/fixtures/eval-suites/simple.json`
- Create: `tests/fixtures/eval-suites/scripts/simple-happy.json`

- [ ] **Step 1: Create test fixtures**

```json
// tests/fixtures/eval-suites/simple.json
{
  "suite": "simple",
  "description": "Test fixture suite",
  "fleet": "scripted",
  "defaults": { "timeout": 5000, "strategy": "open-ended" },
  "cases": [
    {
      "id": "s-001",
      "description": "Simple happy path",
      "tags": ["happy-path"],
      "task": { "goal": "Say hello" },
      "fleet": { "script": "./scripts/simple-happy.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } }
      ]
    },
    {
      "id": "s-002",
      "description": "With contains check",
      "tags": ["output-check"],
      "task": { "goal": "Say hello world" },
      "fleet": { "script": "./scripts/simple-happy.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "content", "grader": "contains", "substrings": ["hello"] }
      ]
    }
  ]
}
```

```json
// tests/fixtures/eval-suites/scripts/simple-happy.json
{
  "goals": {
    "__default__": [
      "```done\n{\"result\":\"hello world\",\"summary\":\"greeted\"}\n```"
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/eval-runner.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 4: Write the runner**

```js
// evals/runner.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
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
    actual = { status: 'failed', result: { error: err.message }, history: [], budget: null };
  } finally {
    await fleet.stop?.();
  }

  const scores = {};
  for (const scorer of testCase.scorers) {
    const graderFn = resolveGrader(scorer.grader, { suiteDir });
    const scorerInput = { ...scorer, _task: testCase.task, _fleetApi: api };
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

// CLI entry point
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/eval-runner.test.mjs`
Expected: all 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add evals/runner.mjs tests/eval-runner.test.mjs tests/fixtures/eval-suites/
git commit -m "feat(evals): add eval runner with suite loading, case execution, and reporting"
```

---

### Task 9: Baseline comparison

**Files:**
- Create: `evals/baseline.mjs`
- Create: `tests/eval-baseline.test.mjs`
- Modify: `evals/runner.mjs` — wire `printBaseline` to call `diffReports()`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/eval-baseline.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// evals/baseline.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

export async function findLatestReport(suiteName, reportDir) {
  let files;
  try { files = await fs.readdir(reportDir); } catch { return null; }
  const matching = files
    .filter(f => f.startsWith(`${suiteName}-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  if (matching.length === 0) return null;
  const text = await fs.readFile(path.join(reportDir, matching[0]), 'utf8');
  return JSON.parse(text);
}

export async function findReportByTimestamp(suiteName, timestamp, reportDir) {
  const files = await fs.readdir(reportDir);
  const match = files.find(f => f.startsWith(`${suiteName}-`) && f.includes(timestamp.replace(/[:.]/g, '-')));
  if (!match) return null;
  const text = await fs.readFile(path.join(reportDir, match), 'utf8');
  return JSON.parse(text);
}

export function diffReports(baseline, current) {
  const baseMap = new Map(baseline.results.map(r => [r.id, r]));
  const curMap = new Map(current.results.map(r => [r.id, r]));

  const fixed = [];
  const regressions = [];
  const scoreChanges = [];
  const added = [];
  const removed = [];

  for (const [id, cur] of curMap) {
    const base = baseMap.get(id);
    if (!base) { added.push(cur); continue; }
    const curPass = Object.values(cur.scores).every(s => s.pass);
    const basePass = Object.values(base.scores).every(s => s.pass);
    if (!basePass && curPass) fixed.push({ id, base, current: cur });
    else if (basePass && !curPass) regressions.push({ id, base, current: cur });
    else {
      for (const [name, curScore] of Object.entries(cur.scores)) {
        const baseScore = base.scores?.[name];
        if (baseScore && Math.abs(curScore.score - baseScore.score) > 0.01) {
          scoreChanges.push({ id, scorer: name, from: baseScore.score, to: curScore.score });
        }
      }
    }
  }

  for (const [id, base] of baseMap) {
    if (!curMap.has(id)) removed.push(base);
  }

  return { fixed, regressions, scoreChanges, added, removed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/eval-baseline.test.mjs`
Expected: all 5 tests PASS

- [ ] **Step 5: Wire baseline into runner**

In `evals/runner.mjs`, replace the empty `printBaseline` function:

```js
import { findLatestReport, findReportByTimestamp, diffReports } from './baseline.mjs';

async function printBaseline(report, baselineArg) {
  const reportDir = path.resolve('.', 'evals', 'reports');
  const baseline = baselineArg === 'latest'
    ? await findLatestReport(report.suite, reportDir)
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
```

- [ ] **Step 6: Run all eval tests**

Run: `node --test tests/eval-graders.test.mjs tests/eval-runner.test.mjs tests/eval-baseline.test.mjs`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add evals/baseline.mjs tests/eval-baseline.test.mjs evals/runner.mjs
git commit -m "feat(evals): add baseline comparison with diff reporting"
```

---

### Task 10: Config and package.json integration

**Files:**
- Modify: `host/config.mjs:9` — add `'evals'` to `IMPLEMENTED_MODULES`
- Modify: `package.json` — add `"eval"` and `"test:eval"` scripts, add `"evals"` to `"files"`
- Modify: `.gitignore` — add `evals/reports/`

- [ ] **Step 1: Add evals to IMPLEMENTED_MODULES**

In `host/config.mjs` line 9, change:

```js
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat', 'router']);
```

to:

```js
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat', 'router', 'evals']);
```

- [ ] **Step 2: Add scripts and files to package.json**

In `package.json`, add to `"scripts"`:

```json
"eval": "node evals/runner.mjs",
"test:eval": "node --test tests/eval-graders.test.mjs tests/eval-runner.test.mjs tests/eval-baseline.test.mjs"
```

Add `"evals"` to the `"files"` array.

- [ ] **Step 3: Add evals/reports/ to .gitignore**

Append to `.gitignore`:

```
evals/reports/
```

- [ ] **Step 4: Run existing test suite to verify no regressions**

Run: `npm test`
Expected: all existing tests PASS

- [ ] **Step 5: Run eval tests**

Run: `npm run test:eval`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add host/config.mjs package.json .gitignore
git commit -m "feat(evals): add evals to config, package scripts, and gitignore"
```

---

### Task 11: Demo suite

**Files:**
- Create: `evals/suites/demo.json`
- Create: `evals/suites/scripts/demo-happy.json`
- Create: `evals/suites/scripts/demo-error.json`

- [ ] **Step 1: Create demo-happy fleet script**

```json
// evals/suites/scripts/demo-happy.json
{
  "goals": {
    "Say hello": [
      "```done\n{\"result\":\"Hello! How can I help you today?\",\"summary\":\"greeted user\"}\n```"
    ],
    "Plan a greeting": [
      "```plan\n{\"steps\":[{\"type\":\"tool\",\"tool\":\"weather\",\"args\":{\"city\":\"London\"},\"reason\":\"check weather\",\"review\":false}]}\n```",
      "```review\n{\"approved\":true}\n```",
      "```done\n{\"result\":\"Hello from London, it is 15°C\",\"summary\":\"greeted with weather\"}\n```"
    ]
  },
  "tools": {
    "weather": { "ok": true, "city": "London", "temperature": "15°C", "description": "Cloudy" }
  }
}
```

- [ ] **Step 2: Create demo-error fleet script**

```json
// evals/suites/scripts/demo-error.json
{
  "goals": {
    "__default__": [
      "```tool_call\n{\"tool\":\"nonexistent\",\"args\":{}}\n```",
      "```done\n{\"result\":{\"error\":\"tool_not_found\"},\"summary\":\"failed\"}\n```"
    ],
    "Exceed budget": [
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"London\"}}\n```",
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"Paris\"}}\n```",
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"Tokyo\"}}\n```",
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"NYC\"}}\n```",
      "```done\n{\"result\":\"done\",\"summary\":\"done\"}\n```"
    ]
  },
  "tools": {
    "weather": { "ok": true, "temperature": "20°C" }
  }
}
```

- [ ] **Step 3: Create demo suite JSON**

```json
// evals/suites/demo.json
{
  "suite": "demo",
  "description": "Core agent behavior tests for Fleet Agent Kit",
  "fleet": "scripted",
  "defaults": {
    "timeout": 10000,
    "strategy": "open-ended"
  },
  "cases": [
    {
      "id": "demo-001",
      "description": "Happy path open-ended task",
      "tags": ["happy-path"],
      "task": { "goal": "Say hello" },
      "fleet": { "script": "./scripts/demo-happy.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "efficiency", "grader": "budget-check", "maxCost": 1.00 }
      ]
    },
    {
      "id": "demo-002",
      "description": "Happy path plan-execute task",
      "tags": ["happy-path"],
      "task": { "goal": "Plan a greeting" },
      "strategy": "plan-execute",
      "fleet": { "script": "./scripts/demo-happy.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "trajectory", "grader": "trajectory-match", "trajectory": [{ "tool": "weather" }] }
      ]
    },
    {
      "id": "demo-003",
      "description": "Agent handles tool error gracefully",
      "tags": ["error-handling"],
      "task": { "goal": "Use a broken tool" },
      "fleet": { "script": "./scripts/demo-error.json" },
      "scorers": [
        { "name": "completes", "grader": "exact-match", "expected": { "status": "completed" } }
      ]
    },
    {
      "id": "demo-004",
      "description": "Task exceeds budget",
      "tags": ["error-handling"],
      "task": { "goal": "Exceed budget" },
      "fleet": { "script": "./scripts/demo-error.json" },
      "scorers": [
        { "name": "budget-exceeded", "grader": "exact-match", "expected": { "status": "budget_exceeded" } }
      ]
    }
  ]
}
```

- [ ] **Step 4: Run the demo suite**

Run: `npm run eval -- --suite=demo`
Expected: Suite runs and prints report to stdout. Some cases may fail — that is expected for now; the demo scripts may need tuning to match actual agent response parsing.

- [ ] **Step 5: Commit**

```bash
git add evals/suites/demo.json evals/suites/scripts/demo-happy.json evals/suites/scripts/demo-error.json
git commit -m "feat(evals): add demo eval suite with scripted fleet responses"
```

---

### Task 12: Travel agent eval suite

**Files:**
- Create: `evals/suites/travel-agent.json`
- Create: `evals/suites/scripts/travel/travel-001-manali.json`
- Create: `evals/suites/scripts/travel/travel-002-japan-prep.json`
- Create: `evals/suites/scripts/travel/travel-003-tokyo-brief.json`
- Create: `evals/suites/scripts/travel/travel-004-delhi-manali.json`
- Create: `evals/suites/scripts/travel/travel-005-unreachable.json`
- Create: `evals/suites/scripts/travel/travel-006-over-budget.json`

This task creates the 6 fleet script JSON files and the suite JSON. Each fleet script must match the response format the run loop strategies expect. Reference `tests/host-run-loop.test.mjs` and `tests/host-scripted-fleet.test.mjs` for the exact format patterns.

- [ ] **Step 1: Create travel-001-manali.json (plan-execute)**

```json
// evals/suites/scripts/travel/travel-001-manali.json
{
  "goals": {
    "Plan a 3-day trip to Manali": [
      "```plan\n{\"steps\":[{\"type\":\"tool\",\"tool\":\"weather\",\"args\":{\"city\":\"Manali\"},\"reason\":\"check current weather\",\"review\":false},{\"type\":\"tool\",\"tool\":\"destination-overview\",\"args\":{\"destination\":\"Manali\"},\"reason\":\"get attractions and activities\",\"review\":false},{\"type\":\"prompt\",\"prompt\":\"compile itinerary\",\"reason\":\"create day-by-day plan\",\"review\":false}]}\n```",
      "```review\n{\"approved\":true}\n```",
      "```done\n{\"result\":\"3-Day Manali Itinerary\\nDay 1: Arrive Manali, visit Hadimba Temple, Old Manali\\nDay 2: Solang Valley, paragliding, Rohtang Pass viewpoint\\nDay 3: Naggar Castle, hot springs, depart\\nBudget: INR 8,000-12,000/day\\nWeather: 12°C, partly cloudy\",\"summary\":\"Planned 3-day Manali trip\"}\n```"
    ]
  },
  "tools": {
    "weather": {"ok":true,"city":"Manali","temperature":"12°C","humidity":"65%","wind":"8 km/h","description":"Partly cloudy"},
    "destination-overview": {"ok":true,"destination":"Manali","summary":"Hill station in Himachal Pradesh","attractions":["Hadimba Temple","Solang Valley","Rohtang Pass","Old Manali","Naggar Castle"]}
  }
}
```

- [ ] **Step 2: Create travel-002-japan-prep.json (open-ended)**

```json
// evals/suites/scripts/travel/travel-002-japan-prep.json
{
  "goals": {
    "Pre-trip preparation for Japan": [
      "```tool_call\n{\"tool\":\"country-info\",\"args\":{\"country\":\"Japan\"}}\n```",
      "```tool_call\n{\"tool\":\"travel-advisory\",\"args\":{\"country\":\"JP\"}}\n```",
      "```tool_call\n{\"tool\":\"currency\",\"args\":{\"from\":\"INR\",\"to\":\"JPY\",\"amount\":1000}}\n```",
      "```done\n{\"result\":\"Japan Pre-Trip Summary\\nVisa: e-Visa available for Indian passport\\nSafety: Level 1 - Exercise normal precautions\\nCurrency: 1000 INR ≈ 1,800 JPY\\nLanguage: Japanese, limited English\\nPower: Type A/B, 100V\",\"summary\":\"Japan pre-trip prep complete\"}\n```"
    ]
  },
  "tools": {
    "country-info": {"ok":true,"name":"Japan","capital":"Tokyo","population":125800000,"languages":["Japanese"]},
    "travel-advisory": {"ok":true,"country":"JP","score":1.5,"advisory":"Exercise normal precautions"},
    "currency": {"ok":true,"from":"INR","to":"JPY","rate":1.8,"amount":1000,"result":1800}
  }
}
```

- [ ] **Step 3: Create travel-003-tokyo-brief.json (open-ended)**

```json
// evals/suites/scripts/travel/travel-003-tokyo-brief.json
{
  "goals": {
    "City briefing for Tokyo": [
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"Tokyo\"}}\n```",
      "```tool_call\n{\"tool\":\"timezone\",\"args\":{\"city\":\"Tokyo\"}}\n```",
      "```done\n{\"result\":\"Tokyo City Briefing\\nWeather: 22°C, clear skies\\nLocal time: 14:30 JST (UTC+9)\\nTemperature comfortable for sightseeing\",\"summary\":\"Tokyo briefing complete\"}\n```"
    ]
  },
  "tools": {
    "weather": {"ok":true,"city":"Tokyo","temperature":"22°C","humidity":"55%","wind":"12 km/h","description":"Clear"},
    "timezone": {"ok":true,"city":"Tokyo","datetime":"2026-09-25T14:30:00+09:00","timezone":"JST","utc_offset":"+09:00"}
  }
}
```

- [ ] **Step 4: Create travel-004-delhi-manali.json (open-ended)**

```json
// evals/suites/scripts/travel/travel-004-delhi-manali.json
{
  "goals": {
    "Driving route from Delhi to Manali": [
      "```tool_call\n{\"tool\":\"route-distance\",\"args\":{\"from\":\"Delhi\",\"to\":\"Manali\"}}\n```",
      "```done\n{\"result\":\"Delhi to Manali Route\\nDistance: 530 km\\nEstimated driving time: 12 hours 30 minutes\\nRoute: Delhi → Chandigarh → Mandi → Manali\\nRoad conditions: NH3 mostly good, mountain roads after Mandi\",\"summary\":\"Route check complete\"}\n```"
    ]
  },
  "tools": {
    "route-distance": {"ok":true,"from":"Delhi","to":"Manali","distance_km":530,"duration_hours":12.5,"duration_text":"12 hours 30 minutes"}
  }
}
```

- [ ] **Step 5: Create travel-005-unreachable.json (plan-execute, weather error)**

```json
// evals/suites/scripts/travel/travel-005-unreachable.json
{
  "goals": {
    "Plan a trip to an unreachable destination": [
      "```plan\n{\"steps\":[{\"type\":\"tool\",\"tool\":\"weather\",\"args\":{\"city\":\"Atlantis\"},\"reason\":\"check weather\",\"review\":false}]}\n```",
      "```review\n{\"approved\":true}\n```",
      "```done\n{\"result\":\"Unable to plan trip: weather data unavailable for Atlantis. The destination may not exist or is not accessible.\",\"summary\":\"Trip planning failed - unreachable destination\"}\n```"
    ]
  },
  "tools": {
    "weather": {"ok":false,"error":"city_not_found","message":"No weather data available for Atlantis"}
  }
}
```

- [ ] **Step 6: Create travel-006-over-budget.json (plan-execute, budget exceeded)**

```json
// evals/suites/scripts/travel/travel-006-over-budget.json
{
  "goals": {
    "Plan a detailed world tour": [
      "```plan\n{\"steps\":[{\"type\":\"tool\",\"tool\":\"weather\",\"args\":{\"city\":\"Paris\"},\"reason\":\"check Paris weather\",\"review\":false},{\"type\":\"tool\",\"tool\":\"weather\",\"args\":{\"city\":\"Tokyo\"},\"reason\":\"check Tokyo weather\",\"review\":false},{\"type\":\"tool\",\"tool\":\"destination-overview\",\"args\":{\"destination\":\"Paris\"},\"reason\":\"Paris overview\",\"review\":false},{\"type\":\"tool\",\"tool\":\"destination-overview\",\"args\":{\"destination\":\"Tokyo\"},\"reason\":\"Tokyo overview\",\"review\":false}]}\n```",
      "```review\n{\"approved\":true}\n```",
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"London\"}}\n```",
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"NYC\"}}\n```",
      "```tool_call\n{\"tool\":\"weather\",\"args\":{\"city\":\"Sydney\"}}\n```",
      "```done\n{\"result\":\"World tour planned\",\"summary\":\"done\"}\n```"
    ]
  },
  "tools": {
    "weather": {"ok":true,"temperature":"20°C","description":"Clear"},
    "destination-overview": {"ok":true,"summary":"Major world city","attractions":["landmark1","landmark2"]}
  }
}
```

- [ ] **Step 5: Create travel-agent.json suite**

```json
{
  "suite": "travel-agent",
  "description": "Travel research agent eval suite",
  "fleet": "scripted",
  "defaults": { "timeout": 15000 },
  "cases": [
    {
      "id": "travel-001", "description": "Plan a 3-day trip to Manali",
      "tags": ["travel", "plan-execute", "happy-path"],
      "task": { "goal": "Plan a 3-day trip to Manali" },
      "strategy": "plan-execute",
      "fleet": { "script": "./scripts/travel/travel-001-manali.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "trajectory", "grader": "trajectory-match", "trajectory": [{ "tool": "weather" }, { "tool": "destination-overview" }] },
        { "name": "efficiency", "grader": "budget-check", "maxCost": 1.00 }
      ]
    },
    {
      "id": "travel-002", "description": "Pre-trip prep for Japan",
      "tags": ["travel", "open-ended", "happy-path"],
      "task": { "goal": "Pre-trip preparation for Japan" },
      "strategy": "open-ended",
      "fleet": { "script": "./scripts/travel/travel-002-japan-prep.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "trajectory", "grader": "trajectory-match", "trajectory": [{ "tool": "country-info" }, { "tool": "travel-advisory" }, { "tool": "currency" }] }
      ]
    },
    {
      "id": "travel-003", "description": "City briefing for Tokyo",
      "tags": ["travel", "open-ended"],
      "task": { "goal": "City briefing for Tokyo" },
      "strategy": "open-ended",
      "fleet": { "script": "./scripts/travel/travel-003-tokyo-brief.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "content", "grader": "contains", "substrings": ["Tokyo"] }
      ]
    },
    {
      "id": "travel-004", "description": "Route check Delhi to Manali",
      "tags": ["travel", "open-ended"],
      "task": { "goal": "Driving route from Delhi to Manali" },
      "strategy": "open-ended",
      "fleet": { "script": "./scripts/travel/travel-004-delhi-manali.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "content", "grader": "contains", "substrings": ["distance"] }
      ]
    },
    {
      "id": "travel-005", "description": "Trip plan with unreachable destination",
      "tags": ["travel", "error-handling"],
      "task": { "goal": "Plan a trip to an unreachable destination" },
      "strategy": "plan-execute",
      "fleet": { "script": "./scripts/travel/travel-005-unreachable.json" },
      "scorers": [
        { "name": "completes", "grader": "pattern", "pattern": "completed|failed" }
      ]
    },
    {
      "id": "travel-006", "description": "Trip plan that exceeds budget",
      "tags": ["travel", "error-handling"],
      "task": { "goal": "Plan a detailed world tour" },
      "strategy": "plan-execute",
      "fleet": { "script": "./scripts/travel/travel-006-over-budget.json" },
      "scorers": [
        { "name": "budget-exceeded", "grader": "exact-match", "expected": { "status": "budget_exceeded" } },
        { "name": "efficiency", "grader": "budget-check", "maxCost": 0.01, "maxIterations": 2 }
      ]
    }
  ]
}
```

- [ ] **Step 6: Run the travel agent suite**

Run: `npm run eval -- --suite=travel-agent`
Expected: Suite runs. Tune fleet scripts until cases behave as expected.

- [ ] **Step 7: Commit**

```bash
git add evals/suites/travel-agent.json evals/suites/scripts/travel/
git commit -m "feat(evals): add travel agent eval suite with 6 scripted cases"
```

---

### Task 13: Template integration (create command)

**Files:**
- Create: `template/evals/suites/hello.json`
- Create: `template/evals/suites/scripts/hello-happy.json`
- Modify: `template/package.json` — add `"eval"` script
- Modify: `template/gitignore` — add `evals/reports/`
- Modify: `create/copy.mjs:14-27` — add `'evals'` to `PUBLISHED_DIRS`

- [ ] **Step 1: Create template hello suite**

```json
// template/evals/suites/hello.json
{
  "suite": "hello",
  "description": "Starter eval suite for the hello workflow",
  "fleet": "scripted",
  "defaults": { "timeout": 15000, "strategy": "open-ended" },
  "cases": [
    {
      "id": "hello-001",
      "description": "Hello workflow completes with a greeting",
      "tags": ["happy-path"],
      "task": { "goal": "Say hello to Ada" },
      "fleet": { "script": "./scripts/hello-happy.json" },
      "scorers": [
        { "name": "correctness", "grader": "exact-match", "expected": { "status": "completed" } },
        { "name": "mentions-name", "grader": "contains", "substrings": ["Ada"] }
      ]
    }
  ]
}
```

- [ ] **Step 2: Create template hello fleet script**

```json
// template/evals/suites/scripts/hello-happy.json
{
  "goals": {
    "Say hello to Ada": [
      "```done\n{\"result\":\"Hello, Ada! Welcome aboard.\",\"summary\":\"greeted Ada\"}\n```"
    ]
  }
}
```

- [ ] **Step 3: Add eval script to template/package.json**

In `template/package.json`, add to `"scripts"`:

```json
"eval": "node node_modules/@dsiddharth2/create-fleet-agent/evals/runner.mjs"
```

- [ ] **Step 4: Add evals/reports/ to template/gitignore**

Append to `template/gitignore`:

```
evals/reports/
```

- [ ] **Step 5: Add evals to PUBLISHED_DIRS in create/copy.mjs**

In `create/copy.mjs`, add `'evals'` to the `PUBLISHED_DIRS` array:

```js
export const PUBLISHED_DIRS = [
  'mcp',
  'pool',
  'host',
  'transport',
  'comm',
  '.claude/skills/agent-builder',
  'workflows/standalone.mjs',
  'tools/weather',
  'tools/textstats',
  'docs/architecture.md',
  'docs/development.md',
  '.dockerignore',
  'evals',
];
```

- [ ] **Step 6: Run the create command tests to verify no regressions**

Run: `node --test tests/create-copy.test.mjs tests/create-template.test.mjs`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add template/evals/ template/package.json template/gitignore create/copy.mjs
git commit -m "feat(evals): ship eval scaffolding with create template"
```

---

### Task 14: Agent-builder skill integration (deferred)

**Note:** Spec §10 calls for the `agent-builder` skill to generate tailored eval suites when building a new agent. This is deferred to a follow-up task after the core harness is stable. The template integration (Task 13) covers the `npm create` path. The skill integration requires modifying `.claude/skills/agent-builder/` to emit eval suite JSON during agent generation — a separate PR once the suite format is battle-tested.

---

### Task 15: Final integration test — full eval cycle

**Files:**
- No new files — this is a verification task

- [ ] **Step 1: Run all eval-harness tests**

Run: `npm run test:eval`
Expected: all PASS

- [ ] **Step 2: Run the demo suite**

Run: `npm run eval -- --suite=demo`
Expected: Prints report to stdout, writes JSON to `evals/reports/`

- [ ] **Step 3: Run the demo suite again with baseline**

Run: `npm run eval -- --suite=demo --baseline=latest`
Expected: Prints baseline comparison (should show no regressions since nothing changed)

- [ ] **Step 4: Run the full existing test suite**

Run: `npm test`
Expected: all existing tests still PASS — no regressions

- [ ] **Step 5: Verify generated projects get eval scaffolding**

Run: `node bin/create.mjs /tmp/test-eval-agent`
Check that `/tmp/test-eval-agent/evals/suites/hello.json` exists and `/tmp/test-eval-agent/package.json` has the `"eval"` script.

- [ ] **Step 6: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "fix(evals): integration test fixups"
```
