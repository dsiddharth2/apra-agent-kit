# Jobs API

Async task submission, polling, streaming, and webhooks for the autonomous agent host.

## Overview

`POST /task` accepts a goal and returns immediately with `202 { jobId }`. You can get the result three ways: poll `GET /jobs/:id`, stream `GET /jobs/:id/events` (SSE), or register a webhook `callbackUrl` on submit. Add `?wait=true` to block until the run loop finishes and receive a synchronous `200 { taskId, status, result, history, budget }`. Two backends implement the same contract: **`in-process`** (SQLite store, one Node process — VM and Docker) and **`durable`** (Azure Durable Functions task hub — Premium or Dedicated custom Linux container). Use in-process for single-container deployments; use durable when you need horizontal scale on Azure Functions.

## Routes

| Method | Path | Response |
|---|---|---|
| POST | `/task` | `202 { jobId, status: 'queued', position, links: { self, events } }` · `429` + `Retry-After: 30` when the queue is full · `400 invalid_callback_url` · `503 shutting_down` |
| POST | `/task?wait=true` | `200 { taskId, status, result, history, budget }` |
| GET | `/jobs/:id` | `200 JobRecord` · `404` |
| DELETE | `/jobs/:id` | `202 { ok: true, status: 'cancelling' }` · `200 { ok: true, status: 'cancelled' }` · `404` · `409 already_terminal` |
| GET | `/jobs/:id/events` | `200 text/event-stream` · `404` |

```bash
curl.exe -sX POST localhost:3000/task -H "content-type: application/json" -d "{\"goal\":\"What is the weather in Tokyo?\"}"
curl.exe -s localhost:3000/jobs/job-abc123
curl.exe -N localhost:3000/jobs/job-abc123/events
curl.exe -sX DELETE localhost:3000/jobs/job-abc123
curl.exe -sX POST "localhost:3000/task?wait=true" -H "content-type: application/json" -d "{\"goal\":\"...\"}"
```

Note that PowerShell's `curl` alias is `Invoke-WebRequest`; use `curl.exe`.

## Job record

Every backend stores the same shape:

```js
{
  id: 'job-a1b2c3',           // unique job id
  status: 'queued' | ...,     // see transitions below
  task: { goal, inputs, constraints, budget },  // as submitted, after stricter-wins merge
  submittedAt: '...',         // ISO timestamp when queued
  startedAt: null,            // set when processing begins
  finishedAt: null,           // set on any terminal status
  attempts: 1,                // retry count (reserved)
  result: null,               // run loop result on completion
  history: [],                // run loop observations, filled at settle
  budget: null,               // final BudgetSnapshot when budgets enabled
  progress: { iteration, message, at },  // latest progress snapshot
  callbackUrl: null,          // webhook URL if provided at submit
  metadata: {},               // caller pass-through
  error: null,                // { code, message } when failed
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

### Error codes

| `error.code` | Meaning |
|---|---|
| `dispatch_failed` | No worker lease could be obtained (dispatcher overflow or closed). |
| `interrupted` | Process restarted while the job was `processing`. |
| `lease_expired` | Job exceeded `leaseTimeoutMs` and was aborted. |
| `run_failed` | Run loop returned `failed` (reason in `message`, e.g. `no_action`). |
| `activity_failed` | Durable only: the activity threw or the host recycled it. |

## Events and SSE

Lifecycle events: `queued`, `started`, `settled`. Progress events carry a rich `kind` field (see table below).

Wire format — each SSE message:

```
id: 3
event: progress
data: {"type":"progress","jobId":"job-a1b2c3","at":"...","iteration":3,"kind":"step_started",...}
```

- `id:` is the monotonic `seq` per job.
- `event:` matches `data.type` (`queued`, `started`, `progress`, `settled`).
- `data:` is the full event object as JSON.

Reconnect with the `Last-Event-ID` header (or query param on some proxies). The server replays stored events after that seq with no gaps or duplicates, then follows live. While idle, the server emits `: ping` every 25 s to keep the connection alive.

### Progress event `kind` values

| `kind` | Fields | Meaning |
|---|---|---|
| `plan` | `plan.steps[]: { index, type, tool?, description, status:'pending' }` | Plan created |
| `replan` | same as `plan` | Plan revised after a rejection or failure |
| `step_started` | `stepIndex`, `step: { type, tool?, args? }` | A step is about to run |
| `step_completed` | `stepIndex`, `step`, `result: { ok: true, result }` | A step finished |
| `step_failed` | `stepIndex`, `step`, `error`, `willRetry` | A step failed |
| `review` | `reviewType: 'plan' \| 'step'`, `approved`, `feedback`, `step?` | Reviewer verdict |

Every progress event also carries `iteration` and a human-readable `message`.

Browser example — switch on `data.kind`:

```js
const es = new EventSource('/jobs/job-abc123/events');
es.addEventListener('progress', (e) => {
  const data = JSON.parse(e.data);
  switch (data.kind) {
    case 'plan':
    case 'replan':
      renderPlan(data.plan.steps);
      break;
    case 'step_started':
      highlightStep(data.stepIndex);
      break;
    case 'step_completed':
      markDone(data.stepIndex, data.result);
      break;
    case 'step_failed':
      markFailed(data.stepIndex, data.error);
      break;
    case 'review':
      showReview(data.reviewType, data.approved, data.feedback);
      break;
  }
});
es.addEventListener('settled', (e) => {
  const data = JSON.parse(e.data);
  es.close();
  showResult(data.status, data.result);
});
```

For Node, use `tests/helpers/sse.mjs` (`readSse(response)` async iterator).

## Webhook

When you submit with a `callbackUrl`, the notifier POSTs the event object as JSON.

Headers: `X-Fleet-Job-Id`, `X-Fleet-Event-Seq`.

- `settled` is always delivered.
- `progress` is delivered only when `notify.webhook.sendProgress` is true.

Failed deliveries retry 3 times with exponential backoff starting at 1 s. A webhook failure does not change the job record.

`callbackUrl` must use `https:` unless `notify.webhook.allowHttp` is true or `WEBHOOK_ALLOW_HTTP=true` (development only).

## Cancellation

- **`queued`** — removed from the queue immediately; settles as `cancelled`.
- **`processing`** — an abort signal is sent; the run loop yields cooperatively and settles as `cancelled`.
- On Azure, cancel latency is bounded by `dispatch.durable.pollMs` (default 2 s) because the activity polls the orchestrator's `customStatus.cancelRequested`.

`DELETE` on a terminal job returns `409 already_terminal`.

## Backpressure, retention, restart

- **`maxQueueSize`** — when the queue is full, `POST /task` returns `429` with `Retry-After: 30`.
- **`retentionMs`** (default 24 h) — terminal records are purged; unknown ids return `404`.
- **Restart** — `queued` jobs resume; `processing` jobs settle as `failed` with `error.code = 'interrupted'`.
- **SQLite** — exactly one Node process per database file. Two processes sharing a volume would not corrupt the file but could double-run jobs; use the durable backend for multi-instance scale-out.

## Configuration

From `host.config.mjs`:

```js
dispatch: {
  enabled: true,
  store: { kind: 'sqlite', dbPath: './jobs.db' },
  concurrency: 2,
  maxQueueSize: 10,
},
notify: {
  sse: { enabled: true },
},
```

| Variable | Default | Purpose |
|---|---|---|
| `JOBS_BACKEND` | `in-process` | `in-process` or `durable` |
| `JOBS_MAX_QUEUE_SIZE` | `100` | Max queued jobs before `429` |
| `JOBS_CONCURRENCY` | `1` | Worker loops (in-process only) |
| `JOBS_DB_PATH` | `./workdir/jobs.db` | SQLite file path |
| `JOBS_RETENTION_MS` | `86400000` | How long to keep terminal records |
| `DURABLE_TASK_HUB` | `fleetjobs` | Durable Functions task hub name |
| `DURABLE_POLL_MS` | `2000` | Cancel/SSE poll interval on Azure |
| `WEBHOOK_ALLOW_HTTP` | (unset) | Set `true` to allow `http:` callback URLs (dev only) |

## MCP tools

When `dispatch.enabled` is true, two MCP tools are registered. Neither takes a worker lease.

**`submit-task`** — arguments: `goal` (required), `inputs?`, `callbackUrl?`. Returns `{ jobId, status, position }`.

**`job-status`** — argument: `jobId`. Returns the full job record, or `{ ok: false, error: 'not_found' }`.

Claude Code walkthrough:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Ask Claude: *"Submit a task to inspect members, then poll until it completes."* Claude calls `submit-task`, then `job-status` until `status` is terminal.

## Testing

| Command | What it runs |
|---|---|
| `npm run test:phase4` | Unit tests: jobs backends, notifier, comm adapters, scripted fleet |
| `npm run test:acceptance` | Real Fleet + LLM, in-process host (spends tokens) |
| `npm run test:e2e` | Black-box `/task` suite over HTTP; set `BASE_URL` and `E2E_MODE` |
| `npm run e2e:vm` | Docker compose `vm` profile + e2e runner |
| `npm run e2e:durable` | Docker compose `durable` profile (Azurite + Functions image) + e2e runner |

**Scripted vs live:** `E2E_MODE=scripted` (default) uses `FLEET_MOCK_SCRIPT` with deterministic LLM responses — no tokens. `E2E_MODE=live` runs real Fleet and spends tokens. The mock script is honoured only when `NODE_ENV=test`; an empty `FLEET_MOCK_SCRIPT` disables it for live runs.
