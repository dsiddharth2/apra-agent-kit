# Phase 2: Autonomous Run Loop

The run loop turns apra-agent-kit from a tool server into an autonomous agent. Instead of
an external LLM choosing tools one at a time through MCP, the host accepts a task goal
and drives tool selection, execution, and review internally.

## Two interfaces, two consumers

| Endpoint | Consumer | Who decides what to do |
|---|---|---|
| `POST /mcp` | An external AI agent (Claude Code, etc.) | The caller's LLM picks tools |
| `POST /task` | A human, app, or API client | The host's own LLM plans and executes |

These are deliberately separate. Nesting an autonomous loop inside an MCP tool call
would create agent-inside-agent — double token spend, lost visibility, and two brains
fighting over strategy.

## Architecture

```text
POST /task { goal, constraints, budget }
  │
  ├─ mergeBudgetConfig()        server defaults ∩ request constraints (stricter wins)
  ├─ dispatcher.dispatch()      acquire a worker lease (doer + reviewer pair)
  │
  └─ runTask(task, opts)        host/run-loop.mjs
       │
       ├─ select strategy       'open-ended' or 'plan-execute' (from config)
       │
       ├─ for await (event of strategy.iterate())
       │    ├─ prompt_usage → budgets.record() + budgets.check()
       │    ├─ done         → return result
       │    ├─ error        → return failure
       │    └─ observation  → accumulate history
       │
       └─ return { status, result, history, budget }
```

## Strategies

### Open-ended (ReAct loop)

A simple act-observe loop. The doer LLM sees the task and tools, picks one to call,
observes the result, and repeats until it emits a `done` block.

```text
Doer: "I need weather data" → tool_call { weather, { city: "Tokyo" } }
  → observation: { temp_c: 28, ... }
Doer: "Now I need currency" → tool_call { currency, { from: USD, to: JPY } }
  → observation: { rate: 149.52, ... }
Doer: "I have everything"   → done { result: "..." }
```

Good for: simple tasks, few steps, quick lookups.

Safety valves:
- `maxNoActionTurns` (default 3) — stops if the LLM produces thinking without
  calling a tool or finishing.

### Plan-execute

A structured multi-phase loop with a doer and a reviewer.

```text
Phase 1: PLAN
  Doer creates an ordered plan (tool steps + reason steps)
    ↓
Phase 2: REVIEW
  Reviewer approves or rejects with feedback
  If rejected → Doer replans (up to maxReplanAttempts)
    ↓
Phase 3: EXECUTE
  Steps run one at a time:
    tool step  → execute tool, record observation
    reason step → Doer analyzes/synthesizes, record observation
  Per-step review for irreversible tools or flagged steps
  Dynamic arg resolution for steps depending on prior results
  Tool failure → retry if retryable, otherwise replan
    ↓
Phase 4: DONE
  Doer produces final result
```

Good for: multi-step tasks, tasks with irreversible actions, tasks needing review.

Configuration:

| Option | Default | Purpose |
|---|---|---|
| `maxReplanAttempts` | 3 | Total replans before failing |
| `maxReviewAttempts` | 2 | Plan review rounds before accepting |
| `maxStepReviewAttempts` | 2 | Per-step review retries before replan |
| `maxNoActionTurns` | 3 | Thinking-only turns before failing |
| `minReviewPolicy` | `'irreversible'` | Which steps get step-level review |

### How decisions are made

The code is pure orchestration — it structures conversations with the LLM and routes
responses into actions. The LLM is the decision-maker at every step.

The **doer** LLM proposes plans and executes steps. The **reviewer** LLM evaluates plans
and step results. They are both `executePrompt` calls but with different prompt framing.
The code never decides *what* to do — it decides *when to ask whom* and *what to do with
the answer*.

The strategy is a static config value, not a runtime decision. Set it in
`host.config.mjs` under `modules.runLoop.strategy`.

## Budgets

Caps on resource consumption. Checked after every LLM call.

```js
modules: {
  budgets: {
    enabled: true,
    maxIterations: 25,       // LLM calls (plan, review, reason, done)
    maxCostUsd: 5.00,        // estimated cost from token counts
    maxTokens: 500_000,      // total input + output tokens
    timeoutMs: 600_000,      // wall clock time (10 minutes)
  }
}
```

### Per-request overrides

Callers can tighten (never loosen) budgets via the request body:

```json
{
  "goal": "...",
  "constraints": { "maxIterations": 10, "timeoutMs": 300000 },
  "budget": { "maxCostUsd": 1.00, "maxTokens": 100000 }
}
```

`mergeBudgetConfig` picks `Math.min(server, request)` for each cap.

### Budget-exceeded response

When a limit is hit, the response includes diagnostics:

```json
{
  "status": "budget_exceeded",
  "result": {
    "budgetReason": "timeout",
    "limit": 60000,
    "actual": 86284
  }
}
```

Possible `budgetReason` values: `max_iterations`, `max_tokens`, `max_cost`, `timeout`.

### Iteration counting

Only LLM calls (`executePrompt`) increment the iteration counter. Tool calls
(`executeCommand`) do not. A plan-execute run with 9 tools and 4 LLM calls
(plan + review + reason + done) counts as 4 iterations.

## Guardrails

Per-tool safety policies checked before every tool execution. Created once at host
startup and shared across all requests.

```js
modules: {
  guardrails: {
    enabled: true,
    defaultPolicy: 'allow',
    policies: {
      'deploy': 'deny',
      'delete-file': 'approve',
    },
    approvalCallback: async ({ tool, args }) => 'approve' | 'deny',
    validateInputs: true,
    sandboxFs: true,
    workdir: '/safe/workdir',
    dryRunMode: false,
  }
}
```

### Policy resolution order

1. **Input validation** — Zod schema check against the tool's `inputSchema`
2. **Policy lookup** — `config.policies[tool.name]` → tool irreversibility → `config.defaultPolicy`
3. **Policy enforcement**:
   - `allow` → proceed
   - `deny` → block immediately
   - `approve` → call `approvalCallback`; block if missing or denied
4. **Filesystem sandbox** — scan all string args for paths outside `workdir`
5. **Dry-run mode** — block everything if `dryRunMode: true`

### Two entry points

- **`gate(tool, args)`** — check only, no execution. Returns `{ allowed: true }` or
  `{ allowed: false, reason }`.
- **`execute(tool, executorArgs)`** — check + execute. Runs the full gauntlet, then
  calls the real executor if everything passes.

### Where guardrails plug in

- **MCP tool calls** — every tool call through `/mcp` goes through `guardrails.execute()`
- **Run loop strategies** — the autonomous agent's tool calls also go through guardrails

## Prompt Templates

Ten structured prompt builders in `host/prompts/`:

| Template | Used by | Purpose |
|---|---|---|
| `system.mjs` | Both strategies | Agent identity + response format rules |
| `act.mjs` | Open-ended | Task + tools + history → pick a tool or finish |
| `plan.mjs` | Plan-execute | Task + tools → create a plan |
| `review.mjs` | Plan-execute | Proposed plan → approve or reject |
| `execute.mjs` | Plan-execute | Completed step → continue or finish |
| `step-review.mjs` | Plan-execute | Step result → approve or reject |
| `resolve-args.mjs` | Plan-execute | Empty/partial args + history → concrete args |
| `reason.mjs` | Plan-execute | Reasoning step → analysis text |
| `replan.mjs` | Plan-execute | Failed plan + feedback → revised plan |
| `format-tools.mjs` | Both strategies | Tool registry → text catalog for LLM |

### Response format

The LLM communicates decisions through fenced JSON blocks:

- `` ```tool_call `` — `{ "tool": "name", "args": {} }`
- `` ```plan `` — `{ "steps": [...] }`
- `` ```done `` — `{ "result": ..., "summary": "..." }`
- `` ```review `` — `{ "approved": true/false, "feedback": "..." }`
- `` ```step_review `` — `{ "approved": true/false, "feedback": "..." }`

The response parser (`host/response-parser.mjs`) extracts the first fenced block,
parses the JSON, and returns a typed object. Malformed JSON returns an error type.
Text before the block is captured as reasoning.

## Travel Research Tools

Seven tools added as both MCP tools and run-loop-accessible tools:

| Tool | API | Notes |
|---|---|---|
| `weather` | wttr.in | Current conditions for a city |
| `forecast` | Open-Meteo | Multi-day forecast (1-16 days) |
| `currency` | ECB via frankfurter.app | Live exchange rates |
| `country-info` | Wikipedia + Nominatim | Accepts ISO codes (IN, JP) or full names |
| `travel-advisory` | travel-advisory.info | Safety scores (currently down — 404) |
| `geocode` | Nominatim | City → lat/lon or reverse |
| `wikipedia-summary` | Wikipedia REST API | Summary extract for any topic |
| `public-holidays` | Nager.Date | Public holidays by country/year (~100 countries) |

All tools are Python scripts in `tools/`, called via `fleetApi.executeCommand()` on
the doer member. All are read-only and spend no LLM tokens.

## Host Configuration

`host.config.mjs` at the project root:

```js
export default {
  name: 'apra-agent-kit',
  fleet: {},
  comm: { adapter: 'express' },
  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,
    },
  },
};
```

## Builder API

Programmatic alternative to the config file:

```js
import { createHost } from './host/index.mjs';

const host = createHost({ fleetApi, dispatcher })
  .runLoop({ strategy: 'plan-execute' })
  .budget({ maxIterations: 10, timeoutMs: 120_000 })
  .guardrails({ defaultPolicy: 'allow', validateInputs: true })
  .build();

await host.start();            // starts HTTP server with /mcp and /task
const result = await host.run(task);  // run a task programmatically
```

## `/task` API

### Request

```
POST /task
Content-Type: application/json

{
  "goal": "Plan a 3-day trip to Tokyo",
  "id": "optional-task-id",
  "inputs": { "optional": "extra context" },
  "constraints": {
    "maxIterations": 100,
    "timeoutMs": 300000
  },
  "budget": {
    "maxCostUsd": 10.00,
    "maxTokens": 100000
  }
}
```

Only `goal` is required. `id` auto-generates if omitted. `constraints` and `budget`
tighten the server defaults — the stricter value wins.

### Response

```json
{
  "taskId": "my-task-123",
  "status": "completed",
  "result": "The final output from the agent",
  "history": [
    { "type": "observation", "stepType": "tool", "tool": "weather", "args": {...}, "result": {...} },
    { "type": "observation", "stepType": "reason", "text": "Analysis..." }
  ],
  "budget": {
    "iterations": 4,
    "totalInputTokens": 0,
    "totalOutputTokens": 2401,
    "totalTokens": 2401,
    "estimatedCostUsd": 0.036,
    "elapsedMs": 92000
  }
}
```

Status values: `completed`, `failed`, `cancelled`, `budget_exceeded`.

### Timing guidance

The plan-execute strategy with ~9 tools typically needs 90-120 seconds:
- Plan prompt: ~20s
- Review prompt: ~30s
- Tool execution: ~10s
- Reason/summary prompt: ~28s
- Done prompt: ~15s

Set `timeoutMs` to at least 300000 (5 minutes) for plan-execute tasks.

## Docker

### MCP server only (no run loop)

```bash
docker compose up --build
```

### Host with run loop

```bash
docker compose run --rm -p 3000:3000 fleet node host/index.mjs
```

Then POST to `/task`:

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"goal":"Plan a trip to Jaipur","constraints":{"timeoutMs":300000}}'
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (none) | Required for LLM calls |
| `MCP_PORT` | 3000 | Host port mapping |
| `WORKER_POOL_SIZE` | 4 | Pre-provisioned worker pairs |
| `WORKER_EPHEMERAL_MAX` | 10 | Max ephemeral workers on overflow |
| `MCP_BIND_HOST` | 0.0.0.0 | Bind address inside container |

## Tests

| Script | Tests | What it covers |
|---|---|---|
| `npm run test:phase2` | 79 | All Phase 2 modules in isolation |
| `npm run test:host` | 52 | Host config, registry, executor, express, index |
| `npm run test:phase2:live` | — | End-to-end with real Fleet + LLM (spends tokens) |

Phase 2 tests use a mock Fleet with scripted `promptResponses` — deterministic
multi-turn agent loops without hitting a real LLM.

## Module map

| File | Responsibility |
|---|---|
| `host/run-loop.mjs` | Top-level `runTask()` — selects strategy, wires budgets/guardrails, iterates events |
| `host/strategies/open-ended.mjs` | ReAct loop: act → observe → repeat |
| `host/strategies/plan-execute.mjs` | Plan → review → execute → step-review → replan → done |
| `host/budgets.mjs` | `createBudgets()` — iteration/token/cost/time caps with `check()` and `record()` |
| `host/guardrails.mjs` | `createGuardrails()` — policy gate, sandbox, validation, dry-run |
| `host/response-parser.mjs` | Extracts fenced JSON blocks from LLM responses |
| `host/prompts/*.mjs` | Prompt builders for each LLM interaction |
| `host/tools/registry.mjs` | Extends the MCP registry with reversibility, timeout, retry metadata |
| `host/tools/executor.mjs` | Runs a tool with validation, timeout, and error handling |
| `host/config.mjs` | Loads and validates `host.config.mjs` |
| `host/index.mjs` | `startHost()` and `createHost()` — wires everything together |
