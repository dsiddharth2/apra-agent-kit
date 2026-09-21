# Strategy Router — Automatic Task Routing

**Date**: 2026-09-21
**Status**: Proposed
**Scope**: New router module + 4 starter workflows + pool lease optimization

## Problem

Every task submitted via `/task` runs the `plan-execute` strategy regardless of
complexity. This strategy makes 4-8 sequential LLM calls (plan → review → execute
→ step-review → done), taking 4-7 minutes even for simple questions like "weather
in Tokyo" or "places near Port Blair" that could be answered in seconds.

From the `func-2026-09-21_16-37-55.log` analysis:

| Phase | Duration | What happens |
|-------|----------|--------------|
| Member registration | ~7s | DOER + REVIEWER registered (REVIEWER never used in simple tasks) |
| DOER prompt #1 | ~2 min | LLM reads question, decides to call a tool |
| Tool execution | instant | Tool returns JSON |
| DOER prompt #2 | ~2.5 min | LLM reads tool output, composes answer |
| Orchestrator | 25ms | Crashes — payload 22KB > 16KB limit |

95% of the time is sequential LLM calls. The tools are instant. For a question
that maps to a single known tool, the plan-review-execute cycle is pure overhead.

Additionally, the REVIEWER member is registered for every task (~3.5s) but never
used by the open-ended strategy or by workflows.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Router approach | LLM classifier on the doer | Semantic understanding beats keyword matching; "plan a trip" vs "places near X" requires intent classification, not regex |
| Classifier model | Doer's model (no separate member) | Fleet members have fixed models; no per-call model override. Even on Opus, a ~300 token classification prompt completes in 5-10s — still saves minutes vs plan-execute |
| Three routing paths | Workflow → open-ended → plan-execute | Workflows (predefined steps) are fastest; open-ended handles moderate tasks; plan-execute reserved for complex multi-step work |
| Workflow registration | `routing` block on existing registry entries | Single source of truth; no separate catalog; new workflows auto-appear in classifier menu |
| Reviewer registration | Deferred — only for plan-execute | Open-ended and workflows never use the reviewer; skip saves ~3.5s per task |
| Config | Dedicated `modules.router` section | Clean separation from `runLoop`; router can be disabled independently |
| Backward compatibility | `router.enabled: false` preserves today's behavior | Zero risk to existing deployments |

---

## Architecture

```
POST /task
  → executeHostedTask
    → dispatcher.dispatch()              ← lease with DOER only (reviewer deferred)
    → router.classify(goal, registry)    ← one short prompt to doer
    → routing decision:
        ├─ workflow   → runWorkflow()    ← predefined tool sequence + 1 LLM compose (0 strategy calls)
        ├─ open-ended → runTask()        ← LLM improvises per turn (1-3 LLM calls)
        └─ plan-execute → register reviewer → runTask()  ← full pipeline (4-8+ LLM calls)
    → lease.release()
```

### Priority resolution

```
task.strategy (per-task explicit override)     ← highest, always wins
  ↓ not set
router.enabled: true                           ← classifier decides
  ↓ classifier fails / invalid JSON
router.fallbackStrategy                        ← safety net (default: 'open-ended')
  ↓ router.enabled: false
runLoop.strategy                               ← static config, today's behavior
```

---

## Router Module

**File**: `host/router.mjs`

### classify()

```js
export async function classify(goal, { fleetApi, lease, registry, fallbackStrategy })
  → { path: 'workflow' | 'open-ended' | 'plan-execute', workflow?: string, args?: object }
```

Sends one prompt to the doer member. The prompt includes:

1. A short system instruction: "You are a task router. Given a user's goal, pick
   the best execution path."
2. The list of routable workflows (name + `routing.description` for each registry
   entry that has a `routing` block).
3. The two strategy options with guidance on when to use each.
4. The user's goal.
5. Instruction to respond with ONLY a JSON object.

**Classifier prompt template:**

```
You are a task router for a travel assistant. Given the user's goal, decide the
best execution path.

Available workflows (predefined, fastest — pick one if the goal is a direct match):
{{#each routableWorkflows}}
- {{name}}: {{routing.description}} (args: {{routing.args}})
{{/each}}

Available strategies (flexible, for goals that don't match a workflow):
- open-ended: Good for simple questions needing 1-2 tool calls or conversational replies.
- plan-execute: For complex multi-step tasks that need planning, multiple tools in
  a dynamic order, and review. Use only when the task genuinely requires it.

User's goal: "{{goal}}"

Respond with ONLY a JSON object, no other text:
{"path":"workflow|open-ended|plan-execute","workflow":"name-if-workflow","args":{extracted args if workflow}}
```

**Response parsing:**

1. Extract JSON from the response (strip markdown fences if present).
2. Validate `path` is one of the three allowed values.
3. If `path` is `workflow`, validate `workflow` name exists in the registry.
4. On any parse failure or invalid value, return `{ path: fallbackStrategy }`.

**Not included in the classifier prompt:**

- Tool descriptions (the classifier picks paths, not tools).
- Conversation history (the router sees only the current goal).
- The full system prompt (kept short for speed).

---

## Workflow Registry Changes

### routing block

Each registry entry in `mcp/registry.mjs` that should be routable gains a
`routing` property:

```js
{
  name: 'quick-weather',
  description: 'Fetches current weather and 3-day forecast for a city...',
  routing: {
    description: 'Current weather + short forecast for a single city',
    args: {
      city: { extract: 'city name from the goal' },
    },
  },
  inputSchema: z.object({ city: z.string().optional() }),
  async run({ fleetApi, args, workspace, signal, reportPhase }) { ... }
}
```

- `routing.description` — written for the classifier, not humans. Concise,
  pattern-oriented.
- `routing.args` — tells the classifier what to extract from the goal. Each key
  is an arg name the workflow expects; the `extract` value is a natural-language
  instruction included in the classifier prompt (e.g., `"city name from the goal"`).
  The classifier returns these as JSON keys in its response, which are passed
  directly to the workflow's `run({ args })`. Example: goal "weather in Tokyo"
  with `args: { city: { extract: 'city name from the goal' } }` → classifier
  returns `{"path":"workflow","workflow":"quick-weather","args":{"city":"Tokyo"}}`.
- Entries without `routing` (demo, inspect-members, individual tools like
  `weather`, `timezone`, etc.) are invisible to the router. Individual tools
  are used by strategies, not routed to directly.

### Catalog construction

At startup, the router builds its workflow menu:

```js
const routableWorkflows = registry.filter(t => t.routing);
```

This list is embedded in the classifier prompt. Adding a new routable workflow
is: add the entry to `mcp/registry.mjs` with a `routing` block — no changes to
the router.

---

## Starter Workflows

Four new workflows plus routing metadata on the existing `city-briefing`.

### 1. quick-weather

**Goal patterns**: "weather in Tokyo", "what's the forecast for Delhi",
"is it raining in London"

**Sequence**:
```
weather(city) → forecast(city, 3) → LLM compose short answer
```

Tools: `weather`, `forecast`. One LLM call to compose.

**File**: `workflows/quick-weather/quick-weather.js`

**Registry routing**:
```js
routing: {
  description: 'Current weather + short forecast for a single city',
  args: { city: { extract: 'city name from the goal' } },
}
```

### 2. destination-overview

**Goal patterns**: "tell me about Bali", "places to visit in Port Blair",
"what's there to do in Manali"

**Sequence**:
```
wikipedia-summary(destination) → places-of-interest(destination) → LLM compose overview
```

Tools: `wikipedia-summary`, `places-of-interest`. One LLM call to compose.

**File**: `workflows/destination-overview/destination-overview.js`

**Registry routing**:
```js
routing: {
  description: 'Overview of a destination: background info + tourist attractions and activities',
  args: { destination: { extract: 'destination/city/region name from the goal' } },
}
```

### 3. travel-prep

**Goal patterns**: "going to Japan, what do I need to know", "visa info for
Thailand", "travel requirements for France"

**Sequence**:
```
country-info(country) → travel-advisory(country_code) → currency(INR, local_currency) → public-holidays(country_code) → LLM compose prep guide
```

Tools: `country-info`, `travel-advisory`, `currency`, `public-holidays`. One LLM
call to compose.

**File**: `workflows/travel-prep/travel-prep.js`

**Registry routing**:
```js
routing: {
  description: 'Pre-trip preparation: country info + visa/advisory + currency + public holidays',
  args: { country: { extract: 'country name from the goal' } },
}
```

### 4. route-check

**Goal patterns**: "how far is Delhi from Manali", "distance between Shimla and
Dharamshala", "driving time Mumbai to Pune"

**Sequence**:
```
route-distance(from, to) → LLM compose answer
```

Tools: `route-distance`. One LLM call to compose.

**File**: `workflows/route-check/route-check.js`

**Registry routing**:
```js
routing: {
  description: 'Driving distance and travel time between two cities',
  args: {
    from: { extract: 'origin city from the goal' },
    to: { extract: 'destination city from the goal' },
  },
}
```

### 5. city-briefing (existing)

Already implemented. Add routing metadata:

```js
routing: {
  description: 'Weather + local time + short briefing for a city',
  args: { city: { extract: 'city name from the goal' } },
}
```

### Workflow execution pattern

All workflows follow the same structure as the existing `city-briefing`:

```js
export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const fleetApi = args.fleetApi;
  const city = args.city || 'London';
  const signal = args.signal;
  const cancelled = () => signal?.aborted === true;

  // Phase 1: fetch data
  phase('fetch weather');
  const weather = await runTool('weather', { city }, fleetApi);
  if (cancelled()) return { cancelled: true, weather };

  // Phase 2: fetch more data
  phase('fetch forecast');
  const forecast = await runTool('forecast', { city, days: 3 }, fleetApi);
  if (cancelled()) return { cancelled: true, weather, forecast };

  // Phase 3: LLM compose
  phase('compose');
  const prompt = `Given this data, write a short weather summary for ${city}:\n${JSON.stringify({ weather, forecast })}`;
  const answer = await agent(prompt, { member_name: 'doer' });

  return { city, weather, forecast, answer };
}
```

Workflows emit `phase` events that flow through the existing progress/SSE
pipeline. The chat UI sees them as step progress without any changes.

---

## Pool Lease Optimization

### Deferred reviewer registration

Today `MemberManager.provisionPair()` registers both DOER and REVIEWER upfront.
The change splits this into two steps:

```js
// pool/member-manager.mjs — new methods
async provisionDoer(prefix, workRoot) → { doer }
async provisionReviewer(prefix, workRoot, existingDoer) → { doer, reviewer }
```

`provisionDoer` registers only the DOER member and provisions its auth.
`provisionReviewer` adds the REVIEWER to an existing doer-only lease.

### Lease flow by route

| Route | Lease at dispatch | After classification |
|-------|-------------------|---------------------|
| Workflow | doer only | no change |
| Open-ended | doer only | no change |
| Plan-execute | doer only | + reviewer registered (~3.5s) |

### Member needs per route

| Route | DOER | REVIEWER |
|-------|------|----------|
| Classifier call | yes (runs on doer) | no |
| Workflow | yes (tool commands + compose) | no |
| Open-ended | yes (strategy only calls doer) | no |
| Plan-execute | yes | yes (plan review + step review) |

### Ephemeral factory changes

`pool/ephemeral-factory.mjs` gains an option to create doer-only leases:

```js
// Today:
create({ signal }) → lease { doer, reviewer, release() }

// New:
create({ signal, members: ['doer'] }) → lease { doer, reviewer: null, release() }
create({ signal, members: ['doer', 'reviewer'] }) → lease { doer, reviewer, release() }
// default (no members specified) → ['doer', 'reviewer'] for backward compat
```

The lease gains an `upgradeToReviewer()` method that registers the reviewer
on demand:

```js
lease.upgradeToReviewer() → registers REVIEWER, sets lease.reviewer, provisions auth
```

Called by `executeHostedTask` only when the router returns `plan-execute`.

---

## Run Loop Integration

### Changes to executeHostedTask (`host/tasks.mjs`)

```js
export async function executeHostedTask(task, {
  api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig,
  budgetsConfig, guardrailsMod, jobs, signal, onProgress,
}) {
  // ... existing task setup ...

  let lease;
  try {
    // Dispatch with doer only — reviewer deferred
    lease = await activeDispatcher.dispatch({ signal, members: ['doer'] });
  } catch (err) {
    return { /* dispatch_failed */ };
  }

  try {
    // --- NEW: routing step ---
    let strategy = task.strategy ?? null;    // explicit task override wins
    let workflowName = null;
    let workflowArgs = null;

    if (!strategy && routerConfig?.enabled) {
      const route = await classify(task.goal, {
        fleetApi: createPooledFleetApi(api, lease),
        lease,
        registry: toolRegistry,
        fallbackStrategy: routerConfig.fallbackStrategy ?? 'open-ended',
      });
      if (route.path === 'workflow') {
        workflowName = route.workflow;
        workflowArgs = route.args;
        strategy = 'workflow';
      } else {
        strategy = route.path;
      }
    }

    strategy ??= runLoopConfig.strategy ?? 'open-ended';

    // --- Upgrade lease if plan-execute ---
    if (strategy === 'plan-execute' && !lease.reviewer) {
      await lease.upgradeToReviewer();
    }

    // --- Execute ---
    let result;
    if (strategy === 'workflow') {
      result = await executeWorkflow(workflowName, workflowArgs, {
        fleetApi: createPooledFleetApi(api, lease),
        toolRegistry, signal, onProgress,
      });
    } else {
      const workspace = { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer };
      result = await runTask(fullTask, {
        strategy,
        tools: toolRegistry,
        fleetApi: createPooledFleetApi(api, lease),
        budgets: budgetsMod,
        guardrails: guardrailsMod,
        ...runLoopConfig,
        jobs, traceId, signal: combined.signal, workspace, onIteration: onProgress,
      });
    }

    return { taskId: fullTask.id, routedTo: workflowName ? `workflow:${workflowName}` : strategy, ...result };
  } finally {
    await lease.release();
  }
}
```

### New: executeWorkflow (`host/router.mjs`)

```js
export async function executeWorkflow(name, args, { fleetApi, toolRegistry, signal, onProgress }) {
  const entry = toolRegistry.find(t => t.name === name && t.routing);
  if (!entry) return { status: 'failed', result: { error: 'workflow_not_found' }, history: [] };

  try {
    const result = await entry.run({ fleetApi, args: args ?? {}, signal, reportPhase: onProgress });
    return {
      status: 'completed',
      result: typeof result === 'string' ? result : JSON.stringify(result),
      history: [],
      budget: null,
    };
  } catch (err) {
    if (err?.name === 'AbortError') return { status: 'cancelled', result: null, history: [], budget: null };
    return { status: 'failed', result: { error: 'workflow_failed', message: String(err?.message ?? err) }, history: [], budget: null };
  }
}
```

---

## Configuration

### Config shape

```js
// host.config.mjs / host.config.local-functions.mjs
modules: {
  router: {
    enabled: true,
    fallbackStrategy: 'open-ended',
  },
  runLoop: {
    enabled: true,
    strategy: 'plan-execute',        // used when router is disabled
    // ... existing settings unchanged
  },
  // ... all other modules unchanged
}
```

### Validation rules (`host/config.mjs`)

| Condition | Result |
|---|---|
| `router.enabled` and not `runLoop.enabled` | **error**: nothing to fall back to |
| `router.enabled` and no registry entries with `routing` block | **warning**: router enabled but no routable workflows |
| `router.fallbackStrategy` not `'open-ended'` or `'plan-execute'` | **error**: invalid fallback |
| `router.enabled: false` or absent | no change to current behavior |

### Environment overrides

| Env var | Maps to |
|---|---|
| `ROUTER_ENABLED` | `router.enabled` |
| `ROUTER_FALLBACK_STRATEGY` | `router.fallbackStrategy` |

---

## Files Changed

### New files

| File | Description |
|------|-------------|
| `host/router.mjs` | classify() + executeWorkflow() + classifier prompt builder |
| `workflows/quick-weather/workflow.json` | Workflow metadata |
| `workflows/quick-weather/quick-weather.js` | weather + forecast + compose |
| `workflows/quick-weather/main.mjs` | Standalone entry |
| `workflows/destination-overview/workflow.json` | Workflow metadata |
| `workflows/destination-overview/destination-overview.js` | wikipedia + places + compose |
| `workflows/destination-overview/main.mjs` | Standalone entry |
| `workflows/travel-prep/workflow.json` | Workflow metadata |
| `workflows/travel-prep/travel-prep.js` | country-info + advisory + currency + holidays + compose |
| `workflows/travel-prep/main.mjs` | Standalone entry |
| `workflows/route-check/workflow.json` | Workflow metadata |
| `workflows/route-check/route-check.js` | route-distance + compose |
| `workflows/route-check/main.mjs` | Standalone entry |
| `tests/host-router.test.mjs` | Router classifier unit tests |
| `tests/host-tasks-routing.test.mjs` | Routing integration tests |
| `tests/host-workflow-runner.test.mjs` | Starter workflow tests |
| `tests/host-registry-routing.test.mjs` | Registry routing metadata tests |
| `tests/acceptance/router.acceptance.test.mjs` | Live routing acceptance tests |

### Changed files

| File | Change |
|------|--------|
| `host/tasks.mjs` | executeHostedTask gains routing step + deferred reviewer |
| `host/index.mjs` | Pass routerConfig through to executeHostedTask |
| `host/config.mjs` | Validate modules.router, env overrides |
| `host.config.mjs` | Add modules.router |
| `host.config.local-functions.mjs` | Add modules.router |
| `deploy/azure-functions/host.config.mjs` | Add modules.router |
| `mcp/registry.mjs` | Add routing blocks + register 4 new workflows |
| `pool/member-manager.mjs` | provisionDoer() + provisionReviewer() split |
| `pool/ephemeral-factory.mjs` | members hint on create(), upgradeToReviewer() on lease |
| `workflows/city-briefing/workflow.json` | Add routing block |
| `tests/host-config.test.mjs` | Router validation test cases |
| `tests/e2e/scenarios/s01-tokyo-weather.json` | Add expectedRoute field |
| `tests/e2e/scenarios/s02-nyc-time-weather.json` | Add expectedRoute field |
| `tests/e2e/scenarios/s05-us-japan-currency.json` | Add expectedRoute field |
| `tests/e2e/scenarios/s10-europe-capitals.json` | Add expectedRoute field |

### Unchanged

- `host/run-loop.mjs` — no changes
- `host/strategies/open-ended.mjs` — no changes
- `host/strategies/plan-execute.mjs` — no changes
- `host/prompts/*` — no changes
- `comm/*` — no changes
- `host/jobs/*` — no changes
- `host/notify/*` — no changes

---

## Testing Strategy

### Unit tests (no Fleet, no tokens)

| Area | Test file | Covers |
|---|---|---|
| Router classifier | `tests/host-router.test.mjs` | Valid JSON → correct paths; invalid JSON → fallback; unknown workflow → fallback; task.strategy override bypasses router; router.enabled: false skips classification |
| Routing integration | `tests/host-tasks-routing.test.mjs` | executeHostedTask with mock fleet: workflow route skips run loop; open-ended skips reviewer; plan-execute registers reviewer; routedTo field in result |
| Workflow execution | `tests/host-workflow-runner.test.mjs` | Each starter workflow with canned tool responses; compose prompt sent to doer; result shape matches job record; cancellation returns cancelled |
| Config validation | `tests/host-config.test.mjs` | All router validation rules; env overrides |
| Registry metadata | `tests/host-registry-routing.test.mjs` | filter(t => t.routing) returns only routable entries; description and args present |

### Acceptance tests (real Fleet, real tokens)

| File | Capability |
|---|---|
| `tests/acceptance/router.acceptance.test.mjs` | "weather in Tokyo" → workflow, <30s. "plan a 10-day trip" → plan-execute, full itinerary. task.strategy override → router bypassed. |

### E2E scenario updates

| Scenario | Expected route | Expected time |
|---|---|---|
| `s01-tokyo-weather.json` | `workflow:quick-weather` | <15s |
| `s02-nyc-time-weather.json` | `workflow:city-briefing` | <15s |
| `s05-us-japan-currency.json` | `workflow:travel-prep` | <20s |
| `s10-europe-capitals.json` | `open-ended` or `plan-execute` | depends on budget |

### npm scripts

```
test:router       node --test tests/host-router.test.mjs tests/host-tasks-routing.test.mjs tests/host-workflow-runner.test.mjs tests/host-registry-routing.test.mjs
```

Added to `test:phase2` or as a separate script — no dependency on Phase 4 tests.

---

## Expected Impact

| Question type | Today | With router | Speedup |
|---|---|---|---|
| "Weather in Tokyo" | ~5 min | ~7-12s (workflow) | **25-40x** |
| "Places near Port Blair" | ~5 min | ~10-15s (workflow) | **20-30x** |
| "How far is Delhi from Manali?" | ~5 min | ~7-10s (workflow) | **30-40x** |
| "Going to Japan, what do I need?" | ~5 min | ~15-20s (workflow) | **15-20x** |
| "Tell me about Goa" | ~5 min | ~1-2 min (open-ended) | **3-5x** |
| "Plan 10-day Himachal trip" | ~5 min | ~5 min 5s (plan-execute) | ~1x (+5s overhead) |

The classifier adds ~5-10s to every task. For simple questions routed to
workflows, total time drops from minutes to seconds. For complex tasks that
genuinely need plan-execute, the overhead is negligible.

---

## Out of Scope

- Per-call model override on Fleet's execute_prompt (Fleet limitation)
- Conversation-aware routing (router sees only the current goal, not chat history)
- Workflow chaining (one workflow calling another)
- Dynamic workflow generation (LLM creating new workflows at runtime)
- Progressive escalation (start open-ended, auto-upgrade to plan-execute mid-run)
- Prompt caching on the classifier call (Fleet/API-level concern)
- The 16KB Durable Functions payload crash (separate fix, tracked independently)

---

## Open Risks

- **Classifier accuracy** — if the doer model misroutes a complex task to a
  workflow, the user gets an incomplete answer. Mitigation: workflows return
  structured data; if the result looks thin, the chat UI could surface "need
  more detail?" as a follow-up. The fallback strategy catches parse failures.
- **Classifier latency on Opus** — if the doer runs Opus, classification may take
  ~10s. Still worthwhile (saves minutes), but noticeable. Mitigation: if this
  becomes a problem, a future version could register a dedicated Haiku member.
- **Workflow arg extraction** — the classifier extracts args like city names from
  natural language. "What's the weather like where the Taj Mahal is" needs to
  become `{ city: "Agra" }`. The LLM handles this well but edge cases exist.
  Mitigation: workflows validate args and return errors that the run loop can
  handle gracefully.
- **Registry size** — as more workflows are added, the classifier prompt grows.
  At 20+ workflows the prompt could slow down. Mitigation: cap the routable
  list or add a two-stage classifier (category → workflow).
