# Fleet Agent Kit — Phase 3: Memory + Eval

Status: approved design — not yet implemented.

## What this phase ships

Three memory modules (working context, run state, long-term) and an eval
harness with four graders. All modules are independently toggleable via
`host.config.mjs` and follow the kit's existing modularity patterns.

## Relationship to existing code

Phase 3 builds on the shipped Phase 2 foundation: run loop (open-ended +
plan-execute strategies), budgets, guardrails, and the Phase 4a dispatch/jobs
system. Memory hooks into the strategies and prompt builders. Eval calls
`executeHostedTask()` directly (no HTTP).

No existing module is removed or restructured. Memory wraps around the
existing observation arrays inside the strategies. The prompt builders gain
an optional `memories` parameter. Existing behavior when memory is disabled
is unchanged.

---

## 1. Memory Store Interface

A pluggable persistence contract shared by run-state and long-term memory.
Same pattern as `host/jobs/store/interface.mjs`.

### Contract

```js
// host/memory/store/interface.mjs
export const MEMORY_STORE_METHODS = [
  'open',     // async () => void — connect, create dirs/tables
  'close',    // async () => void — cleanup
  'store',    // async (entry) => void — persist a memory entry
  'get',      // async (id) => entry | null
  'update',   // async (id, patch) => entry
  'remove',   // async (id) => void
  'query',    // async ({ kinds, tags, query, limit }) => entry[]
  'purge',    // async (olderThan) => count — remove stale entries
];

export function assertMemoryStore(store) {
  const missing = MEMORY_STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`memory store missing: ${missing.join(', ')}`);
  return store;
}
```

### Memory entry shape

```js
{
  id: 'mem-abc123',             // generated or caller-supplied
  kind: 'rule' | 'domain' | 'preference' | 'pattern' | 'procedure',
  text: 'Always check backup status before deletions',
  tags: ['safety', 'deletions'],
  source: 'human' | 'agent' | 'system',
  confidence: 1.0,              // human=1.0, agent-learned=0.8
  createdAt: '2026-09-18T...',
  lastUsedAt: null,
  useCount: 0,
  metadata: {},                 // extensible
}
```

### Shipped backends

| Backend | Config value | Storage | Use case |
|---|---|---|---|
| `memory` | `store: 'memory'` | In-process Map | Tests, ephemeral agents |
| `filesystem` | `store: 'filesystem'` | JSON files in a directory | Default. Single-container. Easy to inspect and manually edit. |
| `sqlite` | `store: 'sqlite'` | SQLite DB file (node:sqlite) | Structured queries, full-text search |
| `http` | `store: 'http'` | External REST API | Shared memory service, Cosmos DB, any REST-compatible store |

### HTTP backend

The HTTP store maps store methods to REST calls against a configurable
`baseUrl`:

```
store(entry)           → POST   {baseUrl}/memories
get(id)                → GET    {baseUrl}/memories/:id
update(id, patch)      → PATCH  {baseUrl}/memories/:id
remove(id)             → DELETE {baseUrl}/memories/:id
query({ kinds, tags }) → GET    {baseUrl}/memories?kinds=rule,domain&tags=safety&limit=20
purge(olderThan)       → DELETE {baseUrl}/memories?olderThan=2026-01-01
```

The external service is a black box — any backend that speaks this REST
contract. The kit does not ship the external service; it ships the client.

HTTP backend config:

```js
memory: {
  longTerm: {
    enabled: true,
    store: 'http',
    http: {
      baseUrl: 'https://memory-service.internal/api/v1',
      headers: { 'x-api-key': '${MEMORY_API_KEY}' },
      timeoutMs: 5000,
    },
  },
}
```

Environment variable interpolation in `headers` values: `${VAR}` is replaced
with `process.env[VAR]` at startup.

---

## 2. Working Context (in-run compaction)

Manages observation history during a single run so prompts stay within the
LLM context window. Purely in-process — no persistence, no store backend.

### Integration point

The working context module wraps the `observations` array inside each
strategy. Instead of passing raw observations to prompt builders, strategies
call `workingContext.forPrompt()` which returns a compacted version.

```
Strategy (open-ended / plan-execute)
    │
    ├── observation happens → workingContext.append(observation)
    ├── build prompt        → history = await workingContext.forPrompt()
    │
    ▼
Prompt builder receives compacted history
```

### Compaction strategies

| Strategy | How it works | Cost |
|---|---|---|
| `summarise` | When history exceeds `maxTurns`, older entries are summarized via a Fleet `executePrompt` call. The summary replaces old entries as a single `{ type: 'summary', text }` entry. | One small LLM call per compaction event |
| `sliding-window` | Drop entries beyond the last `keepRecent` turns. No LLM call. Older context is lost entirely. | Zero |

Default: `summarise`.

### Interface

```js
// host/memory/working-context.mjs
createWorkingContext({ fleetApi, maxTurns, compactionStrategy, keepRecent })

  .append(observation)        // add an observation to the raw history
  .forPrompt() → entry[]     // async — returns compacted history for prompts
  .history() → observation[]  // full raw history (for checkpoints, eval)
```

### Config

```js
memory: {
  workingContext: {
    enabled: true,
    maxTurns: 50,
    compactionStrategy: 'summarise',
    keepRecent: 25,
  },
}
```

When disabled: strategies pass raw `observations[]` exactly as today. Zero
behavior change.

---

## 3. Run State (checkpoint / resume)

Checkpoint after each step so a crashed process can resume. Uses the
pluggable memory store for persistence.

### Flow

```
Step completes → runState.save(taskId, snapshot)

Container crashes → restarts → task arrives (same id)
  → runState.load(taskId)
  → checkpoint found → resume from saved stepIndex
  → checkpoint not found → start fresh

Task completes → runState.clear(taskId)
```

### Idempotency

Each completed step gets a key derived from (tool name, args, stepIndex).
On resume, the run loop checks the idempotency set before re-executing a
step. This prevents double-writes to external systems.

### Checkpoint shape

```js
{
  taskId: 'task-abc',
  savedAt: '2026-09-18T...',
  stepIndex: 3,
  plan: { steps: [...] },
  observations: [...],
  budgetSnapshot: { iterations: 3, estimatedCost: 0.12 },
  idempotencyKeys: ['k1', 'k2', 'k3'],
  strategy: 'plan-execute',
}
```

### Config

```js
memory: {
  runState: {
    enabled: true,
    checkpointDir: './state',
    store: 'filesystem',
  },
}
```

Docker setup: mount `checkpointDir` as a Docker volume so checkpoints
survive container restarts.

When disabled: crash = restart from scratch. Current behavior.

---

## 4. Long-Term Memory (cross-run facts)

Facts that persist across separate task runs. The "teaching" system.

### How facts enter

1. **Human-taught** — via HTTP routes (`POST /memory`), MCP tools
   (`remember`), or pre-loaded knowledge files.
2. **Agent-learned** (opt-in, `autoLearn: true`) — after a run completes,
   a learner module reviews the history and extracts reusable facts via an
   LLM call.

### Recall flow

```
Task arrives
  → memory.query({ tags derived from task, kinds: [...] })
  → Rules (kind: 'rule') always recalled regardless of tag match
  → Other kinds recalled when tags overlap with the task
  → Matched facts injected into system prompt as a "## Your Memory" section
  → Run loop proceeds with enriched prompt
```

### Recall ranking

1. Rules first (always relevant)
2. Higher confidence before lower
3. More recently used before older
4. Limit to `recallLimit` entries (default 20)

### Auto-learner

After a run completes, if `autoLearn: true`:

```
Task completes
  → learner.extract({ task, history, fleetApi })
  → LLM call: "What reusable facts did you learn from this run?"
  → Parsed facts stored with source: 'agent', confidence: 0.8
```

The learner prompt instructs the LLM to only extract facts useful in future
runs — not task-specific results. The learner is a single `executePrompt`
call and produces a JSON array of fact objects.

### Memory access — three doors, one module

The memory module's methods (`store`, `query`, `get`, `update`, `remove`)
are the primary API. Three thin access layers wrap them:

| Access layer | Who uses it | How |
|---|---|---|
| Direct JS calls | Run loop, strategies, learner | `memory.query(...)` |
| HTTP routes on agent | External callers (humans, UIs, other agents) | `POST /memory`, `GET /memory?tags=...` |
| MCP tools | LLM tool calls during a run | `remember`, `recall`, `forget` tools in registry |

The routes and tools contain no logic — they validate input and delegate to
the memory module.

### HTTP routes

```
POST   /memory          → memory.store(body)
GET    /memory          → memory.query(querystring params)
GET    /memory/:id      → memory.get(id)
PATCH  /memory/:id      → memory.update(id, body)
DELETE /memory/:id      → memory.remove(id)
```

### MCP tools

| Tool | Input | Action |
|---|---|---|
| `remember` | `{ text, kind, tags }` | `memory.store({ ...input, source: 'human' })` |
| `recall` | `{ tags?, kinds?, query?, limit? }` | `memory.query(input)` |
| `forget` | `{ id }` | `memory.remove(id)` |

### Config

```js
memory: {
  longTerm: {
    enabled: true,
    store: 'filesystem',
    dir: './memory',
    http: { baseUrl: '...' },     // only when store: 'http'
    autoLearn: false,             // opt-in self-learning
    maxEntries: 500,
    recallLimit: 20,
  },
}
```

When disabled (the default): each run starts with a clean slate. No routes
or tools registered.

---

## 5. Eval Harness

A test runner that calls the agent and grades output. Direct function call
mode — calls `executeHostedTask()`, no HTTP server needed.

### Runner flow

```
npm run eval [-- --suite=demo --tag=happy-path]
  │
  ▼
Load suite JSON files from evals/suites/
  │
  ▼
For each task case:
  ├── Optionally pre-load memory entries (preloadMemory field)
  ├── Create fleetApi (mock or real per suite config)
  ├── Call executeHostedTask(taskCase.task, ...)
  ├── Grade: grader(expected, actual) → { pass, reason }
  ├── Record: time, cost, pass/fail
  │
  ▼
Print report to stdout + write JSON to evals/reports/
```

### Task suite format

```json
[
  {
    "id": "inv-001",
    "description": "Find the mismatched invoice in the test ledger",
    "task": {
      "goal": "Find mismatched invoices for January 2026",
      "inputs": { "period": "2026-01", "threshold": 0.01 }
    },
    "expected": { "status": "completed", "result": { "count": 3 } },
    "grader": "exact-match",
    "tags": ["invoices", "happy-path"],
    "timeout": 30000,
    "preloadMemory": []
  }
]
```

Optional `preloadMemory` field: array of memory entries loaded into
long-term memory before the test case runs. Tests whether the agent uses
taught facts correctly.

### Graders

| Grader | How it works |
|---|---|
| `exact-match` | `deepEqual(expected, actual)` on the result field |
| `contains` | Checks that actual output contains all expected substrings |
| `llm-judge` | Sends expected + actual to Fleet LLM: "does this pass?" Returns `{ pass, reason }` |
| `custom` | User provides a function `(expected, actual) => { pass, reason }` |

Graders are resolved by name via a factory (`evals/graders/index.mjs`).
Custom graders are loaded from suite-relative paths or supplied via the
programmatic API.

### Report format

Stdout (human-readable):

```
fleet-agent-kit eval — 2026-09-18T14:30:00Z
  ✓ inv-001  Find mismatched invoice       exact-match   1.2s   $0.03
  ✗ inv-002  Handle missing ledger         exact-match   0.8s   $0.01
    Expected: { error: "ledger_not_found" }
    Actual:   { error: "file_not_found" }

22/25 passed · 3 failed · $0.52 total · 34s wall
```

JSON (machine-readable, written to `evals/reports/`):

```json
{
  "timestamp": "2026-09-18T14:30:00Z",
  "suite": "demo",
  "results": [
    { "id": "inv-001", "pass": true, "grader": "exact-match", "durationMs": 1200, "cost": 0.03 },
    { "id": "inv-002", "pass": false, "grader": "exact-match", "durationMs": 800, "cost": 0.01,
      "expected": {}, "actual": {}, "reason": "..." }
  ],
  "summary": { "total": 25, "passed": 22, "failed": 3, "cost": 0.52, "wallMs": 34000 }
}
```

### CLI options

```
npm run eval                          # run all suites
npm run eval -- --suite=demo          # run one suite
npm run eval -- --tag=happy-path      # filter by tag
npm run eval -- --grader=llm-judge    # override grader for all cases
npm run eval -- --parallel            # run cases in parallel
```

### Config

```js
evals: {
  enabled: true,
  suiteDir: './evals/suites',
  reportDir: './evals/reports',
  parallel: false,
}
```

---

## 6. Configuration

### Full memory + eval config block

```js
// host.config.mjs
export default {
  name: 'invoice-matcher',
  fleet: { ... },
  comm: { ... },
  modules: {
    runLoop: { enabled: true, strategy: 'plan-execute' },
    budgets: { enabled: true, maxIterations: 25 },
    guardrails: { enabled: true },

    memory: {
      workingContext: {
        enabled: true,
        maxTurns: 50,
        compactionStrategy: 'summarise',
        keepRecent: 25,
      },
      runState: {
        enabled: true,
        checkpointDir: './state',
        store: 'filesystem',
      },
      longTerm: {
        enabled: true,
        store: 'filesystem',
        dir: './memory',
        autoLearn: false,
        maxEntries: 500,
        recallLimit: 20,
      },
    },

    evals: {
      enabled: true,
      suiteDir: './evals/suites',
      reportDir: './evals/reports',
      parallel: false,
    },
  },
}
```

### Module dependency rules (additions)

| Module | Depends on | Reason |
|---|---|---|
| Working context | Run loop | No turn history to compact without a run loop |
| Run state | Run loop | No step sequence to checkpoint without a run loop |
| Long-term memory | None | Can be used standalone — routes + tools work without a run loop |
| Auto-learner | Run loop + long-term memory | Needs a run to learn from and a store to write to |
| Evals | Tools registry | Tests call through executeHostedTask. No run loop required for tool-only evals |

Dependency violations log warnings at startup (not errors), consistent with
existing behavior.

---

## 7. Directory structure (new files)

```
host/memory/
  store/
    interface.mjs          ← MEMORY_STORE_METHODS + assertMemoryStore()
    memory.mjs             ← in-process Map (tests, ephemeral)
    filesystem.mjs         ← JSON files on disk (default)
    sqlite.mjs             ← node:sqlite
    http.mjs               ← external REST API client
  working-context.mjs      ← compaction (summarise / sliding-window)
  run-state.mjs            ← checkpoint / resume
  long-term.mjs            ← cross-run facts (recall / store / forget)
  learner.mjs              ← auto-extract facts after runs (opt-in)
  index.mjs                ← createMemoryModule() wires enabled pieces
  routes.mjs               ← thin /memory HTTP endpoints

evals/
  runner.mjs               ← run(suite, agentOpts) → report
  graders/
    exact-match.mjs
    contains.mjs
    llm-judge.mjs
    custom.mjs
    index.mjs              ← resolveGrader(name) factory
  suites/
    demo.json              ← example suite for demo agent
  reports/                 ← generated (gitignored)
```

## 8. Changes to existing files

| File | Change |
|---|---|
| `host/config.mjs` | Add `'memory'` and `'evals'` to `IMPLEMENTED_MODULES`. Validate memory sub-modules and dependency rules. |
| `host/index.mjs` | Initialize memory module via `createMemoryModule()`. Pass working context to strategies. Pass long-term memory to prompt building. Register `/memory` routes. Add `remember`/`recall`/`forget` tools. Wire auto-learner on run completion. Add `.memory()` to builder API. |
| `host/strategies/open-ended.mjs` | When working context enabled: call `workingContext.append()` and `workingContext.forPrompt()` instead of raw `observations` array. When run state enabled: call `runState.save()` after each observation. |
| `host/strategies/plan-execute.mjs` | Same working context and run state integration. On startup, check for existing checkpoint and resume. |
| `host/prompts/system.mjs` | Accept optional `memories` parameter. When present, inject a `## Your Memory` section listing recalled facts. |
| `host/prompts/act.mjs` | No structural change — receives compacted history from the strategy. |
| `host/prompts/replan.mjs` | Same — receives compacted history. |
| `host/prompts/resolve-args.mjs` | Same — receives compacted history. |
| `host/prompts/reason.mjs` | Same — receives compacted history. |
| `host/routes.mjs` | Import and mount memory routes when long-term memory is enabled. |
| `host/tools/registry.mjs` | Export `withMemoryTools()` function (same pattern as `withJobTools()`). |
| `host/run-loop.mjs` | After run completes, call learner if `autoLearn` enabled. |
| `host/tasks.mjs` | Pass memory module to `runTask()`. Recall long-term facts before starting. |
| `package.json` | Add `"eval": "node evals/runner.mjs"` script. |
| `.gitignore` | Add `evals/reports/`. |

---

## What this spec does not cover

- **Semantic / vector search for recall.** The query method uses tag matching
  and substring search. Embedding-based retrieval is a future enhancement
  that would ship as an additional store backend or a query strategy.
- **Memory sharing between agents.** One container = one agent = one memory
  store. Cross-agent memory sharing is handled by pointing multiple agents
  at the same external memory service via the HTTP backend.
- **Memory UI.** No browser-based interface for viewing/editing agent memory.
  Filesystem backend files are human-readable JSON. The HTTP routes serve
  as the programmatic interface.
- **Memory versioning / audit trail.** Entries are created, updated, and
  removed. There is no history of changes to individual entries.
