# Fleet Agent Kit — Phase 4b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The same agent that runs today as a Docker container on a VM runs unchanged as an Azure Function App (Premium plan) with jobs persisted by Durable Functions, and both deployment targets are proven by one black-box e2e suite that runs in CI.

**Architecture:** Phase 4a shipped the jobs backend contract, the in-process backend, the notifier, the neutral comm contract, and the `/task` + `/jobs` routes. Phase 4b adds a second jobs backend (`host/jobs/durable.mjs`) and a third comm adapter (`comm/azure-functions/`), so the seams 4a defined get their second implementation. A scripted Fleet switch (`FLEET_MOCK_SCRIPT`, `NODE_ENV=test` only) makes the e2e suite deterministic and free; the same suite also runs live against real Fleet when a token is present.

**Tech Stack:** Node 22 (`node:test`, `node:sqlite`), `@azure/functions` v4, `durable-functions` v3 (both already `optionalDependencies`), Azurite, Docker Compose profiles, GitHub Actions.

**Spec:** `docs/specs/2026-09-17-fleet-agent-kit-phase4-spec.md` — sections "Durable backend", "Neutral comm contract → azure-functions", "End-to-end testing", "CI", "Documentation deliverables".

**Source plan:** `docs/superpowers/plans/2026-09-17-fleet-agent-kit-phase4.md` Tasks 11–14, 16, 17. This file supersedes those tasks: it is written against the code as it exists on `feature/fleet-agent-kit-phase4` after PR #31, and every code block here is current. Do not copy from the source plan.

## Global Constraints

- Node `>=22.16` (`package.json` engines). No new runtime dependencies; `@azure/functions` and `durable-functions` stay `optionalDependencies` and are imported lazily.
- Project name is `apra-agent-kit` everywhere (repo, package, Docker image tags `apra-agent-kit-*`). Never write `workflow-kit`.
- Docs never use the words "Phase 1/2/3/4" in user-facing prose. Test script names `test:phase2` / `test:phase4` are existing identifiers and stay.
- The run-loop reference doc is `docs/run-loop.md` (not `phase2-run-loop.md`).
- Commits: no AI attribution lines. Every "Commit" step means: stage the listed files, show `git status`, and commit **only after the user approves**.
- `tests/package-scripts.test.mjs` fails if any `test:*` / `e2e:*` script references a missing `tests/...` or `docker-compose.*` path. Add scripts only in the task that creates the files.
- Azure Functions: Premium or Dedicated plan with a custom Linux container only. No Consumption plan.

---

## What Phase 4a already ships (read before starting)

Exact names later tasks consume. All exist on this branch; verify with `npm run test:phase4 && npm run test:host` (both green).

| Export | File | Signature |
|---|---|---|
| `JobQueueFullError`, `JobsClosedError`, `InvalidCallbackUrlError`, `validateCallbackUrl(url, { allowHttp })`, `assertJobsBackend(obj)` | `host/jobs/interface.mjs` | contract: `start() stop({drainMs}) submit(task,{callbackUrl,metadata}) get(id) cancel(id) subscribe(id,fn) events(id,{afterSeq}) stats()` |
| `createRecord(task, { id, callbackUrl, metadata, now })`, `TERMINAL_STATUSES`, `queuedEvent(jobId, position, now)`, `startedEvent`, `progressEvent(jobId, iteration, detail, now)`, `settledEvent(jobId, {status,result,error}, now)`, `ringEvents(events, max=50)`, `settleFromRunResult(run)` | `host/jobs/record.mjs` | `progressEvent` accepts a string `message` **or** a rich object `{ message, kind, stepIndex, ... }` and spreads it |
| `createJobsBackend(dispatchConfig, { runJob, notifier, logger, capacity, allowHttpCallbacks, durableClient })` | `host/jobs/index.mjs` | already lazy-imports `./durable.mjs` when `dispatchConfig.backend === 'durable'` and passes `{ client: durableClient, config, notifier, logger, allowHttpCallbacks }` |
| `resolveDispatchConfig(raw, { env, budgetsConfig })`, `DISPATCH_DEFAULTS` (`durable: { taskHub:'fleetjobs', pollMs:2000, maxActivityMs:3_600_000 }`) | `host/jobs/config.mjs` | env: `JOBS_BACKEND JOBS_MAX_QUEUE_SIZE JOBS_CONCURRENCY JOBS_RETENTION_MS JOBS_DB_PATH DURABLE_TASK_HUB` |
| `executeHostedTask(task, { api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, jobs, signal, onProgress })` | `host/tasks.mjs` | `onProgress` receives the **rich** progress object: `{ iteration, message, kind, stepIndex?, step?, plan?, result?, error?, approved?, ... }` with `kind ∈ plan replan step_started step_completed step_failed review` |
| `createNotifier(config, { jobs, logger, fetchImpl }) → { config, sseHandler, publish(event, { callbackUrl }), stop() }` | `host/notify/index.mjs` | webhook posts `settled` (and `progress` if `sendProgress`) with headers `x-fleet-job-id`, `x-fleet-event-seq` |
| `buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled })` | `host/routes.mjs` | route names `health mcp task jobGet jobCancel jobEvents` |
| `matchRoute`, `compileRoute`, `parseQuery`, `lowerHeaders(headers)`, `buildRequest`, `runHandler(route, request, authenticate)`, `writeNodeResponse`, `requestSignal` | `comm/router.mjs` | |
| `startHost({ fleetApi, dispatcher, port, bindHost, adapter, createAdapter, env, registry, configDir, authenticate, runLoop, budgets, guardrails, dispatch, notify, durableClient })` → `{ host, jobs, notifier, callTool, close, stop, config, registry }` | `host/index.mjs` | `SUPPORTED_ADAPTERS['azure-functions']` already lazy-imports `../comm/azure-functions/http.mjs` and calls `createAzureFunctionsAdapter()`; `adapter.start({ routes, port, host, authenticate, mcpServerFactory })` |
| `loadConfig(dir, env)` | `host/config.mjs` | already errors on `durable` without `azure-functions`, warns on `in-process` on Functions, warns when `budgets.timeoutMs > durable.maxActivityMs` |
| `createMockFleetApi({ members, commandPayload, promptResponses })`, `rosterNames(n)` | `tests/helpers/mock-fleet.mjs` | `commandPayload` may be a function of `options`; `promptResponses` may be a function of `options` |
| `readSse(response)` | `tests/helpers/sse.mjs` | async iterator of `{ id, event, data }`, skips `:` heartbeats |
| `runCommContract(name, createAdapter)` | `tests/helpers/comm-contract.mjs` | socket-based (uses `adapter.port()`); the Azure adapter has no port, so it gets its own in-process suite (Task 3) |
| `WebStandardStreamableHTTPServerTransport` | `@modelcontextprotocol/server` | verified present: `node -e "import('@modelcontextprotocol/server').then(m=>console.log('WebStandardStreamableHTTPServerTransport' in m))"` → `true` |

Known gaps this plan closes:
- `.github/workflows/ci-host.yml` still runs `tests/host.live.test.mjs`, which 4a moved to `tests/acceptance/tool-server.acceptance.test.mjs`. CI Host is red until Task 8.
- `docs/development.md` and `docs/run-loop.md` still list `npm run test:phase2:live`, which no longer exists. Fixed in Task 9.
- `startHost` does not return `fleetApi`, `dispatcher`, `guardrailsMod`, `runLoopConfig`, `budgetsConfig`; the Functions activity needs them. Added in Task 4.

---

## File structure

```
host/
  jobs/durable.mjs                    NEW  Task 1  jobs backend over a Durable client
  jobs/config.mjs                     MOD  Task 4  DURABLE_POLL_MS env override
  index.mjs                           MOD  Task 4  return fleetApi/dispatcher/guardrailsMod/runLoopConfig/budgetsConfig
                                      MOD  Task 5  FLEET_MOCK_SCRIPT switch (NODE_ENV=test only)
comm/azure-functions/
  orchestrator.mjs                    NEW  Task 2  deterministic orchestrator, customStatus contract
  http.mjs                            NEW  Task 3  HttpRequest ↔ neutral request/response; adapter
  activity.mjs                        NEW  Task 4  runTaskActivity = executeHostedTask inside Durable
  index.mjs                           NEW  Task 4  registerDurableFunctions
  main.mjs                            NEW  Task 4  Functions host entry
  host.json                           NEW  Task 4
  local.settings.json.example         NEW  Task 4
tests/
  host-jobs-durable.test.mjs          NEW  Task 1
  comm-azure-orchestrator.test.mjs    NEW  Task 2
  comm-azure-http.test.mjs            NEW  Task 3
  comm-azure-activity.test.mjs        NEW  Task 4
  helpers/scripted-fleet.mjs          NEW  Task 5
  host-scripted-fleet.test.mjs        NEW  Task 5
  e2e/scripted-llm.json               NEW  Task 6
  e2e/scenarios/s01..s10.json         NEW  Task 6
  e2e/webhook-receiver.mjs            NEW  Task 6
  e2e/task.e2e.test.mjs               NEW  Task 6
deploy/azure-functions/
  Dockerfile                          NEW  Task 7
  wwwroot-package.json                NEW  Task 7
  host.config.mjs                     NEW  Task 7  adapter azure-functions, backend durable
  README.md                           NEW  Task 7
docker-compose.e2e.yml                NEW  Task 7
.github/workflows/ci-host.yml         MOD  Task 8
.github/workflows/ci-e2e.yml          NEW  Task 8
docs/jobs.md                          NEW  Task 9
docs/deploy-azure-functions.md        NEW  Task 9
docs/architecture.md, docs/mcp-interface.md, docs/development.md, docs/run-loop.md, docs/README.md, README.md   MOD Task 9
package.json                          MOD  Tasks 1,2,3,4,5,6 (scripts only)
```

---

### Task 1: Durable Functions jobs backend

**Files:**
- Create: `host/jobs/durable.mjs`
- Modify: `package.json` (`test:phase4` script)
- Test: `tests/host-jobs-durable.test.mjs`

**Interfaces:**
- Consumes: `JobQueueFullError`, `JobsClosedError`, `validateCallbackUrl` from `host/jobs/interface.mjs`; `TERMINAL_STATUSES`, `createRecord`, `queuedEvent` from `host/jobs/record.mjs`. A Durable client with `startNew(name, { instanceId, input })`, `getStatus(id, { showHistory, showInput })`, `raiseEvent(id, name, data)`, `terminate(id, reason)`, `getStatusBy({ runtimeStatus })`.
- Produces: `createDurableJobs({ client, config, notifier, logger, allowHttpCallbacks, now }) → JobsBackend & { refreshStats() }`, `mapDurableStatus(instance) → JobRecord | null`, `ORCHESTRATOR_NAME = 'runTaskOrchestrator'`, `ACTIVITY_NAME = 'runTaskActivity'`. Reads the `customStatus` contract Task 2 writes: `{ status, events: [{ seq, ...JobEvent }], progress: { iteration, message, at }, cancelRequested, startedAt, finishedAt }`. Orchestration `input` shape it writes: `{ task: { id, ...record.task }, record, callbackUrl, metadata, queuedEvent }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-jobs-durable.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createDurableJobs, mapDurableStatus, ORCHESTRATOR_NAME } = await import('../host/jobs/durable.mjs');
const { JobQueueFullError } = await import('../host/jobs/interface.mjs');

function fakeClient({ instances = {} } = {}) {
  const calls = { startNew: [], raiseEvent: [], terminate: [] };
  return {
    calls, instances,
    async startNew(name, { instanceId, input }) {
      calls.startNew.push({ name, instanceId, input });
      instances[instanceId] = { instanceId, runtimeStatus: 'Pending', input, customStatus: null, output: null, createdTime: '2026-09-17T10:00:00.000Z', lastUpdatedTime: '2026-09-17T10:00:00.000Z' };
      return instanceId;
    },
    async getStatus(id) { return instances[id] ?? null; },
    async raiseEvent(id, name, data) { calls.raiseEvent.push({ id, name, data }); },
    async terminate(id, reason) { calls.terminate.push({ id, reason }); instances[id].runtimeStatus = 'Terminated'; },
    async getStatusBy({ runtimeStatus }) { return Object.values(instances).filter(i => runtimeStatus.includes(i.runtimeStatus)); },
  };
}
const cfg = { maxQueueSize: 2, durable: { taskHub: 'hub', pollMs: 5, maxActivityMs: 1000 }, retentionMs: 1 };
const quiet = { warn() {}, info() {} };

test('submit starts an orchestration with the job id and task input', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  await jobs.start();
  const out = await jobs.submit({ goal: 'g', inputs: { a: 1 } }, { callbackUrl: 'https://cb.test/h' });
  assert.equal(out.status, 'queued');
  assert.match(out.jobId, /^job-/);
  assert.equal(out.position, 1);
  const call = client.calls.startNew[0];
  assert.equal(call.name, ORCHESTRATOR_NAME);
  assert.equal(call.instanceId, out.jobId);
  assert.equal(call.input.task.goal, 'g');
  assert.equal(call.input.task.id, out.jobId);
  assert.equal(call.input.callbackUrl, 'https://cb.test/h');
  assert.equal(call.input.record.status, 'queued');
  assert.equal(call.input.queuedEvent.type, 'queued');
});

test('submit rejects a missing goal and a plain-http callback by default', async () => {
  const jobs = createDurableJobs({ client: fakeClient(), config: cfg, notifier: null, logger: quiet });
  await assert.rejects(() => jobs.submit({ goal: '' }), TypeError);
  await assert.rejects(() => jobs.submit({ goal: 'g' }, { callbackUrl: 'http://cb.test/h' }), /https/);
});

test('submit enforces maxQueueSize over Pending + Running', async () => {
  const client = fakeClient({ instances: { a: { runtimeStatus: 'Pending' }, b: { runtimeStatus: 'Running' } } });
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  await assert.rejects(() => jobs.submit({ goal: 'g' }), JobQueueFullError);
});

test('mapDurableStatus maps runtime statuses and merges customStatus + output', () => {
  const record = { id: 'job-1', status: 'queued', task: { goal: 'g', inputs: {}, constraints: {}, budget: {} }, submittedAt: 't0', startedAt: null, finishedAt: null, attempts: 1, result: null, history: [], budget: null, progress: { iteration: 0, message: null, at: null }, callbackUrl: null, metadata: {}, error: null };
  const base = { instanceId: 'job-1', input: { record }, lastUpdatedTime: 'tL' };
  assert.equal(mapDurableStatus({ ...base, runtimeStatus: 'Pending' }).status, 'queued');
  const running = mapDurableStatus({ ...base, runtimeStatus: 'Running', customStatus: { status: 'processing', startedAt: 't1', progress: { iteration: 3, message: 'm', at: 't2' } } });
  assert.equal(running.status, 'processing');
  assert.equal(running.startedAt, 't1');
  assert.equal(running.progress.iteration, 3);
  const done = mapDurableStatus({ ...base, runtimeStatus: 'Completed', customStatus: { status: 'budget_exceeded', finishedAt: 't3' }, output: { status: 'budget_exceeded', result: { r: 1 }, error: null, history: [1], budget: { iterations: 6 } } });
  assert.equal(done.status, 'budget_exceeded');
  assert.deepEqual(done.result, { r: 1 });
  assert.deepEqual(done.history, [1]);
  assert.equal(done.finishedAt, 't3');
  const failed = mapDurableStatus({ ...base, runtimeStatus: 'Failed', output: 'boom' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'activity_failed');
  assert.equal(failed.finishedAt, 'tL');
  assert.equal(mapDurableStatus({ ...base, runtimeStatus: 'Terminated' }).status, 'cancelled');
  assert.equal(mapDurableStatus(null), null);
});

test('get returns the mapped record or null', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  assert.equal((await jobs.get(jobId)).status, 'queued');
  assert.equal((await jobs.get(jobId)).task.goal, 'g');
  assert.equal(await jobs.get('nope'), null);
});

test('cancel: Pending → terminate; Running → raiseEvent cancel; terminal → not ok; unknown → null', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const a = await jobs.submit({ goal: 'a' });
  assert.deepEqual(await jobs.cancel(a.jobId), { ok: true, status: 'cancelled' });
  assert.equal(client.calls.terminate.length, 1);
  const b = await jobs.submit({ goal: 'b' });
  client.instances[b.jobId].runtimeStatus = 'Running';
  assert.deepEqual(await jobs.cancel(b.jobId), { ok: true, status: 'cancelling' });
  assert.deepEqual(client.calls.raiseEvent[0], { id: b.jobId, name: 'cancel', data: {} });
  client.instances[b.jobId].runtimeStatus = 'Completed';
  client.instances[b.jobId].output = { status: 'completed' };
  assert.deepEqual(await jobs.cancel(b.jobId), { ok: false, status: 'completed' });
  assert.deepEqual(await jobs.cancel('nope'), { ok: false, status: null });
});

test('events reads customStatus.events preferring stored seq; subscribe polls and emits only new events', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  const inst = client.instances[jobId];
  const E = (seq, type, extra = {}) => ({ seq, type, jobId, at: 't', ...extra });
  inst.customStatus = { status: 'processing', events: [E(1, 'queued', { position: 1 }), E(2, 'started')] };
  assert.deepEqual((await jobs.events(jobId)).map(e => [e.seq, e.type]), [[1, 'queued'], [2, 'started']]);
  assert.deepEqual((await jobs.events(jobId, { afterSeq: 1 })).map(e => e.seq), [2]);
  const seen = [];
  const unsub = jobs.subscribe(jobId, e => seen.push(e.seq));
  await sleep(15);
  inst.customStatus = { status: 'processing', events: [...inst.customStatus.events, E(3, 'progress', { iteration: 1, message: 'm', kind: 'step_started' })] };
  await sleep(15);
  inst.runtimeStatus = 'Completed';
  inst.output = { status: 'completed', result: 1 };
  inst.customStatus = { status: 'completed', events: [...inst.customStatus.events, E(4, 'settled', { status: 'completed' })] };
  await sleep(20);
  unsub();
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('events after a ring truncation keep their original seq', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  client.instances[jobId].customStatus = { status: 'processing', events: [{ seq: 1, type: 'queued' }, { seq: 2, type: 'started' }, { seq: 40, type: 'progress' }, { seq: 41, type: 'progress' }] };
  assert.deepEqual((await jobs.events(jobId, { afterSeq: 2 })).map(e => e.seq), [40, 41]);
});

test('stats counts pending and running after refreshStats', async () => {
  const client = fakeClient({ instances: { a: { runtimeStatus: 'Pending' }, b: { runtimeStatus: 'Running' }, c: { runtimeStatus: 'Completed' } } });
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  await jobs.refreshStats();
  assert.deepEqual(jobs.stats(), { queued: 1, processing: 1, capacity: 1, maxQueueSize: 2 });
});

test('submit after stop throws JobsClosedError and stop clears pollers', async () => {
  const { JobsClosedError } = await import('../host/jobs/interface.mjs');
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: quiet });
  const { jobId } = await jobs.submit({ goal: 'g' });
  jobs.subscribe(jobId, () => {});
  await jobs.stop();
  await assert.rejects(() => jobs.submit({ goal: 'g' }), JobsClosedError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-durable.test.mjs`
Expected: FAIL — `Cannot find module '.../host/jobs/durable.mjs'`.

- [ ] **Step 3: Implement `host/jobs/durable.mjs`**

```js
// host/jobs/durable.mjs
// Jobs backend over Azure Durable Functions. The orchestration instance id IS the
// job id. All job state lives in the task hub; this module keeps only per-subscriber
// polling cursors in memory. It reads the customStatus contract that
// comm/azure-functions/orchestrator.mjs writes.
import { JobQueueFullError, JobsClosedError, validateCallbackUrl } from './interface.mjs';
import { TERMINAL_STATUSES, createRecord, queuedEvent } from './record.mjs';

export const ORCHESTRATOR_NAME = 'runTaskOrchestrator';
export const ACTIVITY_NAME = 'runTaskActivity';
const ACTIVE = ['Pending', 'Running'];
const STATUS_OPTS = { showHistory: false, showInput: true };

export function mapDurableStatus(instance) {
  if (!instance) return null;
  const record = instance.input?.record ? structuredClone(instance.input.record) : { id: instance.instanceId };
  const cs = instance.customStatus ?? {};
  const rt = instance.runtimeStatus;

  let status;
  if (rt === 'Pending') status = 'queued';
  else if (rt === 'Running' || rt === 'Suspended' || rt === 'ContinuedAsNew') status = cs.status && cs.status !== 'queued' ? cs.status : 'processing';
  else if (rt === 'Completed') status = instance.output?.status ?? cs.status ?? 'completed';
  else if (rt === 'Terminated' || rt === 'Canceled') status = 'cancelled';
  else status = 'failed';

  const out = { ...record, status };
  if (cs.startedAt) out.startedAt = cs.startedAt;
  if (cs.finishedAt) out.finishedAt = cs.finishedAt;
  if (cs.progress) out.progress = cs.progress;
  if (rt === 'Completed' && instance.output && typeof instance.output === 'object') {
    out.result = instance.output.result ?? null;
    out.error = instance.output.error ?? null;
    out.history = instance.output.history ?? [];
    out.budget = instance.output.budget ?? null;
  }
  if (rt === 'Failed') {
    const message = typeof instance.output === 'string' ? instance.output : JSON.stringify(instance.output ?? 'orchestration failed');
    out.error = { code: 'activity_failed', message };
  }
  if (TERMINAL_STATUSES.has(status) && !out.finishedAt) out.finishedAt = instance.lastUpdatedTime ?? null;
  return out;
}

// The orchestrator stores `seq` on every event it appends, so numbering survives
// ring truncation. Fall back to position only for events that lack it.
function withSeq(events = []) {
  return events.map((e, i) => ({ ...e, seq: e.seq ?? i + 1 }));
}

export function createDurableJobs({ client, config, notifier = null, logger = console, allowHttpCallbacks = false, now = () => new Date() }) {
  if (!client) throw new Error('createDurableJobs requires a Durable client');
  const { maxQueueSize = 100, durable: { pollMs = 2000 } = {} } = config ?? {};
  let closed = false;
  let lastStats = { queued: 0, processing: 0 };
  const pollers = new Map(); // jobId → { timer, subs: Set<fn>, lastSeq }

  const activeInstances = () => client.getStatusBy({ runtimeStatus: ACTIVE });

  function stopPoller(jobId) {
    const s = pollers.get(jobId);
    if (!s) return;
    clearInterval(s.timer);
    pollers.delete(jobId);
  }

  function startPoller(jobId) {
    const state = { subs: new Set(), lastSeq: 0, timer: null };
    const tick = async () => {
      try {
        const inst = await client.getStatus(jobId, STATUS_OPTS);
        const events = withSeq(inst?.customStatus?.events);
        for (const e of events) {
          if (e.seq <= state.lastSeq) continue;
          state.lastSeq = e.seq;
          for (const fn of state.subs) {
            try { fn(e); } catch (err) { logger.warn(`[durable] subscriber error: ${err?.message ?? err}`); }
          }
        }
        const rec = mapDurableStatus(inst);
        const finished = !inst || TERMINAL_STATUSES.has(rec?.status);
        if (finished && (state.subs.size === 0 || events.at(-1)?.type === 'settled')) stopPoller(jobId);
      } catch (err) {
        logger.warn(`[durable] poll ${jobId} failed: ${err?.message ?? err}`);
      }
    };
    state.timer = setInterval(() => void tick(), pollMs);
    state.timer.unref?.();
    void tick();
    pollers.set(jobId, state);
    return state;
  }

  return {
    async start() {},

    async stop() {
      closed = true;
      for (const id of [...pollers.keys()]) stopPoller(id);
    },

    async submit(task, { callbackUrl, metadata } = {}) {
      if (closed) throw new JobsClosedError();
      if (!task || typeof task.goal !== 'string' || !task.goal.trim()) throw new TypeError('task.goal is required');
      const url = validateCallbackUrl(callbackUrl, { allowHttp: allowHttpCallbacks });
      const active = await activeInstances();
      if (active.length >= maxQueueSize) throw new JobQueueFullError();
      const record = createRecord(task, { callbackUrl: url, metadata, now: now() });
      const position = active.filter(i => i.runtimeStatus === 'Pending').length + 1;
      await client.startNew(ORCHESTRATOR_NAME, {
        instanceId: record.id,
        input: {
          task: { id: record.id, ...record.task },
          record,
          callbackUrl: url,
          metadata: metadata ?? {},
          queuedEvent: queuedEvent(record.id, position, now()),
        },
      });
      return { jobId: record.id, status: 'queued', position };
    },

    async get(jobId) {
      return mapDurableStatus(await client.getStatus(jobId, STATUS_OPTS));
    },

    async cancel(jobId) {
      const inst = await client.getStatus(jobId, STATUS_OPTS);
      if (!inst) return { ok: false, status: null };
      const rec = mapDurableStatus(inst);
      if (TERMINAL_STATUSES.has(rec.status)) return { ok: false, status: rec.status };
      if (inst.runtimeStatus === 'Pending') {
        await client.terminate(jobId, 'cancelled before start');
        return { ok: true, status: 'cancelled' };
      }
      await client.raiseEvent(jobId, 'cancel', {});
      return { ok: true, status: 'cancelling' };
    },

    subscribe(jobId, onEvent) {
      const state = pollers.get(jobId) ?? startPoller(jobId);
      state.subs.add(onEvent);
      return () => {
        state.subs.delete(onEvent);
        if (state.subs.size === 0) stopPoller(jobId);
      };
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      const inst = await client.getStatus(jobId, STATUS_OPTS);
      return withSeq(inst?.customStatus?.events).filter(e => e.seq > afterSeq);
    },

    async refreshStats() {
      const active = await activeInstances();
      lastStats = {
        queued: active.filter(i => i.runtimeStatus === 'Pending').length,
        processing: active.filter(i => i.runtimeStatus === 'Running').length,
      };
      return lastStats;
    },

    stats() {
      return { ...lastStats, capacity: 1, maxQueueSize };
    },
  };
}
```

`notifier` is accepted for interface symmetry but unused here: on Azure the activity (Task 4) publishes the webhook itself, because the activity may run on a different instance from the one that answered `POST /task`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/host-jobs-durable.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Add the file to `test:phase4`**

In `package.json`, append ` tests/host-jobs-durable.test.mjs` to the `test:phase4` script string.

Run: `npm run test:phase4`
Expected: PASS (includes `package-scripts` check).

- [ ] **Step 6: Commit (with approval)**

```bash
git add host/jobs/durable.mjs tests/host-jobs-durable.test.mjs package.json
git commit -m "feat: add Durable Functions jobs backend"
```

---

### Task 2: Durable orchestrator

**Files:**
- Create: `comm/azure-functions/orchestrator.mjs`
- Modify: `package.json` (`test:phase4`)
- Test: `tests/comm-azure-orchestrator.test.mjs`

**Interfaces:**
- Consumes: `ACTIVITY_NAME` from `host/jobs/durable.mjs`; `ringEvents(events, max)` from `host/jobs/record.mjs`. Orchestration input `{ task, record, callbackUrl, metadata, queuedEvent }` (Task 1). External events raised by the activity (Task 4): `'progress'` with a full JobEvent (`type: 'started' | 'progress'`), `'cancel'` with `{}`.
- Produces: `buildOrchestrator({ ringSize = 50 }) → function* runTaskOrchestrator(context)` and `export const runTaskOrchestrator = buildOrchestrator()`. Writes `customStatus = { status, events: [{ seq, ...JobEvent }], progress: { iteration, message, at }, cancelRequested, startedAt, finishedAt }`. Returns the activity output `{ status, result, error, history, budget }` as the orchestration output.

- [ ] **Step 1: Write the failing test**

```js
// tests/comm-azure-orchestrator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');

// Replay-free driver for a Durable orchestrator generator: the test resolves
// whichever task in the yielded Task.any list it wants to "win".
function fakeContext({ instanceId = 'job-1', input }) {
  const statuses = [];
  const mk = (kind, name, inp) => ({ kind, name, input: inp, done: false, result: undefined });
  const df = {
    instanceId,
    getInput: () => input,
    setCustomStatus: (s) => statuses.push(structuredClone(s)),
    callActivity: (name, inp) => mk('activity', name, inp),
    waitForExternalEvent: (name) => mk('event', name),
    Task: { any: (list) => ({ kind: 'any', list }) },
    currentUtcDateTime: new Date('2026-09-17T10:00:00.000Z'),
  };
  return { df, statuses };
}

function drive(gen) {
  let step = gen.next();
  return {
    get pending() { return step.value?.list ?? []; },
    resolve(pred, result) {
      const t = step.value.list.find(pred);
      t.done = true; t.result = result;
      step = gen.next(t);
      return step;
    },
    get done() { return step.done; },
    get value() { return step.value; },
  };
}

const input = {
  task: { id: 'job-1', goal: 'g' }, record: { id: 'job-1' }, callbackUrl: null, metadata: {},
  queuedEvent: { type: 'queued', jobId: 'job-1', at: 't0', position: 1 },
};
const isProgress = t => t.kind === 'event' && t.name === 'progress';
const isCancel = t => t.kind === 'event' && t.name === 'cancel';
const isActivity = t => t.kind === 'activity';

test('orchestrator records queued, forwards started + rich progress, and settles from the activity output', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  assert.equal(ctx.statuses[0].status, 'queued');
  assert.deepEqual(ctx.statuses[0].events.map(e => e.type), ['queued']);
  assert.equal(ctx.statuses[0].events[0].seq, 1);
  assert.equal(d.pending.find(isActivity).name, 'runTaskActivity');
  assert.equal(d.pending.find(isActivity).input.jobId, 'job-1');

  d.resolve(isProgress, { type: 'started', jobId: 'job-1', at: 't1' });
  assert.equal(ctx.statuses.at(-1).status, 'processing');
  assert.equal(ctx.statuses.at(-1).startedAt, 't1');
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started']);

  d.resolve(isProgress, { type: 'progress', jobId: 'job-1', at: 't2', iteration: 1, message: 'starting: weather', kind: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' } });
  const last = ctx.statuses.at(-1);
  assert.deepEqual(last.events.map(e => e.type), ['queued', 'started', 'progress']);
  assert.equal(last.events.at(-1).kind, 'step_started');
  assert.equal(last.events.at(-1).seq, 3);
  assert.deepEqual(last.progress, { iteration: 1, message: 'starting: weather', at: 't2' });

  const output = { status: 'completed', result: 'ok', error: null, history: [1], budget: null };
  d.resolve(isActivity, output);
  assert.equal(d.done, true);
  assert.deepEqual(d.value, output);
  assert.equal(ctx.statuses.at(-1).status, 'completed');
  assert.equal(ctx.statuses.at(-1).events.at(-1).type, 'settled');
  assert.equal(ctx.statuses.at(-1).events.at(-1).result, 'ok');
  assert.ok(ctx.statuses.at(-1).finishedAt);
});

test('a progress event before any started event marks the job started', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isProgress, { type: 'progress', jobId: 'job-1', at: 't1', iteration: 1, message: 'm', kind: 'plan' });
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'progress']);
  assert.equal(ctx.statuses.at(-1).startedAt, 't1');
});

test('orchestrator sets cancelRequested on cancel and keeps waiting for the activity', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isCancel, {});
  assert.equal(ctx.statuses.at(-1).cancelRequested, true);
  assert.ok(d.pending.some(isActivity), 'activity still awaited');
  d.resolve(isActivity, { status: 'cancelled', result: null, error: null, history: [], budget: null });
  assert.equal(ctx.statuses.at(-1).status, 'cancelled');
  assert.equal(ctx.statuses.at(-1).events.at(-1).status, 'cancelled');
});

test('activity finishing with no prior events still yields started + settled', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isActivity, { status: 'failed', result: null, error: { code: 'run_failed', message: 'x' }, history: [], budget: null });
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'settled']);
  assert.equal(ctx.statuses.at(-1).status, 'failed');
});

test('orchestrator ring keeps at most 50 events, never drops queued/started, and keeps seq stable', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(isProgress, { type: 'started', jobId: 'job-1', at: 't1' });
  for (let i = 1; i <= 70; i++) {
    d.resolve(isProgress, { type: 'progress', jobId: 'job-1', at: 't', iteration: i, message: `m${i}`, kind: 'step_completed' });
  }
  const events = ctx.statuses.at(-1).events;
  assert.equal(events.length, 50);
  assert.deepEqual(events.slice(0, 2).map(e => [e.seq, e.type]), [[1, 'queued'], [2, 'started']]);
  assert.equal(events.at(-1).seq, 72); // 1 queued + 1 started + 70 progress
  assert.equal(events[2].seq, 72 - 48 + 1); // oldest surviving progress
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/comm-azure-orchestrator.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `comm/azure-functions/orchestrator.mjs`**

```js
// comm/azure-functions/orchestrator.mjs
// One orchestration per job. Deterministic: it only reacts to Durable-delivered
// tasks (activity completion, 'progress' events, 'cancel' events). The activity
// (activity.mjs) is the run loop; this generator only records what it is told.
//
// customStatus contract read by host/jobs/durable.mjs:
//   { status, events: [{ seq, ...JobEvent }] (ring of 50, queued/started/settled always kept),
//     progress: { iteration, message, at }, cancelRequested, startedAt, finishedAt }
import { ACTIVITY_NAME } from '../../host/jobs/durable.mjs';
import { ringEvents } from '../../host/jobs/record.mjs';

export function buildOrchestrator({ ringSize = 50 } = {}) {
  return function* runTaskOrchestrator(context) {
    const df = context.df;
    const input = df.getInput();
    const jobId = df.instanceId;
    const nowIso = () => (df.currentUtcDateTime ?? new Date()).toISOString();

    let seq = 0;
    const events = [];
    const push = (e) => { seq += 1; events.push({ ...e, seq }); };
    const state = {
      status: 'queued', events, progress: { iteration: 0, message: null, at: null },
      cancelRequested: false, startedAt: null, finishedAt: null,
    };
    const publish = () => df.setCustomStatus({ ...state, events: ringEvents(events, ringSize) });

    push(input.queuedEvent ?? { type: 'queued', jobId, at: nowIso(), position: 1 });
    publish();

    const activity = df.callActivity(ACTIVITY_NAME, { ...input, jobId });

    let started = false;
    const markStarted = (at) => {
      if (started) return;
      started = true;
      state.status = 'processing';
      state.startedAt = at;
      push({ type: 'started', jobId, at });
    };

    for (;;) {
      const progress = df.waitForExternalEvent('progress');
      const cancel = df.waitForExternalEvent('cancel');
      const winner = yield df.Task.any([activity, progress, cancel]);
      if (winner === activity) break;
      if (winner === cancel) {
        state.cancelRequested = true;
        publish();
        continue;
      }
      const e = progress.result;
      markStarted(e.at);
      if (e.type === 'progress') {
        push(e);
        state.progress = { iteration: e.iteration, message: e.message, at: e.at };
      }
      publish();
    }

    const output = activity.result;
    const at = nowIso();
    markStarted(state.startedAt ?? at);
    state.status = output.status;
    state.finishedAt = at;
    push({ type: 'settled', jobId, at, status: output.status, result: output.result ?? null, error: output.error ?? null });
    publish();
    return output;
  };
}

export const runTaskOrchestrator = buildOrchestrator();
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/comm-azure-orchestrator.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Add to `test:phase4` and commit (with approval)**

Append ` tests/comm-azure-orchestrator.test.mjs` to `test:phase4` in `package.json`. Run `npm run test:phase4` → PASS.

```bash
git add comm/azure-functions/orchestrator.mjs tests/comm-azure-orchestrator.test.mjs package.json
git commit -m "feat: add Durable orchestrator for async jobs"
```

---

### Task 3: Azure Functions HTTP adapter

**Files:**
- Create: `comm/azure-functions/http.mjs`
- Modify: `package.json` (`test:phase4`)
- Test: `tests/comm-azure-http.test.mjs`

**Interfaces:**
- Consumes: `runHandler`, `lowerHeaders` from `comm/router.mjs`; RouteDefs from `host/routes.mjs`; `mcpServerFactory` (already passed by `startHost` to `adapter.start`); `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`.
- Produces: `createAzureFunctionsAdapter({ app, extraInputs = [] } = {}) → { start({ routes, authenticate, mcpServerFactory }), stop(), port() → null, address() → null }`; pure helpers `toNeutralRequest(httpRequest, params) → Promise<request>`, `toHttpResponse(response) → HttpResponseInit`, `toFunctionsRoute(path) → string`. Every registered function gets `extraInputs` so Task 4's Durable client input is available in HTTP invocations.

The socket-based `runCommContract` cannot drive this adapter (no port), so this task ships an equivalent in-process suite against a fake `@azure/functions` `app`. This is a deliberate deviation from the spec's "one contract suite for all adapters".

- [ ] **Step 1: Write the failing test**

```js
// tests/comm-azure-http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAzureFunctionsAdapter, toNeutralRequest, toHttpResponse, toFunctionsRoute } = await import('../comm/azure-functions/http.mjs');

function fakeApp() {
  const registered = {};
  return { registered, setup(opts) { registered.__setup = opts; }, http(name, opts) { registered[name] = opts; } };
}
function fakeHttpRequest({ method = 'GET', url = 'http://f/api/jobs/j1?q=2', headers = {}, params = {}, body = null, signal } = {}) {
  return {
    method, url, params, query: new URL(url).searchParams,
    headers: new Headers(headers),
    async json() { if (body === null) throw new Error('no body'); return body; },
    async text() { return body == null ? '' : JSON.stringify(body); },
    signal: signal ?? new AbortController().signal,
  };
}
async function collect(stream) { const out = []; for await (const c of stream) out.push(c.toString()); return out; }

test('toFunctionsRoute strips the leading slash and converts :params to {params}', () => {
  assert.equal(toFunctionsRoute('/health'), 'health');
  assert.equal(toFunctionsRoute('/jobs/:id/events'), 'jobs/{id}/events');
});

test('toNeutralRequest maps method, /api-stripped path, params, query, lower-case headers, body', async () => {
  const r = await toNeutralRequest(fakeHttpRequest({ method: 'POST', url: 'http://f/api/task?wait=true', headers: { 'X-Test': 'a' }, body: { goal: 'g' } }), { id: 'j1' });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/task');
  assert.deepEqual(r.params, { id: 'j1' });
  assert.deepEqual(r.query, { wait: 'true' });
  assert.equal(r.headers['x-test'], 'a');
  assert.deepEqual(r.body, { goal: 'g' });
  assert.equal(r.user, null);
  const g = await toNeutralRequest(fakeHttpRequest({ method: 'GET', url: 'http://f/api/health' }));
  assert.equal(g.path, '/health');
  assert.equal(g.body, null);
  const d = await toNeutralRequest(fakeHttpRequest({ method: 'DELETE', url: 'http://f/api/jobs/j1' }));
  assert.equal(d.body, null);
  const bad = await toNeutralRequest(fakeHttpRequest({ method: 'POST', url: 'http://f/api/task', body: null }));
  assert.equal(bad.body, null);
});

test('toHttpResponse maps JSON and stream responses', async () => {
  const j = toHttpResponse({ status: 202, headers: { 'retry-after': '30' }, body: { a: 1 } });
  assert.equal(j.status, 202);
  assert.equal(j.headers['retry-after'], '30');
  assert.equal(j.headers['content-type'], 'application/json');
  assert.deepEqual(j.jsonBody, { a: 1 });
  async function* gen() { yield 'a'; yield 'b'; }
  const s = toHttpResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen() });
  assert.equal(s.status, 200);
  assert.equal(s.headers['content-type'], 'text/event-stream');
  assert.deepEqual(await collect(s.body), ['a', 'b']);
  const empty = toHttpResponse({ status: 204 });
  assert.deepEqual(empty.jsonBody, {});
});

test('adapter registers one anonymous function per non-null route, with extraInputs, and applies auth', async () => {
  const app = fakeApp();
  const clientInput = { name: 'client', type: 'durableClient' };
  const adapter = createAzureFunctionsAdapter({ app, extraInputs: [clientInput] });
  const authenticate = (r) => (r.headers['x-deny'] ? null : { id: 'u' });
  await adapter.start({
    routes: {
      health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
      jobGet: { method: 'GET', path: '/jobs/:id', handler: async (r) => ({ status: 200, body: { id: r.params.id, user: r.user } }) },
      task: null,
      boom: { method: 'GET', path: '/boom', handler: async () => { throw new Error('kaboom'); } },
    },
    authenticate,
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => {} }),
  });
  assert.equal(app.registered.__setup.enableHttpStream, true);
  assert.equal(app.registered.task, undefined);
  assert.deepEqual(app.registered.jobGet.methods, ['GET']);
  assert.equal(app.registered.jobGet.route, 'jobs/{id}');
  assert.equal(app.registered.jobGet.authLevel, 'anonymous');
  assert.deepEqual(app.registered.jobGet.extraInputs, [clientInput]);

  const ok = await app.registered.jobGet.handler(fakeHttpRequest({ params: { id: 'j1' } }), {});
  assert.deepEqual(ok.jsonBody, { id: 'j1', user: { id: 'u' } });
  const denied = await app.registered.jobGet.handler(fakeHttpRequest({ params: { id: 'j1' }, headers: { 'x-deny': '1' } }), {});
  assert.equal(denied.status, 401);
  const health = await app.registered.health.handler(fakeHttpRequest({ url: 'http://f/api/health', headers: { 'x-deny': '1' } }), {});
  assert.equal(health.status, 200);
  const err = await app.registered.boom.handler(fakeHttpRequest({ url: 'http://f/api/boom' }), {});
  assert.equal(err.status, 500);
  assert.equal(err.jsonBody.error, 'internal_error');
  assert.equal(adapter.port(), null);
  assert.equal(adapter.address(), null);
  await adapter.stop();
});

test('raw route: 401 when denied; delegates to route.web when present', async () => {
  const app = fakeApp();
  const adapter = createAzureFunctionsAdapter({ app });
  let webCalled = null;
  await adapter.start({
    routes: { mcp: { method: 'POST', path: '/mcp', raw: true, handler: () => {}, web: async (req, user) => { webCalled = user; return { status: 200, jsonBody: { via: 'web' } }; } } },
    authenticate: (r) => (r.headers['x-deny'] ? null : { id: 'u' }),
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => {} }),
  });
  const denied = await app.registered.mcp.handler(fakeHttpRequest({ method: 'POST', url: 'http://f/api/mcp', headers: { 'x-deny': '1' }, body: {} }), {});
  assert.equal(denied.status, 401);
  const ok = await app.registered.mcp.handler(fakeHttpRequest({ method: 'POST', url: 'http://f/api/mcp', body: {} }), {});
  assert.deepEqual(ok.jsonBody, { via: 'web' });
  assert.deepEqual(webCalled, { id: 'u' });
});

test('raw route without web falls back to the MCP web-standard transport and returns its Response', async () => {
  const app = fakeApp();
  const adapter = createAzureFunctionsAdapter({
    app,
    loadWebTransport: async () => class FakeTransport {
      constructor() { this.connected = false; }
      async handleRequest(webReq) { return new Response(JSON.stringify({ echo: await webReq.text() }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    },
  });
  let closed = 0;
  await adapter.start({
    routes: { mcp: { method: 'POST', path: '/mcp', raw: true, handler: () => {} } },
    authenticate: () => ({ id: 'u' }),
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => { closed += 1; } }),
  });
  const res = await app.registered.mcp.handler(fakeHttpRequest({ method: 'POST', url: 'http://f/api/mcp', body: { jsonrpc: '2.0' } }), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse((await collect(res.body)).join('')), { echo: JSON.stringify({ jsonrpc: '2.0' }) });
  assert.equal(closed, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/comm-azure-http.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `comm/azure-functions/http.mjs`**

```js
// comm/azure-functions/http.mjs
// Azure Functions v4 (Node) HTTP trigger adapter for the neutral comm contract.
// One `app.http()` registration per route. `start()` registers; `stop()` is a
// no-op because the Functions host owns the process. There is no port.
import { Readable } from 'node:stream';
import { runHandler, lowerHeaders } from '../router.mjs';

export const toFunctionsRoute = (path) =>
  path.replace(/^\//, '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

export async function toNeutralRequest(req, params = {}) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  let body = null;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    try { body = await req.json(); } catch { body = null; }
  }
  return {
    method: req.method, path, params: { ...params }, query: Object.fromEntries(url.searchParams),
    headers: lowerHeaders(req.headers), body, signal: req.signal, user: null,
  };
}

export function toHttpResponse(response) {
  const headers = { ...(response.headers ?? {}) };
  if (response.stream) {
    headers['content-type'] = headers['content-type'] ?? 'text/event-stream';
    return { status: response.status ?? 200, headers, body: Readable.from(response.stream) };
  }
  return { status: response.status ?? 200, headers: { 'content-type': 'application/json', ...headers }, jsonBody: response.body ?? {} };
}

async function defaultLoadWebTransport() {
  const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');
  return WebStandardStreamableHTTPServerTransport;
}

export function createAzureFunctionsAdapter({ app: injectedApp, extraInputs = [], loadWebTransport = defaultLoadWebTransport } = {}) {
  return {
    async start({ routes, authenticate, mcpServerFactory }) {
      const app = injectedApp ?? (await import('@azure/functions')).app;
      app.setup({ enableHttpStream: true });

      for (const [name, route] of Object.entries(routes)) {
        if (!route) continue;
        const common = { methods: [route.method], route: toFunctionsRoute(route.path), authLevel: 'anonymous', extraInputs };

        if (route.raw) {
          app.http(name, {
            ...common,
            handler: async (req) => {
              const request = await toNeutralRequest(req, req.params);
              const user = route.auth === false ? null : await authenticate(request);
              if (route.auth !== false && !user) return toHttpResponse({ status: 401, body: { ok: false, error: 'unauthorized' } });
              if (route.web) return route.web(req, user);
              // MCP on Functions: the SDK's web-standard transport, one server per request.
              const Transport = await loadWebTransport();
              const server = mcpServerFactory();
              const transport = new Transport({ sessionIdGenerator: undefined });
              try {
                await server.connect(transport);
                const webReq = new Request(req.url, { method: req.method, headers: req.headers, body: await req.text() });
                const webRes = await transport.handleRequest(webReq);
                return {
                  status: webRes.status,
                  headers: Object.fromEntries(webRes.headers),
                  body: webRes.body ? Readable.fromWeb(webRes.body) : undefined,
                };
              } finally {
                await server.close();
              }
            },
          });
          continue;
        }

        app.http(name, {
          ...common,
          handler: async (req) => {
            const request = await toNeutralRequest(req, req.params);
            return toHttpResponse(await runHandler(route, request, authenticate));
          },
        });
      }
    },
    async stop() {},
    port() { return null; },
    address() { return null; },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/comm-azure-http.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify the real MCP transport signature once**

Run:
```bash
node -e "import('@modelcontextprotocol/server').then(m => { const t = new m.WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined }); console.log(typeof t.handleRequest); })"
```
Expected: `function`. If it prints anything else, stop and report; the fallback branch in `http.mjs` depends on `handleRequest(Request) → Response`.

- [ ] **Step 6: Add to `test:phase4` and commit (with approval)**

Append ` tests/comm-azure-http.test.mjs` to `test:phase4`. Run `npm run test:phase4 && npm run test:host` → PASS.

```bash
git add comm/azure-functions/http.mjs tests/comm-azure-http.test.mjs package.json
git commit -m "feat: add Azure Functions comm adapter"
```

---

### Task 4: Durable activity, Functions registration, and host entry

**Files:**
- Create: `comm/azure-functions/activity.mjs`, `comm/azure-functions/index.mjs`, `comm/azure-functions/main.mjs`, `comm/azure-functions/host.json`, `comm/azure-functions/local.settings.json.example`
- Modify: `host/index.mjs:248` (return object), `host/jobs/config.mjs:37` (`DURABLE_POLL_MS`)
- Modify: `package.json` (`test:phase4`)
- Test: `tests/comm-azure-activity.test.mjs`

**Interfaces:**
- Consumes: `executeHostedTask` (rich `onProgress`), `settleFromRunResult` from `host/jobs/record.mjs`, `ORCHESTRATOR_NAME`/`ACTIVITY_NAME`, `runTaskOrchestrator` (Task 2), `createAzureFunctionsAdapter` (Task 3).
- Produces:
  - `createRunTaskActivity({ getClient, pollMs = 2000, getContext = getHostContext }) → async (input, context) => settled`.
  - `setHostContextFactory(factory)`, `getHostContext() → Promise<{ api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, notifier }>`.
  - `registerDurableFunctions({ hostContextFactory, pollMs }) → { df, clientInput }`.
  - `startHost` now also returns `fleetApi`, `dispatcher`, `guardrailsMod`, `runLoopConfig`, `budgetsConfig`.
  - `resolveDispatchConfig` honours `DURABLE_POLL_MS`.

Deviation from the spec, deliberate: Fleet is spawned when `main.mjs` loads (eagerly, once per Functions instance) rather than lazily on the first activity, because `createWorkerDispatcher` needs `fleetApi` before any HTTP route can answer.

- [ ] **Step 1: Write the failing activity test**

```js
// tests/comm-azure-activity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createRunTaskActivity, setHostContextFactory, getHostContext } = await import('../comm/azure-functions/activity.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}
function fakeClient({ cancelAfterPolls = Infinity } = {}) {
  const calls = { raiseEvent: [], getStatus: 0 };
  return {
    calls,
    async raiseEvent(id, name, data) { calls.raiseEvent.push({ id, name, data }); },
    async getStatus() { calls.getStatus += 1; return { customStatus: { cancelRequested: calls.getStatus > cancelAfterPolls } }; },
  };
}
function hostCtx(api, dispatcher, extra = {}) {
  return { api, activeDispatcher: dispatcher, toolRegistry: extendRegistry(), runLoopConfig: { strategy: 'open-ended' }, budgetsConfig: null, guardrailsMod: null, notifier: null, ...extra };
}

test('activity raises started, forwards rich progress, returns the settled result, and posts the webhook', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```tool_call\n{"tool": "inspect-members", "args": {}}\n```', '```done\n{"result": "done", "summary": "s"}\n```'],
  });
  const dispatcher = await makeDispatcher();
  const client = fakeClient();
  const published = [];
  const notifier = { publish: async (event, ctx) => { published.push({ event, ctx }); } };
  try {
    const activity = createRunTaskActivity({ getClient: () => client, pollMs: 50, getContext: async () => hostCtx(api, dispatcher, { notifier }) });
    const out = await activity({ jobId: 'job-1', task: { goal: 'inspect' }, callbackUrl: 'https://cb.test/h' }, { warn() {} });
    assert.equal(out.status, 'completed');
    assert.equal(out.result, 'done');
    assert.ok(Array.isArray(out.history));
    const raised = client.calls.raiseEvent;
    assert.equal(raised[0].name, 'progress');
    assert.equal(raised[0].data.type, 'started');
    assert.equal(raised[0].id, 'job-1');
    const progress = raised.filter(r => r.data.type === 'progress');
    assert.equal(progress.length, 2);
    assert.deepEqual(progress.map(p => p.data.kind), ['step_started', 'step_completed']);
    assert.equal(progress[0].data.iteration, 1);
    assert.ok(progress[0].data.at);
    assert.equal(published.length, 1);
    assert.equal(published[0].event.type, 'settled');
    assert.equal(published[0].event.status, 'completed');
    assert.equal(published[0].ctx.callbackUrl, 'https://cb.test/h');
  } finally { await dispatcher.close(); }
});

test('activity aborts when customStatus.cancelRequested appears and settles cancelled', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: async () => { await new Promise(r => setTimeout(r, 120)); return '```tool_call\n{"tool": "inspect-members", "args": {}}\n```'; },
  });
  const dispatcher = await makeDispatcher();
  const client = fakeClient({ cancelAfterPolls: 1 });
  try {
    const activity = createRunTaskActivity({ getClient: () => client, pollMs: 30, getContext: async () => hostCtx(api, dispatcher) });
    const out = await activity({ jobId: 'job-2', task: { goal: 'slow' }, callbackUrl: null }, { warn() {} });
    assert.equal(out.status, 'cancelled');
  } finally { await dispatcher.close(); }
});

test('activity returns failed / dispatch_failed as a value when no lease is available', async () => {
  const api = createMockFleetApi({ members: rosterNames(1) });
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => { throw new Error('queue overflow'); };
  try {
    const activity = createRunTaskActivity({ getClient: () => fakeClient(), pollMs: 50, getContext: async () => hostCtx(api, dispatcher) });
    const out = await activity({ jobId: 'job-3', task: { goal: 'x' }, callbackUrl: null }, { warn() {} });
    assert.equal(out.status, 'failed');
    assert.equal(out.error.code, 'dispatch_failed');
  } finally { await dispatcher.close(); }
});

test('getHostContext memoises the factory and throws before one is set', async () => {
  setHostContextFactory(null);
  await assert.rejects(() => getHostContext(), /host context factory/);
  let calls = 0;
  setHostContextFactory(async () => { calls += 1; return { api: 'a' }; });
  assert.equal((await getHostContext()).api, 'a');
  await getHostContext();
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/comm-azure-activity.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `comm/azure-functions/activity.mjs`**

```js
// comm/azure-functions/activity.mjs
// The run loop inside a Durable activity. Progress goes to the orchestrator as
// external events (raiseEvent 'progress'); cancellation is read back from the
// orchestrator's customStatus, polled from the task hub, because the activity
// can run on a different instance from the one that received DELETE /jobs/:id.
import { executeHostedTask } from '../../host/tasks.mjs';
import { settleFromRunResult } from '../../host/jobs/record.mjs';

let factory = null;
let contextPromise = null;

export function setHostContextFactory(fn) {
  factory = fn;
  contextPromise = null;
}

export function getHostContext() {
  if (!factory) return Promise.reject(new Error('host context factory not set; call setHostContextFactory first'));
  contextPromise ??= Promise.resolve().then(factory);
  return contextPromise;
}

export function createRunTaskActivity({ getClient, pollMs = 2000, getContext = getHostContext }) {
  return async function runTaskActivity(input, context) {
    const { jobId, task, callbackUrl } = input;
    const client = getClient(context);
    const hostCtx = await getContext();
    const controller = new AbortController();
    const iso = () => new Date().toISOString();

    const raise = async (event) => {
      try { await client.raiseEvent(jobId, 'progress', event); }
      catch (err) { context?.warn?.(`[activity] raiseEvent failed: ${err?.message ?? err}`); }
    };
    await raise({ type: 'started', jobId, at: iso() });

    const cancelPoll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId, { showHistory: false, showInput: false });
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* transient; next tick retries */ }
    }, pollMs);
    cancelPoll.unref?.();

    try {
      const run = await executeHostedTask({ ...task, id: jobId }, {
        api: hostCtx.api,
        activeDispatcher: hostCtx.activeDispatcher,
        toolRegistry: hostCtx.toolRegistry,
        runLoopConfig: hostCtx.runLoopConfig,
        budgetsConfig: hostCtx.budgetsConfig,
        guardrailsMod: hostCtx.guardrailsMod,
        signal: controller.signal,
        onProgress: (progress) => raise({ type: 'progress', jobId, at: iso(), ...progress }),
      });
      const settled = settleFromRunResult(run);
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
        settled.status = 'cancelled';
        settled.result = null;
        settled.error = null;
      }
      if (hostCtx.notifier && callbackUrl) {
        await hostCtx.notifier.publish(
          { type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result, error: settled.error },
          { callbackUrl },
        );
      }
      return settled;
    } finally {
      clearInterval(cancelPoll);
    }
  };
}
```

`onProgress` receives the rich object `{ iteration, message, kind, stepIndex, step, plan, result, error, ... }` and the whole thing is spread into the external event, so SSE consumers on Azure see the same `kind` fields as on the VM.

- [ ] **Step 4: Run the activity test**

Run: `node --test tests/comm-azure-activity.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Extend `startHost`'s return and add `DURABLE_POLL_MS`**

In `host/index.mjs`, replace the return statement (currently line 248):

```js
  return {
    host: adapter, jobs, notifier, callTool, close, stop: close, config, registry: toolRegistry,
    fleetApi: api, dispatcher: activeDispatcher, guardrailsMod, runLoopConfig, budgetsConfig,
  };
```

In `host/jobs/config.mjs`, after the line `merged.durable.taskHub = env.DURABLE_TASK_HUB || merged.durable.taskHub;` add:

```js
  merged.durable.pollMs = intEnv(env, 'DURABLE_POLL_MS', merged.durable.pollMs);
```

Add one assertion to `tests/host-jobs-config.test.mjs` inside the existing env-override test (or as a new test if that file has none for `durable`):

```js
test('DURABLE_POLL_MS overrides dispatch.durable.pollMs', () => {
  const { resolveDispatchConfig } = require('../host/jobs/config.mjs');
});
```

Use the file's existing import style instead of `require`; the body is:

```js
  const c = resolveDispatchConfig({ enabled: true }, { env: { DURABLE_POLL_MS: '500' } });
  assert.equal(c.durable.pollMs, 500);
```

Run: `npm run test:phase4 && npm run test:host` → PASS.

- [ ] **Step 6: Create the Functions registration and entry**

```js
// comm/azure-functions/index.mjs
// Registers the orchestrator and activity with Durable Functions.
export async function registerDurableFunctions({ hostContextFactory, pollMs = 2000 }) {
  const df = await import('durable-functions');
  const { ORCHESTRATOR_NAME, ACTIVITY_NAME } = await import('../../host/jobs/durable.mjs');
  const { runTaskOrchestrator } = await import('./orchestrator.mjs');
  const { createRunTaskActivity, setHostContextFactory } = await import('./activity.mjs');

  setHostContextFactory(hostContextFactory);
  const clientInput = df.input.durableClient();
  df.app.orchestration(ORCHESTRATOR_NAME, runTaskOrchestrator);
  df.app.activity(ACTIVITY_NAME, {
    extraInputs: [clientInput],
    handler: createRunTaskActivity({ getClient: (context) => df.getClient(context), pollMs }),
  });
  return { df, clientInput };
}
```

```js
// comm/azure-functions/main.mjs
// Entry point loaded by the Azure Functions host (wwwroot package.json "main").
// Registers HTTP functions (via the adapter), the orchestrator, and the activity.
import { app } from '@azure/functions';
import * as df from 'durable-functions';
import { startHost } from '../../host/index.mjs';
import { createAzureFunctionsAdapter } from './http.mjs';
import { registerDurableFunctions } from './index.mjs';

// HTTP triggers get a Durable client per invocation. host/jobs/durable.mjs wants
// one stable client object, so proxy every method to the current invocation's client.
let currentContext = null;
const clientInput = df.input.durableClient();
const durableClient = new Proxy({}, {
  get: (_, method) => (...args) => df.getClient(currentContext)[method](...args),
});
app.hook.preInvocation((ctx) => { currentContext = ctx.invocationContext; });

const started = await startHost({
  createAdapter: () => createAzureFunctionsAdapter({ extraInputs: [clientInput] }),
  durableClient,
});

await registerDurableFunctions({
  pollMs: started.config.modules.dispatch?.durable?.pollMs ?? 2000,
  hostContextFactory: async () => ({
    api: started.fleetApi,
    activeDispatcher: started.dispatcher,
    toolRegistry: started.registry,
    runLoopConfig: started.runLoopConfig,
    budgetsConfig: started.budgetsConfig,
    guardrailsMod: started.guardrailsMod,
    notifier: started.notifier,
  }),
});

app.hook.appTerminate(async () => { await started.close(); });
```

`startHost` reads `host.config.mjs` from the repo root by default; the Functions image (Task 7) ships `deploy/azure-functions/host.config.mjs` (adapter `azure-functions`, backend `durable`) over it, so config validation passes on Azure.

```json
// comm/azure-functions/host.json
{
  "version": "2.0",
  "functionTimeout": "-1",
  "extensionBundle": { "id": "Microsoft.Azure.Functions.ExtensionBundle", "version": "[4.*, 5.0.0)" },
  "extensions": { "durableTask": { "hubName": "%DURABLE_TASK_HUB%" } },
  "logging": { "logLevel": { "default": "Information" } }
}
```

```json
// comm/azure-functions/local.settings.json.example
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "DURABLE_TASK_HUB": "fleetjobs",
    "JOBS_BACKEND": "durable",
    "WORKER_POOL_SIZE": "0",
    "WORKER_EPHEMERAL_MAX": "2",
    "CLAUDE_CODE_OAUTH_TOKEN": ""
  }
}
```

- [ ] **Step 7: Smoke-check the modules load**

Run: `node -e "import('./comm/azure-functions/index.mjs').then(() => console.log('ok'))"`
Expected: `ok`. (`main.mjs` is not importable outside a Functions host; do not run it here.)

- [ ] **Step 8: Add to `test:phase4` and commit (with approval)**

Append ` tests/comm-azure-activity.test.mjs` to `test:phase4`. Run `npm run test:phase4 && npm run test:host` → PASS.

```bash
git add comm/azure-functions host/index.mjs host/jobs/config.mjs tests/comm-azure-activity.test.mjs tests/host-jobs-config.test.mjs package.json
git commit -m "feat: Durable activity and Azure Functions host entry"
```

---

### Task 5: Scripted fleet and the `FLEET_MOCK_SCRIPT` switch

**Files:**
- Create: `tests/helpers/scripted-fleet.mjs`
- Modify: `host/index.mjs:107-116` (fleet acquisition block)
- Modify: `package.json` (`test:phase4`)
- Test: `tests/host-scripted-fleet.test.mjs`

**Interfaces:**
- Consumes: `createMockFleetApi`, `rosterNames` from `tests/helpers/mock-fleet.mjs`.
- Produces: `createScriptedFleetApi(script, { members }) → fleetApi`, `loadScript(path) → Promise<script>`. Script shape: `{ tools: { [toolName]: jsonPayload }, goals: { [goalSubstring]: string[] }, default: string[], delays?: { [goalSubstring]: ms } }`. `startHost` honours `env.FLEET_MOCK_SCRIPT` only when `env.NODE_ENV === 'test'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/host-scripted-fleet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createScriptedFleetApi, loadScript } = await import('./helpers/scripted-fleet.mjs');
const { startHost } = await import('../host/index.mjs');

const script = {
  tools: { weather: { ok: true, location: 'Tokyo', temp_c: '22' } },
  goals: { 'weather in Tokyo': ['```tool_call\n{"tool":"weather","args":{"city":"Tokyo"}}\n```', '```done\n{"result":"22C","summary":"s"}\n```'] },
  default: ['```done\n{"result":"default","summary":"s"}\n```'],
  delays: { 'weather in Tokyo': 20 },
};

test('executeCommand returns the payload for the tool named in the command', async () => {
  const api = createScriptedFleetApi(script);
  const out = await api.executeCommand({ member_name: 'doer', command: 'python3 "/x/tools/weather/weather.py" "Tokyo"' });
  assert.equal(JSON.parse(out.structuredContent.stdout).location, 'Tokyo');
  const miss = await api.executeCommand({ member_name: 'doer', command: 'python3 nothing.py' });
  assert.equal(JSON.parse(miss.structuredContent.stdout).ok, false);
});

test('executePrompt walks the goal script, repeats the last response, falls back to default, honours delays', async () => {
  const api = createScriptedFleetApi(script);
  const p = (text) => api.executePrompt({ member_name: 'doer', prompt: `Task: What is the weather in Tokyo?\n${text}` });
  const t0 = Date.now();
  assert.match((await p('')).structuredContent.response, /tool_call/);
  assert.ok(Date.now() - t0 >= 15, 'delay applied');
  assert.match((await p('')).structuredContent.response, /done/);
  assert.match((await p('')).structuredContent.response, /done/);
  assert.match((await api.executePrompt({ member_name: 'doer', prompt: 'Task: something else' })).structuredContent.response, /default/);
});

test('loadScript reads JSON from disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scripted-'));
  const file = path.join(dir, 's.json');
  await fs.writeFile(file, JSON.stringify(script));
  assert.deepEqual((await loadScript(file)).tools.weather.location, 'Tokyo');
});

test('startHost uses the scripted fleet under NODE_ENV=test and refuses it otherwise', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scripted-host-'));
  const file = path.join(dir, 's.json');
  await fs.writeFile(file, JSON.stringify(script));
  const base = { ...process.env, FLEET_MOCK_SCRIPT: file, WORKER_POOL_SIZE: '1', WORKER_EPHEMERAL_MAX: '0', WORKER_POOL_ROOT: path.join(dir, 'pool') };

  await assert.rejects(
    () => startHost({ port: 0, env: { ...base, NODE_ENV: 'production' }, dispatch: { enabled: false } }),
    /NODE_ENV=test/,
  );

  const { host, close } = await startHost({ port: 0, env: { ...base, NODE_ENV: 'test' }, runLoop: { enabled: true, strategy: 'open-ended' }, dispatch: { enabled: false } });
  try {
    const res = await fetch(`http://127.0.0.1:${host.port()}/task?wait=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'What is the weather in Tokyo?' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.result, '22C');
  } finally { await close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-scripted-fleet.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Create the helper**

```js
// tests/helpers/scripted-fleet.mjs
// A fleetApi driven by a JSON script. Used by E2E_MODE=scripted (through the
// FLEET_MOCK_SCRIPT switch in host/index.mjs) and by unit tests.
import { readFile } from 'node:fs/promises';
import { createMockFleetApi, rosterNames } from './mock-fleet.mjs';

export function createScriptedFleetApi(script, { members = rosterNames(4) } = {}) {
  const cursors = new Map(); // goal key → next response index
  const toolFor = (command) => Object.keys(script.tools ?? {}).find(name => command.includes(`${name}.py`) || command.includes(`/${name}/`));
  const keyFor = (prompt) => Object.keys(script.goals ?? {}).find(k => prompt.includes(k)) ?? '__default__';
  const fallback = ['```done\n{"result":"no script","summary":"none"}\n```'];

  const api = createMockFleetApi({
    members,
    commandPayload: (options) => {
      const name = toolFor(options.command ?? '');
      const payload = name ? script.tools[name] : { ok: false, error: `no scripted payload for command: ${options.command}` };
      return JSON.stringify(payload);
    },
    promptResponses: (options) => {
      const key = keyFor(String(options.prompt ?? ''));
      const list = key !== '__default__' ? script.goals[key] : (script.default ?? fallback);
      const i = cursors.get(key) ?? 0;
      cursors.set(key, i + 1);
      return list[Math.min(i, list.length - 1)];
    },
  });

  // Optional per-goal latency so e2e cancel/backpressure cases find a running job.
  const origPrompt = api.executePrompt.bind(api);
  api.executePrompt = async (options) => {
    const delay = script.delays?.[keyFor(String(options.prompt ?? ''))];
    if (delay) await new Promise(r => setTimeout(r, delay));
    return origPrompt(options);
  };
  return api;
}

export async function loadScript(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
```

Both run-loop strategies put the task goal into every prompt they build, so keying on a goal substring is reliable.

- [ ] **Step 4: Add the switch to `host/index.mjs`**

Replace the block that starts `let api = fleetApi;` and ends after `stopFleet = fleet.stop;` with:

```js
  let api = fleetApi;
  let stopFleet = null;
  if (!api && env.FLEET_MOCK_SCRIPT) {
    if (env.NODE_ENV !== 'test') throw new Error('FLEET_MOCK_SCRIPT is only honoured when NODE_ENV=test');
    const { createScriptedFleetApi, loadScript } = await import('../tests/helpers/scripted-fleet.mjs');
    api = createScriptedFleetApi(await loadScript(env.FLEET_MOCK_SCRIPT));
    console.warn(`[host] using scripted fleet from ${env.FLEET_MOCK_SCRIPT} — no LLM calls will be made`);
  }
  if (!api) {
    const { ensureApralabs } = await import('../workflows/demo/ensure-apralabs.mjs');
    ensureApralabs();
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }
```

An empty `FLEET_MOCK_SCRIPT` is falsy and therefore treated as unset; Task 7's compose file relies on that.

- [ ] **Step 5: Run tests**

Run: `node --test tests/host-scripted-fleet.test.mjs && npm run test:host`
Expected: PASS.

- [ ] **Step 6: Add to `test:phase4` and commit (with approval)**

Append ` tests/host-scripted-fleet.test.mjs` to `test:phase4`. Run `npm run test:phase4` → PASS.

```bash
git add tests/helpers/scripted-fleet.mjs tests/host-scripted-fleet.test.mjs host/index.mjs package.json
git commit -m "feat: scripted fleet switch for deterministic e2e runs"
```

---

### Task 6: Black-box e2e suite

**Files:**
- Create: `tests/e2e/scripted-llm.json`, `tests/e2e/scenarios/s01-tokyo-weather.json`, `s02-nyc-time-weather.json`, `s05-us-japan-currency.json`, `s10-europe-capitals.json`, `tests/e2e/webhook-receiver.mjs`, `tests/e2e/task.e2e.test.mjs`
- Modify: `package.json` (`test:e2e` script)

**Interfaces:**
- Consumes: `readSse` from `tests/helpers/sse.mjs`; a running host at `BASE_URL`. Env: `BASE_URL` (required), `E2E_MODE` (`scripted` default | `live`), `E2E_TARGET` (`vm` default | `durable`), `WEBHOOK_RECEIVER_HOST` (default `e2e`), `WEBHOOK_RECEIVER_PORT` (default `9000`), `E2E_RESTART_CMD` (optional, vm only).
- Produces: `startWebhookReceiver({ port, host }) → { port, received, waitFor(pred, timeoutMs), close() }`; the test prints one line `E2E_SUMMARY_JSON {...}` that Task 8's CI parses.

The suite imports no host code. It talks HTTP only, so the same file serves the VM container and the Functions container.

- [ ] **Step 1: Write the scripted LLM file**

```json
// tests/e2e/scripted-llm.json
{
  "tools": {
    "weather":         { "ok": true, "location": "Tokyo", "temp_c": "22", "humidity": "60", "description": "Clear", "wind_speed_kmph": "8", "uv_index": "5" },
    "timezone":        { "ok": true, "timezone": "America/New_York", "datetime": "2026-09-17T06:00:00-04:00", "utc_offset": "-04:00", "abbreviation": "EDT" },
    "country-info":    { "ok": true, "name": "Japan", "capital": "Tokyo", "currency_code": "JPY", "currency_name": "Japanese yen", "languages": ["Japanese"], "region": "Asia", "population": 125000000 },
    "currency":        { "ok": true, "from": "USD", "to": "JPY", "rate": 146.2, "amount": 1, "converted": 146.2 },
    "travel-advisory": { "ok": true, "country": "JP", "score": 1.8, "message": "Exercise normal precautions" }
  },
  "goals": {
    "weather in Tokyo": [
      "```tool_call\n{\"tool\": \"weather\", \"args\": {\"city\": \"Tokyo\"}}\n```",
      "```done\n{\"result\": \"Tokyo is 22C and clear.\", \"summary\": \"Weather retrieved\"}\n```"
    ],
    "time is it in New York": [
      "```plan\n{\"steps\": [{\"type\": \"tool\", \"tool\": \"timezone\", \"args\": {\"city\": \"New York\"}, \"reason\": \"time\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"New York\"}, \"reason\": \"weather\", \"review\": false}, {\"type\": \"reason\", \"prompt\": \"Combine\", \"review\": false}]}\n```",
      "```review\n{\"approved\": true}\n```",
      "It is 06:00 EDT in New York and 22C and clear.",
      "```done\n{\"result\": \"It is 06:00 EDT in New York, 22C and clear.\", \"summary\": \"Combined\"}\n```"
    ],
    "US to Japan": [
      "```plan\n{\"steps\": [{\"type\": \"tool\", \"tool\": \"country-info\", \"args\": {\"country\": \"Japan\"}, \"reason\": \"currency code\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"currency\", \"args\": {}, \"reason\": \"rate\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"travel-advisory\", \"args\": {\"country\": \"JP\"}, \"reason\": \"safety\", \"review\": false}, {\"type\": \"reason\", \"prompt\": \"Synthesize\", \"review\": false}]}\n```",
      "```review\n{\"approved\": true}\n```",
      "```tool_call\n{\"tool\": \"currency\", \"args\": {\"from\": \"USD\", \"to\": \"JPY\"}}\n```",
      "Bring yen. 1 USD = 146.2 JPY. Normal precautions.",
      "```done\n{\"result\": \"Bring JPY; 1 USD = 146.2 JPY; advisory: normal precautions.\", \"summary\": \"Travel prep\"}\n```"
    ],
    "every capital city in Europe": [
      "```plan\n{\"steps\": [{\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Paris\"}, \"reason\": \"1\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Berlin\"}, \"reason\": \"2\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Rome\"}, \"reason\": \"3\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Madrid\"}, \"reason\": \"4\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Vienna\"}, \"reason\": \"5\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Lisbon\"}, \"reason\": \"6\", \"review\": false}, {\"type\": \"tool\", \"tool\": \"weather\", \"args\": {\"city\": \"Oslo\"}, \"reason\": \"7\", \"review\": false}]}\n```",
      "```review\n{\"approved\": true}\n```",
      "```done\n{\"result\": \"partial\", \"summary\": \"partial\"}\n```"
    ]
  },
  "default": ["```done\n{\"result\": \"unscripted goal\", \"summary\": \"none\"}\n```"],
  "delays": { "every capital city in Europe": 1500 }
}
```

Two deliberate details. The `every capital city` goal carries a 1.5 s delay per LLM prompt so the cancel and backpressure cases find the job still `processing`. Scenario s10 uses `maxIterations: 2` in scripted mode: the plan and review prompts reach the cap and the closing `done` prompt trips the budget check, so the outcome is `budget_exceeded` deterministically; in live mode `liveConstraints.maxIterations: 6` lets the real LLM exhaust the budget on its own.

- [ ] **Step 2: Write the scenario fixtures**

```json
// tests/e2e/scenarios/s01-tokyo-weather.json
{ "id": "s01", "title": "Tokyo weather (open-ended)", "goal": "What is the weather in Tokyo?",
  "strategy": "open-ended", "constraints": { "maxIterations": 10 },
  "expectedStatus": ["completed"], "expectedTools": ["weather"] }
```
```json
// tests/e2e/scenarios/s02-nyc-time-weather.json
{ "id": "s02", "title": "NYC time and weather (plan-execute)", "goal": "What time is it in New York and what is the weather like?",
  "strategy": "plan-execute", "constraints": { "maxIterations": 15 },
  "expectedStatus": ["completed"], "expectedTools": ["timezone", "weather"] }
```
```json
// tests/e2e/scenarios/s05-us-japan-currency.json
{ "id": "s05", "title": "US to Japan currency and advisory (dynamic args)", "goal": "I am traveling from the US to Japan. What currency do I need, what is the exchange rate, and are there any travel advisories?",
  "strategy": "plan-execute", "constraints": { "maxIterations": 20 },
  "expectedStatus": ["completed"], "expectedTools": ["country-info", "currency", "travel-advisory"] }
```
```json
// tests/e2e/scenarios/s10-europe-capitals.json
{ "id": "s10", "title": "Europe capitals survey (budget exceeded)", "goal": "Research every capital city in Europe - weather and country info for each.",
  "strategy": "plan-execute", "constraints": { "maxIterations": 2 }, "liveConstraints": { "maxIterations": 6 },
  "expectedStatus": ["budget_exceeded"], "expectedTools": [] }
```

The `strategy` field is informational: the running host decides the strategy from its config (`host.config.mjs` uses `plan-execute`; the open-ended fixture still completes because the scripted first response is a `tool_call`, which plan-execute treats as an invalid plan only if it never sees a `plan` block — s01 therefore also carries a plan-execute script in live mode via the LLM). If s01 fails under plan-execute in scripted mode, change its first scripted response to a one-step `plan` block plus a `review` approval; do not change the host config.

- [ ] **Step 3: Create the webhook receiver**

```js
// tests/e2e/webhook-receiver.mjs
import http from 'node:http';

export function startWebhookReceiver({ port = 0, host = '0.0.0.0' } = {}) {
  const received = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const entry = { headers: req.headers, body: data ? JSON.parse(data) : null, at: Date.now() };
      received.push(entry);
      for (const w of waiters.splice(0)) w(entry);
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    port: server.address().port,
    received,
    waitFor(pred, timeoutMs = 60_000) {
      return new Promise((res, rej) => {
        const hit = received.find(pred);
        if (hit) return res(hit);
        const timer = setTimeout(() => rej(new Error('webhook not received in time')), timeoutMs);
        const waiter = (e) => { if (pred(e)) { clearTimeout(timer); res(e); } else waiters.push(waiter); };
        waiters.push(waiter);
      });
    },
    close: () => new Promise(r => server.close(r)),
  })));
}
```

- [ ] **Step 4: Write the e2e suite**

```js
// tests/e2e/task.e2e.test.mjs
// Black-box: only HTTP against BASE_URL. Never imports host code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSse } from '../helpers/sse.mjs';
import { startWebhookReceiver } from './webhook-receiver.mjs';

const BASE = process.env.BASE_URL;
if (!BASE) throw new Error('BASE_URL is required, e.g. http://agent-vm:3000 or http://agent-durable/api');
const MODE = process.env.E2E_MODE ?? 'scripted';
const TARGET = process.env.E2E_TARGET ?? 'vm';
const TIMEOUT = MODE === 'live' ? 600_000 : 90_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const api = {
  async post(p, body) { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; },
  async get(p) { const r = await fetch(`${BASE}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; },
  async del(p) { const r = await fetch(`${BASE}${p}`, { method: 'DELETE' }); return { status: r.status, body: await r.json().catch(() => null) }; },
  async follow(jobId) {
    const events = [];
    for await (const e of readSse(await fetch(`${BASE}/jobs/${jobId}/events`))) { events.push(e); if (e.event === 'settled') break; }
    return events;
  },
  async waitProcessing(jobId) {
    for (let i = 0; i < 600; i++) {
      const r = await api.get(`/jobs/${jobId}`);
      if (r.body?.status === 'processing') return;
      await sleep(100);
    }
    throw new Error(`job ${jobId} never reached processing`);
  },
};

const summary = [];
test.after(() => { console.log('E2E_SUMMARY_JSON ' + JSON.stringify({ target: TARGET, mode: MODE, results: summary })); });

test('health', async () => { assert.deepEqual((await api.get('/health')).body, { ok: true }); });

const scenarioFiles = (await readdir(path.join(here, 'scenarios'))).filter(f => f.endsWith('.json')).sort();
for (const file of scenarioFiles) {
  const s = JSON.parse(await readFile(path.join(here, 'scenarios', file), 'utf8'));
  test(`scenario ${s.id}: ${s.title}`, { timeout: TIMEOUT }, async () => {
    const t0 = Date.now();
    const constraints = MODE === 'live' && s.liveConstraints ? s.liveConstraints : s.constraints;
    const sub = await api.post('/task', { goal: s.goal, constraints, metadata: { scenario: s.id } });
    assert.equal(sub.status, 202, JSON.stringify(sub.body));
    const { jobId, links } = sub.body;
    assert.equal(links.events, `/jobs/${jobId}/events`);

    const events = await api.follow(jobId);
    const types = events.map(e => e.event);
    assert.equal(types.at(-1), 'settled');
    assert.ok(types.includes('started'), `expected started in ${types}`);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].id > events[i - 1].id, 'ids strictly increase');
    const progress = events.filter(e => e.event === 'progress');
    for (const p of progress) assert.ok(typeof p.data.kind === 'string', 'progress events carry kind');
    const settled = events.at(-1).data;

    const rec = (await api.get(`/jobs/${jobId}`)).body;
    assert.equal(rec.status, settled.status);
    assert.ok(s.expectedStatus.includes(rec.status), `status ${rec.status} not in ${s.expectedStatus}`);
    assert.ok(rec.finishedAt && rec.startedAt, 'timestamps populated');
    assert.ok(Array.isArray(rec.history));
    const toolsSeen = new Set(rec.history.filter(h => h.tool).map(h => h.tool));
    for (const tool of s.expectedTools) assert.ok(toolsSeen.has(tool), `expected tool ${tool} in history; saw ${[...toolsSeen]}`);
    summary.push({ scenario: s.id, status: rec.status, iterations: rec.budget?.iterations ?? null, tokens: rec.budget?.totalTokens ?? null, costUsd: rec.budget?.estimatedCostUsd ?? null, wallMs: Date.now() - t0 });
  });
}

test('unknown job is 404', async () => { assert.equal((await api.get('/jobs/does-not-exist')).status, 404); });

test('cancel a running job settles cancelled', { timeout: TIMEOUT }, async () => {
  const sub = await api.post('/task', { goal: 'Research every capital city in Europe - weather and country info for each.', constraints: { maxIterations: 50 } });
  assert.equal(sub.status, 202);
  const { jobId } = sub.body;
  await api.waitProcessing(jobId);
  const del = await api.del(`/jobs/${jobId}`);
  assert.ok([200, 202].includes(del.status), JSON.stringify(del.body));
  const events = await api.follow(jobId);
  assert.equal(events.at(-1).data.status, 'cancelled');
  assert.equal((await api.get(`/jobs/${jobId}`)).body.status, 'cancelled');
});

test('backpressure returns 429 with Retry-After when the queue is full', { timeout: TIMEOUT }, async () => {
  // agent-vm runs with JOBS_MAX_QUEUE_SIZE=1 JOBS_CONCURRENCY=1; agent-durable with
  // JOBS_MAX_QUEUE_SIZE=2 (Durable counts Running + Pending). Both yield: a=202, b=202, c=429.
  const goal = 'Research every capital city in Europe - weather and country info for each.';
  const a = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  assert.equal(a.status, 202);
  await api.waitProcessing(a.body.jobId);
  const b = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  const c = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  assert.equal(b.status, 202, JSON.stringify(b.body));
  assert.equal(c.status, 429, JSON.stringify(c.body));
  assert.equal(c.headers.get('retry-after'), '30');
  await api.del(`/jobs/${a.body.jobId}`);
  await api.del(`/jobs/${b.body.jobId}`);
  await api.follow(a.body.jobId);
  await api.follow(b.body.jobId);
});

test('webhook delivers exactly one settled event', { timeout: TIMEOUT }, async () => {
  const receiver = await startWebhookReceiver({ port: Number(process.env.WEBHOOK_RECEIVER_PORT ?? 9000) });
  try {
    const url = `http://${process.env.WEBHOOK_RECEIVER_HOST ?? 'e2e'}:${receiver.port}/hook`;
    const sub = await api.post('/task', { goal: 'What is the weather in Tokyo?', constraints: { maxIterations: 10 }, callbackUrl: url });
    assert.equal(sub.status, 202, JSON.stringify(sub.body));
    const hit = await receiver.waitFor(e => e.headers['x-fleet-job-id'] === sub.body.jobId, TIMEOUT - 5000);
    assert.equal(hit.body.type, 'settled');
    await sleep(500);
    assert.equal(receiver.received.filter(e => e.headers['x-fleet-job-id'] === sub.body.jobId).length, 1);
  } finally { await receiver.close(); }
});

test('record survives an agent restart (vm only, needs E2E_RESTART_CMD)', { skip: !(TARGET === 'vm' && process.env.E2E_RESTART_CMD), timeout: TIMEOUT }, async () => {
  const sub = await api.post('/task', { goal: 'What is the weather in Tokyo?', constraints: { maxIterations: 10 } });
  await api.follow(sub.body.jobId);
  execSync(process.env.E2E_RESTART_CMD, { stdio: 'inherit' });
  for (let i = 0; i < 120; i++) { try { if ((await api.get('/health')).status === 200) break; } catch { /* booting */ } await sleep(500); }
  const rec = await api.get(`/jobs/${sub.body.jobId}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.status, 'completed');
});
```

- [ ] **Step 5: Add the `test:e2e` script**

In `package.json` scripts add:

```json
    "test:e2e": "node --test tests/e2e/task.e2e.test.mjs"
```

Run: `node --test tests/package-scripts.test.mjs` → PASS.

- [ ] **Step 6: Run the suite locally against a scripted host**

Terminal 1 (PowerShell):
```powershell
$env:NODE_ENV='test'; $env:FLEET_MOCK_SCRIPT='tests/e2e/scripted-llm.json'; $env:JOBS_MAX_QUEUE_SIZE='1'; $env:JOBS_CONCURRENCY='1'; $env:WEBHOOK_ALLOW_HTTP='true'; $env:JOBS_DB_PATH='./workdir/e2e-jobs.db'; $env:WORKER_POOL_SIZE='2'; npm run host
```
Terminal 2:
```powershell
$env:BASE_URL='http://127.0.0.1:3000'; $env:WEBHOOK_RECEIVER_HOST='127.0.0.1'; npm run test:e2e
```
(bash: prefix each command with the same `NAME=value` pairs.)

Expected: health, 4 scenarios, 404, cancel, 429, webhook PASS; restart skipped. `host.config.mjs` already has `dispatch.enabled: true`, so `/task` answers `202`.

If s01 fails with `invalid_plan` under the host's `plan-execute` strategy, apply the fix described under Step 2 (give s01 a one-step `plan` + `review` script) and re-run.

- [ ] **Step 7: Commit (with approval)**

```bash
git add tests/e2e package.json
git commit -m "test: black-box /task e2e suite with scripted and live modes"
```

---

### Task 7: Functions image and e2e compose

**Files:**
- Create: `deploy/azure-functions/Dockerfile`, `deploy/azure-functions/wwwroot-package.json`, `deploy/azure-functions/host.config.mjs`, `deploy/azure-functions/README.md`
- Create: `docker-compose.e2e.yml`
- Modify: `package.json` (`e2e:vm`, `e2e:durable` scripts)

**Interfaces:**
- Consumes: `comm/azure-functions/main.mjs`, `host.json` (Task 4); the e2e suite and `FLEET_MOCK_SCRIPT` switch (Tasks 5, 6). `resolveDispatchConfig` env overrides `JOBS_BACKEND JOBS_MAX_QUEUE_SIZE JOBS_CONCURRENCY JOBS_DB_PATH DURABLE_TASK_HUB DURABLE_POLL_MS`; `WEBHOOK_ALLOW_HTTP`.
- Produces: image `apra-agent-kit-functions` (Functions host on port 80, routes under `/api`), compose profiles `vm` and `durable`, runner service `e2e`.

- [ ] **Step 1: Verify the Functions base image tag**

```bash
docker manifest inspect mcr.microsoft.com/azure-functions/node:4-node22 > /dev/null && echo OK || echo MISSING
```

If MISSING, use `mcr.microsoft.com/azure-functions/node:4-node20` and add `RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs` before the npm installs in Step 2.

- [ ] **Step 2: Create the Functions Dockerfile and its package.json / host config**

```dockerfile
# deploy/azure-functions/Dockerfile
# The same agent as the VM image, hosted by the Azure Functions runtime. Premium plan only.
FROM mcr.microsoft.com/azure-functions/node:4-node22

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    FUNCTIONS_WORKER_RUNTIME=node \
    WORKER_POOL_SIZE=0 \
    WORKER_EPHEMERAL_MAX=2 \
    JOBS_BACKEND=durable \
    DURABLE_TASK_HUB=fleetjobs

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates git curl \
  && update-ca-certificates \
  && pip install --no-cache-dir --break-system-packages certifi \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /home/site/wwwroot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --include=optional
COPY . .
# The Functions host loads `main` from this package.json; point it at the Functions entry.
COPY deploy/azure-functions/wwwroot-package.json ./package.json
COPY comm/azure-functions/host.json ./host.json
# Adapter azure-functions + backend durable; replaces the repo's express/in-process config.
COPY deploy/azure-functions/host.config.mjs ./host.config.mjs
RUN node -e "import('./workflows/demo/ensure-apralabs.mjs').then(m => m.ensureApralabs())"

HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=12 \
  CMD curl -fsS http://localhost/api/health || exit 1
```

```json
// deploy/azure-functions/wwwroot-package.json
{
  "name": "apra-agent-kit-functions",
  "private": true,
  "type": "module",
  "main": "comm/azure-functions/main.mjs",
  "engines": { "node": ">=22.16" }
}
```

```js
// deploy/azure-functions/host.config.mjs
// Config shipped inside the Functions image. Same modules as the repo config,
// with the Azure adapter and the Durable jobs backend.
export default {
  name: 'apra-agent-kit',
  description: 'Fleet Agent Kit — Azure Functions host',
  fleet: {},
  comm: { adapter: 'azure-functions' },
  modules: {
    runLoop: {
      enabled: true, strategy: 'plan-execute',
      maxReplanAttempts: 3, maxReviewAttempts: 2, maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible', maxNoActionTurns: 3,
    },
    budgets: { enabled: true, maxIterations: 25, maxCostUsd: 5.00, maxTokens: 500_000, timeoutMs: 600_000 },
    guardrails: { enabled: true, defaultPolicy: 'allow', validateInputs: true, dryRunMode: false },
    dispatch: { enabled: true, backend: 'durable', maxQueueSize: 100 },
    notify: { sse: { enabled: true } },
  },
};
```

`.dockerignore` already excludes only `docs`, `.env`, `node_modules`, and editor state, so `tests/` (needed for `FLEET_MOCK_SCRIPT`) is copied. Do not change it.

- [ ] **Step 3: Create `docker-compose.e2e.yml`**

```yaml
# docker-compose.e2e.yml
# Profiles:  vm       → agent-vm (in-process jobs, SQLite)
#            durable  → azurite + agent-durable (Azure Functions host + Durable)
# Run:       docker compose -f docker-compose.e2e.yml --profile vm up -d --wait agent-vm
#            docker compose -f docker-compose.e2e.yml run --rm e2e
name: apra-agent-kit-e2e

# ${VAR-default} (no colon) so an explicitly empty FLEET_MOCK_SCRIPT disables the mock (live mode).
x-agent-env: &agent-env
  NODE_ENV: ${E2E_NODE_ENV-test}
  FLEET_MOCK_SCRIPT: ${FLEET_MOCK_SCRIPT-/workspace/tests/e2e/scripted-llm.json}
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
  WEBHOOK_ALLOW_HTTP: "true"
  WORKER_POOL_SIZE: ${WORKER_POOL_SIZE:-2}
  WORKER_EPHEMERAL_MAX: ${WORKER_EPHEMERAL_MAX:-2}

services:
  agent-vm:
    profiles: [vm]
    build: .
    command: ["node", "host/index.mjs"]
    environment:
      <<: *agent-env
      MCP_BIND_HOST: "0.0.0.0"
      PORT: "3000"
      JOBS_MAX_QUEUE_SIZE: "1"
      JOBS_CONCURRENCY: "1"
      JOBS_DB_PATH: /workspace/workdir/jobs.db
    volumes:
      - vm-workdir:/workspace/workdir
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 20s

  azurite:
    profiles: [durable]
    image: mcr.microsoft.com/azure-storage/azurite
    command: azurite --silent --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0 --location /data
    healthcheck:
      test: ["CMD-SHELL", "nc -z localhost 10000 && nc -z localhost 10001 && nc -z localhost 10002"]
      interval: 5s
      timeout: 3s
      retries: 20

  agent-durable:
    profiles: [durable]
    build:
      context: .
      dockerfile: deploy/azure-functions/Dockerfile
    depends_on:
      azurite: { condition: service_healthy }
    environment:
      <<: *agent-env
      FLEET_MOCK_SCRIPT: ${FLEET_MOCK_SCRIPT-/home/site/wwwroot/tests/e2e/scripted-llm.json}
      # Public, well-known Azurite development key — not a secret.
      AzureWebJobsStorage: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1;"
      JOBS_BACKEND: durable
      DURABLE_TASK_HUB: fleetjobs
      # Durable counts Running + Pending: 2 lets a=Running, b=Pending, c=429 (same shape as vm).
      JOBS_MAX_QUEUE_SIZE: "2"
      DURABLE_POLL_MS: "500"
      WORKER_POOL_SIZE: "0"
    # healthcheck inherited from the Dockerfile (start_period 90s for the extension bundle)

  e2e:
    build: .
    environment:
      BASE_URL: ${BASE_URL:-http://agent-vm:3000}
      E2E_MODE: ${E2E_MODE:-scripted}
      E2E_TARGET: ${E2E_TARGET:-vm}
      WEBHOOK_RECEIVER_HOST: e2e
      WEBHOOK_RECEIVER_PORT: "9000"
    command: ["node", "--test", "tests/e2e/task.e2e.test.mjs"]

volumes:
  vm-workdir:
```

Compose profiles cannot express profile-conditional `depends_on`, so the runner is started in a second step after `up -d --wait agent-<target>`. For the `durable` profile the runner needs `BASE_URL=http://agent-durable/api E2E_TARGET=durable`; the Functions host prefixes routes with `/api` and `toNeutralRequest` strips it.

- [ ] **Step 4: Add compose convenience scripts**

In `package.json` scripts add:

```json
    "e2e:vm": "docker compose -f docker-compose.e2e.yml --profile vm up -d --wait agent-vm && docker compose -f docker-compose.e2e.yml run --rm e2e; docker compose -f docker-compose.e2e.yml --profile vm down -v",
    "e2e:durable": "docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable && BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e; docker compose -f docker-compose.e2e.yml --profile durable down -v"
```

These are bash-shaped (`&&`, `;`, inline env); on Windows run them through Git Bash or use the explicit commands in Step 6. `tests/package-scripts.test.mjs` only checks that `docker-compose.e2e.yml` exists.

- [ ] **Step 5: Write `deploy/azure-functions/README.md`**

```markdown
# Azure Functions deployment

Full guide: [docs/deploy-azure-functions.md](../../docs/deploy-azure-functions.md).

Quick reference:

    # build and run locally against Azurite (same as CI)
    docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable
    BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e
    docker compose -f docker-compose.e2e.yml --profile durable down -v

    # push to Azure (Premium plan, custom container)
    az acr build -r <registry> -t apra-agent-kit-functions:latest -f deploy/azure-functions/Dockerfile .
    az functionapp create -g <rg> -n <app> -p <premium-plan> -s <storage> \
      --functions-version 4 --runtime node --image <registry>.azurecr.io/apra-agent-kit-functions:latest
    az functionapp config appsettings set -g <rg> -n <app> --settings \
      JOBS_BACKEND=durable DURABLE_TASK_HUB=fleetjobs WORKER_POOL_SIZE=0 WORKER_EPHEMERAL_MAX=2 \
      CLAUDE_CODE_OAUTH_TOKEN=<token>
```

- [ ] **Step 6: Bring up both profiles and run the suite**

```bash
docker compose -f docker-compose.e2e.yml --profile vm up -d --wait agent-vm
docker compose -f docker-compose.e2e.yml run --rm e2e
docker compose -f docker-compose.e2e.yml --profile vm down -v

docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable
BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e
docker compose -f docker-compose.e2e.yml --profile durable down -v
```

Expected: every e2e test passes on both targets (restart case skipped). If `agent-durable` never becomes healthy: `docker compose -f docker-compose.e2e.yml --profile durable logs agent-durable` — look for extension-bundle download failures (needs outbound network) or `AzureWebJobsStorage` connection errors. If the bundle download makes cold start exceed the 90 s `start_period`, pre-bake it: add `RUN npm i -g azure-functions-core-tools@4 && func extensions install && npm rm -g azure-functions-core-tools` after the `COPY . .` line and re-test.

- [ ] **Step 7: Commit (with approval)**

```bash
git add docker-compose.e2e.yml deploy/azure-functions package.json
git commit -m "feat: e2e compose profiles for VM and Durable targets, Functions image"
```

---

### Task 8: CI workflows

**Files:**
- Modify: `.github/workflows/ci-host.yml`
- Create: `.github/workflows/ci-e2e.yml`

**Interfaces:**
- Consumes: npm scripts `test:host test:phase2 test:phase4 test:acceptance`, `docker-compose.e2e.yml` profiles, the `E2E_SUMMARY_JSON` line the e2e suite prints.

`ci-host.yml` is currently red: its Docker step runs `tests/host.live.test.mjs`, which 4a moved to `tests/acceptance/`.

- [ ] **Step 1: Rewrite `.github/workflows/ci-host.yml`**

```yaml
name: CI — Host

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  host-unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:host
      - run: npm run test:phase2
      - run: npm run test:phase4

  host-integration-tests:
    runs-on: ubuntu-latest
    needs: host-unit-tests
    env:
      HAS_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker image
        run: docker build -t apra-agent-kit-ci .

      - name: Run host, run-loop and jobs suites in Docker
        run: |
          docker run --rm apra-agent-kit-ci \
            sh -c "npm run test:host && npm run test:phase2 && npm run test:phase4"

      - name: Run acceptance suite (real Fleet)
        if: ${{ env.HAS_OAUTH_TOKEN == 'true' }}
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN apra-agent-kit-ci npm run test:acceptance
```

- [ ] **Step 2: Create `.github/workflows/ci-e2e.yml`**

```yaml
name: CI — E2E (/task path)

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  e2e-scripted:
    name: e2e scripted (${{ matrix.target }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        target: [vm, durable]
    env:
      COMPOSE: docker compose -f docker-compose.e2e.yml
      BASE_URL: ${{ matrix.target == 'vm' && 'http://agent-vm:3000' || 'http://agent-durable/api' }}
      E2E_TARGET: ${{ matrix.target }}
      E2E_MODE: scripted
    steps:
      - uses: actions/checkout@v4
      - name: Build images
        run: $COMPOSE --profile ${{ matrix.target }} build
      - name: Start agent
        run: $COMPOSE --profile ${{ matrix.target }} up -d --wait agent-${{ matrix.target }}
      - name: Run e2e suite
        run: $COMPOSE run --rm e2e | tee e2e-${{ matrix.target }}.log
      - name: Collect logs on failure
        if: failure()
        run: $COMPOSE --profile ${{ matrix.target }} logs --no-color > agent-${{ matrix.target }}.log || true
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: e2e-logs-${{ matrix.target }}
          path: |
            e2e-${{ matrix.target }}.log
            agent-${{ matrix.target }}.log
      - name: Tear down
        if: always()
        run: $COMPOSE --profile ${{ matrix.target }} down -v

  e2e-live:
    name: e2e live (${{ matrix.target }})
    runs-on: ubuntu-latest
    needs: e2e-scripted
    continue-on-error: true
    strategy:
      fail-fast: false
      matrix:
        target: [vm, durable]
    env:
      HAS_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}
      COMPOSE: docker compose -f docker-compose.e2e.yml
      BASE_URL: ${{ matrix.target == 'vm' && 'http://agent-vm:3000' || 'http://agent-durable/api' }}
      E2E_TARGET: ${{ matrix.target }}
      E2E_MODE: live
      E2E_NODE_ENV: production
      FLEET_MOCK_SCRIPT: ""
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - if: ${{ env.HAS_OAUTH_TOKEN == 'true' }}
        run: $COMPOSE --profile ${{ matrix.target }} build
      - if: ${{ env.HAS_OAUTH_TOKEN == 'true' }}
        run: $COMPOSE --profile ${{ matrix.target }} up -d --wait agent-${{ matrix.target }}
      - name: Run live e2e suite
        id: run
        if: ${{ env.HAS_OAUTH_TOKEN == 'true' }}
        run: |
          $COMPOSE run --rm e2e 2>&1 | tee e2e-live-${{ matrix.target }}.log
          summary=$(grep -o 'E2E_SUMMARY_JSON .*' e2e-live-${{ matrix.target }}.log | sed 's/^E2E_SUMMARY_JSON //' | tail -n 1)
          echo "summary=${summary}" >> "$GITHUB_OUTPUT"
      - name: Post results to PR
        if: github.event_name == 'pull_request' && steps.run.outputs.summary != ''
        uses: actions/github-script@v7
        env:
          SUMMARY: ${{ steps.run.outputs.summary }}
        with:
          script: |
            const s = JSON.parse(process.env.SUMMARY);
            const rows = s.results.map(r => `| ${r.scenario} | ${r.status} | ${r.iterations ?? '-'} | ${r.tokens ?? '-'} | ${r.costUsd != null ? '$' + r.costUsd.toFixed(3) : '-'} | ${(r.wallMs / 1000).toFixed(1)}s |`);
            const marker = `## E2E Results — ${s.target}`;
            const body = [marker, '', '| scenario | status | iterations | tokens | cost | wall |', '|---|---|---|---|---|---|', ...rows].join('\n');
            const { data: comments } = await github.rest.issues.listComments({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number });
            const existing = comments.find(c => c.user.type === 'Bot' && c.body.startsWith(marker));
            if (existing) await github.rest.issues.updateComment({ owner: context.repo.owner, repo: context.repo.repo, comment_id: existing.id, body });
            else await github.rest.issues.createComment({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number, body });
      - if: always()
        run: $COMPOSE --profile ${{ matrix.target }} down -v
```

`FLEET_MOCK_SCRIPT: ""` works because the compose file uses `${FLEET_MOCK_SCRIPT-default}` (no colon): an explicitly empty value is kept, and `host/index.mjs` treats an empty string as unset.

- [ ] **Step 3: Lint the workflows**

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color
```

Expected: no errors. If actionlint is unavailable, push the branch and fix any parse errors GitHub reports before requesting review.

- [ ] **Step 4: Commit (with approval)**

```bash
git add .github/workflows/ci-host.yml .github/workflows/ci-e2e.yml
git commit -m "ci: e2e workflow for VM and Durable targets; fix host CI after acceptance move"
```

---

### Task 9: Documentation

**Files:**
- Create: `docs/jobs.md`, `docs/deploy-azure-functions.md`
- Modify: `docs/architecture.md`, `docs/mcp-interface.md`, `docs/development.md`, `docs/run-loop.md`, `docs/README.md`, `README.md`

**Interfaces:**
- Consumes: everything above. Every command in the docs is run against a scripted host before commit (Step 7).

Write for a developer who has never seen this repo. No phase numbers in prose. Project name `apra-agent-kit`.

- [ ] **Step 1: Write `docs/jobs.md`** with exactly these sections:

1. **Overview** — one paragraph: `POST /task` returns `202 { jobId }`; three ways to get the result (poll, SSE, webhook); `?wait=true` for a synchronous response; two backends — `in-process` (SQLite, VM/Docker) and `durable` (Azure Functions) — and when each applies.
2. **Routes** — this table, then one `curl` per row:

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
3. **Job record** — the JSON from the spec's "The job record" section with one line per field; the status transition diagram (`queued → processing → completed | failed | budget_exceeded | cancelled`, `queued → cancelled`); the error-code table (`dispatch_failed`, `interrupted`, `lease_expired`, `run_failed`, `activity_failed`).
4. **Events and SSE** — lifecycle events `queued`, `started`, `settled`; the wire format (`id:` = seq, `event:`, `data:` JSON); `Last-Event-ID` reconnect with replay; `: ping` heartbeat every 25 s; then the **progress event `kind` table**:

   | `kind` | Fields | Meaning |
   |---|---|---|
   | `plan` | `plan.steps[]: { index, type, tool?, description, status:'pending' }` | Plan created |
   | `replan` | same as `plan` | Plan revised after a rejection or failure |
   | `step_started` | `stepIndex`, `step: { type, tool?, args? }` | A step is about to run |
   | `step_completed` | `stepIndex`, `step`, `result: { ok: true, result }` | A step finished |
   | `step_failed` | `stepIndex`, `step`, `error`, `willRetry` | A step failed |
   | `review` | `reviewType: 'plan' \| 'step'`, `approved`, `feedback`, `step?` | Reviewer verdict |

   Every progress event also carries `iteration` and a human-readable `message`. Include a browser `EventSource` snippet that switches on `data.kind`, and point to `tests/helpers/sse.mjs` for Node.
5. **Webhook** — body is the event object; headers `X-Fleet-Job-Id`, `X-Fleet-Event-Seq`; `settled` always, `progress` only with `notify.webhook.sendProgress`; 3 retries with exponential backoff from 1 s; `https` required unless `notify.webhook.allowHttp` / `WEBHOOK_ALLOW_HTTP=true` (development only).
6. **Cancellation** — `queued` jobs are removed and settle `cancelled` immediately; `processing` jobs get an abort signal and settle `cancelled` when the run loop yields; on Azure, cancel latency is bounded by `dispatch.durable.pollMs` (default 2 s).
7. **Backpressure, retention, restart** — `maxQueueSize` → `429`; `retentionMs` (24 h) purge; on restart `queued` jobs resume and `processing` jobs settle `failed / interrupted`; exactly one process per SQLite file.
8. **Configuration** — the `dispatch` and `notify` blocks from `host.config.mjs` and this env table: `JOBS_BACKEND JOBS_MAX_QUEUE_SIZE JOBS_CONCURRENCY JOBS_DB_PATH JOBS_RETENTION_MS DURABLE_TASK_HUB DURABLE_POLL_MS WEBHOOK_ALLOW_HTTP`.
9. **MCP tools** — `submit-task` (`goal`, `inputs?`, `callbackUrl?` → `{ jobId, status, position }`) and `job-status` (`jobId` → record); both skip the worker lease; a short Claude Code walkthrough (`claude mcp add ...`, ask Claude to submit a task and poll it).
10. **Testing** — `npm run test:phase4` (unit), `npm run test:acceptance` (real Fleet), `npm run test:e2e` with `BASE_URL`/`E2E_MODE`, `npm run e2e:vm`, `npm run e2e:durable`; scripted vs live mode and the `FLEET_MOCK_SCRIPT` + `NODE_ENV=test` rule.

- [ ] **Step 2: Write `docs/deploy-azure-functions.md`** with exactly these sections:

1. **Supported and unsupported** — Premium/Dedicated plan with a custom Linux container; no Consumption plan; `/mcp` on Functions uses the MCP SDK's web-standard transport (`WebStandardStreamableHTTPServerTransport`).
2. **How it works** — the diagram: HTTP trigger → `startNew` → orchestrator → activity = run loop; one Fleet child per instance, spawned when `comm/azure-functions/main.mjs` loads; progress via `raiseEvent('progress')`; cancel via `customStatus.cancelRequested` polled by the activity; `customStatus.events` ring of 50 with stable `seq`.
3. **Image** — `deploy/azure-functions/Dockerfile`; `wwwroot-package.json` sets `main`; `host.json` (`functionTimeout: -1`, task hub from `DURABLE_TASK_HUB`); `deploy/azure-functions/host.config.mjs` replaces the repo config (adapter `azure-functions`, backend `durable`).
4. **App settings** — table: `AzureWebJobsStorage`, `DURABLE_TASK_HUB`, `JOBS_BACKEND=durable`, `WORKER_POOL_SIZE=0`, `WORKER_EPHEMERAL_MAX`, `CLAUDE_CODE_OAUTH_TOKEN`, `JOBS_MAX_QUEUE_SIZE`, `DURABLE_POLL_MS`, `WEBHOOK_ALLOW_HTTP` (never in production).
5. **Local run** — the three compose commands from `deploy/azure-functions/README.md`; Azurite; `comm/azure-functions/local.settings.json.example` for Core Tools users.
6. **Deploy** — the `az acr build` / `az functionapp create` / `appsettings set` commands; scale to 2 instances and verify `GET /jobs/:id` answers from both.
7. **Limits and tuning** — `budgets.timeoutMs` vs `dispatch.durable.maxActivityMs`; `pollMs` trades cancel/SSE latency against task-hub reads; ring of 50 events; the 230 s idle cut and the 25 s heartbeat.
8. **Troubleshooting** — extension bundle download, `AzureWebJobsStorage` connection, cold start vs healthcheck window, `Cannot find package '@azure/functions'` (install with `--include=optional`), `dispatch.backend "durable" requires comm.adapter "azure-functions"` (wrong `host.config.mjs` in the image).

- [ ] **Step 3: Update `docs/architecture.md`**

- Module map: add rows for `host/jobs/` (`interface.mjs`, `record.mjs`, `in-process.mjs`, `durable.mjs`, `store/`), `host/notify/` (`index.mjs`, `sse.mjs`, `webhook.mjs`), `host/routes.mjs`, `host/tasks.mjs`, `comm/router.mjs`, `comm/raw-http.mjs`, `comm/azure-functions/` (`http.mjs`, `orchestrator.mjs`, `activity.mjs`, `main.mjs`).
- Layers diagram: add `POST /task → jobs backend → executeHostedTask` and the two backends under `host/`.
- Data flow: add "An async task (POST /task)" mirroring the existing MCP flow: submit → queued event → worker loop / orchestration → started → progress (`kind`) → settled; SSE and webhook fan-out.
- Design decisions: add "Two seams" (comm adapter vs jobs backend), "Progress events are rich" (`kind` + `stepIndex` so a UI can render the plan), "Cancellation is cooperative and polled on Azure".
- Configuration table: add the `JOBS_*`, `DURABLE_*`, `WEBHOOK_ALLOW_HTTP` env vars; add the `dispatch` and `notify` blocks to the host config example (they are already in `host.config.mjs`).

- [ ] **Step 4: Update `docs/mcp-interface.md`**

Add `submit-task` and `job-status` rows to the tool catalog (arguments, behaviour, "no worker lease"), and a short subsection "Job-control tools" with one example call and response for each.

- [ ] **Step 5: Update `docs/development.md`, `docs/run-loop.md`, `docs/README.md`, `README.md`**

- `docs/development.md` "Running things": remove `npm run test:phase2:live` (no longer exists); add `npm run test:phase4`, `npm run test:acceptance`, `npm run test:e2e`, `npm run e2e:vm`, `npm run e2e:durable` rows with their Fleet/token needs; in Testing, describe the three tiers: unit (mock), acceptance (real Fleet, in-process), e2e (containers over HTTP, scripted or live).
- `docs/run-loop.md` Tests table: replace `npm run test:phase2:live` with `npm run test:acceptance`; add one paragraph under "Two interfaces" pointing to `docs/jobs.md` for the async `/task` mode.
- `docs/README.md`: add rows for `jobs.md` and `deploy-azure-functions.md`; add `specs/2026-09-17-fleet-agent-kit-phase4-spec.md` to the Specs table as Implemented.
- `README.md`: under Quick start add an "Async tasks" block with the three `curl.exe` commands (submit, stream, poll) and links to `docs/jobs.md` and `docs/deploy-azure-functions.md`; add both docs to the Docs table.

- [ ] **Step 6: Scan for banned words**

```bash
grep -rn "workflow-kit\|phase2-run-loop\|Phase [1-5]" README.md docs/*.md
```
Expected: no output. (`docs/specs/` and `docs/superpowers/` are out of scope and may keep phase names.)

- [ ] **Step 7: Verify every command in the docs**

Start a scripted host (Task 6 Step 6, terminal 1) and run every `curl.exe` and `npm run` command that appears in `docs/jobs.md` and `README.md`. Fix any command whose output does not match what the doc says. Run `npm run test:phase4 && npm run test:host` once more.

- [ ] **Step 8: Commit (with approval)**

```bash
git add docs README.md
git commit -m "docs: async jobs API, Azure Functions deployment, architecture and test updates"
```

---

## Self-review against the spec

**Spec coverage**

| Spec section | Task |
|---|---|
| Durable backend: mapping, backpressure, cancel (terminate vs raiseEvent), poll-based subscribe, `events()` ring with stable seq, multi-instance correctness | 1 |
| Orchestrator: deterministic, `customStatus` contract, ring of 50 keeping queued/started/settled | 2 |
| `azure-functions` adapter: `enableHttpStream`, one function per route, `/api` prefix stripped, raw MCP route via web-standard transport | 3 |
| Activity: `executeHostedTask` inside Durable, progress as external events, cancel via polled `customStatus`, webhook from the activity | 4 |
| Functions layout: `main.mjs`, `host.json` (`functionTimeout -1`, hub from env), `local.settings.json.example`, Fleet per instance | 4 |
| Scripted fleet + `FLEET_MOCK_SCRIPT` guarded by `NODE_ENV=test` | 5 |
| E2E: black-box `/task` suite, 4 scenarios, 404 / cancel / 429 / webhook / restart, scripted vs live, `E2E_SUMMARY_JSON` | 6 |
| Docker: compose profiles `vm` / `durable`, Azurite, Functions image, healthchecks | 7 |
| CI: `ci-e2e.yml` (scripted required, live gated + PR comment), `ci-host.yml` runs `test:phase4` and `test:acceptance` | 8 |
| Docs: `jobs.md`, `deploy-azure-functions.md`, architecture, mcp-interface, README, index | 9 |
| Open risk "MCP raw route on Azure" | 3 (web-standard transport confirmed present; fallback branch is the real path) |
| Open risk "Durable progress via external events" | 4 note; `DURABLE_POLL_MS` added for tuning |

**Deliberate deviations**

- Fleet spawns eagerly when the Functions entry loads (spec: lazily on first activity). Reason: the worker dispatcher needs `fleetApi` before any route can answer.
- The Azure adapter has its own in-process test suite instead of joining the socket-based `runCommContract` (which requires `adapter.port()`).
- `/health` on Functions returns `{ ok: true }` unconditionally (spec: `503` until the task hub is reachable). The compose healthcheck's 90 s `start_period` covers the extension-bundle cold start instead.
- `agent-durable` runs with `JOBS_MAX_QUEUE_SIZE=2` where `agent-vm` uses `1`, because Durable counts Running + Pending; the observable e2e behaviour (`202, 202, 429`) is identical.
- Progress events on Azure carry the full rich payload (`kind`, `stepIndex`, …), not just `{ iteration, message }`; the orchestrator stores `record.progress` as `{ iteration, message, at }` exactly like the in-process backend.

**Type consistency** — names used across tasks: `createDurableJobs`, `mapDurableStatus`, `ORCHESTRATOR_NAME`, `ACTIVITY_NAME`, `refreshStats` (1); `buildOrchestrator`, `runTaskOrchestrator`, `ringEvents` import (2); `createAzureFunctionsAdapter({ app, extraInputs, loadWebTransport })`, `toNeutralRequest`, `toHttpResponse`, `toFunctionsRoute` (3); `createRunTaskActivity({ getClient, pollMs, getContext })`, `setHostContextFactory`, `getHostContext`, `registerDurableFunctions({ hostContextFactory, pollMs })`, `startHost` return keys `fleetApi dispatcher guardrailsMod runLoopConfig budgetsConfig`, env `DURABLE_POLL_MS` (4); `createScriptedFleetApi(script, { members })`, `loadScript`, env `FLEET_MOCK_SCRIPT` (5); `startWebhookReceiver`, `E2E_SUMMARY_JSON`, env `BASE_URL E2E_MODE E2E_TARGET WEBHOOK_RECEIVER_HOST WEBHOOK_RECEIVER_PORT E2E_RESTART_CMD` (6); compose services `agent-vm agent-durable azurite e2e`, profiles `vm durable`, scripts `test:e2e e2e:vm e2e:durable` (6, 7, 8). Verified consistent.
