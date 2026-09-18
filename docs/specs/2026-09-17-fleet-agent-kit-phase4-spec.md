# Fleet Agent Kit — Phase 4 Spec

Status: proposed

## What Phase 2 shipped

Phase 2 delivered autonomy: the run loop (`host/run-loop.mjs`) with plan-execute
and open-ended strategies, budgets (`host/budgets.mjs`), guardrails
(`host/guardrails.mjs`), prompt templates, and a synchronous `POST /task` route
that blocks until the run loop finishes. The builder exposes `.runLoop()`,
`.budget()`, `.guardrails()`, and `.run(task)`.

Phase 2 is a working agent, but it is not deployable as a service. Every task
holds an HTTP connection open for its whole duration, nothing remembers a task
after the response is sent, there is no way to cancel a running task, and the
comm layer is Express-shaped so no second adapter can exist.

Phase 3 (memory, evals) is deferred behind this phase, as agreed in the Phase 2
spec's revised order.

## What Phase 4 ships

1. **Async task execution.** `POST /task` returns `202 { jobId }`. Callers poll
   `GET /jobs/:id`, stream `GET /jobs/:id/events`, or receive a webhook. Jobs can
   be cancelled with `DELETE /jobs/:id`. Sync execution stays available via
   `POST /task?wait=true`.
2. **Jobs backend interface** with two implementations: **in-process** (FIFO
   queue + SQLite store, for VM and Docker) and **durable** (Azure Durable
   Functions, one orchestrator, one activity).
3. **Notifier** with two channels: **SSE** and **webhook**.
4. **Framework-neutral comm contract** and three adapters: `express` (migrated),
   `raw-http` (new), `azure-functions` (new).
5. **Two MCP tools**: `submit-task` and `job-status`, so Claude Code can drive
   long runs without holding a connection open.

### Milestone

The same agent, unchanged, runs as a Docker container on a VM with jobs
persisted in SQLite, and as an Azure Function App on a Premium plan with jobs
persisted by Durable Functions. A submitted task returns a job id in under a
second, progress streams over SSE, the result arrives by webhook, and a runaway
task can be cancelled. Excess load gets a `429` instead of a stall.

### Does not ship

- Redis Streams backend, concurrent tasks on multiple leases beyond dispatcher
  capacity, long-term memory (Phase 5).
- Run-state checkpoints and mid-task resume (Phase 3). A job interrupted by a
  process crash is marked `failed / interrupted`, not resumed.
- Memory compaction, eval harness (Phase 3).
- WebSocket or Azure SignalR delivery. SignalR is a documented extension point
  on the notifier interface.
- Azure Table Storage job store. Durable's task hub is the Azure store.
- Consumption-plan Azure Functions. Fleet needs a long-lived child process and
  the Claude CLI on disk; only Premium or Dedicated plans with a custom Linux
  container are supported.
- Real authentication. `authenticate` remains an injected stub.
- Human-in-the-loop feedback (`waiting_input` status, `input_required` event,
  `POST /jobs/:id/input`, guardrails approval routed to a human, `ask_user`
  block). Deferred on 2026-09-17; tracked as a GitHub issue. The Phase 4 event
  and status model is designed so that adding a non-terminal `waiting_input`
  state is additive.

---

## Architecture

```
                 comm adapter (express | raw-http | azure-functions)
                     │  neutral handler(request) → response
                     ▼
   ┌──────────── host routes ─────────────────────────────────┐
   │ POST /mcp             → MCP server (sync, unchanged)      │
   │ POST /task?wait=true  → run loop inline (Phase 2)         │
   │ POST /task            → jobs.submit(task) → 202 {jobId}   │
   │ GET  /jobs/:id        → jobs.get(id)                      │
   │ DELETE /jobs/:id      → jobs.cancel(id)                   │
   │ GET  /jobs/:id/events → SSE from jobs.subscribe(id)       │
   │ GET  /health                                              │
   └───────────────────────────┬───────────────────────────────┘
                               ▼
                   jobs backend (host/jobs/interface.mjs)
                 ┌─────────────┴──────────────┐
        in-process (VM/Docker)          durable (Azure)
        FIFO queue + SQLite store       startNew / getStatus /
        worker loop in same process     terminate; 1 orchestrator,
                                        1 activity = runTask
                 └─────────────┬──────────────┘
                               ▼
              executeHostedTask (existing Phase 2 function)
              dispatcher lease → run loop → tools → notifier events
```

Three rules hold this together:

1. **The jobs backend never knows which HTTP framework called it.** It receives
   a Task and returns records and events.
2. **The run loop never knows whether it is inside a Durable activity or a Node
   worker loop.** Both call the existing `executeHostedTask` with one new
   optional `onEvent` callback.
3. **Backpressure lives at the job level.** `dispatch.maxQueueSize` is what
   returns `429`. The worker dispatcher's lease queue only ever holds jobs that
   are already `processing`, so it never fills on the job path.

### Two seams, not one

| Seam | Owns | Implementations |
|------|------|-----------------|
| Comm adapter | HTTP shape: parsing requests, writing responses, streaming | `express`, `raw-http`, `azure-functions` |
| Jobs backend | Queueing, job records, cancellation, event fan-out source | `in-process`, `durable` |

Durable Functions touches only the async job path. MCP `tools/call`, sync
`/task?wait=true`, and `/health` run inside a plain HTTP trigger on Azure
exactly as they run on Express today.

---

## The job record

One shape on both backends:

```js
{
  id: 'job-a1b2c3',
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded',
  task: { goal, inputs, constraints, budget },   // as submitted, after stricter-wins merge
  submittedAt: '2026-09-17T10:00:00.000Z',
  startedAt: null,                               // set when processing begins
  finishedAt: null,                              // set on any terminal status
  attempts: 1,
  result: null,                                  // run loop result on completion
  history: [],                                   // run loop observations, filled at settle
  budget: null,                                  // final BudgetSnapshot, if budgets enabled
  progress: { iteration: 0, message: null, at: null },
  callbackUrl: null,
  metadata: {},                                  // caller pass-through
  error: null,                                   // { code, message } when failed
}
```

### Status transitions

```
queued ──► processing ──► completed
   │            │      ├─► failed
   │            │      ├─► budget_exceeded
   │            └─────►└─► cancelled
   └──────────────────────► cancelled
```

- `queued → cancelled`: the job is removed from the queue without running.
- `processing → cancelled`: the job's AbortSignal is aborted; the run loop
  returns `status: 'cancelled'` cooperatively.
- Terminal states never change. `cancel` on a terminal job returns
  `{ ok: false, status }` and the route answers `409`.

### Error codes

| `error.code` | Meaning |
|---|---|
| `dispatch_failed` | No worker lease could be obtained (dispatcher overflow or closed). |
| `interrupted` | Process restarted while the job was `processing`. |
| `lease_expired` | Job exceeded `leaseTimeoutMs` and was aborted. |
| `run_failed` | Run loop returned `failed` (reason in `message`, e.g. `no_action`). |
| `activity_failed` | Durable only: the activity threw or the host recycled it. |

### Retention

Terminal records are kept for `retentionMs` (default 24 hours), then purged.
`GET /jobs/:id` on a purged or unknown id returns `404`.

---

## Job events

Events are the single source for SSE, webhook, and the `progress` field of the
record. Both backends emit the same four types:

```js
{ type: 'queued',   jobId, at, position }
{ type: 'started',  jobId, at }
{ type: 'progress', jobId, at, iteration, message }   // once per run-loop iteration
{ type: 'settled',  jobId, at, status, result, error } // terminal, always last
```

Each stored event carries a monotonically increasing `seq` per job, used as the
SSE event id.

---

## The jobs interface

```js
// host/jobs/interface.mjs — every backend implements this shape
{
  async start(),                                 // open store, resume queue
  async stop({ drainMs }),                       // stop intake, drain, abort remainder
  async submit(task, { callbackUrl, metadata })  → { jobId, status: 'queued', position },
  async get(jobId)                               → JobRecord | null,
  async cancel(jobId)                            → { ok: boolean, status },
  subscribe(jobId, onEvent)                      → unsubscribe(),
  async events(jobId, { afterSeq })              → JobEvent[],   // replay for SSE
  stats()                                        → { queued, processing, capacity, maxQueueSize },
}
```

`submit` throws `JobQueueFullError` when `queued >= maxQueueSize`. The route maps
it to `429` with `Retry-After: 30`. `submit` throws `JobsClosedError` after
`stop()` has begun; the route maps it to `503`.

Both backends are constructed by a factory in `host/jobs/index.mjs`:

```js
createJobsBackend(config.modules.dispatch, {
  runJob,        // (task, { signal, onEvent }) → run loop result; wraps executeHostedTask
  notifier,      // receives every event
  logger,
})
```

---

## How the run loop plugs in

`executeHostedTask` in `host/index.mjs` already does: dispatch lease → build
per-request budgets → `runTask` → release lease. Phase 4 changes:

1. It gains an optional `onEvent(event)` argument. The run loop
   (`host/run-loop.mjs`) gains an optional `onIteration({ iteration, message })`
   hook that it calls once per driven strategy yield. `executeHostedTask` maps
   that to a `progress` event.
2. It is extracted into `host/tasks.mjs` as a named export so both backends
   and the sync route import the same function. `host/index.mjs` keeps a thin
   wrapper.
3. `dispatch_failed` remains a returned value, not a throw, so the jobs
   backend settles the job as `failed / dispatch_failed` instead of crashing
   the worker loop.

Nothing in strategies, budgets, or guardrails changes.

---

## In-process backend

`host/jobs/in-process.mjs`. For VM and Docker deployments.

### Queue

- An array of job ids in submit order.
- `concurrency` worker loops (default `1`). Each loop: take head → mark
  `processing` → emit `started` → `runJob` → write outcome → emit `settled`.
- `concurrency` is clamped to the worker dispatcher's `capacity` at start with a
  warning, because each running job holds one doer/reviewer lease. This is
  not Phase 5 parallelism; it only stops the job loop from outrunning leases.

### Store

`host/jobs/store/interface.mjs` defines the store contract. Two implementations:

**`host/jobs/store/sqlite.mjs`** — `node:sqlite` (Node ≥ 22.13, no flag; this
repo requires ≥ 22.16). WAL mode. Two tables:

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  record       TEXT NOT NULL          -- full JobRecord as JSON
);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX jobs_finished ON jobs(finished_at);

CREATE TABLE events (
  job_id TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  at     TEXT NOT NULL,
  event  TEXT NOT NULL,               -- JobEvent as JSON
  PRIMARY KEY (job_id, seq)
);
```

The database file lives at `store.dbPath` (default `./workdir/jobs.db`),
created on first start, with `PRAGMA journal_mode = WAL` and
`PRAGMA busy_timeout = 5000`.

**Concurrency model.** Two simultaneous `POST /task` requests cannot collide:
Node runs both handlers on one event loop and every `node:sqlite` statement is
synchronous, so the two `submit` calls serialize naturally with no
application-level lock. Interleaving between worker loops happens only at
`await` points in the run loop, and every store write is one atomic statement.

**Exactly one process per database file.** The queue lives in process memory;
the SQLite file is a record store, not a shared queue. Two containers sharing a
volume would not corrupt the file (WAL handles file locking) but would both
pick up the same `queued` row. A shared queue across containers is the Phase 5
Redis backend. As cheap insurance the claim is atomic anyway:

```sql
UPDATE jobs SET status = 'processing', started_at = ? WHERE id = ? AND status = 'queued'
```

The worker loop runs the job only if exactly one row changed; otherwise it
skips it, so an accidental second process never double-runs a job.

**`host/jobs/store/memory.mjs`** — same contract over two `Map`s. Used by unit
tests and when `store.kind` is `memory`.

### Restart behaviour

On `start()`:

- Rows still `queued` are re-enqueued in `submitted_at` order.
- Rows still `processing` are marked `failed` with `error.code = 'interrupted'`
  and a `settled` event is appended. Resuming mid-task is Phase 3's run-state
  checkpointing; the job store does not attempt it.
- Terminal rows older than `retentionMs` are purged. A purge also runs every
  `retentionMs / 24` (hourly at the default) while running.

### Lease timeout

A job whose `startedAt` is older than `leaseTimeoutMs` is treated as stuck: its
signal is aborted and, if the run loop has not returned within a further 30s,
the job settles as `failed / lease_expired`. Default `leaseTimeoutMs` is
`budgets.timeoutMs + 60_000` when budgets is enabled, else `660_000`. Budgets
should always fire first; this is the safety net.

### Shutdown

`stop({ drainMs })`: stop taking from the queue, reject new `submit` with
`JobsClosedError`, wait up to `drainMs` (default `30_000`) for `processing`
jobs, then abort the rest. Queued jobs remain `queued` in SQLite and resume on
the next start. With the memory store they are lost, which is acceptable for
tests.

---

## Durable backend

`host/jobs/durable.mjs`. For Azure Function Apps. Depends on the
`durable-functions` npm package, loaded lazily so non-Azure deployments never
import it.

### Mapping

| Interface | Durable call |
|---|---|
| `submit(task)` | `client.startNew('runTaskOrchestrator', { instanceId: jobId, input: { task, callbackUrl, metadata } })` |
| `get(jobId)` | `client.getStatus(jobId, { showHistory: false, showInput: true })` → mapped record |
| `cancel(jobId)` | Set `cancelRequested` via `client.raiseEvent(jobId, 'cancel')`; the activity aborts on its next progress tick. If the orchestration is still `Pending`, `client.terminate(jobId)` instead. |
| `subscribe(jobId, cb)` | Poll `getStatus` every `durable.pollMs` (default `2000`) and synthesize events from `customStatus` deltas. |
| `events(jobId)` | Read `customStatus.events` (a bounded ring of the last 50 events; older progress events are dropped, `queued`/`started`/`settled` are always kept). |
| `stats()` | `client.getStatusBy({ runtimeStatus: ['Pending', 'Running'] })` counts. |

Status mapping: Durable `Pending → queued`, `Running → processing`,
`Completed → the activity output's status` (`completed`, `failed`,
`budget_exceeded`, `cancelled`), `Failed → failed / activity_failed`,
`Terminated → cancelled`.

### Backpressure

Before `startNew`, `submit` counts `Pending + Running` instances. At or above
`maxQueueSize` it throws `JobQueueFullError`. This is coarser than the
in-process count (it includes running jobs) but preserves the same contract.

### Functions layout

```
comm/azure-functions/
  index.mjs          ← registers all functions with @azure/functions app
  http.mjs           ← HTTP trigger; translates HttpRequest ↔ neutral handler
  orchestrator.mjs   ← one callActivity('runTaskActivity'); deterministic; nothing else
  activity.mjs       ← spawns/reuses Fleet, calls executeHostedTask, updates customStatus, fires webhook
  host.json          ← functionTimeout: -1, extensions.durableTask.hubName from config
  local.settings.json.example
```

### Progress and cancellation inside Durable

Only the orchestrator can call `setCustomStatus`, and activities cannot touch
orchestration state directly. So progress flows as external events: the
activity's `onEvent` calls `client.raiseEvent(instanceId, 'progress', event)`
once per iteration, and the orchestrator waits on the activity, a `progress`
event, and a `cancel` event at the same time, updating `customStatus` as
events arrive. The orchestrator stays deterministic because it only reacts to
Durable-delivered events:

```js
export function* runTaskOrchestrator(context) {
  const input = context.df.getInput();
  const events = [queuedEvent(context.df.instanceId)];
  context.df.setCustomStatus({ status: 'queued', events });

  const activity = context.df.callActivity('runTaskActivity', input);
  while (true) {
    const progress = context.df.waitForExternalEvent('progress');
    const cancel   = context.df.waitForExternalEvent('cancel');
    const winner   = yield context.df.Task.any([activity, progress, cancel]);
    if (winner === activity) break;
    if (winner === cancel) {
      yield context.df.callActivity('signalCancelActivity', context.df.instanceId);
      continue;
    }
    events.push(progress.result);
    context.df.setCustomStatus({ status: 'processing', events: ring(events, 50) });
  }
  const result = activity.result;
  events.push(settledEvent(result));
  context.df.setCustomStatus({ status: result.status, events: ring(events, 50) });
  return result;
}
```

The activity raises `progress` external events on the orchestration through
the Durable client once per iteration. For cancellation, the orchestrator
records `cancelRequested: true` in `customStatus` when the `cancel` event
arrives, and the running activity polls `client.getStatus(instanceId)` every
`durable.pollMs` and aborts its signal when it sees the flag. Polling the task
hub, rather than an in-memory registry, is deliberate: activities can be
scheduled on any Function instance, so nothing in memory can be assumed shared
between the orchestrator, the activity, and the HTTP trigger that received the
`DELETE`. Cancel latency is therefore bounded by `pollMs` (default 2s).

### Fleet inside the Functions host

- Spawned lazily on the first activity invocation, cached at module scope,
  reused while the instance is warm, stopped on the `appTerminate` hook.
- `WORKER_POOL_SIZE=0`, ephemeral workers under `os.tmpdir()`, exactly as the
  tiered-dispatch design specifies for Function Apps.
- The image is a custom Linux container with Node 22, `apra-fleet`, and the
  Claude CLI preinstalled, deployed on a **Premium plan** with `functionTimeout`
  `-1`. `CLAUDE_CODE_OAUTH_TOKEN` and `WORKER_*` come from app settings.
- Config validation warns when `budgets.timeoutMs` exceeds a configured
  `durable.maxActivityMs` (default `3_600_000`), since the plan's cap kills the
  activity before budgets would.

### Multiple instances

Durable's task hub is the shared state, so `get`, `cancel`, and `events` are
correct from any instance. SSE subscriptions poll `getStatus`, so they are also
correct from any instance, at `pollMs` latency. Webhooks fire from the activity,
so they are always correct.

---

## Notifier

`host/notify/index.mjs` exports `createNotifier(config)` returning
`{ publish(event), sseHandler, stop() }`. Every job event passes through
`publish`, which fans out to enabled channels.

### SSE — `host/notify/sse.mjs`

`GET /jobs/:id/events`:

1. `404` if the job is unknown.
2. If the job is terminal, send all stored events (or those after
   `Last-Event-ID`) and close.
3. Otherwise replay stored events after `Last-Event-ID`, then follow live via
   `jobs.subscribe`. Close after `settled`.
4. A comment line `: ping` every `heartbeatMs` (default `25_000`) keeps the
   connection under Azure's ~230s idle cut. Clients that get cut reconnect
   with `Last-Event-ID` and miss nothing.

Wire format:

```
id: 3
event: progress
data: {"type":"progress","jobId":"job-a1b2c3","at":"...","iteration":3,"message":"executing step 2"}

```

### Webhook — `host/notify/webhook.mjs`

If the job has a `callbackUrl`:

- POST the `settled` event as JSON, plus `progress` events when
  `webhook.sendProgress` is true.
- Header `X-Fleet-Job-Id`. Body is the event object.
- `retries` attempts (default `3`) with exponential backoff from 1s. After the
  last failure, log and give up; the job record is unaffected.
- `callbackUrl` must be `https:` unless `webhook.allowHttp` is true. Rejected
  URLs fail `submit` with `400`.

### Extension point

A third channel implements `{ publish(event) }` and is registered in
`createNotifier`. Azure SignalR Service is the intended first extension; it is
not part of Phase 4.

---

## Neutral comm contract

### Today

`comm/interface.mjs` passes Express-style `(req, res)` handlers and Express
middleware for `authenticate`. Nothing but Express can implement it.

### Phase 4 contract

```js
// comm/interface.mjs
{
  async start({ routes, port, host, authenticate }),
  async stop(),
  port(), address(),
}

// routes: { [name]: { method, path, handler, raw?: boolean, auth?: boolean } }
// handler(request) → response
//
// request:  { method, path, params, query, headers, body, signal, user }
// response: { status, headers?, body? }                       // JSON body
//        |  { status, headers?, stream: AsyncIterable<string> } // SSE / streaming
//
// authenticate(request) → user | null   (null → adapter answers 401)
```

Route table produced by the host:

| Name | Method | Path | Raw | Notes |
|---|---|---|---|---|
| `health` | GET | `/health` | no | no auth |
| `mcp` | POST | `/mcp` | **yes** | needs Node `req`/`res` for the MCP SDK transport |
| `task` | POST | `/task` | no | `?wait=true` for sync |
| `jobGet` | GET | `/jobs/:id` | no | |
| `jobCancel` | DELETE | `/jobs/:id` | no | |
| `jobEvents` | GET | `/jobs/:id/events` | no | streaming response |

`raw: true` routes receive `(req, res, user)` Node objects. Express and raw-http
mount them directly. The Azure adapter serves them through a small Node
`IncomingMessage`/`ServerResponse` shim built from `HttpRequest`; this is the
one place the MCP SDK's Node dependency leaks, and it is confined to the adapter.

### Adapters

| Adapter | File | Notes |
|---|---|---|
| `express` | `comm/express.mjs` | Migrated to the neutral contract. Existing tests updated. |
| `raw-http` | `comm/raw-http.mjs` | `node:http` only. Proves the contract with no framework. |
| `azure-functions` | `comm/azure-functions/http.mjs` | `@azure/functions` v4 model. `app.setup({ enableHttpStream: true })` for SSE. `start()` registers functions; `stop()` is a no-op (the host owns the process). `port()` returns `null`. |

Each adapter passes the same contract test suite (see Testing).

---

## MCP tools

Two new registry entries in `host/tools/registry.mjs`:

```js
{
  name: 'submit-task',
  description: 'Submit a task for asynchronous execution. Returns a job id to poll with job-status.',
  inputSchema: z.object({
    goal: z.string(),
    inputs: z.record(z.any()).optional(),
    callbackUrl: z.string().url().optional(),
  }),
  annotations: { readOnlyHint: false },
  reversible: true, tags: ['jobs'],
  run: async ({ args, jobs }) => jobs.submit(args, { callbackUrl: args.callbackUrl }),
}
{
  name: 'job-status',
  description: 'Return the current record for a job, including result when finished.',
  inputSchema: z.object({ jobId: z.string() }),
  annotations: { readOnlyHint: true },
  reversible: true, tags: ['jobs'],
  run: async ({ args, jobs }) => (await jobs.get(args.jobId)) ?? { ok: false, error: 'not_found' },
}
```

Both are only registered when `dispatch.enabled` is true. The executor passes
the jobs backend in `executorArgs.jobs`. These tools do **not** take a worker
lease: the MCP server skips dispatch for tools tagged `jobs`, since they touch
no Fleet member. Guardrails still apply.

---

## Configuration

```js
// host.config.mjs additions
comm: {
  adapter: 'express',            // 'express' | 'raw-http' | 'azure-functions'
  port: 3000,
  host: '127.0.0.1',
},

modules: {
  dispatch: {
    enabled: true,
    backend: 'in-process',       // 'in-process' | 'durable'
    maxQueueSize: 100,
    concurrency: 1,
    leaseTimeoutMs: 660_000,     // default: budgets.timeoutMs + 60s
    retentionMs: 86_400_000,
    drainMs: 30_000,
    store: {                     // in-process only
      kind: 'sqlite',            // 'sqlite' | 'memory'
      dbPath: './workdir/jobs.db',
    },
    durable: {                   // durable only
      taskHub: 'fleetjobs',
      pollMs: 2000,
      maxActivityMs: 3_600_000,
    },
  },
  notify: {
    sse:     { enabled: true, heartbeatMs: 25_000 },
    webhook: { enabled: true, sendProgress: false, allowHttp: false, retries: 3 },
  },
}
```

Environment overrides for Docker and Azure app settings:

| Env var | Maps to |
|---|---|
| `JOBS_BACKEND` | `dispatch.backend` |
| `JOBS_MAX_QUEUE_SIZE` | `dispatch.maxQueueSize` |
| `JOBS_CONCURRENCY` | `dispatch.concurrency` |
| `JOBS_DB_PATH` | `dispatch.store.dbPath` |
| `JOBS_RETENTION_MS` | `dispatch.retentionMs` |
| `DURABLE_TASK_HUB` | `dispatch.durable.taskHub` |
| `WEBHOOK_ALLOW_HTTP` | `notify.webhook.allowHttp` |

### Validation rules (`host/config.mjs`)

| Condition | Result |
|---|---|
| `dispatch.enabled` and not `runLoop.enabled` | **error**: nothing to run |
| `dispatch.backend: 'durable'` with `comm.adapter` ≠ `azure-functions` | **error** |
| `comm.adapter: 'azure-functions'` with `dispatch.backend: 'in-process'` | **warning**: jobs are lost when the instance recycles |
| `dispatch.concurrency` > worker dispatcher capacity | clamp with **warning** |
| `budgets.timeoutMs` > `durable.maxActivityMs` | **warning** |
| `notify.webhook.allowHttp: true` | **warning** at startup |
| `dispatch.store.kind: 'memory'` outside tests | **warning**: jobs lost on restart |

`SUPPORTED_ADAPTERS` becomes `express`, `raw-http`, `azure-functions`.
`IMPLEMENTED_MODULES` gains `dispatch` and `notify`.

---

## Host integration

### Startup order

```
Config loaded and validated
  → Tools registry loaded (+ submit-task / job-status when dispatch enabled)
  → Fleet transport ready (lazy on Azure)
  → Worker dispatcher created
  → Guardrails, budgets config, run loop config (Phase 2)
  → Notifier created (if notify enabled)
  → Jobs backend created and started (if dispatch enabled)
      in-process: open store, re-enqueue queued, mark processing → interrupted, start worker loops
      durable:    create Durable client
  → Route table built
  → Comm adapter starts
```

### Shutdown order

```
SIGINT / SIGTERM
  → dispatcher.beginShutdown()          (no new leases)
  → adapter.stop()                      (no new requests; in-flight sync requests finish)
  → jobs.stop({ drainMs })              (drain processing jobs, abort the rest)
  → notifier.stop()                     (close SSE streams with a final comment)
  → dispatcher.close(), Fleet stop
```

### The `/task` route

```
POST /task                         → 202 { jobId, status: 'queued', position, links: { self, events } }
POST /task?wait=true               → 200 { taskId, status, result, history, budget }   (Phase 2 shape)
POST /task  (queue full)           → 429 { ok: false, error: 'queue_full' }  + Retry-After: 30
POST /task  (bad callbackUrl)      → 400 { ok: false, error: 'invalid_callback_url' }
POST /task  (shutting down)        → 503 { ok: false, error: 'shutting_down' }
POST /task  (dispatch disabled)    → behaves as ?wait=true (Phase 2 behaviour preserved)

GET    /jobs/:id                   → 200 JobRecord | 404
DELETE /jobs/:id                   → 202 { ok: true, status: 'cancelling' } | 200 { ok: true, status: 'cancelled' } | 404 | 409 (terminal)
GET    /jobs/:id/events            → 200 text/event-stream | 404
```

### Builder API

```js
const agent = createHost({ fleetApi, dispatcher })
  .tools([...])
  .runLoop({ strategy: 'plan-execute' })
  .budget({ maxIterations: 25 })
  .dispatch({ backend: 'in-process', store: { kind: 'memory' } })   // new
  .notify({ webhook: { allowHttp: true } })                          // new
  .build();

const { host, jobs, close } = await agent.start();
const { jobId } = await jobs.submit({ goal: '...' });
const record = await jobs.get(jobId);
```

`agent.start()` now returns `jobs` (the backend, or `null` when dispatch is
disabled). `agent.run(task)` is unchanged and synchronous.

---

## File tree

```
host/
  index.mjs                  ← CHANGED — route table, jobs + notifier wiring, .dispatch()/.notify() on builder, FLEET_MOCK_SCRIPT switch (NODE_ENV=test only)
  tasks.mjs                  ← NEW — executeHostedTask extracted, gains onEvent
  run-loop.mjs               ← CHANGED — optional onIteration hook
  config.mjs                 ← CHANGED — dispatch/notify validation, new adapters, env overrides
  tools/registry.mjs         ← CHANGED — submit-task, job-status entries
  jobs/
    interface.mjs            ← NEW — contract + JobQueueFullError, JobsClosedError
    index.mjs                ← NEW — createJobsBackend factory
    record.mjs               ← NEW — record shape, transitions, event constructors, ring()
    in-process.mjs           ← NEW — FIFO queue, worker loops, lease timeout, restart, drain
    durable.mjs              ← NEW — Durable client mapping, poll-based subscribe
    store/
      interface.mjs          ← NEW
      sqlite.mjs             ← NEW — node:sqlite
      memory.mjs             ← NEW
  notify/
    index.mjs                ← NEW — createNotifier fan-out
    sse.mjs                  ← NEW
    webhook.mjs              ← NEW
comm/
  interface.mjs              ← CHANGED — neutral contract
  express.mjs                ← CHANGED — migrated
  raw-http.mjs               ← NEW
  azure-functions/
    index.mjs                ← NEW — function registrations
    http.mjs                 ← NEW — HTTP trigger adapter + raw shim
    orchestrator.mjs         ← NEW
    activity.mjs             ← NEW — runTaskActivity, signalCancelActivity
    host.json                ← NEW
    local.settings.json.example ← NEW
mcp/
  server.mjs                 ← CHANGED — skip lease for tools tagged 'jobs'; pass jobs in executorArgs
deploy/
  azure-functions/
    Dockerfile               ← NEW — Functions base image + Node 22 + apra-fleet + Claude CLI
    README.md                ← NEW — points to docs/deploy-azure-functions.md
docker-compose.e2e.yml       ← NEW — profiles vm / durable, azurite, e2e runner
tests/
  helpers/sse.mjs            ← NEW — readSse(response) async iterator
  helpers/scripted-fleet.mjs ← NEW — builds mock-fleet from a goal-keyed script file
  acceptance/
    tool-server.acceptance.test.mjs   ← MOVED from tests/host.live.test.mjs
    sync-task.acceptance.test.mjs     ← MOVED from tests/host-phase2.live.test.mjs
    async-job.acceptance.test.mjs     ← NEW
  e2e/
    task.e2e.test.mjs        ← NEW — black-box /task + /jobs suite, BASE_URL + E2E_MODE
    webhook-receiver.mjs     ← NEW — tiny HTTP receiver used by the webhook case
    scripted-llm.json        ← NEW — LLM + tool responses for scripted mode
    scenarios/
      s01-tokyo-weather.json
      s02-nyc-time-weather.json
      s05-us-japan-currency.json
      s10-europe-capitals.json
.github/workflows/
  ci-e2e.yml                 ← NEW — e2e-scripted (required) + e2e-live (secret-gated) × [vm, durable]
  ci-host.yml                ← CHANGED — adds test:phase4; live step runs test:acceptance
docs/
  jobs.md                    ← NEW — async task API reference
  deploy-azure-functions.md  ← NEW
  architecture.md            ← CHANGED
  mcp-interface.md           ← CHANGED — two new tools
README.md                    ← CHANGED
package.json                 ← CHANGED — scripts; optionalDependencies: @azure/functions, durable-functions
```

`@azure/functions` and `durable-functions` are `optionalDependencies` and are
imported lazily only when the Azure adapter or Durable backend is configured.
Non-Azure installs never load them.

---

## Testing strategy

### Unit tests (no Fleet, no token)

| Area | Test file | Covers |
|---|---|---|
| Store contract | `tests/host-jobs-store.test.mjs` | Same suite run against `memory` and `sqlite` (temp file): put/get, status index, events append + replay after seq, purge by age |
| Record | `tests/host-jobs-record.test.mjs` | Legal/illegal transitions, event constructors, ring truncation keeps queued/started/settled |
| In-process backend | `tests/host-jobs-in-process.test.mjs` | FIFO order, `429` at cap, `submit` after stop, cancel queued vs processing, restart re-enqueues queued and marks processing `interrupted`, lease timeout, drain timeout, concurrency clamp, `dispatch_failed` settles not throws |
| Durable backend | `tests/host-jobs-durable.test.mjs` | Mock Durable client: status mapping table, backpressure count, cancel → raiseEvent vs terminate by state, poll-based subscribe emits deltas only, `events()` from customStatus |
| Orchestrator | `tests/comm-azure-orchestrator.test.mjs` | Drive the generator by hand: progress events update customStatus, cancel triggers signal activity, activity completion sets settled |
| Notifier | `tests/host-notify.test.mjs` | SSE handler driven directly with a fake jobs backend, no HTTP: replay after `Last-Event-ID`, live follow via `subscribe` then close on `settled`, terminal job returns stored events without subscribing, heartbeat cadence with mock timers, `404` for unknown job, request abort calls `unsubscribe`. Webhook: retries/backoff, https rule, `sendProgress` |
| Comm contract | `tests/comm-contract.test.mjs` | One suite run against express, raw-http, and azure-functions (with a fake `HttpRequest`): routing, params, query, 401 from authenticate, JSON body, raw route passthrough. Streaming: a scripted stream must arrive chunk by chunk with `Content-Type: text/event-stream`, read over a real socket with `fetch` for express/raw-http and from the returned body for azure-functions |
| Config | `tests/host-config.test.mjs` | All validation rules above, env overrides |
| Host integration | `tests/host-index.test.mjs` | 202 path end to end with memory store and mock fleet, `?wait=true` unchanged, 429, 404, 409, DELETE, MCP `submit-task`/`job-status` without a lease. SSE end to end using `tests/helpers/sse.mjs` (a `readSse(response)` async iterator that splits on blank lines, skips `:` heartbeats, and parses `id`/`event`/`data`): asserts the sequence `started`, `progress`+, `settled` with strictly increasing ids and `settled.status` equal to `GET /jobs/:id`; disconnect after first `progress` and reconnect with `Last-Event-ID` yields no gap or duplicate; `DELETE` mid-stream ends with `settled: cancelled` |
| Run loop | `tests/host-run-loop.test.mjs` | `onIteration` fires once per yield |

### Acceptance suite (replaces phase-numbered live tests)

Live tests are named by the product capability they protect, not by the phase
that added them, so the suite as a whole answers "does the agent still work
after this change". Phase 4 introduces `tests/acceptance/` and moves the two
existing live files into it:

| File | Capability | Origin |
|---|---|---|
| `tests/acceptance/tool-server.acceptance.test.mjs` | MCP `tools/list` shows the registry; `tools/call weather` returns data | today's `tests/host.live.test.mjs` |
| `tests/acceptance/sync-task.acceptance.test.mjs` | `POST /task?wait=true` completes open-ended and plan-execute tasks | today's `tests/host-phase2.live.test.mjs` |
| `tests/acceptance/async-job.acceptance.test.mjs` | submit → `202`; SSE to `settled`; `GET /jobs/:id` matches; cancel mid-run settles `cancelled`; host restart with the SQLite store keeps the record readable | new |

All three start the host in-process via `startHost` against real Fleet and
require Docker or a local Fleet install plus `CLAUDE_CODE_OAUTH_TOKEN`.
`npm run test:acceptance` runs the directory. `ci-host.yml` runs it in its
Docker step in place of the two individual live files, so every PR runs the
whole product check, not just the newest phase's.

The acceptance suite and the end-to-end suite (below) answer different
questions and both stay: acceptance asks whether the host code works with real
Fleet; end-to-end asks whether the built containers work over HTTP on both
deployment targets.

### Azure verification

Manual, documented in `docs/deploy-azure-functions.md`: build the image, deploy
to a Premium Function App with a storage account for the task hub, run the same
submit / SSE / cancel sequence with `curl`, and confirm `getStatus` from a second
instance after scaling to two. Local dry run uses Azure Functions Core Tools
plus Azurite. Not part of CI.

### npm scripts

```
test:phase4       node --test tests/host-jobs-*.test.mjs tests/host-notify.test.mjs tests/comm-contract.test.mjs tests/comm-azure-orchestrator.test.mjs
test:acceptance   node --test tests/acceptance/                # real Fleet; replaces test:host:live and test:phase2:live
test:e2e          node --test tests/e2e/task.e2e.test.mjs      # needs BASE_URL, E2E_MODE
```

`test:host` and `test:phase2` continue to pass unchanged. `test:host:live` and
`test:phase2:live` are removed in favour of `test:acceptance`.

---

## End-to-end testing

The unit and live tests above prove each module. End-to-end testing proves the
deployed artefact: the VM container and the Azure Functions container, each
driven only over HTTP, each running the same travel-research scenarios.

### Chosen path: `/task`, not MCP

The end-to-end suite drives `POST /task` and `GET /jobs/*`. It does not drive
MCP through Claude Code. Reasons: the `/task` path reaches everything Phase 4
adds (queue, store, SSE, cancel, webhook, Durable orchestration); it is
deterministic and needs no second LLM deciding when to poll; it works
identically on both targets, whereas the MCP route on Azure depends on the raw
Node shim listed under open risks. MCP keeps its existing tests and load tests.
Driving the agent from Claude Code via `submit-task` / `job-status` is
documented in `docs/jobs.md` as a manual check, never a CI step.

### One black-box test, two targets, two modes

`tests/e2e/task.e2e.test.mjs` imports no host code. It reads `BASE_URL` and
`E2E_MODE` and talks HTTP, so one file serves both containers.

**Per scenario:** `POST /task` → assert `202` and a job id → consume
`GET /jobs/:id/events` with `tests/helpers/sse.mjs` → assert `started`,
one or more `progress`, `settled` with increasing ids → `GET /jobs/:id` →
assert the record matches the settled event and that `history`, `budget`, and
`finishedAt` are populated → assert the expected terminal status and that each
expected tool name appears in `history`.

**Pipeline cases**, run once per target:

| Case | Setup | Assertion |
|---|---|---|
| Unknown job | `GET /jobs/does-not-exist` | `404` |
| Backpressure | agent started with `JOBS_MAX_QUEUE_SIZE=1`, `JOBS_CONCURRENCY=1`; submit three tasks quickly | third returns `429` with `Retry-After` |
| Cancel | submit, wait for first `progress`, `DELETE /jobs/:id` | stream ends with `settled: cancelled`; `GET` agrees |
| Webhook | submit with `callbackUrl` pointing at a receiver inside the `e2e` container (`allowHttp` on for the test) | exactly one `settled` POST with `X-Fleet-Job-Id` |
| Restart (vm only) | submit, wait for `settled`, `docker compose restart agent-vm` | `GET /jobs/:id` still returns the record |

**Scenarios** live in `tests/e2e/scenarios/*.json`, taken from the Phase 2
travel-research list and chosen for cost:

| File | Phase 2 scenario | Strategy | Budget | Expected status | Expected tools |
|---|---|---|---|---|---|
| `s01-tokyo-weather.json` | 1 | open-ended | 10 iterations | `completed` | `weather` |
| `s02-nyc-time-weather.json` | 2 | plan-execute | 15 iterations | `completed` | `timezone`, `weather` |
| `s05-us-japan-currency.json` | 5 | plan-execute | 20 iterations | `completed` | `country-info`, `currency`, `travel-advisory` |
| `s10-europe-capitals.json` | 10 | plan-execute | 6 iterations | `budget_exceeded` | `weather` or `country-info` |

Each fixture holds `goal`, `strategy`, `budget`, `expectedStatus`,
`expectedTools`, and, for scripted mode, the LLM response script.

**Modes** (`E2E_MODE`):

- `scripted` — the agent container starts with
  `FLEET_MOCK_SCRIPT=/workspace/tests/e2e/scripted-llm.json`. A small switch in
  `host/index.mjs` (`startHost` already accepts an injected `fleetApi`; this
  makes the injection reachable from the environment) builds the existing
  `tests/helpers/mock-fleet.mjs` with a goal-keyed table of prompt responses
  (plan, tool_call, done blocks) and canned `executeCommand` JSON for each
  tool. Deterministic, free, seconds per scenario. Exercises every Phase 4
  component on both targets. **This is the CI gate.** The switch refuses to
  activate unless `NODE_ENV` is `test`, so it cannot be enabled in production
  by accident.
- `live` — real Fleet, real Claude, real Python tools. Asserts terminal status
  and tool names in history, never prose. Requires `CLAUDE_CODE_OAUTH_TOKEN`.

### Docker layout

`docker-compose.e2e.yml`, with profiles:

| Service | Profile | Image | Role |
|---|---|---|---|
| `agent-vm` | `vm` | existing `Dockerfile`, command `node host/index.mjs` | in-process backend, SQLite at `/workspace/workdir/jobs.db`, `JOBS_*` via env, `healthcheck` on `/health` |
| `azurite` | `durable` | `mcr.microsoft.com/azure-storage/azurite` | blob, queue, table for the Durable task hub |
| `agent-durable` | `durable` | `deploy/azure-functions/Dockerfile`: `FROM mcr.microsoft.com/azure-functions/node:4-node22` plus python3, `apra-fleet`, Claude CLI, repo copy | the real Functions host on port 80, no Core Tools; `AzureWebJobsStorage` is the Azurite connection string with `azurite` as hostname; `WORKER_POOL_SIZE=0`; `healthcheck` on `/health`, which returns `503` until the Durable client can reach the task hub |
| `e2e` | both | existing image | runs `npm run test:e2e` with `BASE_URL` pointing at whichever agent is up; `depends_on` with `condition: service_healthy`; hosts the webhook receiver on port 9000 |

Local use:

```
docker compose -f docker-compose.e2e.yml --profile vm      run --rm e2e
docker compose -f docker-compose.e2e.yml --profile durable run --rm e2e
E2E_MODE=live docker compose -f docker-compose.e2e.yml --profile durable run --rm e2e
```

The `agent-durable` image is the same image that deploys to the Premium plan,
so what passes here is what ships. `deploy/azure-functions/README.md` shows the
`az functionapp` commands to push it.

### CI: `.github/workflows/ci-e2e.yml`

```
e2e-scripted   matrix target: [vm, durable]      always; required check
  build images → compose --profile $target up -d → compose run e2e (E2E_MODE=scripted)
  → on failure: upload agent + azurite logs as artifact → compose down --volumes

e2e-live       matrix target: [vm, durable]      if CLAUDE_CODE_OAUTH_TOKEN secret exists
  continue-on-error: true
  same steps with E2E_MODE=live
  → parse the test's JSON summary → post/update one PR comment per run:
    "## E2E Results — vm / durable": scenario, status, iterations, tokens, cost, wall time
```

`ci-host.yml` gains `npm run test:phase4` in both its native and Docker steps,
and its Docker live step runs `npm run test:acceptance` instead of the two
individual live files. Nothing in CI drives `/mcp` for the agent path; `ci.yml`
continues to cover MCP and the load tests unchanged.

### To verify during planning

- The `mcr.microsoft.com/azure-functions/node:4-node22` tag is current
  (fallback: `4-node20` plus a Node 22 install layer, or pin Node 20 for the
  Functions image only).
- Functions host cold start with the Durable extension bundle fits a
  healthcheck window of about 90s in CI (fallback: pre-bake the bundle into
  the image with `func extensions install`, which needs Core Tools at build
  time only).

---

## Documentation deliverables

- `docs/jobs.md` — the async task API: routes, status codes, record shape,
  event types, SSE wire format and reconnect, webhook contract, cancellation
  semantics, retention, restart behaviour, and `curl` examples for each.
- `docs/deploy-azure-functions.md` — plan requirements, container image, app
  settings, task hub storage, `functionTimeout`, local run with Core Tools and
  Azurite, scaling notes, what is and is not supported.
- `docs/architecture.md` — new layers diagram, jobs and notify module map,
  comm contract section replacing the Express-specific text.
- `docs/mcp-interface.md` — `submit-task` and `job-status`.
- `README.md` — async quick start.

---

## Open risks

- **Durable progress via external events** adds one orchestration replay per
  iteration. At 25 iterations per task this is well within Durable's limits,
  but a task with hundreds of iterations would be better served by writing
  progress to the SQLite-equivalent store. If this becomes a problem, the fix
  is to emit `progress` events every N iterations, configurable.
- **MCP raw route on Azure** relies on a Node `IncomingMessage` shim. If the MCP
  SDK's Node transport proves too tightly bound to real sockets, the fallback is
  to serve `/mcp` on Azure only through the sync HTTP path with the SDK's
  fetch-based transport, which the SDK also ships.
- **`node:sqlite` stability** is marked stable from Node 22.13 but the API
  surface is small; the store is written against `DatabaseSync` only, and the
  `memory` store is the escape hatch if a platform build lacks it.
