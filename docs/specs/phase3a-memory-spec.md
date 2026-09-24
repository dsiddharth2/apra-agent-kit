# Fleet Agent Kit — Phase 3a: Memory

Status: approved design — not yet implemented.

## What this phase ships

Three memory tiers (working context, run state, long-term) with tier
isolation, FSRS-6 decay, prediction-error gating (dedup), a pluggable
store adapter interface, and SSE-based memory events. All tiers are
independently toggleable via `host.config.mjs` and follow the kit's
existing modularity patterns.

Eval is not part of this phase.

## Relationship to existing code

Phase 3a builds on the shipped Phase 2 foundation: run loop (open-ended +
plan-execute strategies), budgets, guardrails, and the Phase 4a dispatch/jobs
system. Memory hooks into the strategies and prompt builders. The prompt
builders gain an optional `memories` parameter. Existing behavior when memory
is disabled is unchanged.

No existing module is removed or restructured. Memory wraps around the
existing observation arrays inside the strategies.

---

## 1. Memory Store Interface (Adapter Pattern)

A pluggable persistence contract shared by run-state and long-term memory.
Same pattern as `host/jobs/store/interface.mjs`. The code calling memory
never knows which backend is behind it — config picks the implementation.

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
  'query',    // async ({ kinds, tags, states, query, limit }) => entry[]
  'purge',    // async ({ states, olderThan }) => count — remove entries matching criteria
  'count',    // async ({ kinds, states }) => number — count entries matching criteria
];

export function assertMemoryStore(store) {
  const missing = MEMORY_STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`memory store missing: ${missing.join(', ')}`);
  return store;
}
```

### Store resolution

```
createMemoryStore(config)
    ├── config.store === 'filesystem'  → new FilesystemStore(config)
    ├── config.store === 'sqlite'      → new SqliteStore(config)
    ├── config.store === 'cosmos'      → new CosmosStore(config)
    ├── typeof config.store === 'function' → custom adapter (user passes constructor)
    └── unknown string → throw
```

### Memory entry shape

```js
{
  id: 'mem-abc123',
  kind: 'rule' | 'domain' | 'preference' | 'pattern' | 'procedure',
  text: 'Always check backup status before deletions',
  tags: ['safety', 'deletions'],
  source: 'human' | 'agent' | 'system',
  confidence: 1.0,

  // FSRS-6 decay fields
  storageStrength: 1.0,       // 0.0–1.0, only increases, never decreases
  retrievalStrength: 1.0,     // 0.0–1.0, decays over time, restored by promote
  state: 'active',            // active | dormant | silent | unavailable
  stability: 1.0,             // FSRS-6 stability parameter (days)
  difficulty: 0.3,            // FSRS-6 difficulty parameter (0.0–1.0)
  reps: 0,                    // number of successful reviews/promotes
  lapses: 0,                  // number of times fact decayed below active then was re-promoted
  lastPromotedAt: null,       // timestamp of last promote event
  lastReviewRating: null,     // last FSRS rating (1=Again, 2=Hard, 3=Good, 4=Easy)

  // Standard timestamps
  createdAt: '2026-09-18T...',
  lastUsedAt: null,
  useCount: 0,
  metadata: {},
}
```

### Shipped backends

| Backend | Config value | Storage | Use case |
|---|---|---|---|
| `filesystem` | `store: 'filesystem'` | JSON files in a directory | Default. Single agent. Human-readable, easy to inspect and edit. |
| `sqlite` | `store: 'sqlite'` | SQLite DB file (node:sqlite) | Structured queries, full-text search, trigram similarity |
| `cosmos` | `store: 'cosmos'` | Azure Cosmos DB | Production. Function apps, serverless, multi-region |

All backends are "dumb stores" — they handle CRUD persistence only. Decay
logic, ranking, state management, and dedup live in the memory module above
the store layer.

### Custom adapters

A custom adapter is a function that receives config and returns an object
satisfying the store contract:

```js
// host.config.mjs
import { myRedisStore } from './my-redis-store.mjs';

export default {
  modules: {
    memory: {
      longTerm: {
        store: myRedisStore,   // function → called with config, must return store contract
      },
    },
  },
}
```

The kit validates the returned object with `assertMemoryStore()` at startup.
Community-built adapters (Redis, Postgres, Mongo, Vestige, vector DBs) plug
in this way. The kit does not ship them.

---

## 2. Tier Isolation & Failure Policies

Each memory tier gets its own store instance, configured independently. A
failure in one tier never affects the others. Memory is a helper, never a
blocker — every failure degrades gracefully.

| Tier | On Failure | Policy |
|---|---|---|
| **Working Context** (compaction fails) | Fall back from `summarise` to `sliding-window` automatically. Log warning. Run continues. |
| **Run State** (checkpoint write fails) | Log warning, continue run. Emit health event. Track consecutive failures — 3+ triggers louder alert. Never halt a good run for a checkpoint failure. |
| **Long-Term Recall** (can't read facts) | Proceed with blank slate + warn. Agent never refuses work because it can't remember. |
| **Long-Term Store** (can't persist fact) | Log and drop. Run unaffected. |
| **Auto-Learner** (post-run extraction fails) | Log and skip. Run already succeeded. |

### Config per tier

Each tier specifies its own store, directory, and failure settings:

```js
memory: {
  workingContext: {
    enabled: true,
    // ... (no store — purely in-process)
    fallbackStrategy: 'sliding-window',
  },
  runState: {
    enabled: true,
    store: 'filesystem',
    dir: './state',
    maxConsecutiveFailures: 3,
  },
  longTerm: {
    enabled: true,
    store: 'sqlite',
    dir: './memory',
    recallFailurePolicy: 'blank-slate',  // 'blank-slate' | 'error'
  },
}
```

---

## 3. Working Context (in-run compaction)

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

Default: `summarise`. On compaction failure: auto-fallback to `sliding-window`.

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
    fallbackStrategy: 'sliding-window',
    keepRecent: 25,
  },
}
```

When disabled: strategies pass raw `observations[]` exactly as today. Zero
behavior change.

---

## 4. Run State (checkpoint / resume)

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
    store: 'filesystem',
    dir: './state',
    maxConsecutiveFailures: 3,
  },
}
```

Docker setup: mount `dir` as a Docker volume so checkpoints survive
container restarts.

When disabled: crash = restart from scratch. Current behavior.

---

## 5. FSRS-6 Decay Engine

The decay engine computes how fast facts fade over time. It sits above the
store layer — the store persists the FSRS state fields, the engine does the
math.

### Algorithm

FSRS-6 (Free Spaced Repetition Scheduler, version 6) uses a power-law
forgetting curve validated on 700M+ Anki reviews. The 21 parameters are
pre-trained constants from the public FSRS dataset — not tuned per agent.

Retrievability formula:

```
R(t, S) = (1 + factor * t / S) ^ -w20

where:
  t      = days since last promote
  S      = stability (days — how long until retrievability drops to 90%)
  w20    = decay parameter (pre-trained, ~0.5)
  factor = 0.9 ^ (-1 / w20) - 1
```

After each promote event (review), FSRS-6 updates `stability` and
`difficulty` based on the review rating:

| Rating | Meaning | When used |
|---|---|---|
| 1 (Again) | Fact was recalled but wrong/unhelpful | Explicit negative feedback |
| 2 (Hard) | Fact was recalled with effort | Reserved for future use |
| 3 (Good) | Fact was useful | Default for promote signals |
| 4 (Easy) | Fact was obviously useful | Reserved for future use |

For V1, all promote signals map to rating 3 (Good). The rating field
exists for future refinement.

### State thresholds

Retrieval strength is the live `R(t, S)` value computed by the decay timer.

| State | Retrieval Strength | Recall behavior |
|---|---|---|
| `active` | >= 0.7 | Returned normally, ranked by strength |
| `dormant` | 0.4 – 0.7 | Backfills automatically if active facts don't fill `recallLimit` |
| `silent` | 0.1 – 0.4 | Only returned when explicitly requested via `includeStates` |
| `unavailable` | < 0.1 | Invisible at recall. Candidate for purge. Only visible via `get(id)` |

Thresholds are configurable:

```js
decay: {
  thresholds: {
    active: 0.7,
    dormant: 0.4,
    silent: 0.1,
  },
}
```

### Default decay speed (fast profile)

A fact that is never promoted after being taught:

| Time since last promote | Retrieval Strength | State |
|---|---|---|
| Day 0 | 1.0 | Active |
| Day 3 | ~0.80 | Active |
| Day 7 | ~0.65 | Dormant |
| Day 14 | ~0.50 | Dormant |
| Day 30 | ~0.30 | Silent |
| Day 60 | ~0.15 | Silent |
| Day 90 | ~0.08 | Unavailable |

Roughly: **1 week to dormant, 1 month to silent, 3 months to unavailable**.

Each promote resets retrieval strength and increases stability — the next
decay cycle is slower. A fact promoted 5 times decays much more slowly than
one promoted once. This is the spaced repetition effect.

### Rules are exempt from decay

Entries with `kind: 'rule'` are never processed by the decay timer. They
remain in `active` state permanently. The only way to remove a rule is
explicit deletion via `remove(id)`.

### Decay engine interface

```js
// host/memory/decay/interface.mjs
export const DECAY_ENGINE_METHODS = [
  'computeRetrievability',  // (entry, now) => number (0.0–1.0)
  'computeState',           // (retrievability, thresholds) => state string
  'processReview',          // (entry, rating) => updated FSRS fields
  'shouldProcess',          // (entry) => boolean (false for rules)
];
```

FSRS-6 is the default engine. The interface allows swapping in a different
decay model (simpler power-law, exponential, custom) without changing the
memory module.

### Decay timer

The timer periodically recomputes retrieval strength and state for all
eligible facts. Three modes:

| Mode | Who runs decay | Use case |
|---|---|---|
| `interval` | Kit's internal `setInterval` | Long-running process, always-on agent |
| `none` | External caller invokes `runDecayPass()` | Function apps (Azure timer trigger), cron jobs, serverless |
| `manual` | Developer calls `runDecayPass()` in code/tests | Dev, testing, custom orchestration |

```
Decay Timer (every [intervalMs]):
    1. Query all facts where state !== 'unavailable' AND kind !== 'rule'
    2. For each: compute R(t, S) via FSRS-6
    3. Derive state from thresholds
    4. If strength or state changed → store.update(id, { retrievalStrength, state })
    5. Optionally: purge unavailable facts older than [purgeAfterDays]
```

The `runDecayPass()` function is exported for external callers:

```js
import { runDecayPass } from 'fleet-agent-kit/memory';

// In an Azure timer-triggered function:
export async function decayTimer() {
  const store = createMemoryStore(config);
  await store.open();
  await runDecayPass(store, { engine: 'fsrs6' });
  await store.close();
}
```

### Config

```js
decay: {
  engine: 'fsrs6',
  mode: 'interval',           // 'interval' | 'none' | 'manual'
  intervalMs: 3600000,         // 1 hour (only used in interval mode)
  purgeOnDecay: false,         // auto-purge unavailable facts?
  purgeAfterDays: 90,          // if purgeOnDecay: true, remove unavailable older than this
  thresholds: {
    active: 0.7,
    dormant: 0.4,
    silent: 0.1,
  },
},
```

---

## 6. Prediction-Error Gating (Dedup on Write)

A filter that runs on every write to long-term memory. Compares the incoming
fact against existing facts and decides: create new, merge into existing, or
reinforce existing.

### Flow

```
New fact arrives
    │
    ▼
Find candidate matches (same kind + overlapping tags)
    │
    ▼
Compute similarity against each candidate (trigram, default)
    │
    ├── Similarity > reinforceThreshold (92%)  →  REINFORCE
    │   Action: bump storageStrength, record FSRS review (Good),
    │           restore retrievalStrength. No new entry created.
    │
    ├── Similarity > mergeThreshold (75%)  →  MERGE
    │   Action: update existing fact's text (source priority),
    │           bump strengths, record FSRS review (Good).
    │
    ├── Similarity < mergeThreshold (75%)  →  CREATE
    │   Action: create a new entry as normal.
    │
    ▼
Done — one write, zero duplicates
```

### Similarity strategies

| Strategy | How it works | Dependencies |
|---|---|---|
| `trigram` (default) | Break both texts into 3-character chunks, compare overlap ratio. SQLite has built-in support. Filesystem/cosmos do it in pure JS. | None |
| `text` | Normalize (lowercase, strip punctuation), Dice coefficient on word sets. Faster but less precise. | None |
| `embedding` (opt-in) | Cosine similarity on embedding vectors. Requires configured embedding provider. | External embedding provider |

### Merge policy — source priority

When similarity is 75-92% and texts must be merged, source determines which
text wins:

1. Human-taught always overwrites agent-learned
2. Agent-learned never overwrites human-taught
3. Between same source, incoming (newer) wins

Regardless of which text wins, strengths are always bumped (it's a reinforce
event).

### FSRS interaction

Both reinforce and merge events are recorded as FSRS review events with
rating 3 (Good). This means:

- Retrieval strength is restored
- Stability increases (next decay is slower)
- Frequently re-taught facts naturally stay Active

### Config

```js
dedup: {
  enabled: true,
  strategy: 'trigram',            // 'trigram' | 'text' | 'embedding'
  reinforceThreshold: 0.92,
  mergeThreshold: 0.75,
  embedding: {                    // only when strategy: 'embedding'
    provider: 'openai',
    model: 'text-embedding-3-small',
  },
},
```

When disabled: every write creates a new entry. No dedup check.

---

## 7. Long-Term Memory (cross-run facts)

Facts that persist across separate task runs. The "teaching" system.

### How facts enter

1. **Human-taught** — via HTTP routes (`POST /memory`), MCP tools
   (`remember`), or pre-loaded knowledge files.
2. **Agent-learned** (opt-in, `autoLearn: true`) — after a run completes,
   a learner module reviews the history and extracts reusable facts via an
   LLM call.

All writes pass through prediction-error gating (section 6) before
persisting.

### Pre-loaded knowledge files

A directory of JSON files loaded into memory on agent startup:

```
memory/
  rules/
    safety.json
    compliance.json
  domain/
    database-conventions.json
```

Each file contains an array of memory entries. On startup, each entry is
processed through dedup gating — duplicates are reinforced, not re-created.
This makes repeated restarts safe.

### Rule-setting policy

Rules (`kind: 'rule'`) are exempt from decay and always recalled. Because of
this elevated status, only humans can create rules:

| Channel | Can create rules? |
|---|---|---|
| HTTP route (`POST /memory`) | Yes |
| MCP `remember` tool | Yes (human is driving the conversation) |
| Pre-loaded files | Yes |
| Auto-learner | **No** — can only create domain/preference/pattern/procedure |

The auto-learner enforces this by filtering `rule` from its output kinds.

### Recall — two mechanisms

**Automatic recall (before run starts):**

The kit's own code calls `memory.query()` as a JS method call — no LLM
involved. Facts are injected into the system prompt before the agent sees
anything.

```
Task arrives
  → host/tasks.mjs calls memory.query({ tags from task, states: ['active', 'dormant'] })
  → Rules (kind: 'rule') always recalled regardless of tag match
  → Other kinds recalled when tags overlap with the task
  → Results ranked by retrievalStrength (highest first)
  → Dormant facts backfill if active facts don't fill recallLimit
  → Matched facts injected into system prompt as a "## Your Memory" section
  → System prompt also tells the agent it can recall more facts mid-run
  → Run loop proceeds with enriched prompt
```

**On-demand recall (during run):**

The agent has the `recall` MCP tool available. If the task evolves or spans
multiple domains, the agent can call `recall` mid-run to fetch additional
facts. This costs a tool call turn.

```
Agent mid-run discovers it needs payment gateway facts
  → Agent calls tool: recall({ tags: ["payments", "gateway"], limit: 5 })
  → Internally calls memory.query(...)
  → Returns facts as tool output
  → Agent continues with new context
```

Both mechanisms call the same underlying `memory.query()`. The difference is
who initiates: automatic (kit code, free) vs on-demand (LLM tool call, costs
a turn).

### Recall ranking

1. Rules first (always relevant, always active)
2. Active facts ranked by retrievalStrength descending
3. If slots remain: dormant facts ranked by retrievalStrength descending
4. Limit to `recallLimit` entries (default 20)

### Promote signals

Retrieval alone does not strengthen a fact (audit-only). Only explicit
promote signals restore retrieval strength and record an FSRS-6 review:

| Channel | How it works |
|---|---|
| **Explicit MCP tool** | Agent calls `promote({ id })` during a run after a fact proved useful |
| **Learner bulk promote** | Auto-learner identifies which recalled facts were used in the run and promotes them in batch (requires `autoLearn: true`) |
| **Dedup reinforce** | A new fact matching an existing one at >92% similarity triggers a reinforce (section 6) |
| **Human via API** | `PATCH /memory/:id { promote: true }` |

### Auto-learner

After a run completes, if `autoLearn: true`:

```
Task completes
  → learner.extract({ task, history, recalledFacts, fleetApi })
  → LLM call: "What reusable facts did you learn? Which recalled facts were useful?"
  → New facts stored with source: 'agent', confidence: 0.8 (never kind: 'rule')
  → Used recalled facts promoted in bulk (FSRS review, rating: Good)
```

### Memory access — three doors, one module

| Access layer | Who uses it | How |
|---|---|---|
| Direct JS calls | Run loop, strategies, learner | `memory.query(...)`, `memory.store(...)` |
| HTTP routes on agent | External callers (humans, UIs, other agents) | `POST /memory`, `GET /memory?tags=...` |
| MCP tools | LLM tool calls during a run | `remember`, `recall`, `forget`, `promote` |

The routes and tools contain no logic — they validate input and delegate to
the memory module.

### HTTP routes

```
POST   /memory          → memory.store(body)     — passes through dedup gating
GET    /memory          → memory.query(querystring params)
GET    /memory/:id      → memory.get(id)
PATCH  /memory/:id      → memory.update(id, body)
PATCH  /memory/:id/promote → memory.promote(id)
DELETE /memory/:id      → memory.remove(id)
```

### MCP tools

| Tool | Input | Action |
|---|---|---|
| `remember` | `{ text, kind, tags }` | `memory.store({ ...input, source: 'human' })` — passes through dedup |
| `recall` | `{ tags?, kinds?, query?, limit? }` | `memory.query(input)` — audit only, no strengthen |
| `forget` | `{ id }` | `memory.remove(id)` |
| `promote` | `{ id }` | `memory.promote(id)` — FSRS review, rating: Good |

### Config

```js
memory: {
  longTerm: {
    enabled: true,
    store: 'sqlite',
    dir: './memory',
    autoLearn: false,
    maxEntries: 500,
    recallLimit: 20,
    preloadDir: './memory/rules',

    decay: {
      engine: 'fsrs6',
      mode: 'interval',
      intervalMs: 3600000,
      purgeOnDecay: false,
      purgeAfterDays: 90,
      thresholds: {
        active: 0.7,
        dormant: 0.4,
        silent: 0.1,
      },
    },

    dedup: {
      enabled: true,
      strategy: 'trigram',
      reinforceThreshold: 0.92,
      mergeThreshold: 0.75,
    },
  },
}
```

When disabled (the default): each run starts with a clean slate. No routes,
tools, decay timer, or dedup gating registered.

---

## 8. Memory Events (SSE)

Memory operations emit events through the existing notification system
(`host/notify/`). Events are transported via SSE (and webhooks if
configured). The chat UI or any external listener subscribes to the SSE
stream and decides what to render.

### Event types

| Event | Payload | When emitted |
|---|---|---|
| `memory:recall` | `{ taskId, count, facts: [{ id, kind, text, state }] }` | Automatic recall before run starts |
| `memory:recall:tool` | `{ taskId, count, facts: [{ id, kind, text, state }] }` | Agent calls `recall` MCP tool mid-run |
| `memory:store` | `{ entry, dedupResult: 'created' \| 'merged' \| 'reinforced' }` | New fact stored (any channel) |
| `memory:promote` | `{ id, kind, text, newRetrievalStrength }` | Fact promoted (any channel) |
| `memory:learn` | `{ taskId, newFacts: [...], promotedIds: [...] }` | Auto-learner completes after a run |
| `memory:decay` | `{ processed, stateChanges: [{ id, from, to }] }` | Decay timer pass completes |
| `memory:error` | `{ tier, error, policy }` | Any memory failure (includes which fallback policy was applied) |

### Event levels

Configurable verbosity — the listener receives only events at or above the
configured level:

| Level | What gets emitted |
|---|---|
| `none` | Nothing — memory is silent |
| `notifications` | Summary events: `memory:recall` (count only, no fact details), `memory:store`, `memory:learn`, `memory:error` |
| `full` | Everything including full fact payloads, individual promotes, decay state changes |

### Integration

The memory module calls `notify.emit()` at each event point. No changes to
the notify system are needed — memory events are just another event type on
the same SSE stream and webhook pipeline.

```js
// Inside memory module:
notify.emit('memory:recall', { taskId, count: 5, facts: [...] });

// SSE listener receives:
event: memory:recall
data: {"taskId":"task-abc","count":5,"facts":[...]}
```

### Config

```js
memory: {
  events: {
    enabled: true,
    level: 'notifications',   // 'none' | 'notifications' | 'full'
  },
}
```

---

## 9. Configuration

### Full memory config block (including events)

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
        fallbackStrategy: 'sliding-window',
        keepRecent: 25,
      },
      runState: {
        enabled: true,
        store: 'filesystem',
        dir: './state',
        maxConsecutiveFailures: 3,
      },
      longTerm: {
        enabled: true,
        store: 'sqlite',
        dir: './memory',
        autoLearn: false,
        maxEntries: 500,
        recallLimit: 20,
        preloadDir: './memory/rules',
        recallFailurePolicy: 'blank-slate',

        decay: {
          engine: 'fsrs6',
          mode: 'interval',
          intervalMs: 3600000,
          purgeOnDecay: false,
          purgeAfterDays: 90,
          thresholds: {
            active: 0.7,
            dormant: 0.4,
            silent: 0.1,
          },
        },

        dedup: {
          enabled: true,
          strategy: 'trigram',
          reinforceThreshold: 0.92,
          mergeThreshold: 0.75,
        },
      },

      events: {
        enabled: true,
        level: 'notifications',   // 'none' | 'notifications' | 'full'
      },
    },
  },
}
```

### Azure Function App example

```js
memory: {
  longTerm: {
    enabled: true,
    store: 'cosmos',
    cosmos: {
      endpoint: '${COSMOS_ENDPOINT}',
      key: '${COSMOS_KEY}',
      database: 'agent-memory',
      container: 'facts',
    },
    decay: {
      engine: 'fsrs6',
      mode: 'none',        // external Azure timer function handles decay
    },
  },
}
```

Environment variable interpolation in config string values: `${VAR}` is
replaced with `process.env[VAR]` at startup.

### Module dependency rules (additions)

| Module | Depends on | Reason |
|---|---|---|
| Working context | Run loop | No turn history to compact without a run loop |
| Run state | Run loop | No step sequence to checkpoint without a run loop |
| Long-term memory | None | Can be used standalone — routes + tools work without a run loop |
| Auto-learner | Run loop + long-term memory | Needs a run to learn from and a store to write to |
| Decay timer | Long-term memory | Nothing to decay without long-term memory |

Dependency violations log warnings at startup (not errors), consistent with
existing behavior.

---

## 10. Directory structure (new files)

```
host/memory/
  store/
    interface.mjs          ← MEMORY_STORE_METHODS + assertMemoryStore()
    filesystem.mjs         ← JSON files on disk (default)
    sqlite.mjs             ← node:sqlite with trigram support
    cosmos.mjs             ← Azure Cosmos DB client
  decay/
    interface.mjs          ← DECAY_ENGINE_METHODS
    fsrs6.mjs              ← FSRS-6 implementation (pre-trained constants)
    timer.mjs              ← decay timer (interval / manual / exported runDecayPass)
  dedup/
    interface.mjs          ← similarity strategy contract
    trigram.mjs            ← trigram similarity (default)
    text.mjs               ← normalized text / Dice coefficient
    embedding.mjs          ← cosine similarity on vectors (opt-in)
  working-context.mjs      ← compaction (summarise / sliding-window)
  run-state.mjs            ← checkpoint / resume
  long-term.mjs            ← cross-run facts (recall / store / forget / promote)
  learner.mjs              ← auto-extract facts + bulk promote after runs (opt-in)
  preloader.mjs            ← load knowledge files on startup (through dedup gating)
  events.mjs               ← emit memory events via notify system (SSE + webhooks)
  index.mjs                ← createMemoryModule() wires enabled pieces
  routes.mjs               ← thin /memory HTTP endpoints
```

## 11. Changes to existing files

| File | Change |
|---|---|
| `host/config.mjs` | Add `'memory'` to `IMPLEMENTED_MODULES`. Validate memory sub-modules and dependency rules. |
| `host/index.mjs` | Initialize memory module via `createMemoryModule()`. Pass working context to strategies. Pass long-term memory to prompt building. Register `/memory` routes. Add `remember`/`recall`/`forget`/`promote` tools. Wire auto-learner on run completion. Wire decay timer. Load pre-loaded knowledge files. Wire memory events via `notify.emit()`. Add `.memory()` to builder API. |
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

---

## What this spec does not cover

- **Semantic / vector search for recall.** The query method uses tag matching
  and trigram similarity. Embedding-based retrieval is a future enhancement
  that ships as a store backend or query strategy override.
- **Memory sharing between agents.** One container = one agent = one memory
  store. Cross-agent memory sharing is handled by pointing multiple agents
  at the same store (e.g., same Cosmos DB container) via config.
- **Memory UI.** No browser-based interface for viewing/editing agent memory.
  Filesystem backend files are human-readable JSON. The HTTP routes serve
  as the programmatic interface.
- **Memory versioning / audit trail.** Entries are created, updated, and
  removed. There is no history of changes to individual entries.
- **Eval harness.** Eval is a separate phase and will have its own spec.
- **Smart store adapters.** V1 stores are all dumb (CRUD only). A future
  version may support smart stores where the external system owns decay,
  ranking, and retrieval (e.g., Vestige as a backend).
