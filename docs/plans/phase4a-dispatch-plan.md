# Fleet Agent Kit — Phase 4a Implementation Plan

## Core async jobs for VM/Docker

**Goal:** `POST /task` returns `202 { jobId }`. Jobs are queued, persisted in SQLite,
streamable over SSE, cancellable, and queryable via MCP tools. Sync mode stays
available via `?wait=true`. No Azure dependencies.

**Scope — Tasks from the full Phase 4 plan:**

| Task | What | Steps |
|------|------|-------|
| 0 | Branch + optional deps | 5 |
| 1 | Job record, transitions, events, error types | 7 |
| 2 | Store contract + memory store | 6 |
| 3 | SQLite store | 5 |
| 4 | Run-loop progress hook + `host/tasks.mjs` | 7 |
| 5 | In-process jobs backend | 12 |
| 6 | Notifier: SSE + webhook | 9 |
| 7 | Neutral comm contract + Express migration + raw-http | 8 |
| 8 | Config: dispatch/notify/adapters | 5 |
| 9 | Host wiring: routes, jobs, notifier, builder | 10 |
| 10 | MCP tools `submit-task` + `job-status` | 4 |
| 15 | Acceptance suite + npm scripts | 5 |
| — | **Total** | **~83** |

**Out of scope (Phase 4b):** Tasks 11–14 (Durable Functions, Azure Functions adapter,
Azure Docker images), Task 16 (CI e2e workflows), Task 17 (full documentation).

**Source plan:** `docs/superpowers/plans/2026-09-17-fleet-agent-kit-phase4.md` — each
task here references the same task number. Read the full task from the source plan;
this file is the execution order and checkpoint guidance.

---

## Execution order

The dependency graph allows parallelism, but for a single-session execution, this
serial order minimizes context switching and avoids forward references:

### Batch 1: Foundations (Tasks 0, 1)

**Task 0** — Branch + optional deps. Already done (branch exists). Verify `node:sqlite`
works and run the green baseline.

**Task 1** — Job record + transitions + events + error types. Pure data shapes in
`host/jobs/interface.mjs`. No runtime dependencies. This is the vocabulary every
other task imports.

**Checkpoint:** `node --test tests/host-jobs-interface.test.mjs` passes. Commit.

---

### Batch 2: Persistence (Tasks 2, 3)

**Task 2** — Store contract + in-memory implementation. Defines `createStore()` with
`create`, `get`, `update`, `list`, `addEvent`. Memory store is the test double for
everything else.

**Task 3** — SQLite store. Same contract, backed by `node:sqlite` `DatabaseSync`.
Schema migration on first open. Tested against the same assertions as the memory store.

**Checkpoint:** Both stores pass the shared store test suite. Commit.

---

### Batch 3: Progress + task executor (Task 4)

**Task 4** — Wire `onIteration` callback into the run loop so the jobs backend can
record progress events as the agent runs. Create `host/tasks.mjs` that wraps
`executeHostedTask` with job-record lifecycle (create → processing → completed/failed).

**Checkpoint:** `npm run test:phase2` still passes (onIteration is opt-in). New
task-executor tests pass. Commit.

---

### Batch 4: Jobs backend (Task 5)

**Task 5** — In-process jobs backend. FIFO queue, accepts a store, runs tasks through
the task executor, emits events, supports cancellation via `AbortController`. This is
the central piece — it connects the store, the task executor, and the event emitter.

**Checkpoint:** Jobs backend unit tests pass: submit → processing → completed, cancel,
budget_exceeded, concurrent queue limit. Commit.

---

### Batch 5: Notifications (Task 6)

**Task 6** — Notifier with SSE and webhook channels. Listens to job events from the
backend and fans them out. SSE streams per-job; webhook POSTs to a configured URL.

**Checkpoint:** Notifier unit tests pass. Commit.

---

### Batch 6: Comm layer (Tasks 7, 8)

**Task 7** — Framework-neutral comm contract. Migrate Express adapter to the new
contract. Add `raw-http` adapter (Node `http.createServer`, no framework dependency).

**Task 8** — Config changes: `host.config.mjs` gains `dispatch`, `notify`, and
adapter selection. Environment variable overrides.

**Checkpoint:** `npm run test:host` passes with the migrated Express adapter. Commit.

---

### Batch 7: Wire it all together (Task 9)

**Task 9** — Host wiring. `startHost()` creates the jobs backend, notifier, and comm
adapter. Mounts async `POST /task` (returns 202), `GET /jobs/:id`,
`GET /jobs/:id/events` (SSE), `DELETE /jobs/:id` (cancel), sync `POST /task?wait=true`.
Builder gains `.jobs()` and `.notify()`.

**Checkpoint:** Host integration tests pass: submit → poll → complete, submit → cancel,
submit → SSE stream, sync wait mode. Commit.

---

### Batch 8: MCP + acceptance (Tasks 10, 15)

**Task 10** — Two MCP tools: `submit-task` (calls the jobs backend, returns jobId) and
`job-status` (returns current job state). Registered in the MCP server alongside
existing tools.

**Task 15** — Acceptance test suite: `npm run test:phase4` runs the Phase 4 unit tests,
`npm run test:acceptance` runs against a real Fleet.

**Checkpoint:** All tests pass. Final commit for Phase 4a.

---

## What ships

After Phase 4a, the host supports:

```
POST /task              → 202 { jobId }           (async, default)
POST /task?wait=true    → 200 { taskId, status, result, ... }  (sync, Phase 2 compat)
GET  /jobs/:id          → { job record }
GET  /jobs/:id/events   → SSE stream
DELETE /jobs/:id        → { cancelled: true }
GET  /health            → { ok: true }
POST /mcp               → MCP tools (including submit-task, job-status)
```

Jobs persist in SQLite (survives process restart). SSE streams progress in real time.
Webhooks notify external systems. The same Docker image works as before, plus async.
