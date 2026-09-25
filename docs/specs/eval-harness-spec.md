# Fleet Agent Kit — Eval Harness Spec

Status: approved design — not yet implemented.

## What this ships

A standalone eval harness that calls `executeHostedTask()` directly, grades
output against expected results using multiple scorers per case, compares runs
against baselines, and reports pass/fail with cost and timing. Seven built-in
graders spanning code-based, LLM-based, and custom evaluation. Supports both
scripted (deterministic, zero-cost) and live (real LLM) fleet modes.

Also ships: a travel agent eval suite exercising the kit's example agent, a
hello-world eval suite in the create template so new agents get eval
scaffolding from day one, and package exports so user agents can import the
runner and graders directly.

## Relationship to existing code

The eval harness is a standalone `evals/` directory that imports from the host
and test helpers. It does not modify the host runtime, strategies, prompts, or
run loop. Three existing files gain small additions (config, package.json,
gitignore).

The runner wires up fleet, dispatcher, and tool registry itself — the same
pattern used by the existing test suite — then calls `executeHostedTask()`
from `host/tasks.mjs`. This keeps eval as a dev-time tool with zero runtime
cost.

## Design decisions

- **Eval only** — Memory (Phase 3's other half) is deferred to a separate spec.
- **Standalone runner (Approach A)** — No host integration. The runner does its
  own wiring. Zero impact on existing host code.
- **Both fleet modes** — Scripted for CI/CD gating, live for periodic quality
  checks. Suite-level declaration.
- **Multi-scorer per case** — Each case declares an array of scorers. A case
  passes only when all scorers pass.
- **Baseline comparison** — Every run saves a report. `--baseline=latest` diffs
  against the previous run, showing regressions and fixes.
- **7 graders** — exact-match, contains, pattern, trajectory-match,
  budget-check, llm-judge, custom.
- **Parallel opt-in** — Sequential by default, `--parallel` for concurrent
  execution.
- **Trials deferred** — Running the same case N times for consistency checking
  is a follow-up. Can be added without changing the suite format (a `trials`
  field on the case object, default 1).

---

## 1. Suite Format

Each suite is a JSON file in `evals/suites/`. A suite has metadata and an
array of cases.

### Suite schema

```json
{
  "suite": "demo",
  "description": "Core agent behavior tests",
  "fleet": "scripted",
  "defaults": {
    "timeout": 30000,
    "strategy": "open-ended"
  },
  "cases": [ ... ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `suite` | string | yes | Suite name, used in report filenames |
| `description` | string | no | Human-readable description |
| `fleet` | `"scripted"` \| `"live"` | yes | Fleet mode for this suite |
| `defaults` | object | no | Default values cascaded into cases |
| `defaults.timeout` | number | no | Default timeout in ms (default: 30000) |
| `defaults.strategy` | string | no | Default strategy. Omit to let the router classify |
| `cases` | array | yes | Array of case objects |

### Case schema

```json
{
  "id": "inv-001",
  "description": "Find mismatched invoices in test ledger",
  "tags": ["invoices", "happy-path"],
  "task": {
    "goal": "Find mismatched invoices for January 2026",
    "inputs": { "period": "2026-01", "threshold": 0.01 }
  },
  "fleet": {
    "script": "./scripts/inv-001.json"
  },
  "scorers": [
    {
      "name": "correctness",
      "grader": "exact-match",
      "expected": { "status": "completed", "result": { "count": 3 } }
    },
    {
      "name": "efficiency",
      "grader": "budget-check",
      "maxCost": 0.10,
      "maxIterations": 5
    }
  ],
  "timeout": 15000,
  "strategy": "plan-execute"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique case identifier within the suite |
| `description` | string | no | Human-readable description |
| `tags` | string[] | no | Tags for filtering and segmented reporting |
| `task` | object | yes | The task object passed to `executeHostedTask()` |
| `task.goal` | string | yes | The agent's goal |
| `task.inputs` | object | no | Additional inputs for the task |
| `fleet` | object | no | Per-case fleet config |
| `fleet.script` | string | no | Path to scripted fleet JSON (relative to suite file). Required when suite fleet is `"scripted"`. Ignored when suite fleet is `"live"` |
| `scorers` | array | yes | Array of scorer objects |
| `timeout` | number | no | Timeout in ms (overrides suite default) |
| `strategy` | string | no | Strategy override. Omit to use suite default or let router classify |

### Scorer object schema

```json
{
  "name": "correctness",
  "grader": "exact-match",
  "expected": { "status": "completed", "result": { "count": 3 } }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Scorer name, used as key in report |
| `grader` | string | yes | Grader name (built-in) or path to custom grader |
| All other fields | any | varies | Grader-specific config (passed as `expected` to the grader) |

### Fleet script format

Same format as `createScriptedFleetApi()` already uses:

```json
{
  "goals": {
    "Find mismatched invoices": [
      "```action\n{\"tool\":\"query_ledger\",\"args\":{\"period\":\"2026-01\"}}\n```",
      "```done\n{\"result\":{\"count\":3},\"summary\":\"Found 3 mismatches\"}\n```"
    ]
  },
  "tools": {
    "query_ledger": { "ok": true, "data": [{ "id": 1 }, { "id": 2 }, { "id": 3 }] }
  }
}
```

---

## 2. Graders

Every grader is a pure function with the same signature:

```js
grader(expected, actual) → { pass: boolean, score: number, reason: string }
```

Where `actual` is the full result from `executeHostedTask()`:

```js
{
  taskId: 'inv-001',
  status: 'completed',
  result: { count: 3 },
  history: [ ... ],
  budget: { iterations: 3, estimatedCost: 0.04 },
  traceId: 'tr-abc123',
  routedTo: 'plan-execute',
}
```

### 2.1 exact-match

`deepEqual(expected.result, actual.result)`. Optionally checks
`expected.status` if present. Score is 1 or 0.

```js
// Input
expected: { status: "completed", result: { count: 3 } }
// Checks
actual.status === "completed" && deepEqual(actual.result, { count: 3 })
```

### 2.2 contains

Checks that `actual.result` (stringified if not a string) contains all
substrings in `expected.substrings[]`. Score = fraction of substrings found.

```js
// Input
expected: { substrings: ["invoice", "mismatch", "3 found"] }
// Score
2 of 3 found → { pass: false, score: 0.67, reason: "missing: '3 found'" }
```

### 2.3 pattern

Tests `actual.result` (stringified if not a string) against
`expected.pattern` (a regex string). Optional `expected.flags` for regex
flags. Score is 1 or 0.

```js
// Input
expected: { pattern: "found \\d+ mismatches", flags: "i" }
```

### 2.4 trajectory-match

Extracts tool names from `actual.history` (entries where
`type === 'action'`), compares against `expected.trajectory[].tool`. Four
modes controlled by `expected.mode`:

| Mode | Behavior |
|---|---|
| `strict` | Same tools, same order |
| `unordered` | Same tools, any order |
| `subset` | Agent called no tools outside the expected list |
| `superset` (default) | Agent called at least these tools (extras ok) |

```js
// Input
expected: {
  mode: "superset",
  trajectory: [{ tool: "query_ledger" }, { tool: "format_report" }]
}
// actual.history tools: ["query_ledger", "validate_data", "format_report"]
// superset → pass (expected tools are a subset of actual)
```

Score is 1 when pass, 0 when fail. Reason lists missing or unexpected tools.

### 2.5 budget-check

Checks `actual.budget.estimatedCost <= expected.maxCost` and optionally
`actual.budget.iterations <= expected.maxIterations`. Score scales from 1.0
(zero cost) down toward 0.0 (at the limit).

```js
// Input
expected: { maxCost: 0.10, maxIterations: 5 }
// actual.budget: { estimatedCost: 0.03, iterations: 3 }
// → { pass: true, score: 0.7, reason: "$0.030 of $0.100 budget, 3 of 5 iterations" }
```

If `actual.budget` is null (budgets module disabled), the grader passes with
a warning reason.

### 2.6 llm-judge

Sends the task goal, expected behavior description, and actual result to a
Fleet member with a rubric prompt. The judge uses chain-of-thought: reason
first, then verdict.

```js
// Input
expected: {
  rubric: "The agent should find all mismatched invoices and report the count accurately.",
  scoreScale: 5
}
```

The judge prompt is:

```
You are an eval judge. Grade the agent's output against the rubric.

Task goal: {task.goal}
Rubric: {expected.rubric}
Agent output: {JSON.stringify(actual.result)}
Agent status: {actual.status}

Think step by step, then respond with JSON:
{ "pass": true/false, "score": 0.0-1.0, "reason": "your reasoning" }
```

When `expected.scoreScale` is set (e.g. 5), the judge scores on a 1-N scale
which is normalized to 0-1. Pass threshold is `score >= 0.6`.

Uses the same `fleetApi.executePrompt()` the agent uses. For scripted
suites, the fleet script must include a response for the judge prompt (or
the runner creates a separate live fleet connection for judging — configurable
via `expected.judgeFleet: "live"`).

### 2.7 custom

Loads a user function from a path relative to the suite file. The path is
resolved through `resolveGrader()` — if the grader name starts with `./`
or ends with `.mjs`, it's treated as a custom path.

```js
// Suite case
{ "grader": "./graders/my-custom-check.mjs" }

// my-custom-check.mjs
export default function(expected, actual) {
  const count = actual.result?.count ?? 0;
  return { pass: count >= 3, score: count / 5, reason: `found ${count}` };
}
```

### Grader factory

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

---

## 3. Runner

### Flow

```
1. Load suite JSON from evals/suites/
2. Filter cases by --tag or --suite if specified
3. For each case (sequential or parallel):
   a. Create fleet API:
      - scripted: createScriptedFleetApi(script)
      - live: spawnFleet() from transport/
   b. Create worker dispatcher (createWorkerDispatcher)
   c. Build tool registry (extendRegistry from host/tools/registry.mjs)
   d. Create AbortController with case timeout
   e. Call executeHostedTask(case.task, { api, dispatcher, toolRegistry, ... })
   f. Run each scorer: resolveGrader(scorer.grader)(scorer, actual)
   g. Record: case id, pass/fail, scores, durationMs, cost
   h. Release dispatcher lease, stop fleet if scripted
4. Write JSON report to evals/reports/<suite>-<timestamp>.json
5. Print human-readable summary to stdout
6. If --baseline specified, load baseline report and diff
7. Exit with code 0 if all passed, 1 if any failed
```

### Programmatic API

```js
// evals/runner.mjs
export async function runSuite(suiteName, {
  tags,              // string[] — filter cases by tag
  parallel,          // boolean — run cases concurrently (default: false)
  configDir,         // string — where host.config.mjs lives (default: '.')
  baseline,          // string — 'latest' or timestamp to diff against
  suiteDir,          // string — override suite directory
  reportDir,         // string — override report directory
} = {}) → report
```

Returns a report object (same shape as the JSON report file).

### CLI

```
npm run eval                              # run all suites
npm run eval -- --suite=demo              # one suite
npm run eval -- --tag=happy-path          # filter by tag
npm run eval -- --parallel                # concurrent cases
npm run eval -- --baseline=latest         # diff against last run
npm run eval -- --baseline=2026-09-25T... # diff against specific run
```

### Parallel mode

Uses `Promise.allSettled()`. Each case gets its own fleet API and dispatcher
lease so they don't interfere. Failures in one case don't abort others.
Maximum concurrency follows the dispatcher's capacity.

### Timeout

Per-case timeout from the suite (with suite-level default, final default
30000ms). Implemented via `AbortController` + `setTimeout`, passed to
`executeHostedTask()` as the `signal`.

### Error handling

If `executeHostedTask()` throws (not a graceful failure status), the case is
recorded as failed with scorer results `{ pass: false, score: 0, reason: error.message }` for every scorer.

If a grader throws, that scorer is recorded as `{ pass: false, score: 0, reason: "grader error: ..." }`. Other scorers for the same case still run.

---

## 4. Reports and Baselines

### JSON report format

Written to `evals/reports/<suite>-<timestamp>.json`.

```json
{
  "timestamp": "2026-09-25T14:30:00Z",
  "suite": "demo",
  "fleet": "scripted",
  "results": [
    {
      "id": "inv-001",
      "description": "Find mismatched invoices",
      "tags": ["invoices", "happy-path"],
      "status": "completed",
      "durationMs": 1200,
      "cost": 0.03,
      "scores": {
        "correctness": { "pass": true, "score": 1.0, "grader": "exact-match" },
        "efficiency": { "pass": true, "score": 0.7, "grader": "budget-check",
                        "reason": "$0.030 of $0.100 budget" },
        "trajectory": { "pass": true, "score": 1.0, "grader": "trajectory-match" }
      }
    }
  ],
  "summary": {
    "total": 25,
    "passed": 22,
    "failed": 3,
    "cost": 0.52,
    "wallMs": 34000,
    "byTag": {
      "happy-path": { "total": 10, "passed": 10 },
      "edge-case": { "total": 8, "passed": 5 },
      "error-handling": { "total": 7, "passed": 7 }
    }
  }
}
```

A case passes when **all** its scorers pass.

### Stdout format

```
fleet-agent-kit eval — demo — 2026-09-25T14:30:00Z (scripted)

  ✓ inv-001  Find mismatched invoices     correctness:✓ efficiency:✓ trajectory:✓  1.2s  $0.03
  ✗ inv-002  Handle missing ledger        correctness:✗ efficiency:✓               0.8s  $0.01
    Expected: { error: "ledger_not_found" }
    Actual:   { error: "file_not_found" }

  22/25 passed · 3 failed · $0.52 total · 34s wall

  By tag:
    happy-path      10/10  100%
    edge-case        5/8    62%
    error-handling   7/7   100%
```

### Baseline comparison

Reports are saved with timestamps in the filename. When `--baseline=latest`
is passed, the runner finds the most recent report file for that suite and
diffs case-by-case.

Diff logic:
- Match cases by `id`
- For each matched case, compare each scorer: `pass` change and `score` delta
- Cases in current but not baseline → marked "new"
- Cases in baseline but not current → marked "removed"

Baseline stdout:

```
Baseline: demo-2026-09-24T10:00:00Z

  inv-001  correctness ✓→✓  efficiency $0.03→$0.05 ▲ (+66%)
  inv-002  correctness ✗→✓  FIXED
  inv-005  correctness ✓→✗  REGRESSION
    Was: { count: 3 }
    Now: { count: 2 }

  23/25 passed (was 22/25) · 1 fixed · 1 regression · cost $0.52→$0.58
```

`evals/reports/` is gitignored.

---

## 5. Directory Structure

### New files

```
evals/
  runner.mjs               ← programmatic API + CLI entry point
  graders/
    exact-match.mjs
    contains.mjs
    pattern.mjs
    trajectory-match.mjs
    budget-check.mjs
    llm-judge.mjs
    custom.mjs
    index.mjs              ← resolveGrader(name) factory
  suites/
    demo.json              ← example suite shipping with the kit
    travel-agent.json      ← travel agent eval suite (6 cases)
    scripts/
      demo-happy.json      ← scripted fleet responses for demo suite
      demo-error.json
      travel/
        travel-001-manali.json
        travel-002-japan-prep.json
        travel-003-tokyo-brief.json
        travel-004-delhi-manali.json
        travel-005-unreachable.json
        travel-006-over-budget.json
  reports/                 ← generated (gitignored)

template/
  evals/
    suites/
      hello.json           ← starter eval suite for generated agents
      scripts/
        hello-happy.json
    reports/               ← empty, gitignored
```

### Changes to existing files

| File | Change |
|---|---|
| `host/config.mjs` | Add `'evals'` to `IMPLEMENTED_MODULES` |
| `package.json` | Add `"eval": "node evals/runner.mjs"` script. Add `"evals"` to `"files"` array so the harness ships with npm |
| `.gitignore` | Add `evals/reports/` |
| `create/copy.mjs` | Add `'evals'` to `PUBLISHED_DIRS` so generated projects get the runner and graders |
| `template/package.json` | Add `"eval"` script |
| `template/gitignore` | Add `evals/reports/` |

### Config

Optional `evals` block in `host.config.mjs`:

```js
modules: {
  evals: {
    enabled: true,
    suiteDir: './evals/suites',
    reportDir: './evals/reports',
    parallel: false,
  },
}
```

The runner reads this for defaults. Every value is overridable via CLI flags.
If no evals config block exists, the runner uses these defaults.

---

## 6. Demo Suite

Ships with 5-6 cases covering kit capabilities:

| Case ID | Description | Strategy | Scorers |
|---|---|---|---|
| `demo-001` | Happy path open-ended task | open-ended | exact-match, budget-check |
| `demo-002` | Happy path plan-execute task | plan-execute | exact-match, trajectory-match |
| `demo-003` | Agent handles tool error gracefully | open-ended | exact-match |
| `demo-004` | Task exceeds budget | open-ended | exact-match (expects `budget_exceeded` status) |
| `demo-005` | Task references missing tool | open-ended | exact-match (expects `failed` status) |
| `demo-006` | Router classifies task | (omitted — router decides) | exact-match |

Each case has a corresponding scripted fleet JSON in `evals/suites/scripts/`.

---

## 7. Testing the eval harness itself

The eval harness needs its own tests (separate from the suites it runs).
These go in the existing `tests/` directory following kit conventions:

| Test file | What it covers |
|---|---|
| `tests/eval-graders.test.mjs` | Each grader as a pure function — pass cases, fail cases, edge cases |
| `tests/eval-runner.test.mjs` | Runner loads suites, executes cases with mock fleet, produces correct report format |
| `tests/eval-baseline.test.mjs` | Baseline loading, diffing, "new" and "removed" case handling |

Added to `package.json` as `"test:eval"` script.

---

## 8. Travel Agent Eval Suite

The kit's own travel research agent (`host.config.mjs`) is the primary
real-world eval target. This suite tests the agent end-to-end with scripted
fleet responses, covering the tools and strategies it actually uses.

### Suite: `travel-agent.json`

Fleet mode: `scripted` (zero-cost CI runs). Each case scripts the LLM
responses the travel agent would produce for a given goal, and the tool
outputs (weather, country-info, travel-advisory, etc.) are scripted via
`createScriptedFleetApi`'s `tools` field.

| Case ID | Description | Strategy | Tools exercised | Scorers |
|---|---|---|---|---|
| `travel-001` | Plan a 3-day trip to Manali | plan-execute | weather, forecast, destination-overview, route-distance, places-of-interest | exact-match (status: completed), trajectory-match (superset: must call weather + destination-overview), budget-check (maxCost: 1.00), llm-judge (rubric: itinerary has day-by-day plan with dates and costs) |
| `travel-002` | Pre-trip prep for Japan | open-ended | country-info, travel-advisory, currency, public-holidays | exact-match (status: completed), trajectory-match (superset: must call country-info + travel-advisory + currency) |
| `travel-003` | City briefing for Tokyo | open-ended | weather, timezone | exact-match (status: completed), contains (substrings: ["Tokyo", "temperature"]) |
| `travel-004` | Route check Delhi to Manali | open-ended | route-distance | exact-match (status: completed), contains (substrings: ["distance", "km"]) |
| `travel-005` | Trip plan with unreachable destination | plan-execute | weather (returns error) | exact-match (status: completed or failed), llm-judge (rubric: agent communicates the limitation clearly) |
| `travel-006` | Trip plan that exceeds budget | plan-execute | weather, destination-overview | exact-match (status: budget_exceeded), budget-check (maxCost: 0.01, maxIterations: 2) |

### Fleet scripts

Each case has a corresponding script in `evals/suites/scripts/travel/`:

```
evals/suites/scripts/travel/
  travel-001-manali.json       ← scripted: plan steps + tool responses for Manali trip
  travel-002-japan-prep.json   ← scripted: country-info + advisory + currency responses
  travel-003-tokyo-brief.json  ← scripted: weather + timezone for Tokyo
  travel-004-delhi-manali.json ← scripted: route-distance response
  travel-005-unreachable.json  ← scripted: weather tool returns error
  travel-006-over-budget.json  ← scripted: responses that cause many iterations
```

The scripted tool responses mirror real API output shapes so the agent's
tool-parsing code runs for real. Example for weather:

```json
{
  "tools": {
    "weather": {
      "ok": true,
      "city": "Manali",
      "temperature": "12°C",
      "humidity": "65%",
      "wind": "8 km/h",
      "description": "Partly cloudy"
    }
  },
  "goals": {
    "Plan a 3-day trip to Manali": [
      "I'll start by checking the weather and gathering destination info.\n```action\n{\"tool\":\"weather\",\"args\":{\"city\":\"Manali\"}}\n```",
      "Now let me get the destination overview.\n```action\n{\"tool\":\"destination-overview\",\"args\":{\"destination\":\"Manali\"}}\n```",
      "```done\n{\"result\":\"3-day Manali itinerary...\",\"summary\":\"Planned 3-day trip\"}\n```"
    ]
  }
}
```

### Live variant

A `travel-agent-live.json` suite with `"fleet": "live"` can be created for
periodic quality checks against real LLM responses. It uses the same case
structure and scorers but omits the `fleet.script` field. This suite is not
run in CI — only on demand before releases.

---

## 9. Agent Code Integration

### Adding evals to an existing agent

Users add evals to their agent project in three steps:

**Step 1: Create a suite file**

```
mkdir -p evals/suites/scripts
```

Write a JSON suite file in `evals/suites/` following the suite schema from
Section 1. For scripted evals, create fleet script JSON files in
`evals/suites/scripts/`.

**Step 2: Add the eval script to package.json**

```json
{
  "scripts": {
    "eval": "node node_modules/@dsiddharth2/create-fleet-agent/evals/runner.mjs"
  }
}
```

The runner resolves paths relative to the current working directory — it
reads `host.config.mjs` from `.`, loads suites from `./evals/suites/`, and
writes reports to `./evals/reports/`.

**Step 3: Add reports to .gitignore**

```
evals/reports/
```

### Programmatic usage

Users can also import the runner for custom eval scripts:

```js
import { runSuite } from '@dsiddharth2/create-fleet-agent/evals/runner.mjs';

const report = await runSuite('my-suite', {
  configDir: '.',
  baseline: 'latest',
});

if (report.summary.failed > 0) {
  console.error(`${report.summary.failed} cases failed`);
  process.exit(1);
}
```

### Package exports

The eval runner and grader factory are exported from the package so user
agents can import them directly:

| Export path | What it provides |
|---|---|
| `@dsiddharth2/create-fleet-agent/evals/runner.mjs` | `runSuite()`, `runAllSuites()` |
| `@dsiddharth2/create-fleet-agent/evals/graders/index.mjs` | `resolveGrader()` |

These are added to the `"files"` array in the kit's `package.json` so they
ship with the npm package.

---

## 10. Create Command Integration (Agent Scaffolding)

When a new agent is created via `npm create @dsiddharth2/fleet-agent my-agent`
or the `agent-builder` skill, the generated project ships with eval
scaffolding out of the box.

### Template additions

New files in `template/`:

```
template/
  evals/
    suites/
      hello.json             ← starter eval suite for the hello workflow
      scripts/
        hello-happy.json     ← scripted fleet responses for hello test
    reports/                 ← empty dir, gitignored
```

### hello.json (starter suite)

A minimal eval suite that tests the hello workflow the template already ships:

```json
{
  "suite": "hello",
  "description": "Starter eval suite for the hello workflow",
  "fleet": "scripted",
  "defaults": {
    "timeout": 15000,
    "strategy": "open-ended"
  },
  "cases": [
    {
      "id": "hello-001",
      "description": "Hello workflow completes with a greeting",
      "tags": ["happy-path"],
      "task": {
        "goal": "Say hello to Ada"
      },
      "fleet": {
        "script": "./scripts/hello-happy.json"
      },
      "scorers": [
        {
          "name": "correctness",
          "grader": "exact-match",
          "expected": { "status": "completed" }
        },
        {
          "name": "mentions-name",
          "grader": "contains",
          "substrings": ["Ada"]
        }
      ]
    }
  ]
}
```

### Template package.json additions

```json
{
  "scripts": {
    "eval": "node node_modules/@dsiddharth2/create-fleet-agent/evals/runner.mjs"
  }
}
```

### Template .gitignore addition

```
evals/reports/
```

### Changes to create command

| File | Change |
|---|---|
| `template/package.json` | Add `"eval"` script |
| `template/gitignore` | Add `evals/reports/` |
| `template/evals/suites/hello.json` | New file — starter eval suite |
| `template/evals/suites/scripts/hello-happy.json` | New file — scripted fleet for hello |
| `template/evals/reports/` | Empty directory (gitignored) |
| `create/copy.mjs` `PUBLISHED_DIRS` | Add `'evals'` so the graders and runner ship with the package |
| `package.json` `"files"` | Add `'evals'` so npm publishes the eval harness |

### Agent-builder skill integration

When the `agent-builder` skill generates a new agent (via the Claude skill,
not the npm command), it should also generate a starter eval suite tailored
to the agent's tools and goal. The skill's generation step adds:

1. An `evals/suites/<agent-name>.json` with 2-3 cases covering the agent's
   primary workflow
2. Corresponding fleet scripts in `evals/suites/scripts/`
3. The `"eval"` script in `package.json`

This is a best-effort generation — the user refines the cases after creation.

---

## What this spec does not cover

- **Memory integration.** The `preloadMemory` field from the Phase 3 spec is
  deferred until the memory module ships. The suite format does not reserve
  this field yet.
- **Trials / consistency testing.** Running the same case N times to measure
  nondeterminism. Deferred to a follow-up.
- **Online evaluation.** Scoring live production traffic. The JSON report
  format enables a future online loop but this spec covers offline evals only.
- **UI.** No browser-based interface for viewing eval reports. Reports are JSON
  files and stdout output.
- **Schema validation grader.** A Zod-based grader that validates output
  structure. Can be added as a custom grader by users; a built-in version is
  a potential follow-up.
