# Fleet Agent Kit — Phase 2 Spec

Status: proposed

## What Phase 1 shipped

Phase 1 delivered the mandatory core: config loader/validator (`host/config.mjs`),
extended tools registry (`host/tools/registry.mjs`), tool executor
(`host/tools/executor.mjs`), Express comm adapter (`comm/express.mjs`), and the
host entry point with builder API (`host/index.mjs`). The agent boots from
`host.config.mjs`, serves tools via MCP, and exposes a `callTool` method for
direct programmatic access.

Phase 1 is a tool server. An external caller (Claude Code, another agent) does
the reasoning and picks which tools to call. There is no autonomous behaviour.

## What Phase 2 ships

Three modules that give the agent autonomy:

1. **Run loop** — receives a task, uses the LLM to plan and execute tool calls,
   observes results, replans on failure, and returns a final result.
2. **Budgets** — caps on iterations, tokens, cost, and wall-clock time that
   prevent a bad run from becoming an expensive one.
3. **Guardrails** — per-tool safety policies that gate every tool call before
   execution.

### Milestone

`createHost().tools([...]).runLoop({ strategy: 'plan-execute' }).build()` takes
a task and returns a result autonomously. Budget enforcement stops runaway runs.
Guardrails gate irreversible actions. The agent works end-to-end without an
external orchestrator.

### Does not ship

- Async dispatch, job queue, polling, webhook callbacks (Phase 4 — next).
- Memory compaction, run-state checkpoints, crash recovery (Phase 3).
- Eval harness (Phase 3).
- Azure Functions adapter (Phase 4).
- Redis dispatch, concurrent tasks, long-term memory (Phase 5).

### Revised phase order

Phase 4 (dispatch + adapters) moves ahead of Phase 3 (memory + evals) because
async task execution is required before the agent is deployable, while memory
and evals are quality-of-life improvements.

| Order | Phase | Ships |
|-------|-------|-------|
| Done  | 1     | Core + config + comm + tool server |
| Now   | 2     | Run loop + budgets + guardrails |
| Next  | 4     | Dispatch queue + job status + Azure adapter |
| Then  | 3     | Memory + evals |
| Last  | 5     | Scale (Redis, concurrency, long-term memory) |

---

## Run loop

### Overview

The run loop is a plain JS module (`host/run-loop.mjs`) that orchestrates
`fleetApi.executePrompt` calls (for LLM reasoning) and `executeTool` calls
(for tool execution) in a loop. It is not a `WorkflowEngine` workflow — it sits
one level above tools, which may themselves be workflows.

```
Task arrives
  → run-loop.mjs (JS loop)
    → executePrompt (LLM decides: "call weather tool for London")
    → executeTool("weather", {city: "London"})
    → executePrompt (LLM sees result, decides next action)
    → ...repeat until done or budget exceeded
```

### Interface

```js
export async function runTask(task, {
  strategy,           // 'plan-execute' | 'open-ended'
  tools,              // extended registry array
  fleetApi,           // pooled fleet API for this lease
  signal,             // AbortSignal
  budgets,            // budgets module instance, or null
  guardrails,         // guardrails module instance, or null
  maxReplanAttempts,  // plan-execute only, default 3
  maxNoActionTurns,   // consecutive LLM responses with no tool call before failing, default 3
}) → {
  status: 'completed' | 'budget_exceeded' | 'failed' | 'cancelled',
  result: any,           // final result from the LLM's DONE block
  history: Observation[],// full turn-by-turn record
  budget: BudgetSnapshot,// final budget counters (if budgets enabled)
}
```

### Strategies

Both strategies implement the same generator interface. The run loop drives
the generator, checking budgets and signal after each yield.

```js
async function* iterate(task, { tools, fleetApi, signal, budgets, guardrails })
  → yields { type: 'plan'|'action'|'observation'|'replan'|'done'|'error', ... }
```

#### Plan-execute (`host/strategies/plan-execute.mjs`)

1. **Plan** — sends the task + available tools to the doer via a prompt
   template. The doer returns a JSON plan with two step types:

   - `tool` steps: call a tool with arguments.
   - `reason` steps: LLM reasoning — analyze intermediate data, compose
     text, make decisions without calling a tool.

   Each step includes a `review` flag that tells the run loop whether the
   reviewer should verify that step's result. The doer decides which steps
   need review based on task context: irreversible actions, results that
   feed critical downstream steps, and complex reasoning all warrant review.
   Simple factual lookups typically do not.

   ```json
   {"steps": [
     {"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather data", "review": false},
     {"type": "tool", "tool": "timezone", "args": {"city": "London"}, "reason": "Get local time", "review": false},
     {"type": "reason", "prompt": "Analyze weather and time data, compose a city briefing", "review": true},
     {"type": "tool", "tool": "textstats", "args": {}, "reason": "Analyze briefing quality", "review": false},
     {"type": "reason", "prompt": "Finalize the briefing with stats, produce the final output", "review": false}
   ]}
   ```

2. **Review plan** — sends the plan to the reviewer via a review prompt
   template. The reviewer checks for completeness, correct tool selection,
   safety, and whether the `review` flags are set appropriately. The
   reviewer can request changes to review flags (e.g., "step 1 should also
   be reviewed because accuracy is critical for this use case"). If the
   reviewer approves, proceed to execute. If the reviewer raises issues,
   feed the feedback back to the doer and return to step 1 (counts as a
   replan attempt). Up to `maxReviewAttempts` review rounds (default 2).

3. **Execute** — runs steps sequentially. Step execution depends on the type:

   **Tool steps:**
   - If the step has complete args, execute the tool directly (through
     guardrails if enabled).
   - If the step has empty or partial args (because they depend on prior
     step results), the run loop sends the doer an execute prompt with the
     observation history: "You are on step N. Given what has happened so
     far, provide the concrete args." The doer returns a `tool_call` block
     with the filled-in args. The tool is then executed with those args.

   **Reason steps:**
   - The run loop sends the doer an `executePrompt` with the step's prompt
     and all observations so far. The doer's response is recorded as an
     observation in the history, available to subsequent steps.

   **Step review (when `step.review` is true):**
   - After a step produces a result (tool or reason), the reviewer is sent
     a step-review prompt with the step, its result, and the task context.
   - If the reviewer approves, continue to the next step.
   - If the reviewer rejects, the doer receives the feedback and retries
     the step (up to `maxStepReviewAttempts`, default 2). If retries are
     exhausted, enter replan.

   **Review floor:** `minReviewPolicy` (default `'irreversible'`) ensures
   that irreversible tool steps are always reviewed, even if the doer's plan
   set `review: false`. The run loop overrides the flag at execution time.

4. **On failure** — if a step fails and the tool is `retryable`, retry up to
   the tool's retry limit. If not retryable (or retries exhausted), enter
   replan.

5. **Replan** — sends the original task + execution history to the doer. The
   doer returns a revised plan for the remaining work (with step types and
   review flags). The revised plan goes through review (step 2) before
   execution resumes. Up to `maxReplanAttempts` replans (default 3).

6. **Done** — when all steps complete, or the doer returns a `DONE` block with
   the final result.

#### Open-ended (`host/strategies/open-ended.mjs`)

1. Each iteration: send the task + full observation history + available tools
   to the doer.
2. The doer returns either a `TOOL_CALL` block (execute it, add observation,
   loop) or a `DONE` block (return result).
3. No upfront plan. No reviewer step — the open-ended strategy does not
   produce a plan to review. More tokens per iteration, but handles
   surprises better.

The strategy is a configuration choice:

```js
modules: {
  runLoop: {
    enabled: true,
    strategy: 'plan-execute',      // or 'open-ended'
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,          // plan-execute only: reviewer rounds per plan
    maxStepReviewAttempts: 2,      // plan-execute only: retry per step on reviewer rejection
    minReviewPolicy: 'irreversible', // floor: always review irreversible tools even if plan says review: false
    maxNoActionTurns: 3,
  },
}
```

### LLM response format

Prompt templates instruct the LLM to wrap decisions in fenced JSON blocks:

**Tool call:**
````
I need to check the weather in London to answer this question.

```tool_call
{"tool": "weather", "args": {"city": "London"}}
```
````

**Done:**
````
I have all the information I need.

```done
{"result": "London is 15°C and cloudy with WSW winds.", "summary": "Weather check completed."}
```
````

**Plan (plan-execute strategy):**
````
Here is my plan to complete this task.

```plan
{"steps": [
  {"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get current weather data", "review": false},
  {"type": "tool", "tool": "timezone", "args": {"city": "London"}, "reason": "Get local time", "review": false},
  {"type": "reason", "prompt": "Analyze weather and time data, compose a city briefing", "review": true},
  {"type": "tool", "tool": "textstats", "args": {}, "reason": "Analyze briefing quality", "review": false},
  {"type": "reason", "prompt": "Finalize the briefing with stats", "review": false}
]}
```
````

Tool steps may have empty or partial `args` when the values depend on
prior step results. The run loop resolves these at execution time by
asking the doer to fill in args given the observation history.

**Plan review response (from reviewer):**
````
The plan looks good overall. Tool selection is appropriate.

```review
{"approved": true}
```
````

Or with issues (including review flag adjustments):
````
Two problems: step 1 should be reviewed because weather accuracy is critical
for this travel advisory, and step 4 has no args specified but textstats
requires a text argument.

```review
{"approved": false, "feedback": "Mark step 1 for review — accuracy matters for the advisory. Step 4 needs the text arg to be filled at execution time from step 3's output."}
```
````

**Step review response (from reviewer, after a step executes):**
````
The weather result looks correct — London at 15°C matches expectations.

```step_review
{"approved": true}
```
````

Or rejected:
````
The tool returned data for the wrong city. The task asked for Paris but
the result shows London.

```step_review
{"approved": false, "feedback": "Wrong city — got London instead of Paris. Retry with correct args."}
```
````

A parser function extracts fenced blocks from the response text. If no valid
block is found, the run loop treats the response as a "thinking" observation
and prompts again. After `maxNoActionTurns` consecutive non-action responses,
the run loop fails with `status: 'failed'` and the reason `'no_action'`.

### Tool call flow within the run loop

When the LLM requests a tool call:

1. Look up the tool in the registry by name. If not found, feed an error
   observation back to the LLM ("tool not found").
2. If guardrails is enabled, call `guardrails.execute(tool, args)`. If denied,
   feed the denial reason back to the LLM as an observation — the LLM can
   choose a different tool or replan.
3. If guardrails is disabled, call `executeTool(tool, args)` directly.
4. Record the result as an observation in the history.
5. If budgets is enabled, call `budgets.record(usage)` with token counts from
   the preceding `executePrompt` call.
6. If budgets is enabled, call `budgets.check()`. If exceeded, stop the loop.

### Execution model

Sequential only. One `executePrompt` or `executeTool` call at a time. The
doer and reviewer alternate — never called concurrently. This matches Fleet's
one-prompt-per-member constraint. Concurrent execution is a Phase 5 concern.

Typical plan-execute flow on the wire (city briefing example):

```
executePrompt(doer)        → plan (5 steps: 2 tool, 2 reason, 1 tool)
executePrompt(reviewer)    → plan review (approved, adjusted review flags)
executeTool(weather)       → observation  [step 1, review: false]
executeTool(timezone)      → observation  [step 2, review: false]
executePrompt(doer)        → reason: compose briefing  [step 3, review: true]
executePrompt(reviewer)    → step review: briefing quality (approved)
executePrompt(doer)        → resolve args for textstats from step 3 output
executeTool(textstats)     → observation  [step 4, review: false]
executePrompt(doer)        → reason: finalize output  [step 5, review: false]
executePrompt(doer)        → done
```

---

## Prompt templates

Pure JS functions that take structured inputs and produce prompt strings. No
template engine.

### Module structure

```
host/prompts/
  index.mjs            — re-exports all templates
  system.mjs           — base system prompt (role, rules, response format)
  plan.mjs             — plan-execute: "here's the task, make a plan" (sent to doer)
  review.mjs           — plan-execute: "review this plan" (sent to reviewer)
  step-review.mjs      — plan-execute: "verify this step's result" (sent to reviewer)
  execute.mjs          — plan-execute: "here's the step result, continue" (sent to doer)
  resolve-args.mjs     — plan-execute: "fill in args for step N given history" (sent to doer)
  reason.mjs           — plan-execute: "execute this reasoning step" (sent to doer)
  replan.mjs           — plan-execute: "step failed or reviewer flagged issues, revise" (sent to doer)
  act.mjs              — open-ended: "here's everything so far, what next?" (sent to doer)
  format-tools.mjs     — renders available tools as a text catalog for the LLM
```

### Template signatures

```js
// system.mjs — base system prompt with response format rules
export function buildSystemPrompt({ agentName, agentDescription }) → string

// plan.mjs — initial planning prompt (sent to doer)
export function buildPlanPrompt({ task, tools, systemPrompt }) → string

// review.mjs — plan review prompt (sent to reviewer)
export function buildReviewPrompt({ task, plan, tools, systemPrompt }) → string

// step-review.mjs — step result verification (sent to reviewer)
export function buildStepReviewPrompt({ task, step, result, history, systemPrompt }) → string

// execute.mjs — continue execution after a step (sent to doer)
export function buildExecutePrompt({ task, plan, stepIndex, observation, systemPrompt }) → string

// resolve-args.mjs — fill in tool args from history (sent to doer)
export function buildResolveArgsPrompt({ task, step, history, systemPrompt }) → string

// reason.mjs — execute a reasoning step (sent to doer)
export function buildReasonPrompt({ task, step, history, systemPrompt }) → string

// replan.mjs — revise plan after failure or reviewer feedback (sent to doer)
export function buildReplanPrompt({ task, plan, history, failedStep, reviewerFeedback, systemPrompt }) → string

// act.mjs — open-ended: full history, decide next action (sent to doer)
export function buildActPrompt({ task, history, tools, systemPrompt }) → string

// format-tools.mjs — render tool catalog
export function formatTools(tools) → string
```

### System prompt

Sets the contract for the LLM:

- Role: you are an autonomous agent executing a task using available tools.
- Response format: use `tool_call`, `plan`, and `done` fenced JSON blocks.
- Plan format: steps have a `type` (`tool` or `reason`) and a `review` flag.
  Set `review: true` for irreversible actions, results feeding critical
  downstream steps, and complex reasoning. Set `review: false` for simple
  factual lookups with no downstream risk.
- Tool step args: provide args when known upfront. Leave args empty (`{}`)
  when values depend on prior step results — the run loop will ask you to
  fill them in at execution time with full observation context.
- Rules: one tool call per turn. Always include reasoning before the block.
  Never call tools that do not exist. If a tool is denied by guardrails,
  choose an alternative or report that the task cannot be completed.

### Tool catalog format

`formatTools` renders the registry into a text block the LLM can read:

```
Available tools:

- weather(city?: string) — Fetches current weather for a city. Read-only. [reversible]
- timezone(city?: string) — Fetches current local time and timezone. Read-only. [reversible]
- demo() — Runs the demo workflow. [irreversible]
```

Includes the reversibility flag so the LLM can make informed choices about
which tools to use.

---

## Budgets

Caps that prevent a bad run from becoming an expensive one.

### Interface

```js
export function createBudgets(config) → {
  check()        → { ok: true } | { ok: false, reason: string }
  record(usage)  → void
  snapshot()     → BudgetSnapshot
}
```

Where `BudgetSnapshot` is:

```js
{
  iterations: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalTokens: number,
  estimatedCostUsd: number,
  elapsedMs: number,
}
```

### Configuration

```js
modules: {
  budgets: {
    enabled: true,
    maxIterations: 25,
    maxCostUsd: 5.00,
    maxTokens: 500_000,
    timeoutMs: 600_000,         // 10 min wall clock
    pricing: {                  // optional, defaults to Claude Sonnet
      inputPer1k: 0.003,
      outputPer1k: 0.015,
    },
  },
}
```

### Behaviour

1. `createBudgets(config)` initializes counters at zero and records
   `startTime = Date.now()`.
2. After each `executePrompt` call, the run loop calls
   `budgets.record({ inputTokens, outputTokens })`. The module accumulates
   totals and estimates cost from the pricing table.
3. After each iteration, the run loop calls `budgets.check()`. If any cap is
   exceeded, the check returns `{ ok: false, reason }` where reason is one of
   `'max_iterations'`, `'max_tokens'`, `'max_cost'`, `'timeout'`.
4. The run loop stops and returns `status: 'budget_exceeded'` with a partial
   result and the budget snapshot.
5. `snapshot()` returns the current state of all counters at any time, used
   for logging and the `/task` response.

### Token extraction

Fleet's `executePrompt` returns an MCP tool result. Token counts come from
the response metadata if Fleet provides them. If not available, the module
falls back to a character-based estimate (`chars / 4`) and logs a warning.
This keeps the module functional without requiring Fleet-side changes.

### When disabled

The run loop skips all budget calls. No stub, no no-op — the run loop checks
`if (budgets)` before calling.

---

## Guardrails

Safety checks that gate every tool call before execution.

### Interface

```js
export function createGuardrails(config, tools) → {
  gate(tool, args, context)     → { allowed: true } | { allowed: false, reason, policy }
  execute(tool, executorArgs)   → executeTool result
  dryRun()                      → boolean
}
```

`execute` is the primary call: it runs `gate` first, then `executeTool` if
allowed. The run loop calls `guardrails.execute(tool, args)` instead of
`executeTool(tool, args)` directly when guardrails is enabled.

### Configuration

```js
modules: {
  guardrails: {
    enabled: true,
    dryRunMode: false,
    sandboxFs: true,
    validateInputs: true,
    validateOutputs: false,
    defaultPolicy: 'allow',
    policies: {
      'demo': 'approve',
      'weather': 'allow',
      'dangerous-cleanup': 'deny',
    },
    approvalCallback: async ({ tool, args, context }) => 'approve' | 'deny',
  },
}
```

### Per-tool policy resolution

Three policies: `allow`, `deny`, `approve`.

Resolution order:

1. `config.policies[tool.name]` — explicit per-tool override.
2. If not set, check `tool.reversible`. Irreversible tools
   (`reversible: false`) default to `approve`.
3. If still not resolved, use `config.defaultPolicy` (defaults to `allow`).

### The `approve` policy

When a tool requires approval, guardrails calls `config.approvalCallback`.
If no callback is configured, `approve`-policy tools fall back to `deny`
(safe default — cannot approve without an approver).

Phase 2 ships a logging callback that auto-denies and logs the request. A
future Phase could plug in an HTTP approval endpoint or human-in-the-loop UI
via the same callback interface.

### Gate flow

```
tool call requested
  → validate inputs (if validateInputs, uses tool.inputSchema)
  → resolve policy for this tool
  → if 'deny': return { allowed: false, reason: 'policy_denied' }
  → if 'approve': call approvalCallback
    → 'deny': return { allowed: false, reason: 'approval_denied' }
    → 'approve': continue
  → if 'allow': continue
  → if sandboxFs: check args for paths outside workdir
  → if dryRunMode: log the call, return { allowed: false, reason: 'dry_run' }
  → execute tool via executeTool
  → if validateOutputs: validate return shape
  → return result
```

### When a tool is denied

`guardrails.execute` returns the same error-as-value shape as `executeTool`:
`{ ok: false, error: 'guardrail_denied', reason: 'policy_denied' | 'approval_denied' | 'dry_run' | 'sandbox_violation' }`.
The run loop feeds this back to the LLM as an observation. The LLM can choose
a different tool or replan around the denial.

### When disabled

The run loop calls `executeTool` directly, identical to Phase 1 behaviour.

---

## Integration

### Config evolution

`host/config.mjs` changes:

- `IMPLEMENTED_MODULES` updated from `new Set([])` to
  `new Set(['runLoop', 'budgets', 'guardrails'])`.
- The config loader parses and validates the Phase 2 module sections.
- Module dependency warnings: `budgets` without `runLoop` logs a warning
  (budget enforcement will not run). `guardrails` has no dependency — it
  works in tool-server mode too.

### Host entry point changes

`startHost` gains module initialization:

```
Config loaded
  → Tools registry loaded
  → Fleet transport ready
  → Guardrails created (if enabled) — wraps executeTool
  → Budgets created (if enabled)
  → Run loop configured (if enabled) — receives tools, guardrails, budgets
  → /task route wired (if run loop enabled)
  → /mcp route wired (always)
  → Comm adapter starts
```

### The `/task` route

Synchronous. The request blocks until the run loop finishes, capped by
`budgets.timeoutMs` if budgets is enabled.

```
POST /task
  Content-Type: application/json
  { "goal": "...", "inputs": {...}, "constraints": {...}, "budget": {...} }

  → 200 {
      "taskId": "t-abc123",
      "status": "completed",
      "result": {...},
      "history": [...],
      "budget": { "iterations": 7, "totalTokens": 42000, ... }
    }
```

Caller-supplied `constraints` and `budget` fields merge with the agent's
configured defaults. The stricter value wins (lower cap, shorter timeout).

Phase 4 replaces this synchronous route with async dispatch (202 Accepted +
polling).

### Task shape

```js
{
  id: string,             // generated if not provided
  goal: string,           // natural-language task description
  inputs: object,         // optional structured inputs
  constraints: {          // optional overrides
    maxIterations: number,
    timeoutMs: number,
  },
  budget: {               // optional overrides
    maxCostUsd: number,
    maxTokens: number,
  },
}
```

### Builder API extensions

```js
const agent = createHost({ fleetApi, dispatcher })
  .tools([...])
  .runLoop({ strategy: 'plan-execute', maxReplanAttempts: 3 })
  .budget({ maxIterations: 25, maxCostUsd: 5 })
  .guardrails({ policies: { demo: 'approve' } })
  .build();

// Start as HTTP server
const { host, close } = await agent.start();

// Or run a task programmatically (no HTTP server)
const result = await agent.run({
  goal: 'Find the weather in London and write a briefing',
});
```

The builder's `.run(task)` acquires a worker lease, creates module instances,
calls `runTask`, releases the lease, and returns the result.

### `callTool` with guardrails

The existing `callTool` method routes through guardrails when enabled. Direct
tool calls from external MCP clients also pass through guardrails — the
guardrails module wraps the executor globally, not just for the run loop.

---

## Example scenarios — Travel Research Agent

Phase 2 ships a **Travel Research Agent** as the reference implementation.
All 12 scenarios use the same agent and the same tool set, progressing from
simple lookups to complex multi-step plans that exercise every Phase 2 feature.

### Tool set

10 tools, all read-only, all no-auth free APIs. The first three are already
shipped; the remaining seven are new Python scripts following the same
`tools/<name>/<name>.py` stdlib-only convention.

| # | Tool | API | What it returns |
|---|------|-----|-----------------|
| 1 | `weather` | wttr.in | Current temperature, humidity, wind, UV | 
| 2 | `timezone` | worldtimeapi.org | Local datetime, UTC offset, abbreviation |
| 3 | `textstats` | local Python | Word count, sentence count, avg word length |
| 4 | `currency` | frankfurter.app | Exchange rates, currency conversion |
| 5 | `country-info` | restcountries.com | Language, currency, capital, region, population |
| 6 | `travel-advisory` | travel-advisory.info | Safety score + advisory per country |
| 7 | `geocode` | nominatim.openstreetmap.org | Lat/lon from city name, nearby POIs |
| 8 | `forecast` | open-meteo.com | 7-day weather forecast (hourly/daily) |
| 9 | `wikipedia-summary` | en.wikipedia.org REST API | City/landmark summary extract |
| 10 | `public-holidays` | date.nager.at | Public holidays by country and year |

All tools call their API via `urllib` / `http.client` (Python stdlib only, no
pip install). Each returns JSON. Each is registered in the tools registry with
`reversible: true` and `readOnlyHint: true`.

### Scenario 1 — "What's the weather in Tokyo?"

**Tier:** Simple lookup.
**Strategy:** Open-ended (one-shot, no plan needed).
**Tools:** weather.
**Steps:**

```json
{"type": "tool", "tool": "weather", "args": {"city": "Tokyo"}, "reason": "Get current weather", "review": false}
```

**Exercises:** Simplest possible task. Single tool call, single turn. Verifies
the run loop can execute a one-step task and return a result.

### Scenario 2 — "What time is it in New York and what's the weather like?"

**Tier:** Simple multi-tool.
**Strategy:** Plan-execute.
**Tools:** timezone, weather.
**Steps:**

```json
[
  {"type": "tool", "tool": "timezone", "args": {"city": "New York"}, "reason": "Get local time", "review": false},
  {"type": "tool", "tool": "weather", "args": {"city": "New York"}, "reason": "Get current weather", "review": false},
  {"type": "reason", "prompt": "Combine the time and weather into a natural sentence", "review": false}
]
```

**Exercises:** Two tool calls + one reason step. The reason step composes a
human-readable answer from raw data.

### Scenario 3 — "Compare the weather in London, Paris, and Berlin"

**Tier:** Simple multi-tool with dynamic args.
**Strategy:** Plan-execute.
**Tools:** weather ×3.
**Steps:**

```json
[
  {"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get London weather", "review": false},
  {"type": "tool", "tool": "weather", "args": {"city": "Paris"}, "reason": "Get Paris weather", "review": false},
  {"type": "tool", "tool": "weather", "args": {"city": "Berlin"}, "reason": "Get Berlin weather", "review": false},
  {"type": "reason", "prompt": "Compare all three cities and rank by best weather for outdoor activities", "review": false}
]
```

**Exercises:** Same tool called with different inputs. Reason step does
cross-result analysis.

### Scenario 4 — "I'm visiting Tokyo next week. What's the forecast and are there any public holidays?"

**Tier:** Multi-tool + reasoning.
**Strategy:** Plan-execute.
**Tools:** forecast, public-holidays.
**Steps:**

```json
[
  {"type": "tool", "tool": "forecast", "args": {"city": "Tokyo"}, "reason": "Get 7-day forecast", "review": false},
  {"type": "tool", "tool": "public-holidays", "args": {"country": "JP"}, "reason": "Check for upcoming holidays", "review": false},
  {"type": "reason", "prompt": "Connect forecast to holidays: flag rainy days, warn about holiday crowds, suggest what to pack", "review": false}
]
```

**Exercises:** Two different tools feeding one reason step that synthesizes
practical advice.

### Scenario 5 — "I'm traveling from the US to Japan. What currency do I need, what's the exchange rate, and any travel advisories?"

**Tier:** Multi-tool + reasoning with dynamic args.
**Strategy:** Plan-execute.
**Tools:** country-info, currency, travel-advisory.
**Steps:**

```json
[
  {"type": "tool", "tool": "country-info", "args": {"country": "Japan"}, "reason": "Get local currency name and code", "review": false},
  {"type": "tool", "tool": "currency", "args": {}, "reason": "Convert USD to local currency", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "JP"}, "reason": "Check safety advisories", "review": false},
  {"type": "reason", "prompt": "Synthesize into practical travel prep: what currency to bring, current rate, and any safety warnings", "review": false},
  {"type": "reason", "prompt": "Add practical tips: where to exchange, tipping customs, payment methods common in Japan", "review": false}
]
```

**Exercises:** Dynamic args — step 2 (currency) needs the currency code from
step 1 (country-info), so args are resolved at execution time. Two reason
steps build on each other.

### Scenario 6 — "Give me a complete overview of Barcelona"

**Tier:** Multi-tool briefing.
**Strategy:** Plan-execute.
**Tools:** weather, timezone, country-info, travel-advisory, wikipedia-summary.
**Steps:**

```json
[
  {"type": "tool", "tool": "weather", "args": {"city": "Barcelona"}, "reason": "Current weather", "review": false},
  {"type": "tool", "tool": "timezone", "args": {"city": "Barcelona"}, "reason": "Local time", "review": false},
  {"type": "tool", "tool": "country-info", "args": {"country": "Spain"}, "reason": "Country facts", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "ES"}, "reason": "Safety info", "review": false},
  {"type": "tool", "tool": "wikipedia-summary", "args": {"topic": "Barcelona"}, "reason": "Brief history and highlights", "review": false},
  {"type": "reason", "prompt": "Organize all data into a cohesive city briefing with sections: At a Glance, Weather, Safety, History, and Traveler Tips", "review": false},
  {"type": "reason", "prompt": "Polish the briefing: tighten prose, ensure consistency, highlight what a first-time visitor should know", "review": false}
]
```

**Exercises:** Five different tools feeding a two-pass reasoning pipeline.
The second reason step refines the first — shows iterative composition.

### Scenario 7 — "Compare London, Paris, and Barcelona for a December trip"

**Tier:** Review-critical — cross-city comparison.
**Strategy:** Plan-execute.
**Tools:** weather ×3, public-holidays ×3, travel-advisory ×3, currency ×2.
**Steps (abbreviated):**

```json
[
  {"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "London weather", "review": false},
  {"type": "tool", "tool": "public-holidays", "args": {"country": "GB"}, "reason": "UK December holidays", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "GB"}, "reason": "UK safety", "review": false},
  {"type": "reason", "prompt": "Summarize London as a December destination", "review": false},

  {"type": "tool", "tool": "weather", "args": {"city": "Paris"}, "reason": "Paris weather", "review": false},
  {"type": "tool", "tool": "public-holidays", "args": {"country": "FR"}, "reason": "France December holidays", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "FR"}, "reason": "France safety", "review": false},
  {"type": "reason", "prompt": "Summarize Paris as a December destination", "review": false},

  {"type": "tool", "tool": "weather", "args": {"city": "Barcelona"}, "reason": "Barcelona weather", "review": false},
  {"type": "tool", "tool": "public-holidays", "args": {"country": "ES"}, "reason": "Spain December holidays", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "ES"}, "reason": "Spain safety", "review": false},
  {"type": "reason", "prompt": "Summarize Barcelona as a December destination", "review": false},

  {"type": "tool", "tool": "currency", "args": {"from": "USD", "to": "GBP"}, "reason": "USD to GBP rate", "review": false},
  {"type": "tool", "tool": "currency", "args": {"from": "USD", "to": "EUR"}, "reason": "USD to EUR rate", "review": false},
  {"type": "reason", "prompt": "Compare all three cities across weather, holidays, safety, and cost. Recommend the best option with justification", "review": true}
]
```

**Exercises:** 11+ tool calls, 4 reason steps. **Reviewer checks the final
comparison** — verifies the recommendation follows logically from the data
("you said Paris is cheapest but the exchange rate data says otherwise").
Budget enforcement matters at this scale.

### Scenario 8 — "Write a 3-day Tokyo travel guide"

**Tier:** Review-critical — multi-day guide.
**Strategy:** Plan-execute.
**Tools:** forecast, country-info, public-holidays, wikipedia-summary, travel-advisory.
**Steps (abbreviated):**

```json
[
  {"type": "tool", "tool": "forecast", "args": {"city": "Tokyo"}, "reason": "3-day forecast", "review": false},
  {"type": "tool", "tool": "country-info", "args": {"country": "Japan"}, "reason": "Cultural context", "review": false},
  {"type": "tool", "tool": "public-holidays", "args": {"country": "JP"}, "reason": "Check for holidays during visit", "review": false},
  {"type": "tool", "tool": "wikipedia-summary", "args": {"topic": "Tokyo"}, "reason": "Key landmarks and history", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "JP"}, "reason": "Safety and health advisories", "review": false},
  {"type": "reason", "prompt": "Plan Day 1: arrival, orientation, nearby landmarks. Account for weather and jet lag", "review": true},
  {"type": "reason", "prompt": "Plan Day 2: main sightseeing. Account for weather forecast and any holidays", "review": true},
  {"type": "reason", "prompt": "Plan Day 3: cultural experiences and departure prep. Include practical tips", "review": true},
  {"type": "reason", "prompt": "Compile into a polished 3-day travel guide with cultural tips and safety notes", "review": false}
]
```

**Exercises:** **Reviewer verifies each day's plan** — checks geographic
feasibility ("you can't do Shibuya and Mount Fuji in the same afternoon"),
weather-plan alignment, and cultural accuracy. Review on reason steps, not
tool steps.

### Scenario 9 — "Compare Lisbon, Bangkok, and Cape Town for a potential relocation"

**Tier:** Review-critical — high-stakes research.
**Strategy:** Plan-execute.
**Tools:** weather ×3, country-info ×3, travel-advisory ×3, wikipedia-summary ×3, currency ×3.
**Steps:** 15+ tool calls, 5+ reason steps.

Per city:
```json
[
  {"type": "tool", "tool": "weather", "args": {"city": "Lisbon"}, "reason": "Climate snapshot", "review": false},
  {"type": "tool", "tool": "country-info", "args": {"country": "Portugal"}, "reason": "Language, currency, population", "review": false},
  {"type": "tool", "tool": "travel-advisory", "args": {"country": "PT"}, "reason": "Safety and stability", "review": false},
  {"type": "tool", "tool": "wikipedia-summary", "args": {"topic": "Lisbon"}, "reason": "Culture and lifestyle", "review": false},
  {"type": "tool", "tool": "currency", "args": {"from": "USD", "to": "EUR"}, "reason": "Cost baseline", "review": false},
  {"type": "reason", "prompt": "Analyze Lisbon as a relocation destination: climate, safety, cost, culture, language barrier", "review": true}
]
```

Then repeat for Bangkok and Cape Town, followed by:
```json
[
  {"type": "reason", "prompt": "Write a comparative brief across all three cities. Rank on: climate, safety, cost of living, cultural fit, language accessibility. Give a clear recommendation", "review": true}
]
```

**Exercises:** **Reviewer verifies each city's analysis AND the final
recommendation.** The stakes are higher than a vacation — flawed reasoning
in a relocation recommendation has real consequences. Budget enforcement
prevents runaway research. Dynamic args throughout.

### Scenario 10 — "Research every capital city in Europe — weather and country info"

**Tier:** Budget-critical — scale test.
**Strategy:** Plan-execute.
**Tools:** weather ×40+, country-info ×40+.
**Budget config:** `maxIterations: 25`.

The doer plans 80+ tool calls (40+ countries × 2 tools each). Budget cap at
25 iterations forces the agent to prioritize. The agent must:

1. Recognize it cannot complete all calls within budget.
2. Prioritize the most-requested or most-interesting countries.
3. Produce the best partial result it can.
4. Return `status: 'budget_exceeded'` with what was completed.

**Exercises:** **Budget enforcement is the point.** Tests that `maxIterations`
stops the run cleanly, partial results are returned, and the agent replans
when it realizes it will run out of budget.

### Scenario 11 — "Find the nearest landmarks to GPS coordinates 48.8584, 2.2945"

**Tier:** Guardrails — sandbox test.
**Strategy:** Plan-execute.
**Tools:** geocode, wikipedia-summary.
**Steps:**

```json
[
  {"type": "tool", "tool": "geocode", "args": {"lat": 48.8584, "lon": 2.2945}, "reason": "Reverse geocode to find nearby landmarks", "review": false},
  {"type": "reason", "prompt": "Identify the top 3 landmarks from the geocode results", "review": false},
  {"type": "tool", "tool": "wikipedia-summary", "args": {}, "reason": "Get summary for each landmark", "review": false},
  {"type": "reason", "prompt": "Write a brief guide to the nearby landmarks", "review": false}
]
```

If the agent attempts to write results to a file outside the working
directory, **guardrails sandbox blocks it** and returns
`{ ok: false, error: 'guardrail_denied', reason: 'sandbox_violation' }`.
The agent receives this as an observation and adjusts — returns the result
inline instead.

**Exercises:** Filesystem sandbox enforcement. Guardrails working on a
read-only agent. Also tests dynamic args — wikipedia-summary args depend
on geocode results.

### Scenario 12 — "Full 2-week Japan trip research package — all cities, all data, no shortcuts"

**Tier:** Stress test — everything at once.
**Strategy:** Plan-execute.
**Tools:** All 10.
**Budget config:** `maxIterations: 30`, `maxCostUsd: 3.00`.

The doer plans research for Tokyo, Osaka, Kyoto, Hiroshima, and Nara: weather,
forecast, timezone, country-info, travel-advisory, public-holidays, currency,
wikipedia-summary, and geocode for each city. 40+ tool calls, 8+ reason steps.

The run exercises the full cycle:

1. **Plan** — doer creates an ambitious plan with review flags on key reason
   steps.
2. **Plan review** — reviewer checks the plan, may adjust review flags.
3. **Execute** — tool calls begin. Budget ticks down.
4. **Step review** — reviewer verifies key reason steps (e.g., the cultural
   tips for each city).
5. **Budget exceeded** — at iteration 30, budgets fires. The agent has
   completed 3 of 5 cities.
6. **Replan** — the agent replans to produce the best partial result: a
   complete guide for 3 cities with a note that Hiroshima and Nara were not
   researched due to budget limits.
7. **Done** — returns the partial result with `status: 'budget_exceeded'`
   and the full budget snapshot.

**Exercises:** Every Phase 2 feature: plan-execute strategy, tool + reason
steps, LLM-driven review flags, plan review, step review, dynamic arg
resolution, budget enforcement, replanning on budget exhaustion, and partial
result delivery.

### Feature coverage matrix

| # | Scenario | Tools | Reason | Review | Guardrails | Budget | Replan | Dynamic args |
|---|----------|-------|--------|--------|-----------|--------|--------|-------------|
| 1 | Tokyo weather | 1 | 0 | — | — | — | — | — |
| 2 | NYC time + weather | 2 | 1 | — | — | — | — | — |
| 3 | 3-city weather compare | 3 | 1 | — | — | — | — | — |
| 4 | Tokyo forecast + holidays | 2 | 1 | — | — | — | — | — |
| 5 | US→Japan travel prep | 3 | 2 | — | — | — | — | yes |
| 6 | Barcelona overview | 5 | 2 | — | — | — | — | yes |
| 7 | 3-city December compare | 11+ | 4 | comparison | — | yes | — | yes |
| 8 | 3-day Tokyo guide | 5 | 4 | per-day plan | — | — | — | yes |
| 9 | Relocation comparison | 15+ | 5+ | per-city + final | — | yes | — | yes |
| 10 | Europe capitals survey | 40+ | 1 | — | — | **yes** | yes | yes |
| 11 | GPS landmark lookup | 2 | 2 | — | **sandbox** | — | — | yes |
| 12 | Full Japan research | 40+ | 8+ | key sections | **sandbox** | **yes** | **yes** | yes |

---

## File tree

New and changed files for Phase 2:

```
host/
  index.mjs              ← CHANGED — module wiring, /task route, .run(), .runLoop()/.budget()/.guardrails() on builder
  config.mjs             ← CHANGED — validates Phase 2 modules, IMPLEMENTED_MODULES updated
  run-loop.mjs           ← NEW — drives strategy generator, checks budgets/signal
  budgets.mjs            ← NEW — iteration/token/cost/time caps
  guardrails.mjs         ← NEW — policy gate, approval, sandbox, dry-run
  strategies/
    plan-execute.mjs     ← NEW — plan upfront, execute steps, replan on failure
    open-ended.mjs       ← NEW — no plan, decide each action from full history
  prompts/
    index.mjs            ← NEW — re-exports
    system.mjs           ← NEW — base system prompt
    plan.mjs             ← NEW — "make a plan" template (doer)
    review.mjs           ← NEW — "review this plan" template (reviewer)
    step-review.mjs      ← NEW — "verify this step's result" template (reviewer)
    execute.mjs          ← NEW — "continue executing" template (doer)
    resolve-args.mjs     ← NEW — "fill in args for step N" template (doer)
    reason.mjs           ← NEW — "execute reasoning step" template (doer)
    replan.mjs           ← NEW — "revise the plan" template (doer)
    act.mjs              ← NEW — open-ended "what next?" template (doer)
    format-tools.mjs     ← NEW — renders tool catalog for LLM
  tools/
    registry.mjs         ← UNCHANGED
    executor.mjs         ← UNCHANGED
```

---

## Testing strategy

Each module is independently testable with a mock `fleetApi`.

### Unit tests

| Module | Test file | What it covers |
|--------|-----------|----------------|
| Run loop | `tests/host-run-loop.test.mjs` | Drives a mock strategy, verifies budget checks, signal cancellation, history accumulation, status codes |
| Plan-execute strategy | `tests/host-strategy-plan-execute.test.mjs` | Plan parsing (tool + reason steps), review flags, step execution, arg resolution, step review flow, retry, replan trigger, done detection |
| Open-ended strategy | `tests/host-strategy-open-ended.test.mjs` | Action parsing, history growth, done detection, no-action timeout |
| Prompt templates | `tests/host-prompts.test.mjs` | Each template returns a string containing expected sections (task, tools, format instructions) |
| Budgets | `tests/host-budgets.test.mjs` | Each cap type, record accumulation, snapshot accuracy, disabled state |
| Guardrails | `tests/host-guardrails.test.mjs` | All three policies, approval callback, sandbox path check, dry-run mode, denied observation flow |
| Response parser | `tests/host-response-parser.test.mjs` | Extracts tool_call, plan, done, review, step_review blocks; handles malformed input, missing blocks |
| Config (Phase 2) | `tests/host-config.test.mjs` | Extended to cover Phase 2 module validation |
| Host integration | `tests/host-index.test.mjs` | Extended: /task route, .run() method, guardrails wiring |

### Live integration test

`tests/host-phase2.live.test.mjs` — requires Docker/Fleet. Submits a task to
the `/task` endpoint and verifies the agent plans, executes tools, and returns
a result autonomously.

### Mock fleet extension

`tests/helpers/mock-fleet.mjs` gains a configurable `executePrompt` handler
that returns scripted LLM responses (plan JSON, tool_call blocks, done blocks)
so the run loop can be tested end-to-end without a real LLM.
