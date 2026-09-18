# Concurrency

How parallel task execution works, how to configure it, and how to test it.

## Architecture

A `POST /task` request enters the system through the job queue. How many tasks
run simultaneously depends on two things: how many **workers** are available and
what the **job concurrency** is set to.

### Workers

Every task needs a worker — a doer + reviewer member pair registered on the
Fleet server. Workers come from two tiers, managed by `WorkerDispatcher`:

```
incoming task
     │
     ▼
 ┌─ pool ──────────────────────────────────────────────────┐
 │  Fixed-size set of pre-registered pairs.                │
 │  File-lock-based: proper-lockfile with stale detection. │
 │  Zero registration cost — fastest tier.                 │
 └────────────┬──── all held? ─────────────────────────────┘
              ▼
 ┌─ ephemeral ─────────────────────────────────────────────┐
 │  On-demand pairs created by EphemeralWorkerFactory.     │
 │  Unique id per pair, auto-teardown, TTL safety net.     │
 │  Pays registration cost but still serves.               │
 └────────────┬──── at max? ───────────────────────────────┘
              ▼
 ┌─ queue ─────────────────────────────────────────────────┐
 │  FIFO wait list. Served when any tier releases.         │
 │  Times out at queueTimeoutMs.                           │
 └────────────┬──── full? ─────────────────────────────────┘
              ▼
           reject (429 queue_full or DispatchOverflowError)
```

Total worker capacity = pool size + ephemeral max. With defaults that is
4 + 10 = 14.

### Job queue

The in-process jobs backend (`host/jobs/in-process.mjs`) owns the concurrency
gate. Its `pump()` loop starts queued jobs while `running.size < concurrency`:

```js
function pump() {
  while (running.size < concurrency && queue.length > 0) {
    // shift next job, acquire a worker via the dispatcher, run it
  }
}
```

`concurrency` is clamped at startup: if it exceeds the dispatcher's total
worker capacity, the backend warns and clamps to `capacity`. Setting
`concurrency: 2` with a pool of 1 and no ephemerals gives you 1, not 2.

Each running job holds a worker lease for its entire duration. A multi-step
task (plan → tool call → observe → tool call → … → done) keeps its lease across
all iterations. Tool calls within a single task are sequential; parallelism is
across tasks.

## Configuration

### Config file

In `host.config.mjs`, the dispatch module controls concurrency:

```js
modules: {
  dispatch: {
    enabled: true,
    concurrency: 2,           // how many jobs run at once
    maxQueueSize: 10,         // FIFO queue depth before 429
    store: { kind: 'sqlite', dbPath: './jobs.db' },
  },
}
```

### Environment variables

Environment variables override config-file values. All are non-negative
integers.

| Variable | Default | Controls |
|---|---|---|
| `WORKER_POOL_SIZE` | 4 | Pre-registered pool workers |
| `WORKER_EPHEMERAL_MAX` | 10 | On-demand overflow workers |
| `WORKER_POOL_ACQUIRE_TIMEOUT_MS` | 300 000 | How long `pool.acquire()` waits |
| `WORKER_DISPATCH_QUEUE_SIZE` | 20 | Dispatcher FIFO queue depth |
| `WORKER_DISPATCH_QUEUE_TIMEOUT_MS` | 300 000 | Dispatcher queue wait before reject |
| `JOBS_CONCURRENCY` | 1 | Max simultaneously running jobs |
| `JOBS_MAX_QUEUE_SIZE` | 100 | Job-level queue depth before `JobQueueFullError` |

The code-level default for `JOBS_CONCURRENCY` is 1 (in `DISPATCH_DEFAULTS` at
`host/jobs/config.mjs`). The repo's `host.config.mjs` overrides it to 2. Set
it higher when you have the worker capacity and want more parallel tasks.

### Clamping rules

- `concurrency` is clamped to worker capacity (`pool + ephemeral`).
- Setting `WORKER_POOL_SIZE=0` and `WORKER_EPHEMERAL_MAX=0` is a startup error.
- `concurrency > capacity` logs a warning and clamps silently.

## Testing

### Test suites

| Command | What it tests | Needs Fleet? | Needs LLM? | Duration |
|---|---|---|---|---|
| `npm run test:unit` | Pool, dispatcher, roster, config | no | no | ~1s |
| `npm run test:phase4` | Job queue, store, notifications | no | no | ~2s |
| `npm run test:host` | Host routes, executor, index | no | no | ~1s |
| `npm run test:concurrency` | Real concurrent task execution | yes | yes | ~3–6 min |

The first three use mock Fleet APIs and run everywhere. The concurrency
acceptance test (`tests/acceptance/concurrency.acceptance.test.mjs`) uses a
real Fleet server, real LLM (Claude Sonnet), and real tool calls.

### Concurrency acceptance tests

Three tests. The two `concurrency:2` tests share one host instance to avoid
redundant Fleet startups; the serialization test gets its own.

| Test | What it proves |
|---|---|
| `concurrency:2 — two multi-step tasks run simultaneously` | Both tasks reach `processing` at the same time; each chains 3+ tool calls (weather, timezone, travel-advisory or currency) |
| `concurrency:2 — SSE streams show progress with overlap` | Both SSE streams deliver full lifecycle; timeline overlap measured from timestamps |
| `concurrency:1 — second task waits while first is processing` | One processing, one queued — confirms serialization. Uses light 1-tool goals for speed |

Heavy goals (3 tool calls) are used where multi-step is the point. Light goals
(1 tool call) are used where only scheduling behaviour matters.

### Running locally

```bash
npm run test:concurrency
```

### Running in Docker

```bash
docker build -t apra-agent-kit-ci .
docker run --rm \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  apra-agent-kit-ci \
  node --test tests/acceptance/concurrency.acceptance.test.mjs
```

`CLAUDE_CODE_OAUTH_TOKEN` is required for LLM calls. Without it, prompts fail.

### Why these tests are slow

Each LLM round-trip (prompt → reason → tool_call → execute → observe) takes
6–12 seconds against Claude Sonnet. A multi-step task with 3 tool calls takes
~30–50 seconds. The shared host and light goals keep the suite to ~2–4 minutes,
down from ~6 minutes in earlier versions.

## CI

Two GitHub Actions workflows gate merges to `main`.

### `ci.yml` — pool and integration

1. **unit-tests** — runs `npm run test:unit` on bare Node (no Docker, no Fleet).
2. **integration-tests** (needs unit-tests) — builds the Docker image, runs the
   full mock test suite, then runs load tests at two concurrency levels.
   Load test output is in the CI job logs.

### `ci-host.yml` — host and acceptance

1. **host-unit-tests** — runs `npm run test:host` on bare Node.
2. **host-integration-tests** (needs host-unit-tests) — builds Docker, runs
   host unit tests in-container, then the live tool-server acceptance test and
   the concurrency acceptance tests. The concurrency step passes
   `CLAUDE_CODE_OAUTH_TOKEN` from repo secrets.

### Branch protection

`main` is protected:

- Pull request required — no direct pushes.
- CI status checks must pass: `unit-tests`, `integration-tests`,
  `host-unit-tests`, `host-integration-tests`.
- Branch must be up to date before merging.
- At least 1 approving review required.
- Force pushes and branch deletion blocked.

### Fork PRs

CI runs on fork PRs with the same checks. `GITHUB_TOKEN` on fork PRs is
read-only, so load test results appear only in the CI job logs (no PR
comment is posted). This is by design — see the `ci.yml` history for
context.

## Chat UI and concurrency

The `/chat` page (see [chat-ui.md](chat-ui.md)) submits tasks through the
same `POST /task` → job queue → SSE pipeline that the API uses. The backend
processes concurrent jobs normally, but the chat UI enforces **one task per
tab**: the composer disables while a job is running, and the page tracks a
single `current` turn.

To run tasks concurrently from the UI, open multiple browser tabs — each tab
holds its own job. Alternatively, call `POST /task` directly (curl, Postman,
or another client) to bypass the single-tab limit.

| Client | Concurrent tasks? |
|---|---|
| `POST /task` (API) | Yes — limited by `dispatch.concurrency` |
| `/chat` (single tab) | No — one at a time per tab |
| `/chat` (multiple tabs) | Yes — each tab is an independent job |
| MCP client | Yes — each `callTool` dispatches independently |

The chat UI's single-tab limit is a frontend design choice, not a backend
constraint. See the "Not included" section of [chat-ui.md](chat-ui.md).
