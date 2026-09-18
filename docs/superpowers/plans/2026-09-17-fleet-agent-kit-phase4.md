# Fleet Agent Kit — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent deployable as a service: `POST /task` returns `202 { jobId }`, jobs are queued and persisted, callers follow progress over SSE or webhook and can cancel, and the same agent runs unchanged on a VM/Docker (in-process queue + SQLite) and on Azure Functions (Durable Functions), behind a framework-neutral comm layer.

**Architecture:** Two pluggable seams. The **comm adapter** owns HTTP shape and speaks a neutral `handler(request) → response` contract (`express`, `raw-http`, `azure-functions`). The **jobs backend** owns queueing and job records (`in-process` over `node:sqlite`, `durable` over Azure Durable Functions). Both backends call the existing Phase 2 `executeHostedTask`, which gains a progress callback. A **notifier** fans job events out to SSE and webhook. A black-box e2e suite drives `/task` against both containers in Docker.

**Tech Stack:** Node 22 (≥ 22.16), ESM, `node:test`, `node:sqlite` (`DatabaseSync`), Zod v4, Express 5, `@azure/functions` v4 + `durable-functions` v3 (optional deps, lazy-loaded), Azurite, Docker Compose, GitHub Actions.

**Spec:** `docs/specs/2026-09-17-fleet-agent-kit-phase4-spec.md`

## Global Constraints

- Node `>=22.16` (package.json `engines`). `node:sqlite` is used unflagged; write against `DatabaseSync` only.
- `@azure/functions` and `durable-functions` are `optionalDependencies` and must be imported lazily (dynamic `import()`) only when the Azure adapter or Durable backend is configured. Non-Azure code paths never load them.
- Errors are values inside tools and the run loop. Only `AbortSignal` cancellation throws.
- Every job record and job event has the exact shape given in the spec sections "The job record" and "Job events". Status strings: `queued | processing | completed | failed | cancelled | budget_exceeded`.
- Sync `POST /task?wait=true` keeps the Phase 2 response shape byte-for-byte: `{ taskId, status, result, history, budget }`.
- Existing test scripts `test:host`, `test:phase2`, `test:unit`, `test:integration` must keep passing after every task.
- Work happens on a new branch `feature/fleet-agent-kit-phase4` cut from the current HEAD of `cursor/fleet-agent-kit-phase2-impl-9f5b`.
- **Commits:** Siddharth's rules apply. A "Commit" step means: stage the listed files and ask Siddharth for approval before running `git commit`. Never commit automatically. Never add `Co-Authored-By` or any AI attribution. Never push to `main`, `master`, or `development`.
- Config file is `host.config.mjs` (not `agent.config.mjs`). Module namespace is `host/`.
- Never read or print the contents of `.env`.

---

## Task dependency graph

```
Task 0  branch + optional deps               (first)
Task 1  job record + errors                  (independent)
Task 2  store contract + memory store        (needs 1)
Task 3  sqlite store                         (needs 2)
Task 4  run-loop onIteration + host/tasks.mjs (independent)
Task 5  in-process jobs backend              (needs 1, 2, 4)
Task 6  notifier: SSE + webhook              (needs 1, 2)
Task 7  neutral comm contract + express + raw-http (independent)
Task 8  config: dispatch/notify/adapters      (independent)
Task 9  host wiring: routes, jobs, notifier, builder (needs 4, 5, 6, 7, 8)
Task 10 MCP tools submit-task / job-status    (needs 9)
Task 11 durable jobs backend                  (needs 1, 5)
Task 12 azure-functions adapter + orchestrator + activity (needs 7, 9, 11)
Task 13 scripted fleet switch + SSE helper + e2e suite (needs 9, 10)
Task 14 docker: compose e2e + functions Dockerfile (needs 12, 13)
Task 15 acceptance suite + npm scripts        (needs 9)
Task 16 CI workflows                          (needs 13, 14, 15)
Task 17 documentation                         (needs all)
```

Tasks 1, 4, 7, 8 can run in parallel after Task 0.

---

### Task 0: Branch and optional dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout cursor/fleet-agent-kit-phase2-impl-9f5b
git pull --ff-only
git checkout -b feature/fleet-agent-kit-phase4
```

- [ ] **Step 2: Add optional dependencies and confirm `node:sqlite` is available**

Edit `package.json`: add after `"dependencies"`:

```json
  "optionalDependencies": {
    "@azure/functions": "^4.7.0",
    "durable-functions": "^3.1.0"
  },
```

Run:

```bash
npm install
node -e "import('node:sqlite').then(m => console.log(typeof m.DatabaseSync))"
```

Expected: `function`. If it prints an error, the Node version is below 22.13; stop and upgrade Node.

- [ ] **Step 3: Verify the MCP SDK exposes a web-standard transport (needed by Task 12)**

```bash
node -e "import('@modelcontextprotocol/server').then(m => console.log(Object.keys(m).filter(k => /Streamable/i.test(k))))"
node -e "import('@modelcontextprotocol/node').then(m => console.log(Object.keys(m).filter(k => /Streamable/i.test(k))))"
```

Record the exact export names in a comment at the top of this plan's Task 12 before executing it. Expected: `@modelcontextprotocol/server` lists a `WebStandardStreamableHTTPServerTransport` (or similarly named) class; `@modelcontextprotocol/node` lists `NodeStreamableHTTPServerTransport`. If no web-standard transport exists, Task 12 uses its documented fallback.

- [ ] **Step 4: Run the existing suites to establish a green baseline**

```bash
npm run test:host && npm run test:phase2 && npm run test:unit
```

Expected: all pass.

- [ ] **Step 5: Commit (with approval)**

```bash
git add package.json package-lock.json
git commit -m "chore: add optional Azure Functions dependencies for Phase 4"
```

---

### Task 1: Job record, transitions, events, and error types

**Files:**
- Create: `host/jobs/interface.mjs`
- Create: `host/jobs/record.mjs`
- Test: `tests/host-jobs-record.test.mjs`

**Interfaces:**
- Produces:
  - `interface.mjs`: `class JobQueueFullError`, `class JobsClosedError`, `class InvalidCallbackUrlError`, `class IllegalTransitionError`, `validateCallbackUrl(url, { allowHttp }) → string`, `assertJobsBackend(obj)` (throws if any required method is missing).
  - `record.mjs`: `STATUSES`, `TERMINAL_STATUSES: Set`, `canTransition(from, to) → boolean`, `assertTransition(from, to)`, `newJobId() → string`, `createRecord(task, { id, callbackUrl, metadata, now }) → JobRecord`, `queuedEvent(jobId, position, now)`, `startedEvent(jobId, now)`, `progressEvent(jobId, iteration, message, now)`, `settledEvent(jobId, { status, result, error }, now)`, `ringEvents(events, max = 50) → events`, `settleFromRunResult(runResult) → { status, result, error, history, budget }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-jobs-record.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rec = await import('../host/jobs/record.mjs');
const iface = await import('../host/jobs/interface.mjs');

const NOW = new Date('2026-09-17T10:00:00.000Z');

test('createRecord produces the spec shape with queued status', () => {
  const r = rec.createRecord({ goal: 'g', inputs: { a: 1 } }, { id: 'job-1', callbackUrl: null, metadata: { p: 1 }, now: NOW });
  assert.equal(r.id, 'job-1');
  assert.equal(r.status, 'queued');
  assert.deepEqual(r.task, { goal: 'g', inputs: { a: 1 }, constraints: {}, budget: {} });
  assert.equal(r.submittedAt, NOW.toISOString());
  assert.equal(r.startedAt, null);
  assert.equal(r.finishedAt, null);
  assert.equal(r.attempts, 1);
  assert.equal(r.result, null);
  assert.deepEqual(r.history, []);
  assert.equal(r.budget, null);
  assert.deepEqual(r.progress, { iteration: 0, message: null, at: null });
  assert.equal(r.callbackUrl, null);
  assert.deepEqual(r.metadata, { p: 1 });
  assert.equal(r.error, null);
});

test('newJobId has the job- prefix and is unique', () => {
  const a = rec.newJobId(); const b = rec.newJobId();
  assert.match(a, /^job-[a-f0-9]{12}$/);
  assert.notEqual(a, b);
});

test('transitions follow the spec state machine', () => {
  assert.equal(rec.canTransition('queued', 'processing'), true);
  assert.equal(rec.canTransition('queued', 'cancelled'), true);
  assert.equal(rec.canTransition('queued', 'completed'), false);
  for (const t of ['completed', 'failed', 'cancelled', 'budget_exceeded']) {
    assert.equal(rec.canTransition('processing', t), true);
  }
  assert.equal(rec.canTransition('completed', 'processing'), false);
  assert.equal(rec.canTransition('cancelled', 'completed'), false);
  assert.throws(() => rec.assertTransition('completed', 'failed'), iface.IllegalTransitionError);
});

test('event constructors produce the spec shapes', () => {
  assert.deepEqual(rec.queuedEvent('j', 3, NOW), { type: 'queued', jobId: 'j', at: NOW.toISOString(), position: 3 });
  assert.deepEqual(rec.startedEvent('j', NOW), { type: 'started', jobId: 'j', at: NOW.toISOString() });
  assert.deepEqual(rec.progressEvent('j', 2, 'calling weather', NOW),
    { type: 'progress', jobId: 'j', at: NOW.toISOString(), iteration: 2, message: 'calling weather' });
  assert.deepEqual(rec.settledEvent('j', { status: 'completed', result: { x: 1 }, error: null }, NOW),
    { type: 'settled', jobId: 'j', at: NOW.toISOString(), status: 'completed', result: { x: 1 }, error: null });
});

test('ringEvents drops oldest progress events but keeps lifecycle events', () => {
  const events = [rec.queuedEvent('j', 1, NOW), rec.startedEvent('j', NOW)];
  for (let i = 1; i <= 60; i++) events.push(rec.progressEvent('j', i, `step ${i}`, NOW));
  events.push(rec.settledEvent('j', { status: 'completed', result: 1, error: null }, NOW));
  const out = rec.ringEvents(events, 50);
  assert.equal(out.length, 50);
  assert.equal(out[0].type, 'queued');
  assert.equal(out[1].type, 'started');
  assert.equal(out.at(-1).type, 'settled');
  assert.equal(out[2].iteration, 14); // 60 progress - 47 kept = first 13 dropped
});

test('settleFromRunResult maps run loop outcomes', () => {
  assert.deepEqual(
    rec.settleFromRunResult({ status: 'completed', result: 'ok', history: [1], budget: { iterations: 2 } }),
    { status: 'completed', result: 'ok', error: null, history: [1], budget: { iterations: 2 } });
  assert.deepEqual(
    rec.settleFromRunResult({ status: 'failed', result: { error: 'no_action', message: 'm' }, history: [], budget: null }),
    { status: 'failed', result: null, error: { code: 'run_failed', message: 'no_action: m' }, history: [], budget: null });
  assert.equal(rec.settleFromRunResult({ status: 'budget_exceeded', result: { budgetReason: 'max_iterations' }, history: [], budget: null }).status, 'budget_exceeded');
  assert.equal(rec.settleFromRunResult({ status: 'cancelled', result: null, history: [], budget: null }).status, 'cancelled');
});

test('validateCallbackUrl enforces https unless allowHttp', () => {
  assert.equal(iface.validateCallbackUrl('https://x.test/hook', { allowHttp: false }), 'https://x.test/hook');
  assert.throws(() => iface.validateCallbackUrl('http://x.test/hook', { allowHttp: false }), iface.InvalidCallbackUrlError);
  assert.equal(iface.validateCallbackUrl('http://x.test/hook', { allowHttp: true }), 'http://x.test/hook');
  assert.throws(() => iface.validateCallbackUrl('not a url', { allowHttp: true }), iface.InvalidCallbackUrlError);
  assert.equal(iface.validateCallbackUrl(undefined, { allowHttp: false }), null);
});

test('assertJobsBackend rejects incomplete objects', () => {
  assert.throws(() => iface.assertJobsBackend({ submit() {} }), /jobs backend missing/);
  const ok = { start() {}, stop() {}, submit() {}, get() {}, cancel() {}, subscribe() {}, events() {}, stats() {} };
  assert.doesNotThrow(() => iface.assertJobsBackend(ok));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-record.test.mjs`
Expected: FAIL with `Cannot find module '.../host/jobs/record.mjs'`.

- [ ] **Step 3: Implement `host/jobs/interface.mjs`**

```js
// host/jobs/interface.mjs
//
// Every jobs backend implements:
//   async start()
//   async stop({ drainMs })
//   async submit(task, { callbackUrl, metadata }) → { jobId, status: 'queued', position }
//   async get(jobId)                               → JobRecord | null
//   async cancel(jobId)                            → { ok, status }
//   subscribe(jobId, onEvent)                      → unsubscribe()
//   async events(jobId, { afterSeq })              → JobEvent[] (each with seq)
//   stats()                                        → { queued, processing, capacity, maxQueueSize }

export class JobQueueFullError extends Error {
  constructor(message = 'job queue is full; retry later') { super(message); this.name = 'JobQueueFullError'; }
}
export class JobsClosedError extends Error {
  constructor(message = 'jobs backend is shutting down') { super(message); this.name = 'JobsClosedError'; }
}
export class InvalidCallbackUrlError extends Error {
  constructor(message) { super(message); this.name = 'InvalidCallbackUrlError'; }
}
export class IllegalTransitionError extends Error {
  constructor(from, to) { super(`illegal job transition ${from} → ${to}`); this.name = 'IllegalTransitionError'; }
}

const REQUIRED = ['start', 'stop', 'submit', 'get', 'cancel', 'subscribe', 'events', 'stats'];

export function assertJobsBackend(obj) {
  const missing = REQUIRED.filter(k => typeof obj?.[k] !== 'function');
  if (missing.length) throw new Error(`jobs backend missing: ${missing.join(', ')}`);
  return obj;
}

export function validateCallbackUrl(url, { allowHttp = false } = {}) {
  if (url === undefined || url === null || url === '') return null;
  let parsed;
  try { parsed = new URL(String(url)); } catch {
    throw new InvalidCallbackUrlError(`callbackUrl is not a valid URL: ${String(url)}`);
  }
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol === 'http:' && allowHttp) return parsed.toString();
  throw new InvalidCallbackUrlError(
    `callbackUrl must use https (got ${parsed.protocol}); set notify.webhook.allowHttp for development`,
  );
}
```

- [ ] **Step 4: Implement `host/jobs/record.mjs`**

```js
// host/jobs/record.mjs
import { randomUUID } from 'node:crypto';
import { IllegalTransitionError } from './interface.mjs';

export const STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled', 'budget_exceeded'];
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

const TRANSITIONS = {
  queued: new Set(['processing', 'cancelled']),
  processing: TERMINAL_STATUSES,
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function newJobId() {
  return `job-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

export function createRecord(task, { id = newJobId(), callbackUrl = null, metadata = {}, now = new Date() } = {}) {
  return {
    id,
    status: 'queued',
    task: {
      goal: task.goal,
      inputs: task.inputs ?? {},
      constraints: task.constraints ?? {},
      budget: task.budget ?? {},
    },
    submittedAt: iso(now),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    result: null,
    history: [],
    budget: null,
    progress: { iteration: 0, message: null, at: null },
    callbackUrl,
    metadata: metadata ?? {},
    error: null,
  };
}

export const queuedEvent = (jobId, position, now = new Date()) =>
  ({ type: 'queued', jobId, at: iso(now), position });
export const startedEvent = (jobId, now = new Date()) =>
  ({ type: 'started', jobId, at: iso(now) });
export const progressEvent = (jobId, iteration, message, now = new Date()) =>
  ({ type: 'progress', jobId, at: iso(now), iteration, message });
export const settledEvent = (jobId, { status, result = null, error = null }, now = new Date()) =>
  ({ type: 'settled', jobId, at: iso(now), status, result, error });

// Keep the newest `max` events, but never drop queued/started/settled.
export function ringEvents(events, max = 50) {
  if (events.length <= max) return events;
  const keep = events.filter(e => e.type !== 'progress');
  const budget = Math.max(0, max - keep.length);
  const progress = events.filter(e => e.type === 'progress').slice(-budget);
  return events.filter(e => e.type !== 'progress' || progress.includes(e));
}

// Run loop → { status, result, error }. The run loop puts failure details in
// `result`; the job record wants them in `error`.
export function settleFromRunResult(run) {
  const base = { history: run.history ?? [], budget: run.budget ?? null };
  if (run.status === 'failed') {
    const code = run.result?.error === 'dispatch_failed' ? 'dispatch_failed' : 'run_failed';
    const message = run.result?.error
      ? `${run.result.error}: ${run.result.message ?? ''}`.trim().replace(/:$/, '')
      : 'run loop failed';
    return { status: 'failed', result: null, error: { code, message }, ...base };
  }
  return { status: run.status, result: run.result ?? null, error: null, ...base };
}
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/host-jobs-record.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit (with approval)**

```bash
git add host/jobs/interface.mjs host/jobs/record.mjs tests/host-jobs-record.test.mjs
git commit -m "feat: add job record model, transitions, events, and jobs interface errors"
```

---

### Task 2: Store contract and memory store

**Files:**
- Create: `host/jobs/store/interface.mjs`
- Create: `host/jobs/store/memory.mjs`
- Create: `tests/helpers/store-contract.mjs`
- Test: `tests/host-jobs-store.test.mjs`

**Interfaces:**
- Produces `createMemoryStore() → JobStore` where `JobStore` is:
  ```js
  {
    async open(), async close(),
    async insert(record),                 // throws if id exists
    async get(id) → record | null,
    async update(id, patch) → record,     // shallow merge, throws if missing
    async claim(id, startedAt) → boolean, // atomic queued→processing; true iff exactly one row changed
    async listByStatus(status) → record[] // ordered by submittedAt asc
    async appendEvent(jobId, event) → seq // 1-based per job
    async events(jobId, { afterSeq = 0 } = {}) → [{ seq, ...event }]
    async purgeFinishedBefore(isoTimestamp) → number  // deletes terminal records + their events
    async countByStatus() → { queued, processing, ... }
  }
  ```
- Produces `runStoreContract(name, makeStore)` in `tests/helpers/store-contract.mjs`, reused by Task 3.

- [ ] **Step 1: Write the shared contract suite**

```js
// tests/helpers/store-contract.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, progressEvent } from '../../host/jobs/record.mjs';

export function runStoreContract(name, makeStore) {
  const T0 = new Date('2026-09-17T10:00:00.000Z');
  const T1 = new Date('2026-09-17T10:00:01.000Z');

  test(`${name}: insert then get round-trips a record`, async () => {
    const store = await makeStore(); await store.open();
    try {
      const r = createRecord({ goal: 'g' }, { id: 'job-a', now: T0 });
      await store.insert(r);
      assert.deepEqual(await store.get('job-a'), r);
      assert.equal(await store.get('nope'), null);
    } finally { await store.close(); }
  });

  test(`${name}: insert rejects duplicate id`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      await assert.rejects(() => store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 })), /exists/);
    } finally { await store.close(); }
  });

  test(`${name}: update merges and returns the record`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      const out = await store.update('job-a', { status: 'processing', startedAt: T1.toISOString() });
      assert.equal(out.status, 'processing');
      assert.equal((await store.get('job-a')).startedAt, T1.toISOString());
      await assert.rejects(() => store.update('nope', {}), /not found/);
    } finally { await store.close(); }
  });

  test(`${name}: claim is atomic and only succeeds once`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      assert.equal(await store.claim('job-a', T1.toISOString()), true);
      assert.equal(await store.claim('job-a', T1.toISOString()), false);
      const r = await store.get('job-a');
      assert.equal(r.status, 'processing');
      assert.equal(r.startedAt, T1.toISOString());
    } finally { await store.close(); }
  });

  test(`${name}: listByStatus orders by submittedAt`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'b' }, { id: 'job-b', now: T1 }));
      await store.insert(createRecord({ goal: 'a' }, { id: 'job-a', now: T0 }));
      await store.insert({ ...createRecord({ goal: 'c' }, { id: 'job-c', now: T0 }), status: 'completed' });
      assert.deepEqual((await store.listByStatus('queued')).map(r => r.id), ['job-a', 'job-b']);
      assert.deepEqual(await store.countByStatus(), { queued: 2, completed: 1 });
    } finally { await store.close(); }
  });

  test(`${name}: events append with per-job seq and replay after seq`, async () => {
    const store = await makeStore(); await store.open();
    try {
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-a', now: T0 }));
      await store.insert(createRecord({ goal: 'g' }, { id: 'job-b', now: T0 }));
      assert.equal(await store.appendEvent('job-a', progressEvent('job-a', 1, 'one', T0)), 1);
      assert.equal(await store.appendEvent('job-a', progressEvent('job-a', 2, 'two', T0)), 2);
      assert.equal(await store.appendEvent('job-b', progressEvent('job-b', 1, 'b1', T0)), 1);
      const all = await store.events('job-a');
      assert.deepEqual(all.map(e => [e.seq, e.message]), [[1, 'one'], [2, 'two']]);
      const after = await store.events('job-a', { afterSeq: 1 });
      assert.deepEqual(after.map(e => e.seq), [2]);
    } finally { await store.close(); }
  });

  test(`${name}: purgeFinishedBefore removes old terminal records and their events`, async () => {
    const store = await makeStore(); await store.open();
    try {
      const old = { ...createRecord({ goal: 'g' }, { id: 'job-old', now: T0 }), status: 'completed', finishedAt: T0.toISOString() };
      const fresh = { ...createRecord({ goal: 'g' }, { id: 'job-new', now: T0 }), status: 'completed', finishedAt: T1.toISOString() };
      const running = { ...createRecord({ goal: 'g' }, { id: 'job-run', now: T0 }), status: 'processing' };
      for (const r of [old, fresh, running]) await store.insert(r);
      await store.appendEvent('job-old', progressEvent('job-old', 1, 'x', T0));
      const n = await store.purgeFinishedBefore(new Date('2026-09-17T10:00:00.500Z').toISOString());
      assert.equal(n, 1);
      assert.equal(await store.get('job-old'), null);
      assert.deepEqual(await store.events('job-old'), []);
      assert.ok(await store.get('job-new'));
      assert.ok(await store.get('job-run'));
    } finally { await store.close(); }
  });
}
```

- [ ] **Step 2: Write the test file that runs the contract against the memory store**

```js
// tests/host-jobs-store.test.mjs
import { runStoreContract } from './helpers/store-contract.mjs';

const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
runStoreContract('memory', async () => createMemoryStore());
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/host-jobs-store.test.mjs`
Expected: FAIL, cannot find `host/jobs/store/memory.mjs`.

- [ ] **Step 4: Write the store interface doc and memory store**

```js
// host/jobs/store/interface.mjs
// Persistence contract for job records and events. See tests/helpers/store-contract.mjs
// for the executable specification. Both implementations are async so callers
// never depend on node:sqlite being synchronous.
export const STORE_METHODS = [
  'open', 'close', 'insert', 'get', 'update', 'claim',
  'listByStatus', 'appendEvent', 'events', 'purgeFinishedBefore', 'countByStatus',
];

export function assertJobStore(store) {
  const missing = STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`job store missing: ${missing.join(', ')}`);
  return store;
}
```

```js
// host/jobs/store/memory.mjs
import { TERMINAL_STATUSES } from '../record.mjs';

const clone = (v) => structuredClone(v);

export function createMemoryStore() {
  const records = new Map();
  const events = new Map(); // jobId → [{ seq, ...event }]

  return {
    async open() {},
    async close() {},

    async insert(record) {
      if (records.has(record.id)) throw new Error(`job ${record.id} already exists`);
      records.set(record.id, clone(record));
    },

    async get(id) {
      const r = records.get(id);
      return r ? clone(r) : null;
    },

    async update(id, patch) {
      const r = records.get(id);
      if (!r) throw new Error(`job ${id} not found`);
      const next = { ...r, ...clone(patch) };
      records.set(id, next);
      return clone(next);
    },

    async claim(id, startedAt) {
      const r = records.get(id);
      if (!r || r.status !== 'queued') return false;
      records.set(id, { ...r, status: 'processing', startedAt });
      return true;
    },

    async listByStatus(status) {
      return [...records.values()]
        .filter(r => r.status === status)
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id))
        .map(clone);
    },

    async countByStatus() {
      const out = {};
      for (const r of records.values()) out[r.status] = (out[r.status] ?? 0) + 1;
      return out;
    },

    async appendEvent(jobId, event) {
      const list = events.get(jobId) ?? [];
      const seq = list.length + 1;
      list.push({ seq, ...clone(event) });
      events.set(jobId, list);
      return seq;
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      return (events.get(jobId) ?? []).filter(e => e.seq > afterSeq).map(clone);
    },

    async purgeFinishedBefore(isoTimestamp) {
      let n = 0;
      for (const [id, r] of records) {
        if (TERMINAL_STATUSES.has(r.status) && r.finishedAt && r.finishedAt < isoTimestamp) {
          records.delete(id); events.delete(id); n += 1;
        }
      }
      return n;
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/host-jobs-store.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit (with approval)**

```bash
git add host/jobs/store/interface.mjs host/jobs/store/memory.mjs tests/helpers/store-contract.mjs tests/host-jobs-store.test.mjs
git commit -m "feat: add job store contract and in-memory store"
```

---

### Task 3: SQLite store

**Files:**
- Create: `host/jobs/store/sqlite.mjs`
- Modify: `tests/host-jobs-store.test.mjs`

**Interfaces:**
- Produces `createSqliteStore({ dbPath }) → JobStore` (same contract as Task 2).

- [ ] **Step 1: Extend the test file to run the contract against SQLite in a temp file**

Append to `tests/host-jobs-store.test.mjs`:

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createSqliteStore } = await import('../host/jobs/store/sqlite.mjs');
runStoreContract('sqlite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-sqlite-'));
  return createSqliteStore({ dbPath: path.join(dir, 'jobs.db') });
});
```

And one SQLite-specific persistence test:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../host/jobs/record.mjs';

test('sqlite: records survive close and reopen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-sqlite-'));
  const dbPath = path.join(dir, 'jobs.db');
  const a = createSqliteStore({ dbPath }); await a.open();
  await a.insert(createRecord({ goal: 'persist' }, { id: 'job-p' }));
  await a.appendEvent('job-p', { type: 'started', jobId: 'job-p', at: new Date().toISOString() });
  await a.close();
  const b = createSqliteStore({ dbPath }); await b.open();
  try {
    assert.equal((await b.get('job-p')).task.goal, 'persist');
    assert.equal((await b.events('job-p')).length, 1);
  } finally { await b.close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-store.test.mjs`
Expected: FAIL, cannot find `host/jobs/store/sqlite.mjs`.

- [ ] **Step 3: Implement the SQLite store**

```js
// host/jobs/store/sqlite.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TERMINAL_STATUSES } from '../record.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  record       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  at     TEXT NOT NULL,
  event  TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
`;

export function createSqliteStore({ dbPath }) {
  if (!dbPath) throw new Error('createSqliteStore requires dbPath');
  let db = null;
  let stmts = null;

  const ensureOpen = () => { if (!db) throw new Error('sqlite store is not open'); };
  const terminalList = [...TERMINAL_STATUSES].map(s => `'${s}'`).join(',');

  return {
    async open() {
      if (db) return;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);
      stmts = {
        insert: db.prepare('INSERT INTO jobs (id, status, submitted_at, started_at, finished_at, record) VALUES (?, ?, ?, ?, ?, ?)'),
        get: db.prepare('SELECT record FROM jobs WHERE id = ?'),
        update: db.prepare('UPDATE jobs SET status = ?, started_at = ?, finished_at = ?, record = ? WHERE id = ?'),
        claim: db.prepare("UPDATE jobs SET status = 'processing', started_at = ?, record = json_set(record, '$.status', 'processing', '$.startedAt', ?) WHERE id = ? AND status = 'queued'"),
        byStatus: db.prepare('SELECT record FROM jobs WHERE status = ? ORDER BY submitted_at ASC, id ASC'),
        count: db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
        nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE job_id = ?'),
        appendEvent: db.prepare('INSERT INTO events (job_id, seq, at, event) VALUES (?, ?, ?, ?)'),
        events: db.prepare('SELECT seq, event FROM events WHERE job_id = ? AND seq > ? ORDER BY seq ASC'),
        purgeEvents: db.prepare(`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE status IN (${terminalList}) AND finished_at IS NOT NULL AND finished_at < ?)`),
        purgeJobs: db.prepare(`DELETE FROM jobs WHERE status IN (${terminalList}) AND finished_at IS NOT NULL AND finished_at < ?`),
      };
    },

    async close() {
      if (!db) return;
      db.close(); db = null; stmts = null;
    },

    async insert(record) {
      ensureOpen();
      if (stmts.get.get(record.id)) throw new Error(`job ${record.id} already exists`);
      stmts.insert.run(record.id, record.status, record.submittedAt, record.startedAt, record.finishedAt, JSON.stringify(record));
    },

    async get(id) {
      ensureOpen();
      const row = stmts.get.get(id);
      return row ? JSON.parse(row.record) : null;
    },

    async update(id, patch) {
      ensureOpen();
      const row = stmts.get.get(id);
      if (!row) throw new Error(`job ${id} not found`);
      const next = { ...JSON.parse(row.record), ...patch };
      stmts.update.run(next.status, next.startedAt, next.finishedAt, JSON.stringify(next), id);
      return next;
    },

    async claim(id, startedAt) {
      ensureOpen();
      const { changes } = stmts.claim.run(startedAt, startedAt, id);
      return changes === 1;
    },

    async listByStatus(status) {
      ensureOpen();
      return stmts.byStatus.all(status).map(r => JSON.parse(r.record));
    },

    async countByStatus() {
      ensureOpen();
      const out = {};
      for (const row of stmts.count.all()) out[row.status] = Number(row.n);
      return out;
    },

    async appendEvent(jobId, event) {
      ensureOpen();
      const { seq } = stmts.nextSeq.get(jobId);
      stmts.appendEvent.run(jobId, seq, event.at, JSON.stringify(event));
      return Number(seq);
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      ensureOpen();
      return stmts.events.all(jobId, afterSeq).map(r => ({ seq: Number(r.seq), ...JSON.parse(r.event) }));
    },

    async purgeFinishedBefore(isoTimestamp) {
      ensureOpen();
      stmts.purgeEvents.run(isoTimestamp);
      const { changes } = stmts.purgeJobs.run(isoTimestamp);
      return Number(changes);
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/host-jobs-store.test.mjs`
Expected: PASS (15 tests: 7 memory, 7 sqlite, 1 persistence).

- [ ] **Step 5: Commit (with approval)**

```bash
git add host/jobs/store/sqlite.mjs tests/host-jobs-store.test.mjs
git commit -m "feat: add SQLite job store on node:sqlite"
```

---

### Task 4: Run-loop progress hook and `host/tasks.mjs`

Extracts `executeHostedTask` out of `host/index.mjs` into its own module and adds a progress callback. Both jobs backends and the sync route call this one function.

**Files:**
- Modify: `host/run-loop.mjs`
- Create: `host/tasks.mjs`
- Modify: `host/index.mjs:47-110` (delete `mergeBudgetConfig`, `createRequestBudgets`, `executeHostedTask`; import from `./tasks.mjs`)
- Test: `tests/host-run-loop.test.mjs` (append), `tests/host-tasks.test.mjs` (new)

**Interfaces:**
- Consumes: `runTask` (existing), `createBudgets`, `createPooledFleetApi`.
- Produces:
  - `runTask(task, { ...existing, onIteration })` where `onIteration({ iteration, message })` is awaited once per strategy event of type `plan | action | observation | review | step_review`. Errors thrown by the hook are swallowed.
  - `host/tasks.mjs`: `mergeBudgetConfig(baseConfig, task) → config`, `describeEvent(event) → string`, `executeHostedTask(task, { api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, signal, onProgress }) → { taskId, status, result, history, budget }`. `onProgress({ iteration, message })` is the spec's `onEvent`.

- [ ] **Step 1: Write the failing run-loop test**

Append to `tests/host-run-loop.test.mjs` (the file already imports `runTask` and the mock fleet; reuse its existing helpers, or add the imports below if it does not have them):

```js
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

test('onIteration fires once per progress-worthy event with a message', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "ok", "summary": "s"}\n```',
    ],
  });
  const tools = [{
    name: 'inspect-members', description: 'x', reversible: true, timeout: 5000, retryable: false, tags: [],
    run: async () => ({ ok: true }),
  }];
  const seen = [];
  const out = await runTask({ id: 't', goal: 'g' }, {
    strategy: 'open-ended', tools, fleetApi,
    onIteration: async (p) => { seen.push(p); },
  });
  assert.equal(out.status, 'completed');
  // open-ended yields action then observation for one tool call
  assert.deepEqual(seen.map(s => s.iteration), [1, 2]);
  assert.match(seen[0].message, /calling inspect-members/);
  assert.match(seen[1].message, /observed inspect-members/);
});

test('onIteration errors do not break the run', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```done\n{"result": "ok", "summary": "s"}\n```'],
  });
  const out = await runTask({ id: 't', goal: 'g' }, {
    strategy: 'open-ended', tools: [], fleetApi,
    onIteration: async () => { throw new Error('boom'); },
  });
  assert.equal(out.status, 'completed');
});
```

- [ ] **Step 2: Write the failing tasks test**

```js
// tests/host-tasks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { executeHostedTask, mergeBudgetConfig, describeEvent } = await import('../host/tasks.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

test('mergeBudgetConfig picks the stricter value', () => {
  const merged = mergeBudgetConfig({ maxIterations: 25, timeoutMs: 600000, maxCostUsd: 5 }, {
    constraints: { maxIterations: 10, timeoutMs: 900000 }, budget: { maxCostUsd: 1 },
  });
  assert.deepEqual(merged, { maxIterations: 10, timeoutMs: 600000, maxCostUsd: 1 });
});

test('describeEvent renders each progress event type', () => {
  assert.equal(describeEvent({ type: 'action', tool: 'weather' }), 'calling weather');
  assert.equal(describeEvent({ type: 'observation', tool: 'weather' }), 'observed weather');
  assert.equal(describeEvent({ type: 'observation', stepType: 'reason' }), 'observed reason');
  assert.equal(describeEvent({ type: 'plan', plan: { steps: [1, 2, 3] } }), 'plan with 3 steps');
  assert.equal(describeEvent({ type: 'review', approved: true }), 'plan review approved');
  assert.equal(describeEvent({ type: 'step_review', approved: false, step: 'weather' }), 'step review rejected: weather');
});

test('executeHostedTask runs a task and forwards progress', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const progress = [];
  try {
    const out = await executeHostedTask({ goal: 'inspect' }, {
      api, activeDispatcher: dispatcher, toolRegistry: extendRegistry(),
      runLoopConfig: { strategy: 'open-ended' }, budgetsConfig: null, guardrailsMod: null,
      onProgress: (p) => progress.push(p),
    });
    assert.equal(out.status, 'completed');
    assert.match(out.taskId, /^t-/);
    assert.equal(progress.length, 2);
  } finally { await dispatcher.close(); }
});

test('executeHostedTask returns dispatch_failed as a value', async () => {
  const api = createMockFleetApi({ members: rosterNames(1) });
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => { throw new Error('queue overflow'); };
  const out = await executeHostedTask({ id: 'fixed', goal: 'x' }, {
    api, activeDispatcher: dispatcher, toolRegistry: [], runLoopConfig: { strategy: 'open-ended' },
    budgetsConfig: null, guardrailsMod: null,
  });
  assert.equal(out.taskId, 'fixed');
  assert.equal(out.status, 'failed');
  assert.equal(out.result.error, 'dispatch_failed');
});
```

- [ ] **Step 3: Run both to verify failure**

Run: `node --test tests/host-run-loop.test.mjs tests/host-tasks.test.mjs`
Expected: run-loop tests fail (hook never called → `seen` empty); tasks tests fail (module not found).

- [ ] **Step 4: Add the hook to `host/run-loop.mjs`**

Add `onIteration` to the destructured options (after `agentDescription`), and add these lines inside the `for await` loop immediately after the `signal?.aborted` check:

```js
      if (onIteration && PROGRESS_TYPES.has(event.type)) {
        iteration += 1;
        try { await onIteration({ iteration, message: describeEvent(event) }); } catch { /* progress is best-effort */ }
      }
```

Add at module top:

```js
import { describeEvent, PROGRESS_TYPES } from './tasks.mjs';
```

and `let iteration = 0;` next to `let result = null;`.

- [ ] **Step 5: Create `host/tasks.mjs` by moving code out of `host/index.mjs`**

```js
// host/tasks.mjs
// The one function both the sync /task route and every jobs backend call.
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { runTask } from './run-loop.mjs';
import { createBudgets } from './budgets.mjs';

export const PROGRESS_TYPES = new Set(['plan', 'action', 'observation', 'review', 'step_review']);

export function describeEvent(event) {
  switch (event.type) {
    case 'action':      return `calling ${event.tool}`;
    case 'observation': return `observed ${event.tool ?? event.stepType ?? 'step'}`;
    case 'plan':        return `plan with ${event.plan?.steps?.length ?? 0} steps`;
    case 'review':      return `plan review ${event.approved ? 'approved' : 'rejected'}`;
    case 'step_review': return `step review ${event.approved ? 'approved' : 'rejected'}: ${event.step}`;
    default:            return event.type;
  }
}

export function mergeBudgetConfig(baseConfig, task) {
  const merged = { ...baseConfig };
  const constraints = task.constraints ?? {};
  const budgetOverride = task.budget ?? {};
  const pickStricter = (key, source) => {
    const values = [source[key], merged[key]].filter(v => typeof v === 'number');
    if (values.length) merged[key] = Math.min(...values);
  };
  pickStricter('maxIterations', constraints);
  pickStricter('timeoutMs', constraints);
  pickStricter('maxCostUsd', budgetOverride);
  pickStricter('maxTokens', budgetOverride);
  return merged;
}

export async function executeHostedTask(task, {
  api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, signal, onProgress,
}) {
  const fullTask = { id: task.id ?? `t-${Date.now().toString(36)}`, ...task };
  const budgetsMod = budgetsConfig ? createBudgets(mergeBudgetConfig(budgetsConfig, fullTask)) : null;
  let lease;
  try {
    lease = await activeDispatcher.dispatch({ signal });
  } catch (err) {
    return {
      taskId: fullTask.id,
      status: 'failed',
      result: { error: 'dispatch_failed', message: String(err?.message ?? err) },
      history: [],
      budget: null,
    };
  }
  try {
    const result = await runTask(fullTask, {
      strategy: runLoopConfig.strategy ?? 'open-ended',
      tools: toolRegistry,
      fleetApi: createPooledFleetApi(api, lease),
      budgets: budgetsMod,
      guardrails: guardrailsMod,
      ...runLoopConfig,
      signal,
      onIteration: onProgress,
    });
    return { taskId: fullTask.id, ...result };
  } finally {
    await lease.release();
  }
}
```

Then in `host/index.mjs`: delete the local `mergeBudgetConfig`, `createRequestBudgets`, and `executeHostedTask` definitions (lines 47–110), remove the now-unused imports of `createPooledFleetApi` (still needed by `callTool`, keep it), `runTask`, and `createBudgets`, and add:

```js
import { executeHostedTask } from './tasks.mjs';
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/host-run-loop.test.mjs tests/host-tasks.test.mjs && npm run test:host && npm run test:phase2`
Expected: all PASS. The `/task` route tests in `host-index.test.mjs` still pass because behaviour is unchanged.

- [ ] **Step 7: Commit (with approval)**

```bash
git add host/run-loop.mjs host/tasks.mjs host/index.mjs tests/host-run-loop.test.mjs tests/host-tasks.test.mjs
git commit -m "feat: extract executeHostedTask and add run-loop progress hook"
```

---

### Task 5: In-process jobs backend

**Files:**
- Create: `host/jobs/in-process.mjs`
- Test: `tests/host-jobs-in-process.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`record.mjs`, `interface.mjs`), Task 2 store contract.
- Produces: `createInProcessJobs({ store, runJob, notifier, config, logger, now }) → JobsBackend` where
  - `runJob(task, { signal, onProgress }) → Promise<runResult>` (the host passes a closure over `executeHostedTask`),
  - `notifier` is `{ publish(event, { callbackUrl }) }` or `null`,
  - `config = { maxQueueSize, concurrency, leaseTimeoutMs, retentionMs, drainMs, capacity }`, `capacity` = worker dispatcher capacity used to clamp `concurrency`,
  - `logger = { warn, info }` (defaults to `console`),
  - `now = () => new Date()` injectable for tests.
  - Abort reasons used on the job's `AbortController`: `'cancelled'`, `'lease_expired'`, `'shutdown'`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-jobs-in-process.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessJobs } = await import('../host/jobs/in-process.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
const { JobQueueFullError, JobsClosedError } = await import('../host/jobs/interface.mjs');
const { createRecord } = await import('../host/jobs/record.mjs');

const BASE = { maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000, retentionMs: 86_400_000, drainMs: 500, capacity: 2 };

// A controllable runJob: resolves when the test says so, reports progress, honours abort.
function makeRunner() {
  const pending = new Map(); // taskId → { resolve, onProgress, signal }
  const runJob = (task, { signal, onProgress }) => new Promise((resolve) => {
    pending.set(task.id, { resolve, onProgress, signal });
    signal.addEventListener('abort', () => {
      pending.delete(task.id);
      resolve({ status: 'cancelled', result: null, history: [], budget: null });
    }, { once: true });
  });
  return {
    runJob,
    pending,
    async finish(id, result = { status: 'completed', result: 'ok', history: [{ x: 1 }], budget: { iterations: 1 } }) {
      const p = pending.get(id); pending.delete(id); p.resolve(result);
      await sleep(5);
    },
    async progress(id, iteration, message) { await pending.get(id).onProgress({ iteration, message }); },
    async waitFor(id) { while (!pending.has(id)) await sleep(2); },
  };
}

async function setup(overrides = {}, runner = makeRunner()) {
  const store = createMemoryStore();
  const published = [];
  const jobs = createInProcessJobs({
    store, runJob: runner.runJob,
    notifier: { publish: (e, ctx) => published.push({ e, ctx }) },
    config: { ...BASE, ...overrides }, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  return { jobs, store, runner, published };
}

test('submit returns queued job with position and processes FIFO', async () => {
  const { jobs, runner } = await setup();
  try {
    const a = await jobs.submit({ goal: 'a' });
    const b = await jobs.submit({ goal: 'b' });
    assert.equal(a.status, 'queued'); assert.equal(a.position, 1); assert.equal(b.position, 2);
    await runner.waitFor(a.jobId);
    assert.equal((await jobs.get(a.jobId)).status, 'processing');
    assert.equal((await jobs.get(b.jobId)).status, 'queued');
    await runner.finish(a.jobId);
    const ra = await jobs.get(a.jobId);
    assert.equal(ra.status, 'completed'); assert.equal(ra.result, 'ok');
    assert.deepEqual(ra.history, [{ x: 1 }]); assert.ok(ra.finishedAt);
    await runner.waitFor(b.jobId);
    assert.equal((await jobs.get(b.jobId)).status, 'processing');
    await runner.finish(b.jobId);
  } finally { await jobs.stop(); }
});

test('submit throws JobQueueFullError at maxQueueSize', async () => {
  const { jobs, runner } = await setup({ maxQueueSize: 1 });
  try {
    const a = await jobs.submit({ goal: 'a' });
    await runner.waitFor(a.jobId);                 // a is processing, queue is empty
    await jobs.submit({ goal: 'b' });              // queue has 1
    await assert.rejects(() => jobs.submit({ goal: 'c' }), JobQueueFullError);
    assert.deepEqual(jobs.stats(), { queued: 1, processing: 1, capacity: 1, maxQueueSize: 1 });
  } finally { await jobs.stop(); }
});

test('events and progress are recorded and published', async () => {
  const { jobs, runner, published } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' }, { callbackUrl: 'https://cb.test/h' });
    await runner.waitFor(jobId);
    await runner.progress(jobId, 1, 'calling weather');
    await runner.finish(jobId);
    const events = await jobs.events(jobId);
    assert.deepEqual(events.map(e => e.type), ['queued', 'started', 'progress', 'settled']);
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
    assert.equal((await jobs.get(jobId)).progress.iteration, 1);
    assert.equal(published.length, 4);
    assert.equal(published[3].ctx.callbackUrl, 'https://cb.test/h');
    assert.deepEqual(await jobs.events(jobId, { afterSeq: 3 }).then(l => l.map(e => e.type)), ['settled']);
  } finally { await jobs.stop(); }
});

test('subscribe receives live events and unsubscribe stops them', async () => {
  const { jobs, runner } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    const seen = [];
    const unsub = jobs.subscribe(jobId, (e) => seen.push(e.type));
    await runner.waitFor(jobId);
    await runner.progress(jobId, 1, 'p');
    unsub();
    await runner.finish(jobId);
    assert.deepEqual(seen, ['started', 'progress']);
  } finally { await jobs.stop(); }
});

test('cancel on queued removes from queue; cancel on processing aborts', async () => {
  const { jobs, runner } = await setup();
  try {
    const a = await jobs.submit({ goal: 'a' });
    const b = await jobs.submit({ goal: 'b' });
    await runner.waitFor(a.jobId);
    assert.deepEqual(await jobs.cancel(b.jobId), { ok: true, status: 'cancelled' });
    assert.equal((await jobs.get(b.jobId)).status, 'cancelled');
    const c = await jobs.cancel(a.jobId);
    assert.equal(c.ok, true); assert.equal(c.status, 'cancelling');
    await sleep(20);
    assert.equal((await jobs.get(a.jobId)).status, 'cancelled');
    assert.deepEqual(await jobs.cancel(a.jobId), { ok: false, status: 'cancelled' });
    assert.deepEqual(await jobs.cancel('nope'), { ok: false, status: null });
  } finally { await jobs.stop(); }
});

test('runJob failed result settles as failed with run_failed error', async () => {
  const { jobs, runner } = await setup();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    await runner.waitFor(jobId);
    await runner.finish(jobId, { status: 'failed', result: { error: 'no_action', message: 'stuck' }, history: [], budget: null });
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.error, { code: 'run_failed', message: 'no_action: stuck' });
  } finally { await jobs.stop(); }
});

test('runJob throwing settles as failed rather than crashing the loop', async () => {
  const store = createMemoryStore();
  const jobs = createInProcessJobs({
    store, runJob: async () => { throw new Error('kaboom'); }, notifier: null,
    config: BASE, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  try {
    const { jobId } = await jobs.submit({ goal: 'a' });
    await sleep(20);
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'run_failed');
    assert.match(r.error.message, /kaboom/);
  } finally { await jobs.stop(); }
});

test('start re-enqueues queued rows and marks processing rows interrupted', async () => {
  const store = createMemoryStore(); await store.open();
  await store.insert({ ...createRecord({ goal: 'was-running' }, { id: 'job-run' }), status: 'processing', startedAt: new Date().toISOString() });
  await store.insert(createRecord({ goal: 'was-queued' }, { id: 'job-q' }));
  const runner = makeRunner();
  const jobs = createInProcessJobs({ store, runJob: runner.runJob, notifier: null, config: BASE, logger: { warn() {}, info() {} } });
  await jobs.start();
  try {
    const interrupted = await jobs.get('job-run');
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error.code, 'interrupted');
    assert.equal((await jobs.events('job-run')).at(-1).type, 'settled');
    await runner.waitFor('job-q');
    assert.equal((await jobs.get('job-q')).status, 'processing');
    await runner.finish('job-q');
  } finally { await jobs.stop(); }
});

test('lease timeout aborts a stuck job and settles lease_expired', async () => {
  let clock = Date.now();
  const runner = makeRunner();
  const store = createMemoryStore();
  const jobs = createInProcessJobs({
    store, runJob: runner.runJob, notifier: null,
    config: { ...BASE, leaseTimeoutMs: 1000, sweepIntervalMs: 20 },
    logger: { warn() {}, info() {} }, now: () => new Date(clock),
  });
  await jobs.start();
  try {
    const { jobId } = await jobs.submit({ goal: 'slow' });
    await runner.waitFor(jobId);
    clock += 2000;
    await sleep(60);
    const r = await jobs.get(jobId);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'lease_expired');
  } finally { await jobs.stop(); }
});

test('concurrency is clamped to capacity and runs jobs in parallel', async () => {
  const { jobs, runner } = await setup({ concurrency: 5, capacity: 2 });
  try {
    const ids = [];
    for (const g of ['a', 'b', 'c']) ids.push((await jobs.submit({ goal: g })).jobId);
    await runner.waitFor(ids[0]); await runner.waitFor(ids[1]);
    assert.equal(jobs.stats().processing, 2);
    assert.equal(jobs.stats().capacity, 2);
    assert.equal((await jobs.get(ids[2])).status, 'queued');
    for (const id of ids) { await runner.waitFor(id); await runner.finish(id); }
  } finally { await jobs.stop(); }
});

test('stop drains then aborts; queued jobs stay queued; submit after stop rejects', async () => {
  const { jobs, runner, store } = await setup({ drainMs: 50 });
  const a = await jobs.submit({ goal: 'a' });
  const b = await jobs.submit({ goal: 'b' });
  await runner.waitFor(a.jobId);
  await jobs.stop();
  assert.equal((await store.get(a.jobId)).status, 'failed');
  assert.equal((await store.get(a.jobId)).error.code, 'interrupted');
  assert.equal((await store.get(b.jobId)).status, 'queued');
  await assert.rejects(() => jobs.submit({ goal: 'c' }), JobsClosedError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-in-process.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the backend**

```js
// host/jobs/in-process.mjs
import { JobQueueFullError, JobsClosedError, validateCallbackUrl } from './interface.mjs';
import {
  TERMINAL_STATUSES, createRecord, queuedEvent, startedEvent, progressEvent, settledEvent, settleFromRunResult,
} from './record.mjs';

const FORCE_SETTLE_AFTER_ABORT_MS = 30_000;

export function createInProcessJobs({
  store, runJob, notifier = null, config, logger = console, now = () => new Date(),
  allowHttpCallbacks = false,
}) {
  if (!store) throw new Error('createInProcessJobs requires store');
  if (typeof runJob !== 'function') throw new Error('createInProcessJobs requires runJob');
  const {
    maxQueueSize = 100, concurrency: requestedConcurrency = 1, leaseTimeoutMs = 660_000,
    retentionMs = 86_400_000, drainMs = 30_000, capacity = 1,
    sweepIntervalMs = Math.max(1000, Math.min(15_000, Math.floor(leaseTimeoutMs / 4))),
  } = config ?? {};

  let concurrency = requestedConcurrency;
  if (concurrency > capacity) {
    logger.warn(`[jobs] dispatch.concurrency ${concurrency} exceeds worker capacity ${capacity}; clamping`);
    concurrency = Math.max(1, capacity);
  }

  const queue = [];                    // job ids in submit order
  const running = new Map();           // jobId → { controller, startedAt, promise }
  const subscribers = new Map();       // jobId → Set<fn>
  const callbackUrls = new Map();      // jobId → callbackUrl (for notifier ctx)
  let closed = false;
  let started = false;
  let sweepTimer = null;
  let purgeTimer = null;

  const iso = () => now().toISOString();

  async function publish(jobId, event) {
    const seq = await store.appendEvent(jobId, event);
    const full = { seq, ...event };
    for (const fn of subscribers.get(jobId) ?? []) {
      try { fn(full); } catch (err) { logger.warn(`[jobs] subscriber error: ${err?.message ?? err}`); }
    }
    if (notifier) {
      try { await notifier.publish(full, { callbackUrl: callbackUrls.get(jobId) ?? null }); }
      catch (err) { logger.warn(`[jobs] notifier error: ${err?.message ?? err}`); }
    }
    return full;
  }

  async function settle(jobId, { status, result, error, history = [], budget = null }) {
    await store.update(jobId, { status, result, error, history, budget, finishedAt: iso() });
    await publish(jobId, settledEvent(jobId, { status, result, error }, now()));
    callbackUrls.delete(jobId);
    if (TERMINAL_STATUSES.has(status)) subscribers.delete(jobId);
  }

  async function runOne(jobId) {
    const startedAt = iso();
    const claimed = await store.claim(jobId, startedAt);
    if (!claimed) return;                                   // cancelled meanwhile or claimed elsewhere
    const record = await store.get(jobId);
    const controller = new AbortController();
    const entry = { controller, startedAt, promise: null };
    running.set(jobId, entry);
    await publish(jobId, startedEvent(jobId, now()));

    const onProgress = async ({ iteration, message }) => {
      if (controller.signal.aborted) return;
      await store.update(jobId, { progress: { iteration, message, at: iso() } });
      await publish(jobId, progressEvent(jobId, iteration, message, now()));
    };

    const task = { id: jobId, ...record.task };
    const run = Promise.resolve()
      .then(() => runJob(task, { signal: controller.signal, onProgress }))
      .catch(err => ({ status: 'failed', result: { error: 'run_failed', message: String(err?.message ?? err) }, history: [], budget: null }));

    // If aborted and the run loop does not return within the grace period, settle anyway.
    let forceTimer = null;
    const forced = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => {
        forceTimer = setTimeout(() => resolve({ status: 'cancelled', result: null, history: [], budget: null }), FORCE_SETTLE_AFTER_ABORT_MS);
        forceTimer.unref?.();
      }, { once: true });
    });

    entry.promise = (async () => {
      const outcome = await Promise.race([run, forced]);
      clearTimeout(forceTimer);
      running.delete(jobId);
      const reason = controller.signal.aborted ? controller.signal.reason : null;
      let settled = settleFromRunResult(outcome);
      if (reason === 'lease_expired') {
        settled = { ...settled, status: 'failed', result: null, error: { code: 'lease_expired', message: `exceeded leaseTimeoutMs ${leaseTimeoutMs}` } };
      } else if (reason === 'shutdown') {
        settled = { ...settled, status: 'failed', result: null, error: { code: 'interrupted', message: 'host shut down while processing' } };
      } else if (reason === 'cancelled') {
        settled = { ...settled, status: 'cancelled', error: null };
      }
      await settle(jobId, settled);
      pump();
    })();
    return entry.promise;
  }

  function pump() {
    if (closed) return;
    while (running.size < concurrency && queue.length > 0) {
      const jobId = queue.shift();
      void runOne(jobId).catch(err => logger.warn(`[jobs] runOne failed: ${err?.message ?? err}`));
    }
  }

  async function sweepLeases() {
    const cutoff = now().getTime() - leaseTimeoutMs;
    for (const [jobId, entry] of running) {
      if (!entry.controller.signal.aborted && new Date(entry.startedAt).getTime() < cutoff) {
        logger.warn(`[jobs] job ${jobId} exceeded leaseTimeoutMs; aborting`);
        entry.controller.abort('lease_expired');
      }
    }
  }

  async function purge() {
    const cutoff = new Date(now().getTime() - retentionMs).toISOString();
    const n = await store.purgeFinishedBefore(cutoff);
    if (n) logger.info(`[jobs] purged ${n} finished jobs older than ${cutoff}`);
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await store.open();
      for (const r of await store.listByStatus('processing')) {
        await store.update(r.id, {
          status: 'failed', finishedAt: iso(),
          error: { code: 'interrupted', message: 'process restarted while job was processing' },
        });
        await publish(r.id, settledEvent(r.id, { status: 'failed', result: null, error: { code: 'interrupted', message: 'process restarted while job was processing' } }, now()));
      }
      for (const r of await store.listByStatus('queued')) {
        queue.push(r.id);
        if (r.callbackUrl) callbackUrls.set(r.id, r.callbackUrl);
      }
      await purge();
      sweepTimer = setInterval(() => void sweepLeases(), sweepIntervalMs); sweepTimer.unref?.();
      purgeTimer = setInterval(() => void purge(), Math.max(60_000, Math.floor(retentionMs / 24))); purgeTimer.unref?.();
      pump();
    },

    async stop({ drainMs: drain = drainMs } = {}) {
      closed = true;
      clearInterval(sweepTimer); clearInterval(purgeTimer);
      const inflight = [...running.values()].map(e => e.promise);
      if (inflight.length) {
        await Promise.race([Promise.allSettled(inflight), new Promise(r => setTimeout(r, drain))]);
        for (const entry of running.values()) entry.controller.abort('shutdown');
        await Promise.allSettled([...running.values()].map(e => e.promise));
      }
      await store.close();
    },

    async submit(task, { callbackUrl, metadata } = {}) {
      if (closed) throw new JobsClosedError();
      if (!task || typeof task.goal !== 'string' || !task.goal.trim()) throw new TypeError('task.goal is required');
      const url = validateCallbackUrl(callbackUrl, { allowHttp: allowHttpCallbacks });
      if (queue.length >= maxQueueSize) throw new JobQueueFullError();
      const record = createRecord(task, { callbackUrl: url, metadata, now: now() });
      await store.insert(record);
      if (url) callbackUrls.set(record.id, url);
      queue.push(record.id);
      const position = queue.length;
      await publish(record.id, queuedEvent(record.id, position, now()));
      pump();
      return { jobId: record.id, status: 'queued', position };
    },

    async get(jobId) { return store.get(jobId); },

    async cancel(jobId) {
      const record = await store.get(jobId);
      if (!record) return { ok: false, status: null };
      if (TERMINAL_STATUSES.has(record.status)) return { ok: false, status: record.status };
      if (record.status === 'queued') {
        const idx = queue.indexOf(jobId);
        if (idx >= 0) queue.splice(idx, 1);
        await settle(jobId, { status: 'cancelled', result: null, error: null });
        return { ok: true, status: 'cancelled' };
      }
      const entry = running.get(jobId);
      if (entry && !entry.controller.signal.aborted) entry.controller.abort('cancelled');
      return { ok: true, status: 'cancelling' };
    },

    subscribe(jobId, onEvent) {
      const set = subscribers.get(jobId) ?? new Set();
      set.add(onEvent); subscribers.set(jobId, set);
      return () => { set.delete(onEvent); if (set.size === 0) subscribers.delete(jobId); };
    },

    async events(jobId, { afterSeq = 0 } = {}) { return store.events(jobId, { afterSeq }); },

    stats() {
      return { queued: queue.length, processing: running.size, capacity: concurrency, maxQueueSize };
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/host-jobs-in-process.test.mjs`
Expected: PASS (11 tests). If the lease-timeout test is flaky, raise its `sleep(60)` to `sleep(100)`; the sweep interval is 20ms in that test.

- [ ] **Step 5: Commit (with approval)**

```bash
git add host/jobs/in-process.mjs tests/host-jobs-in-process.test.mjs
git commit -m "feat: add in-process jobs backend with FIFO queue, lease timeout, and restart recovery"
```

---

### Task 6: Notifier — SSE and webhook

**Files:**
- Create: `host/notify/sse.mjs`
- Create: `host/notify/webhook.mjs`
- Create: `host/notify/index.mjs`
- Test: `tests/host-notify.test.mjs`

**Interfaces:**
- Consumes: a jobs backend (`get`, `events`, `subscribe`) from Task 5. The neutral request shape from Task 7: `{ method, path, params, query, headers, body, signal, user }` where `headers` is a plain object with lower-case keys.
- Produces:
  - `createSseHandler({ jobs, heartbeatMs = 25000 }) → async (request) → response`, response is `{ status: 404, body }` or `{ status: 200, headers, stream: AsyncIterable<string> }`.
  - `formatSse({ seq, ...event }) → string` (wire format: `id:`, `event:`, `data:`, blank line).
  - `createWebhookChannel({ retries = 3, sendProgress = false, fetchImpl = fetch, logger, baseDelayMs = 1000 }) → { publish(event, { callbackUrl }) }`.
  - `createNotifier(config, { jobs, logger, fetchImpl }) → { publish(event, ctx), sseHandler, stop() }` where `config = { sse: { enabled, heartbeatMs }, webhook: { enabled, sendProgress, allowHttp, retries } }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-notify.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { createSseHandler, formatSse } = await import('../host/notify/sse.mjs');
const { createWebhookChannel } = await import('../host/notify/webhook.mjs');
const { createNotifier } = await import('../host/notify/index.mjs');

const ev = (seq, type, extra = {}) => ({ seq, type, jobId: 'j', at: '2026-09-17T10:00:00.000Z', ...extra });

// Fake jobs backend with controllable stored events + live subscribers.
function fakeJobs({ status = 'processing', events = [] } = {}) {
  const subs = new Set();
  return {
    status, stored: events, subs,
    async get(id) { return id === 'j' ? { id, status: this.status } : null; },
    async events(id, { afterSeq = 0 } = {}) { return this.stored.filter(e => e.seq > afterSeq); },
    subscribe(id, fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(e) { this.stored.push(e); for (const fn of subs) fn(e); },
  };
}

async function collect(stream, { max = Infinity } = {}) {
  const out = [];
  for await (const chunk of stream) { out.push(chunk); if (out.length >= max) break; }
  return out;
}

test('formatSse renders id/event/data lines', () => {
  const s = formatSse(ev(3, 'progress', { iteration: 3, message: 'm' }));
  assert.equal(s, 'id: 3\nevent: progress\ndata: {"type":"progress","jobId":"j","at":"2026-09-17T10:00:00.000Z","iteration":3,"message":"m"}\n\n');
});

test('sse: 404 for unknown job', async () => {
  const handler = createSseHandler({ jobs: fakeJobs() });
  const res = await handler({ params: { id: 'nope' }, headers: {}, signal: new AbortController().signal });
  assert.equal(res.status, 404);
});

test('sse: terminal job replays stored events and closes without subscribing', async () => {
  const jobs = fakeJobs({ status: 'completed', events: [ev(1, 'queued'), ev(2, 'started'), ev(3, 'settled', { status: 'completed' })] });
  const handler = createSseHandler({ jobs });
  const res = await handler({ params: { id: 'j' }, headers: { 'last-event-id': '1' }, signal: new AbortController().signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const chunks = await collect(res.stream);
  assert.deepEqual(chunks.map(c => c.match(/^id: (\d+)/)[1]), ['2', '3']);
  assert.equal(jobs.subs.size, 0);
});

test('sse: live job replays then follows subscription until settled', async () => {
  const jobs = fakeJobs({ events: [ev(1, 'queued'), ev(2, 'started')] });
  const handler = createSseHandler({ jobs, heartbeatMs: 60_000 });
  const res = await handler({ params: { id: 'j' }, headers: {}, signal: new AbortController().signal });
  const it = res.stream[Symbol.asyncIterator]();
  assert.match((await it.next()).value, /^id: 1/);
  assert.match((await it.next()).value, /^id: 2/);
  jobs.emit(ev(3, 'progress', { iteration: 1, message: 'x' }));
  assert.match((await it.next()).value, /^id: 3\nevent: progress/);
  jobs.emit(ev(4, 'settled', { status: 'completed' }));
  assert.match((await it.next()).value, /^id: 4\nevent: settled/);
  assert.equal((await it.next()).done, true);
  assert.equal(jobs.subs.size, 0);
});

test('sse: events that arrive between replay and subscribe are not lost or duplicated', async () => {
  const jobs = fakeJobs({ events: [ev(1, 'queued')] });
  const originalEvents = jobs.events.bind(jobs);
  jobs.events = async (id, opts) => { const r = await originalEvents(id, opts); jobs.emit(ev(2, 'started')); return r; };
  const handler = createSseHandler({ jobs, heartbeatMs: 60_000 });
  const res = await handler({ params: { id: 'j' }, headers: {}, signal: new AbortController().signal });
  const it = res.stream[Symbol.asyncIterator]();
  assert.match((await it.next()).value, /^id: 1/);
  assert.match((await it.next()).value, /^id: 2/);
  jobs.emit(ev(3, 'settled', { status: 'completed' }));
  assert.match((await it.next()).value, /^id: 3/);
});

test('sse: heartbeat comment is emitted while idle', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const jobs = fakeJobs({ events: [] });
    const handler = createSseHandler({ jobs, heartbeatMs: 1000 });
    const res = await handler({ params: { id: 'j' }, headers: {}, signal: new AbortController().signal });
    const it = res.stream[Symbol.asyncIterator]();
    const next = it.next();
    mock.timers.tick(1000);
    assert.equal((await next).value, ': ping\n\n');
  } finally { mock.timers.reset(); }
});

test('sse: request abort unsubscribes and ends the stream', async () => {
  const jobs = fakeJobs({ events: [] });
  const ctrl = new AbortController();
  const handler = createSseHandler({ jobs, heartbeatMs: 60_000 });
  const res = await handler({ params: { id: 'j' }, headers: {}, signal: ctrl.signal });
  const it = res.stream[Symbol.asyncIterator]();
  const next = it.next();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(jobs.subs.size, 1);
  ctrl.abort();
  assert.equal((await next).done, true);
  assert.equal(jobs.subs.size, 0);
});

test('webhook: posts settled event with job header, retries with backoff, then gives up', async () => {
  const calls = [];
  let failures = 2;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (failures-- > 0) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  const ch = createWebhookChannel({ retries: 3, fetchImpl, baseDelayMs: 1, logger: { warn() {} } });
  await ch.publish(ev(4, 'settled', { status: 'completed', result: 1, error: null }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://cb.test/h');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-fleet-job-id'], 'j');
  assert.equal(JSON.parse(calls[0].init.body).type, 'settled');

  const warnings = [];
  const always500 = async () => ({ ok: false, status: 500 });
  const ch2 = createWebhookChannel({ retries: 2, fetchImpl: always500, baseDelayMs: 1, logger: { warn: (m) => warnings.push(m) } });
  await ch2.publish(ev(4, 'settled', { status: 'completed' }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gave up/);
});

test('webhook: skips non-settled events unless sendProgress, and skips jobs without callbackUrl', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true }; };
  const quiet = createWebhookChannel({ fetchImpl, logger: { warn() {} } });
  await quiet.publish(ev(3, 'progress'), { callbackUrl: 'https://cb.test/h' });
  await quiet.publish(ev(4, 'settled', { status: 'completed' }), { callbackUrl: null });
  assert.equal(calls.length, 0);
  const chatty = createWebhookChannel({ fetchImpl, sendProgress: true, logger: { warn() {} } });
  await chatty.publish(ev(3, 'progress'), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 1);
});

test('createNotifier fans out to enabled channels and exposes sseHandler', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true }; };
  const jobs = fakeJobs({ status: 'completed', events: [ev(1, 'settled', { status: 'completed' })] });
  const n = createNotifier(
    { sse: { enabled: true, heartbeatMs: 1000 }, webhook: { enabled: true, retries: 1 } },
    { jobs, fetchImpl, logger: { warn() {} } },
  );
  await n.publish(ev(1, 'settled', { status: 'completed' }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 1);
  assert.equal(typeof n.sseHandler, 'function');
  const off = createNotifier({ sse: { enabled: false }, webhook: { enabled: false } }, { jobs, fetchImpl });
  assert.equal(off.sseHandler, null);
  await off.publish(ev(1, 'settled', { status: 'completed' }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 1);
  await n.stop(); await off.stop();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-notify.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `host/notify/sse.mjs`**

```js
// host/notify/sse.mjs
import { TERMINAL_STATUSES } from '../jobs/record.mjs';

export function formatSse({ seq, ...event }) {
  return `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
};

export function createSseHandler({ jobs, heartbeatMs = 25_000 }) {
  return async function sseHandler(request) {
    const jobId = request.params?.id;
    const record = jobId ? await jobs.get(jobId) : null;
    if (!record) return { status: 404, body: { ok: false, error: 'not_found' } };

    const lastId = Number(request.headers?.['last-event-id'] ?? 0);
    const afterSeq = Number.isFinite(lastId) ? lastId : 0;
    const signal = request.signal;

    async function* stream() {
      // Subscribe BEFORE replaying so nothing slips between the two; dedupe by seq.
      const pending = [];
      let wake = null;
      let ended = false;
      const push = (e) => { pending.push(e); wake?.(); };
      const unsubscribe = TERMINAL_STATUSES.has(record.status) ? () => {} : jobs.subscribe(jobId, push);
      const onAbort = () => { ended = true; wake?.(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const heartbeat = setInterval(() => push({ heartbeat: true }), heartbeatMs);
      heartbeat.unref?.();

      let lastSeq = afterSeq;
      try {
        for (const e of await jobs.events(jobId, { afterSeq })) {
          if (e.seq > lastSeq) { lastSeq = e.seq; yield formatSse(e); }
          if (e.type === 'settled') return;
        }
        if (TERMINAL_STATUSES.has(record.status)) return;

        while (!ended && !signal?.aborted) {
          if (pending.length === 0) {
            await new Promise((resolve) => { wake = resolve; });
            wake = null;
            continue;
          }
          const e = pending.shift();
          if (e.heartbeat) { yield ': ping\n\n'; continue; }
          if (e.seq <= lastSeq) continue;
          lastSeq = e.seq;
          yield formatSse(e);
          if (e.type === 'settled') return;
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      }
    }

    return { status: 200, headers: { ...HEADERS }, stream: stream() };
  };
}
```

- [ ] **Step 4: Implement `host/notify/webhook.mjs`**

```js
// host/notify/webhook.mjs
export function createWebhookChannel({
  retries = 3, sendProgress = false, fetchImpl = globalThis.fetch, logger = console, baseDelayMs = 1000,
} = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return {
    async publish(event, { callbackUrl } = {}) {
      if (!callbackUrl) return;
      if (event.type !== 'settled' && !(sendProgress && event.type === 'progress')) return;
      const { seq, ...body } = event;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetchImpl(callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fleet-job-id': event.jobId, 'x-fleet-event-seq': String(seq ?? '') },
            body: JSON.stringify(body),
          });
          if (res.ok) return;
          logger.warn(`[webhook] ${callbackUrl} responded ${res.status} (attempt ${attempt}/${retries})`);
        } catch (err) {
          logger.warn(`[webhook] ${callbackUrl} failed: ${err?.message ?? err} (attempt ${attempt}/${retries})`);
        }
        if (attempt < retries) await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
      logger.warn(`[webhook] gave up delivering ${event.type} for job ${event.jobId} to ${callbackUrl}`);
    },
  };
}
```

- [ ] **Step 5: Implement `host/notify/index.mjs`**

```js
// host/notify/index.mjs
import { createSseHandler } from './sse.mjs';
import { createWebhookChannel } from './webhook.mjs';

export const NOTIFY_DEFAULTS = {
  sse: { enabled: true, heartbeatMs: 25_000 },
  webhook: { enabled: true, sendProgress: false, allowHttp: false, retries: 3 },
};

export function resolveNotifyConfig(raw = {}) {
  return {
    sse: { ...NOTIFY_DEFAULTS.sse, ...(raw.sse ?? {}) },
    webhook: { ...NOTIFY_DEFAULTS.webhook, ...(raw.webhook ?? {}) },
  };
}

export function createNotifier(rawConfig, { jobs, logger = console, fetchImpl } = {}) {
  const config = resolveNotifyConfig(rawConfig);
  const channels = [];
  if (config.webhook.enabled) {
    channels.push(createWebhookChannel({ retries: config.webhook.retries, sendProgress: config.webhook.sendProgress, fetchImpl, logger }));
  }
  const sseHandler = config.sse.enabled && jobs
    ? createSseHandler({ jobs, heartbeatMs: config.sse.heartbeatMs })
    : null;

  return {
    config,
    sseHandler,
    async publish(event, ctx = {}) {
      await Promise.all(channels.map(c => c.publish(event, ctx).catch(err =>
        logger.warn(`[notify] channel error: ${err?.message ?? err}`))));
    },
    async stop() {},
  };
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/host-notify.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 7: Commit (with approval)**

```bash
git add host/notify tests/host-notify.test.mjs
git commit -m "feat: add SSE and webhook notifier"
```

---

### Task 7: Neutral comm contract, Express migration, raw-http adapter

**Files:**
- Modify: `comm/interface.mjs`
- Create: `comm/router.mjs`
- Modify: `comm/express.mjs`
- Create: `comm/raw-http.mjs`
- Modify: `mcp/auth.mjs` (add `authenticateRequest`; keep the middleware export)
- Create: `tests/helpers/comm-contract.mjs`
- Create: `tests/comm-contract.test.mjs`
- Modify: `tests/comm-express.test.mjs` (rewrite to the new route shape)

**Interfaces:**
- Produces the route table shape every adapter consumes:
  ```js
  // routes: { [name]: RouteDef | null }
  // RouteDef: { method: 'GET'|'POST'|'DELETE', path: '/jobs/:id', handler, auth = true, raw = false, web = undefined }
  // handler(request) → response            (non-raw)
  //   request:  { method, path, params, query, headers, body, signal, user }
  //   response: { status, headers?, body? } | { status, headers?, stream: AsyncIterable<string> }
  // raw route: handler(req, res, user)     (Node objects; used only by /mcp on Node adapters)
  //            web(request: Request, user) → Response  (used by the Azure adapter, Task 12)
  // authenticate(request) → user | null   (null → 401)
  ```
- `comm/router.mjs`: `compileRoute(path) → (pathname) → params | null`, `matchRoute(routes, method, pathname) → { name, route, params } | null`, `parseQuery(search) → object`, `buildRequest({ method, url, headers, body, signal, user }) → request`, `writeNodeResponse(res, response) → Promise<void>` (JSON or stream), `runHandler(route, request, authenticate) → response` (applies auth, maps thrown errors to 500 JSON).
- `createExpressAdapter()` and `createRawHttpAdapter()` both expose `{ start({ routes, port, host, authenticate }), stop(), port(), address() }`.
- `mcp/auth.mjs` gains `export function authenticateRequest(request) { return { id: 'anonymous' }; }`.

- [ ] **Step 1: Write the shared adapter contract suite**

```js
// tests/helpers/comm-contract.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function readAll(res) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

export function runCommContract(name, createAdapter) {
  const authenticate = (request) => (request.headers['x-deny'] ? null : { id: 'u1' });

  async function withAdapter(routes, fn) {
    const adapter = createAdapter();
    await adapter.start({ routes, port: 0, host: '127.0.0.1', authenticate });
    const base = `http://127.0.0.1:${adapter.port()}`;
    try { await fn(base, adapter); } finally { await adapter.stop(); }
  }

  test(`${name}: routes JSON with params, query, body and user`, async () => {
    let seen;
    await withAdapter({
      jobGet: { method: 'GET', path: '/jobs/:id', handler: async (r) => { seen = r; return { status: 200, body: { id: r.params.id, q: r.query.q, user: r.user } }; } },
      task: { method: 'POST', path: '/task', handler: async (r) => ({ status: 202, headers: { 'retry-after': '30' }, body: { got: r.body } }) },
    }, async (base) => {
      const g = await readAll(await fetch(`${base}/jobs/abc?q=1`));
      assert.equal(g.status, 200);
      assert.deepEqual(g.json(), { id: 'abc', q: '1', user: { id: 'u1' } });
      assert.equal(seen.method, 'GET'); assert.equal(seen.path, '/jobs/abc');
      const p = await readAll(await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x' }) }));
      assert.equal(p.status, 202);
      assert.equal(p.headers.get('retry-after'), '30');
      assert.deepEqual(p.json(), { got: { goal: 'x' } });
    });
  });

  test(`${name}: authenticate returning null yields 401; auth:false skips it`, async () => {
    await withAdapter({
      task: { method: 'POST', path: '/task', handler: async () => ({ status: 200, body: { ok: true } }) },
      health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
    }, async (base) => {
      const denied = await fetch(`${base}/task`, { method: 'POST', headers: { 'x-deny': '1', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 401);
      const health = await fetch(`${base}/health`, { headers: { 'x-deny': '1' } });
      assert.equal(health.status, 200);
    });
  });

  test(`${name}: unknown path is 404 JSON; handler throw is 500 JSON`, async () => {
    await withAdapter({
      boom: { method: 'GET', path: '/boom', handler: async () => { throw new Error('kaboom'); } },
    }, async (base) => {
      const nf = await readAll(await fetch(`${base}/nope`));
      assert.equal(nf.status, 404);
      const err = await readAll(await fetch(`${base}/boom`));
      assert.equal(err.status, 500);
      assert.equal(err.json().error, 'internal_error');
    });
  });

  test(`${name}: null routes are not mounted`, async () => {
    await withAdapter({ task: null, health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: {} }) } },
      async (base) => { assert.equal((await fetch(`${base}/task`, { method: 'POST' })).status, 404); });
  });

  test(`${name}: streaming response arrives chunk by chunk with event-stream headers`, async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    async function* gen() { yield 'id: 1\nevent: a\ndata: {}\n\n'; await gate; yield 'id: 2\nevent: b\ndata: {}\n\n'; }
    await withAdapter({
      events: { method: 'GET', path: '/jobs/:id/events', handler: async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen() }) },
    }, async (base) => {
      const res = await fetch(`${base}/jobs/j/events`);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const first = await reader.read();
      assert.match(first.value, /^id: 1/);
      release();
      const second = await reader.read();
      assert.match(second.value, /^id: 2/);
      assert.equal((await reader.read()).done, true);
    });
  });

  test(`${name}: stream is closed when the client disconnects`, async () => {
    let finished = false;
    async function* gen(signal) {
      try { yield 'id: 1\nevent: a\ndata: {}\n\n'; await new Promise(r => signal.addEventListener('abort', r, { once: true })); }
      finally { finished = true; }
    }
    await withAdapter({
      events: { method: 'GET', path: '/e', handler: async (r) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen(r.signal) }) },
    }, async (base) => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/e`, { signal: ctrl.signal });
      await res.body.getReader().read();
      ctrl.abort();
      for (let i = 0; i < 50 && !finished; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(finished, true);
    });
  });

  test(`${name}: raw route receives Node req/res and the user`, async () => {
    await withAdapter({
      mcp: { method: 'POST', path: '/mcp', raw: true, handler: (req, res, user) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ raw: true, user })); } },
    }, async (base) => {
      const r = await readAll(await fetch(`${base}/mcp`, { method: 'POST', body: '{}' }));
      assert.deepEqual(r.json(), { raw: true, user: { id: 'u1' } });
    });
  });

  test(`${name}: stop() closes the listener`, async () => {
    const adapter = createAdapter();
    await adapter.start({ routes: { health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: {} }) } }, port: 0, host: '127.0.0.1', authenticate });
    const port = adapter.port();
    await adapter.stop();
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
  });
}
```

```js
// tests/comm-contract.test.mjs
import { runCommContract } from './helpers/comm-contract.mjs';

const { createExpressAdapter } = await import('../comm/express.mjs');
const { createRawHttpAdapter } = await import('../comm/raw-http.mjs');

runCommContract('express', createExpressAdapter);
runCommContract('raw-http', createRawHttpAdapter);
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/comm-contract.test.mjs`
Expected: FAIL (raw-http module missing; express adapter ignores the new route shape).

- [ ] **Step 3: Rewrite `comm/interface.mjs` as documentation**

```js
// comm/interface.mjs
//
// Every comm adapter implements:
//
//   { async start({ routes, port, host, authenticate }), async stop(), port(), address() }
//
// routes is an object keyed by route name. Null entries are not mounted.
//
//   RouteDef = {
//     method:  'GET' | 'POST' | 'DELETE',
//     path:    '/jobs/:id',            // ':name' segments become request.params
//     handler: async (request) => response,
//     auth:    true,                   // false → authenticate is skipped
//     raw:     false,                  // true → handler(req, res, user) with Node objects
//     web:     undefined,              // raw routes may also supply web(Request, user) → Response
//   }
//
//   request  = { method, path, params, query, headers, body, signal, user }
//              headers has lower-case keys; body is parsed JSON or null.
//   response = { status, headers?, body? }                          // JSON body
//            | { status, headers?, stream: AsyncIterable<string> }  // chunked text (SSE)
//
//   authenticate(request) → user | null     null → adapter answers 401
//
// The adapter owns the HTTP framework. It never interprets routes beyond this.
// The MCP route is the only raw route: the MCP SDK needs Node req/res (or a
// web-standard Request), which is why RouteDef carries both `handler` and `web`.
export {};
```

- [ ] **Step 4: Create `comm/router.mjs`**

```js
// comm/router.mjs
export function compileRoute(path) {
  const keys = [];
  const pattern = path.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => { keys.push(k); return '/([^/]+)'; });
  const re = new RegExp(`^${pattern}/?$`);
  return (pathname) => {
    const m = re.exec(pathname);
    if (!m) return null;
    return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  };
}

export function matchRoute(routes, method, pathname) {
  for (const [name, route] of Object.entries(routes)) {
    if (!route) continue;
    if (route.method !== method) continue;
    const matcher = route._match ?? (route._match = compileRoute(route.path));
    const params = matcher(pathname);
    if (params) return { name, route, params };
  }
  return null;
}

export function parseQuery(search) {
  return Object.fromEntries(new URLSearchParams(search ?? ''));
}

export function lowerHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

export function buildRequest({ method, url, headers, body = null, signal, user = null }) {
  const u = url instanceof URL ? url : new URL(url, 'http://localhost');
  return { method, path: u.pathname, params: {}, query: parseQuery(u.search), headers: lowerHeaders(headers), body, signal, user };
}

export async function runHandler(route, request, authenticate) {
  if (route.auth !== false) {
    const user = await authenticate(request);
    if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    request.user = user;
  }
  try {
    return await route.handler(request);
  } catch (err) {
    console.error(`[comm] handler error on ${request.method} ${request.path}: ${err?.stack ?? err}`);
    return { status: 500, body: { ok: false, error: 'internal_error', message: String(err?.message ?? err) } };
  }
}

export async function writeNodeResponse(res, response) {
  const headers = { ...(response.headers ?? {}) };
  if (response.stream) {
    if (!headers['content-type']) headers['content-type'] = 'text/event-stream';
    res.writeHead(response.status ?? 200, headers);
    res.flushHeaders?.();
    try {
      for await (const chunk of response.stream) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    } finally {
      res.end();
    }
    return;
  }
  const body = response.body === undefined ? '' : JSON.stringify(response.body);
  headers['content-type'] = headers['content-type'] ?? 'application/json';
  res.writeHead(response.status ?? 200, headers);
  res.end(body);
}

// Node req → request.signal that aborts when the client goes away.
export function requestSignal(req, res) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(new Error('client disconnected'));
  res.on('close', () => { if (!res.writableFinished) abort(); });
  req.on('aborted', abort);
  return ctrl.signal;
}
```

- [ ] **Step 5: Rewrite `comm/express.mjs`**

```js
// comm/express.mjs
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { buildRequest, runHandler, writeNodeResponse, requestSignal } from './router.mjs';

export function createExpressAdapter() {
  let server = null;

  return {
    async start({ routes, port, host, authenticate }) {
      const app = createMcpExpressApp();

      for (const [name, route] of Object.entries(routes)) {
        if (!route) continue;
        // Transitional: Phase 2 passed bare Express handlers keyed by name. Keep
        // them working until Task 9 switches host/index.mjs to RouteDefs.
        if (typeof route === 'function') {
          const legacy = { health: ['get', '/health', false], mcp: ['post', '/mcp', true], task: ['post', '/task', true], jobs: ['get', '/jobs/:id', true] }[name];
          if (!legacy) continue;
          const [m, p, needsAuth] = legacy;
          if (needsAuth) app[m](p, (req, res, next) => { req.user = { id: 'anonymous' }; next(); }, route); else app[m](p, route);
          continue;
        }
        const method = route.method.toLowerCase();
        if (route.raw) {
          app[method](route.path, async (req, res) => {
            const request = buildRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body ?? null, signal: requestSignal(req, res) });
            const user = route.auth === false ? null : await authenticate(request);
            if (route.auth !== false && !user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
            req.user = user;
            await route.handler(req, res, user);
          });
          continue;
        }
        app[method](route.path, async (req, res) => {
          const request = buildRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body ?? null, signal: requestSignal(req, res) });
          request.params = { ...req.params };
          const response = await runHandler(route, request, authenticate);
          await writeNodeResponse(res, response);
        });
      }
      app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

      server = app.listen(port, host);
      await new Promise((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        server.once('listening', onListening);
        server.once('error', onError);
      });
    },
    port() { return server?.address()?.port; },
    address() { return server?.address(); },
    async stop() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      server = null;
    },
  };
}
```

Note: `createMcpExpressApp()` already mounts `express.json()`, so `req.body` is parsed. An empty POST body yields `{}` or `undefined`; both are passed through as-is.

- [ ] **Step 6: Create `comm/raw-http.mjs`**

```js
// comm/raw-http.mjs
import http from 'node:http';
import { buildRequest, matchRoute, runHandler, writeNodeResponse, requestSignal } from './router.mjs';

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return { __invalidJson: text }; }
}

export function createRawHttpAdapter() {
  let server = null;

  return {
    async start({ routes, port, host, authenticate }) {
      server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const match = matchRoute(routes, req.method, url.pathname);
          if (!match) { await writeNodeResponse(res, { status: 404, body: { ok: false, error: 'not_found' } }); return; }
          const { route, params } = match;
          if (route.raw) {
            const request = buildRequest({ method: req.method, url, headers: req.headers, signal: requestSignal(req, res) });
            const user = route.auth === false ? null : await authenticate(request);
            if (route.auth !== false && !user) { await writeNodeResponse(res, { status: 401, body: { ok: false, error: 'unauthorized' } }); return; }
            req.user = user;
            await route.handler(req, res, user);
            return;
          }
          const body = req.method === 'GET' ? null : await readJsonBody(req);
          if (body?.__invalidJson !== undefined) { await writeNodeResponse(res, { status: 400, body: { ok: false, error: 'invalid_json' } }); return; }
          const request = buildRequest({ method: req.method, url, headers: req.headers, body, signal: requestSignal(req, res) });
          request.params = params;
          await writeNodeResponse(res, await runHandler(route, request, authenticate));
        } catch (err) {
          if (!res.headersSent) await writeNodeResponse(res, { status: 500, body: { ok: false, error: 'internal_error', message: String(err?.message ?? err) } });
          else res.end();
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
    },
    port() { return server?.address()?.port; },
    address() { return server?.address(); },
    async stop() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      server = null;
    },
  };
}
```

- [ ] **Step 7: Add `authenticateRequest` to `mcp/auth.mjs`**

```js
// mcp/auth.mjs
// Pass-through stubs. Replace by injection, not by editing this file.
// Express-middleware form (legacy mcp/http.mjs path):
export function authenticate(req, res, next) {
  req.user = { id: 'anonymous' };
  next();
}
// Neutral-contract form (host/ path): request → user | null.
export function authenticateRequest() {
  return { id: 'anonymous' };
}
```

- [ ] **Step 8: Rewrite `tests/comm-express.test.mjs` to the new shape**

Replace the file body with a short smoke test; the contract suite is now the real coverage:

```js
// tests/comm-express.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createExpressAdapter } = await import('../comm/express.mjs');

test('express adapter mounts a health route without auth', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: { health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) } },
    port: 0, host: '127.0.0.1', authenticate: () => null,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${adapter.port()}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await adapter.stop(); }
});
```

- [ ] **Step 9: Run tests**

Run: `node --test tests/comm-contract.test.mjs tests/comm-express.test.mjs`
Expected: PASS (16 contract tests + 1). Then run `npm run test:host`; it must still pass thanks to the transitional legacy-handler branch in the Express adapter. Task 9 removes that branch once `host/index.mjs` emits RouteDefs.

- [ ] **Step 10: Commit (with approval)**

```bash
git add comm/interface.mjs comm/router.mjs comm/express.mjs comm/raw-http.mjs mcp/auth.mjs tests/helpers/comm-contract.mjs tests/comm-contract.test.mjs tests/comm-express.test.mjs
git commit -m "feat: framework-neutral comm contract with Express and raw http adapters"
```

---

### Task 8: Config — dispatch, notify, adapters, env overrides

**Files:**
- Modify: `host/config.mjs`
- Create: `host/jobs/config.mjs`
- Test: `tests/host-config.test.mjs` (append), `tests/host-jobs-config.test.mjs` (new)

**Interfaces:**
- Produces in `host/jobs/config.mjs`:
  - `DISPATCH_DEFAULTS`, `resolveDispatchConfig(raw, { env, budgetsConfig }) → { enabled, backend, maxQueueSize, concurrency, leaseTimeoutMs, retentionMs, drainMs, store: { kind, dbPath }, durable: { taskHub, pollMs, maxActivityMs } }`. Env overrides: `JOBS_BACKEND`, `JOBS_MAX_QUEUE_SIZE`, `JOBS_CONCURRENCY`, `JOBS_DB_PATH`, `JOBS_RETENTION_MS`, `DURABLE_TASK_HUB`. Default `leaseTimeoutMs` = `budgetsConfig.timeoutMs + 60_000` when budgets has `timeoutMs`, else `660_000`.
  - `resolveNotifyConfigWithEnv(raw, env)`: `WEBHOOK_ALLOW_HTTP=1|true` sets `webhook.allowHttp`.
- `host/config.mjs`: `SUPPORTED_ADAPTERS = express | raw-http | azure-functions`; `IMPLEMENTED_MODULES` gains `dispatch`, `notify`; `KNOWN_MODULES` gains `notify`; validation rules from the spec table (errors throw, warnings `console.warn`). Frozen config gains `modules.dispatch` and `modules.notify` resolved objects.

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-jobs-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveDispatchConfig, resolveNotifyConfigWithEnv } = await import('../host/jobs/config.mjs');

test('dispatch defaults and lease timeout derive from budgets', () => {
  const c = resolveDispatchConfig({ enabled: true }, { env: {}, budgetsConfig: { timeoutMs: 600_000 } });
  assert.equal(c.backend, 'in-process');
  assert.equal(c.maxQueueSize, 100);
  assert.equal(c.concurrency, 1);
  assert.equal(c.leaseTimeoutMs, 660_000);
  assert.equal(c.retentionMs, 86_400_000);
  assert.equal(c.drainMs, 30_000);
  assert.equal(c.store.kind, 'sqlite');
  assert.match(c.store.dbPath, /workdir[\\/]jobs\.db$/);
  assert.deepEqual(c.durable, { taskHub: 'fleetjobs', pollMs: 2000, maxActivityMs: 3_600_000 });
});

test('dispatch env overrides win over config values', () => {
  const c = resolveDispatchConfig({ enabled: true, maxQueueSize: 5 }, {
    env: { JOBS_BACKEND: 'durable', JOBS_MAX_QUEUE_SIZE: '7', JOBS_CONCURRENCY: '2', JOBS_DB_PATH: '/data/j.db', JOBS_RETENTION_MS: '1000', DURABLE_TASK_HUB: 'hub2' },
    budgetsConfig: null,
  });
  assert.equal(c.backend, 'durable'); assert.equal(c.maxQueueSize, 7); assert.equal(c.concurrency, 2);
  assert.equal(c.store.dbPath, '/data/j.db'); assert.equal(c.retentionMs, 1000); assert.equal(c.durable.taskHub, 'hub2');
  assert.equal(c.leaseTimeoutMs, 660_000);
});

test('dispatch rejects unknown backend and store kind', () => {
  assert.throws(() => resolveDispatchConfig({ enabled: true, backend: 'redis' }, { env: {} }), /backend/);
  assert.throws(() => resolveDispatchConfig({ enabled: true, store: { kind: 'postgres' } }, { env: {} }), /store\.kind/);
});

test('notify env override for allowHttp', () => {
  assert.equal(resolveNotifyConfigWithEnv({}, { WEBHOOK_ALLOW_HTTP: 'true' }).webhook.allowHttp, true);
  assert.equal(resolveNotifyConfigWithEnv({ webhook: { allowHttp: true } }, {}).webhook.allowHttp, true);
  assert.equal(resolveNotifyConfigWithEnv({}, {}).webhook.allowHttp, false);
});
```

Append to `tests/host-config.test.mjs` (it already defines `tmpDir`, `writeConfig`, and `loadConfig`):

```js
function captureWarnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (m) => seen.push(String(m));
  return fn().finally(() => { console.warn = orig; }).then(r => ({ result: r, warnings: seen }));
}

test('accepts raw-http and azure-functions adapters', async () => {
  for (const adapter of ['raw-http', 'azure-functions']) {
    const dir = await tmpDir();
    await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: '${adapter}' } };`);
    assert.equal((await loadConfig(dir)).comm.adapter, adapter);
  }
});

test('dispatch without runLoop is an error', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { dispatch: { enabled: true } } };`);
  await assert.rejects(() => loadConfig(dir), /dispatch.*runLoop/);
});

test('durable backend requires the azure-functions adapter', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, dispatch: { enabled: true, backend: 'durable' } } };`);
  await assert.rejects(() => loadConfig(dir), /durable.*azure-functions/);
});

test('azure-functions with in-process backend warns; budgets timeout above maxActivityMs warns; allowHttp warns', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'azure-functions' },
    modules: {
      runLoop: { enabled: true },
      budgets: { enabled: true, timeoutMs: 7200000 },
      dispatch: { enabled: true, backend: 'in-process', durable: { maxActivityMs: 3600000 } },
      notify: { webhook: { allowHttp: true } },
    } };`);
  const { result, warnings } = await captureWarnings(() => loadConfig(dir));
  assert.equal(result.modules.dispatch.backend, 'in-process');
  assert.ok(warnings.some(w => /in-process.*azure-functions|lost when the instance recycles/i.test(w)));
  assert.ok(warnings.some(w => /timeoutMs.*maxActivityMs/i.test(w)));
  assert.ok(warnings.some(w => /allowHttp/i.test(w)));
});

test('memory store kind warns outside tests', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, dispatch: { enabled: true, store: { kind: 'memory' } } } };`);
  const { warnings } = await captureWarnings(() => loadConfig(dir, { NODE_ENV: 'production' }));
  assert.ok(warnings.some(w => /memory.*lost on restart/i.test(w)));
});

test('resolved dispatch and notify configs are exposed on the frozen config', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, dispatch: { enabled: true, maxQueueSize: 3 }, notify: { sse: { heartbeatMs: 5 } } } };`);
  const config = await loadConfig(dir, { JOBS_CONCURRENCY: '1' });
  assert.equal(config.modules.dispatch.maxQueueSize, 3);
  assert.equal(config.modules.dispatch.store.kind, 'sqlite');
  assert.equal(config.modules.notify.sse.heartbeatMs, 5);
  assert.equal(config.modules.notify.webhook.enabled, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-config.test.mjs tests/host-config.test.mjs`
Expected: FAIL (module missing; new adapters rejected; no dispatch validation).

- [ ] **Step 3: Create `host/jobs/config.mjs`**

```js
// host/jobs/config.mjs
import path from 'node:path';
import { resolveNotifyConfig } from '../notify/index.mjs';

export const DISPATCH_DEFAULTS = {
  enabled: false,
  backend: 'in-process',
  maxQueueSize: 100,
  concurrency: 1,
  retentionMs: 86_400_000,
  drainMs: 30_000,
  store: { kind: 'sqlite', dbPath: path.join('workdir', 'jobs.db') },
  durable: { taskHub: 'fleetjobs', pollMs: 2000, maxActivityMs: 3_600_000 },
};
const BACKENDS = new Set(['in-process', 'durable']);
const STORE_KINDS = new Set(['sqlite', 'memory']);

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

export function resolveDispatchConfig(raw = {}, { env = process.env, budgetsConfig = null } = {}) {
  const merged = {
    ...DISPATCH_DEFAULTS, ...raw,
    store: { ...DISPATCH_DEFAULTS.store, ...(raw.store ?? {}) },
    durable: { ...DISPATCH_DEFAULTS.durable, ...(raw.durable ?? {}) },
  };
  merged.backend = env.JOBS_BACKEND || merged.backend;
  merged.maxQueueSize = intEnv(env, 'JOBS_MAX_QUEUE_SIZE', merged.maxQueueSize);
  merged.concurrency = intEnv(env, 'JOBS_CONCURRENCY', merged.concurrency);
  merged.retentionMs = intEnv(env, 'JOBS_RETENTION_MS', merged.retentionMs);
  merged.store.dbPath = env.JOBS_DB_PATH || merged.store.dbPath;
  merged.durable.taskHub = env.DURABLE_TASK_HUB || merged.durable.taskHub;
  if (merged.leaseTimeoutMs === undefined) {
    merged.leaseTimeoutMs = typeof budgetsConfig?.timeoutMs === 'number' ? budgetsConfig.timeoutMs + 60_000 : 660_000;
  }
  if (!BACKENDS.has(merged.backend)) throw new Error(`dispatch.backend must be one of ${[...BACKENDS].join(', ')}, got "${merged.backend}"`);
  if (!STORE_KINDS.has(merged.store.kind)) throw new Error(`dispatch.store.kind must be one of ${[...STORE_KINDS].join(', ')}, got "${merged.store.kind}"`);
  return merged;
}

export function resolveNotifyConfigWithEnv(raw = {}, env = process.env) {
  const config = resolveNotifyConfig(raw);
  const flag = String(env.WEBHOOK_ALLOW_HTTP ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') config.webhook.allowHttp = true;
  return config;
}
```

- [ ] **Step 4: Update `host/config.mjs`**

Replace the constants and the module-validation block:

```js
import { resolveDispatchConfig, resolveNotifyConfigWithEnv } from './jobs/config.mjs';

const SUPPORTED_ADAPTERS = new Set(['express', 'raw-http', 'azure-functions']);
const KNOWN_MODULES = new Set(['runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch', 'notify']);
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify']);
```

Inside `validate(raw, env)`, after the existing budgets/runLoop warning and before `return Object.freeze(...)`:

```js
  const modules = { ...(raw.modules ?? {}) };
  const runLoopEnabled = !!modules.runLoop?.enabled;
  const budgetsConfig = modules.budgets?.enabled ? modules.budgets : null;

  if (modules.dispatch?.enabled) {
    if (!runLoopEnabled) throw new Error('dispatch enabled but runLoop disabled — there is nothing to run; enable runLoop or disable dispatch');
    const dispatch = resolveDispatchConfig(modules.dispatch, { env, budgetsConfig });
    if (dispatch.backend === 'durable' && raw.comm.adapter !== 'azure-functions') {
      throw new Error('dispatch.backend "durable" requires comm.adapter "azure-functions"');
    }
    if (raw.comm.adapter === 'azure-functions' && dispatch.backend === 'in-process') {
      console.warn('[host/config] in-process jobs on azure-functions — jobs are lost when the instance recycles; use backend "durable"');
    }
    if (typeof budgetsConfig?.timeoutMs === 'number' && budgetsConfig.timeoutMs > dispatch.durable.maxActivityMs) {
      console.warn(`[host/config] budgets.timeoutMs ${budgetsConfig.timeoutMs} exceeds dispatch.durable.maxActivityMs ${dispatch.durable.maxActivityMs}; the platform may kill the activity before budgets fire`);
    }
    if (dispatch.store.kind === 'memory' && env.NODE_ENV !== 'test') {
      console.warn('[host/config] dispatch.store.kind "memory" — jobs are lost on restart');
    }
    modules.dispatch = dispatch;
  }

  const notify = resolveNotifyConfigWithEnv(modules.notify ?? {}, env);
  if (notify.webhook.allowHttp) console.warn('[host/config] notify.webhook.allowHttp is on — plain-http callback URLs are accepted');
  modules.notify = notify;
```

and change the return to `modules: Object.freeze(modules)`.

- [ ] **Step 5: Run tests**

Run: `node --test tests/host-jobs-config.test.mjs tests/host-config.test.mjs && npm run test:host`
Expected: PASS.

- [ ] **Step 6: Commit (with approval)**

```bash
git add host/config.mjs host/jobs/config.mjs tests/host-config.test.mjs tests/host-jobs-config.test.mjs
git commit -m "feat: config validation for dispatch, notify, and new comm adapters"
```

---

### Task 9: Host wiring — routes, jobs backend, notifier, builder

**Files:**
- Create: `host/jobs/index.mjs`
- Create: `host/routes.mjs`
- Modify: `host/index.mjs` (route table, jobs + notifier lifecycle, builder methods, adapter registry)
- Modify: `comm/express.mjs` (delete the transitional legacy-handler branch)
- Test: `tests/host-routes.test.mjs` (new), `tests/host-index.test.mjs` (append)

**Interfaces:**
- Consumes: Tasks 4–8.
- Produces:
  - `host/jobs/index.mjs`: `createJobsBackend(dispatchConfig, { runJob, notifier, logger, capacity, allowHttpCallbacks, durableClient }) → JobsBackend`. For `in-process` it builds the store from `dispatchConfig.store` and calls `createInProcessJobs`. For `durable` it lazy-imports `./durable.mjs` (Task 11) and calls `createDurableJobs`.
  - `host/routes.mjs`: `buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled }) → routes` producing RouteDefs for `health`, `mcp`, `task`, `jobGet`, `jobCancel`, `jobEvents`. `runSync(task) → Phase 2 response object`. Status mapping exactly as the spec's "The `/task` route" section.
  - `startHost` returns `{ host, jobs, notifier, callTool, close, stop, config, registry }`. Builder gains `.dispatch(config)` and `.notify(config)`. `SUPPORTED_ADAPTERS` in `host/index.mjs` gains `'raw-http'` and a lazy `'azure-functions'` entry (Task 12 fills it in).

- [ ] **Step 1: Write the failing routes test**

```js
// tests/host-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRoutes } = await import('../host/routes.mjs');
const { JobQueueFullError, JobsClosedError, InvalidCallbackUrlError } = await import('../host/jobs/interface.mjs');

function fakeJobs(overrides = {}) {
  return {
    submit: async (task, opts) => ({ jobId: 'job-1', status: 'queued', position: 1 }),
    get: async (id) => (id === 'job-1' ? { id, status: 'processing' } : null),
    cancel: async (id) => (id === 'job-1' ? { ok: true, status: 'cancelling' } : { ok: false, status: null }),
    ...overrides,
  };
}
const req = (over = {}) => ({ method: 'POST', path: '/task', params: {}, query: {}, headers: {}, body: { goal: 'g' }, signal: undefined, user: { id: 'u' }, ...over });

test('POST /task returns 202 with links when dispatch is enabled', async () => {
  const routes = buildRoutes({ jobs: fakeJobs(), notifier: { sseHandler: async () => ({ status: 200 }) }, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  const res = await routes.task.handler(req());
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { jobId: 'job-1', status: 'queued', position: 1, links: { self: '/jobs/job-1', events: '/jobs/job-1/events' } });
});

test('POST /task?wait=true runs synchronously with the Phase 2 shape', async () => {
  const routes = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async (t) => ({ taskId: 't-1', status: 'completed', result: t.goal, history: [], budget: null }), mcpRaw: () => {}, runLoopEnabled: true });
  const res = await routes.task.handler(req({ query: { wait: 'true' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { taskId: 't-1', status: 'completed', result: 'g', history: [], budget: null });
});

test('POST /task with dispatch disabled behaves like wait=true; dispatch_failed → 503', async () => {
  const routes = buildRoutes({ jobs: null, notifier: null, runSync: async () => ({ taskId: 't', status: 'failed', result: { error: 'dispatch_failed', message: 'busy' } }), mcpRaw: () => {}, runLoopEnabled: true });
  const res = await routes.task.handler(req());
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false, error: 'dispatch_failed', message: 'busy' });
});

test('POST /task error mapping: 429 queue_full with Retry-After, 400 bad callback, 503 shutting down, 400 missing goal', async () => {
  const mk = (err) => buildRoutes({ jobs: fakeJobs({ submit: async () => { throw err; } }), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  const full = await mk(new JobQueueFullError()).task.handler(req());
  assert.equal(full.status, 429); assert.equal(full.headers['retry-after'], '30'); assert.equal(full.body.error, 'queue_full');
  const bad = await mk(new InvalidCallbackUrlError('nope')).task.handler(req());
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'invalid_callback_url');
  const closed = await mk(new JobsClosedError()).task.handler(req());
  assert.equal(closed.status, 503); assert.equal(closed.body.error, 'shutting_down');
  const routes = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  const missing = await routes.task.handler(req({ body: {} }));
  assert.equal(missing.status, 400); assert.equal(missing.body.error, 'invalid_task');
});

test('GET /jobs/:id → 200 or 404; DELETE → 202 cancelling, 200 cancelled, 409 terminal, 404', async () => {
  const jobs = fakeJobs({
    cancel: async (id) => ({ 'job-1': { ok: true, status: 'cancelling' }, 'job-q': { ok: true, status: 'cancelled' }, 'job-d': { ok: false, status: 'completed' } }[id] ?? { ok: false, status: null }),
  });
  const routes = buildRoutes({ jobs, notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal((await routes.jobGet.handler(req({ method: 'GET', params: { id: 'job-1' } }))).status, 200);
  assert.equal((await routes.jobGet.handler(req({ method: 'GET', params: { id: 'zzz' } }))).status, 404);
  const c1 = await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'job-1' } }));
  assert.equal(c1.status, 202); assert.deepEqual(c1.body, { ok: true, status: 'cancelling' });
  assert.equal((await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'job-q' } }))).status, 200);
  assert.equal((await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'job-d' } }))).status, 409);
  assert.equal((await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'nope' } }))).status, 404);
});

test('route table shape: task absent without runLoop; job routes absent without jobs; events absent without sse', async () => {
  const none = buildRoutes({ jobs: null, notifier: null, runSync: null, mcpRaw: () => {}, runLoopEnabled: false });
  assert.equal(none.task, null); assert.equal(none.jobGet, null); assert.equal(none.jobEvents, null);
  assert.equal(none.health.auth, false); assert.equal(none.mcp.raw, true);
  const some = buildRoutes({ jobs: fakeJobs(), notifier: { sseHandler: null }, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal(some.jobGet.method, 'GET'); assert.equal(some.jobGet.path, '/jobs/:id');
  assert.equal(some.jobCancel.method, 'DELETE'); assert.equal(some.jobEvents, null);
});
```

- [ ] **Step 2: Write the failing host integration tests**

Append to `tests/host-index.test.mjs`. Add at the top of the file:

```js
import { setTimeout as sleep } from 'node:timers/promises';
import { readSse } from './helpers/sse.mjs';
```

(`tests/helpers/sse.mjs` is created in this task, Step 6.) Then append:

```js
const scripted = () => createMockFleetApi({
  members: rosterNames(2),
  promptResponses: [
    '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
    '```done\n{"result": "inspected", "summary": "ok"}\n```',
  ],
});
const asyncHost = (extra = {}) => startHost({
  port: 0, dispatcher: undefined, env: { ...process.env, NODE_ENV: 'test' },
  runLoop: { enabled: true, strategy: 'open-ended' },
  dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 1, concurrency: 1 },
  notify: { webhook: { allowHttp: true, retries: 1 } },
  ...extra,
});
async function getJson(port, path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('POST /task returns 202 and the job completes; GET /jobs/:id matches SSE settled', async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  try {
    const res = await httpPost(host.port(), '/task', { goal: 'Inspect members' });
    assert.equal(res.status, 202);
    const { jobId, links } = JSON.parse(res.body);
    assert.equal(links.events, `/jobs/${jobId}/events`);
    const types = []; let settled;
    for await (const e of readSse(await fetch(`http://127.0.0.1:${host.port()}${links.events}`))) {
      types.push(e.event); if (e.event === 'settled') settled = e;
    }
    assert.equal(types[0], 'queued'); assert.equal(types.at(-1), 'settled');
    assert.ok(types.includes('started') && types.includes('progress'));
    const rec = await getJson(host.port(), `/jobs/${jobId}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.status, settled.data.status);
    assert.equal(rec.body.status, 'completed');
    assert.ok(rec.body.history.length > 0);
  } finally { await close(); }
});

test('POST /task?wait=true keeps the Phase 2 synchronous shape', async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  try {
    const res = await httpPost(host.port(), '/task?wait=true', { goal: 'Inspect members' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['budget', 'history', 'result', 'status', 'taskId']);
    assert.equal(body.status, 'completed');
  } finally { await close(); }
});

test('429 when the job queue is full; 404 unknown job; DELETE cancels', async () => {
  // A fleet whose prompts never resolve until released, so jobs stay processing.
  let release; const gate = new Promise(r => { release = r; });
  const fleetApi = createMockFleetApi({ members: rosterNames(2), promptResponses: () => '```done\n{"result": 1}\n```' });
  const origPrompt = fleetApi.executePrompt.bind(fleetApi);
  fleetApi.executePrompt = async (o) => { await gate; return origPrompt(o); };
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi, dispatcher });
  try {
    const a = JSON.parse((await httpPost(host.port(), '/task', { goal: 'a' })).body);
    await sleep(30);                                        // a is processing
    const b = await httpPost(host.port(), '/task', { goal: 'b' });   // queued (1/1)
    assert.equal(b.status, 202);
    const c = await httpPost(host.port(), '/task', { goal: 'c' });
    assert.equal(c.status, 429);
    assert.equal(JSON.parse(c.body).error, 'queue_full');
    assert.equal((await getJson(host.port(), '/jobs/does-not-exist')).status, 404);
    const del = await getJson(host.port(), `/jobs/${a.jobId}`, 'DELETE');
    assert.equal(del.status, 202);
    await sleep(30);
    assert.equal((await getJson(host.port(), `/jobs/${a.jobId}`)).body.status, 'cancelled');
    release();
  } finally { release?.(); await close(); }
});

test('webhook receives the settled event', async () => {
  const received = [];
  const receiver = (await import('node:http')).createServer((req, res) => {
    let data = ''; req.on('data', c => { data += c; }); req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(data) }); res.end(); });
  });
  await new Promise(r => receiver.listen(0, '127.0.0.1', r));
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  try {
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const { jobId } = JSON.parse((await httpPost(host.port(), '/task', { goal: 'x', callbackUrl: url })).body);
    for (let i = 0; i < 100 && received.length === 0; i++) await sleep(20);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-fleet-job-id'], jobId);
    assert.equal(received[0].body.type, 'settled');
  } finally { await close(); receiver.close(); }
});

test('builder .dispatch().notify() start returns jobs and submit works programmatically', async () => {
  const dispatcher = await makeDispatcher();
  const agent = createHost({ fleetApi: scripted(), dispatcher, env: { ...process.env, NODE_ENV: 'test' } })
    .runLoop({ strategy: 'open-ended' })
    .dispatch({ store: { kind: 'memory' } })
    .notify({ sse: { enabled: false } })
    .build();
  const { jobs, close } = await agent.start({ port: 0 });
  try {
    const { jobId } = await jobs.submit({ goal: 'x' });
    for (let i = 0; i < 100 && (await jobs.get(jobId)).status !== 'completed'; i++) await sleep(10);
    assert.equal((await jobs.get(jobId)).status, 'completed');
  } finally { await close(); }
});

test('raw-http adapter serves the same host', async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi: makeMockFleetApi(), dispatcher, port: 0, adapter: 'raw-http' });
  try {
    assert.deepEqual((await getJson(host.port(), '/health')).body, { ok: true });
    const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
    const client = new Client({ name: 't', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.ok((await client.listTools()).tools.some(t => t.name === 'weather'));
    await client.close();
  } finally { await close(); }
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/host-routes.test.mjs tests/host-index.test.mjs`
Expected: FAIL (routes module missing; `/task` returns 200 not 202; no `jobs` on start).

- [ ] **Step 4: Create `host/jobs/index.mjs`**

```js
// host/jobs/index.mjs
import { assertJobsBackend } from './interface.mjs';
import { createInProcessJobs } from './in-process.mjs';
import { createMemoryStore } from './store/memory.mjs';
import { createSqliteStore } from './store/sqlite.mjs';

export async function createJobsBackend(dispatchConfig, {
  runJob, notifier = null, logger = console, capacity = 1, allowHttpCallbacks = false, durableClient = null,
}) {
  if (dispatchConfig.backend === 'durable') {
    const { createDurableJobs } = await import('./durable.mjs');
    return assertJobsBackend(createDurableJobs({ client: durableClient, config: dispatchConfig, notifier, logger, allowHttpCallbacks }));
  }
  const store = dispatchConfig.store.kind === 'memory'
    ? createMemoryStore()
    : createSqliteStore({ dbPath: dispatchConfig.store.dbPath });
  return assertJobsBackend(createInProcessJobs({
    store, runJob, notifier, logger, allowHttpCallbacks,
    config: { ...dispatchConfig, capacity },
  }));
}
```

- [ ] **Step 5: Create `host/routes.mjs`**

```js
// host/routes.mjs
import { JobQueueFullError, JobsClosedError, InvalidCallbackUrlError } from './jobs/interface.mjs';

const json = (status, body, headers) => ({ status, body, ...(headers ? { headers } : {}) });

function syncResponse(result) {
  if (result.status === 'failed' && result.result?.error === 'dispatch_failed') {
    return json(503, { ok: false, error: 'dispatch_failed', message: result.result.message });
  }
  return json(200, result);
}

export function buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled }) {
  const routes = {
    health: { method: 'GET', path: '/health', auth: false, handler: async () => json(200, { ok: true }) },
    mcp: { method: 'POST', path: '/mcp', raw: true, handler: mcpRaw, web: mcpWeb },
    task: null, jobGet: null, jobCancel: null, jobEvents: null,
  };

  if (runLoopEnabled) {
    routes.task = {
      method: 'POST', path: '/task',
      handler: async (request) => {
        const body = request.body ?? {};
        if (typeof body.goal !== 'string' || !body.goal.trim()) {
          return json(400, { ok: false, error: 'invalid_task', message: 'goal (string) is required' });
        }
        const wait = String(request.query.wait ?? '').toLowerCase();
        if (!jobs || wait === 'true' || wait === '1') {
          return syncResponse(await runSync(body, { signal: request.signal }));
        }
        const { callbackUrl, metadata, ...task } = body;
        try {
          const out = await jobs.submit(task, { callbackUrl, metadata: { ...(metadata ?? {}), user: request.user?.id ?? null } });
          return json(202, { ...out, links: { self: `/jobs/${out.jobId}`, events: `/jobs/${out.jobId}/events` } });
        } catch (err) {
          if (err instanceof JobQueueFullError) return json(429, { ok: false, error: 'queue_full', message: err.message }, { 'retry-after': '30' });
          if (err instanceof InvalidCallbackUrlError) return json(400, { ok: false, error: 'invalid_callback_url', message: err.message });
          if (err instanceof JobsClosedError) return json(503, { ok: false, error: 'shutting_down', message: err.message });
          if (err instanceof TypeError) return json(400, { ok: false, error: 'invalid_task', message: err.message });
          throw err;
        }
      },
    };
  }

  if (jobs) {
    routes.jobGet = {
      method: 'GET', path: '/jobs/:id',
      handler: async ({ params }) => {
        const record = await jobs.get(params.id);
        return record ? json(200, record) : json(404, { ok: false, error: 'not_found' });
      },
    };
    routes.jobCancel = {
      method: 'DELETE', path: '/jobs/:id',
      handler: async ({ params }) => {
        const out = await jobs.cancel(params.id);
        if (out.ok && out.status === 'cancelling') return json(202, out);
        if (out.ok) return json(200, out);
        if (out.status === null) return json(404, { ok: false, error: 'not_found' });
        return json(409, { ok: false, error: 'already_terminal', status: out.status });
      },
    };
    if (notifier?.sseHandler) {
      routes.jobEvents = { method: 'GET', path: '/jobs/:id/events', handler: notifier.sseHandler };
    }
  }
  return routes;
}
```

- [ ] **Step 6: Create `tests/helpers/sse.mjs`**

```js
// tests/helpers/sse.mjs
// Consume a fetch() Response carrying text/event-stream. Yields { id, event, data }.
export async function* readSse(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      if (!block.trim() || block.startsWith(':')) continue;               // heartbeat
      const field = (k) => block.split('\n').find(l => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();
      const data = field('data');
      yield { id: Number(field('id')), event: field('event'), data: data ? JSON.parse(data) : null };
    }
  }
}
```

- [ ] **Step 7: Rewire `host/index.mjs`**

Replace the adapter registry, `startHost` body from "const adapter = ..." through the end of `close`, and the builder. The full new module:

```js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { buildMcpServer } from '../mcp/server.mjs';
import { authenticateRequest as defaultAuthenticate } from '../mcp/auth.mjs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { loadConfig } from './config.mjs';
import { extendRegistry } from './tools/registry.mjs';
import { executeTool } from './tools/executor.mjs';
import { createExpressAdapter } from '../comm/express.mjs';
import { createRawHttpAdapter } from '../comm/raw-http.mjs';
import { createGuardrails } from './guardrails.mjs';
import { executeHostedTask } from './tasks.mjs';
import { createJobsBackend } from './jobs/index.mjs';
import { resolveDispatchConfig, resolveNotifyConfigWithEnv } from './jobs/config.mjs';
import { createNotifier } from './notify/index.mjs';
import { buildRoutes } from './routes.mjs';

const SUPPORTED_ADAPTERS = {
  'express': () => createExpressAdapter(),
  'raw-http': () => createRawHttpAdapter(),
  'azure-functions': async () => (await import('../comm/azure-functions/http.mjs')).createAzureFunctionsAdapter(),
};

async function resolveAdapter(name) {
  const factory = SUPPORTED_ADAPTERS[name];
  if (!factory) throw new Error(`unsupported comm adapter: "${name}"`);
  return factory();
}

function defaultConfigDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveModules(config, { runLoop, budgets, guardrails, dispatch, notify } = {}) {
  return {
    runLoopConfig: runLoop ?? config.modules?.runLoop,
    budgetsConfig: budgets ?? config.modules?.budgets,
    guardrailsConfig: guardrails ?? config.modules?.guardrails,
    dispatchConfig: dispatch ?? config.modules?.dispatch,
    notifyConfig: notify ?? config.modules?.notify,
  };
}

function createPhase2Modules(toolRegistry, { runLoopConfig, budgetsConfig, guardrailsConfig }) {
  const runLoopEnabled = runLoopConfig?.enabled ?? !!runLoopConfig?.strategy;
  const budgetsEnabled = budgetsConfig && (budgetsConfig.enabled ?? true);
  const guardrailsEnabled = guardrailsConfig && (guardrailsConfig.enabled ?? true);
  const guardrailsMod = guardrailsEnabled ? createGuardrails(guardrailsConfig, toolRegistry, executeTool) : null;
  return { runLoopEnabled, runLoopConfig, budgetsConfig: budgetsEnabled ? budgetsConfig : null, guardrailsMod };
}

export async function startHost({
  fleetApi, dispatcher, port, bindHost: bindHostOption, adapter: adapterName, createAdapter,
  env = process.env, registry, configDir, authenticate = defaultAuthenticate,
  runLoop: runLoopOption, budgets: budgetsOption, guardrails: guardrailsOption,
  dispatch: dispatchOption, notify: notifyOption, durableClient = null,
} = {}) {
  const config = await loadConfig(configDir ?? defaultConfigDir(), env);

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { ensureApralabs } = await import('../workflows/demo/ensure-apralabs.mjs');
    ensureApralabs();
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try { await stopFleet?.(); } catch { /* preserve original error */ }
      throw err;
    }
  }

  const toolRegistry = registry ?? extendRegistry();
  const resolved = resolveModules(config, {
    runLoop: runLoopOption, budgets: budgetsOption, guardrails: guardrailsOption, dispatch: dispatchOption, notify: notifyOption,
  });
  const { runLoopEnabled, runLoopConfig, budgetsConfig, guardrailsMod } = createPhase2Modules(toolRegistry, resolved);

  // Phase 4 modules. Builder overrides arrive raw, config-file values arrive resolved; resolve again idempotently.
  const dispatchEnabled = runLoopEnabled && !!(resolved.dispatchConfig?.enabled ?? (dispatchOption ? true : false));
  const dispatchConfig = dispatchEnabled ? resolveDispatchConfig({ ...resolved.dispatchConfig, enabled: true }, { env, budgetsConfig }) : null;
  const notifyConfig = resolveNotifyConfigWithEnv(resolved.notifyConfig ?? {}, env);

  const runSync = (task, { signal } = {}) => executeHostedTask(task, {
    api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, signal,
  });
  const runJob = (task, { signal, onProgress }) => executeHostedTask(task, {
    api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, signal, onProgress,
  });

  let jobs = null;
  let notifier = null;
  if (dispatchEnabled) {
    // Notifier and jobs reference each other: SSE reads from jobs, jobs publish to notifier.
    const late = { jobs: null };
    notifier = createNotifier(notifyConfig, {
      jobs: { get: (id) => late.jobs.get(id), events: (id, o) => late.jobs.events(id, o), subscribe: (id, fn) => late.jobs.subscribe(id, fn) },
    });
    jobs = await createJobsBackend(dispatchConfig, {
      runJob, notifier, capacity: activeDispatcher.capacity,
      allowHttpCallbacks: notifyConfig.webhook.allowHttp, durableClient,
    });
    late.jobs = jobs;
    await jobs.start();
  }

  const mcpExecute = guardrailsMod
    ? (tool, executorArgs) => guardrailsMod.execute(tool, executorArgs)
    : (tool, executorArgs) => executeTool(tool, executorArgs);

  const mcpServerFactory = () => buildMcpServer({ fleetApi: api, dispatcher: activeDispatcher, registry: toolRegistry, execute: mcpExecute, jobs });

  const mcpRaw = async (req, res) => {
    const server = mcpServerFactory();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  };

  const routes = buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb: null, runLoopEnabled });

  const adapter = createAdapter ? createAdapter() : await resolveAdapter(adapterName ?? config.comm.adapter);
  const listenPort = port ?? config.comm.port;
  const bindHost = bindHostOption ?? config.comm.host;

  try {
    await adapter.start({ routes, port: listenPort, host: bindHost, authenticate, mcpServerFactory });
  } catch (err) {
    try { await adapter.stop(); } catch { /* preserve */ }
    try { await jobs?.stop({ drainMs: 0 }); } catch { /* preserve */ }
    try { await ownDispatcher?.close(); } catch { /* preserve */ }
    try { await stopFleet?.(); } catch { /* preserve */ }
    throw err;
  }

  console.log(
    `host '${config.name}' listening on http://${bindHost}:${adapter.port() ?? '(platform)'} ` +
    `(worker capacity ${activeDispatcher.capacity}${jobs ? `, jobs backend ${dispatchConfig.backend}` : ''})`,
  );

  async function callTool(name, args = {}, { signal } = {}) {
    const tool = toolRegistry.find(t => t.name === name);
    if (!tool) return { ok: false, error: 'not_found', message: `tool "${name}" not found` };
    let lease;
    try {
      lease = await activeDispatcher.dispatch({ signal });
    } catch (err) {
      return { ok: false, error: 'dispatch_failed', message: String(err?.message ?? err) };
    }
    try {
      const executorArgs = {
        fleetApi: createPooledFleetApi(api, lease), args, signal: lease.signal ?? signal,
        reportPhase: () => {}, workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer }, jobs,
      };
      return guardrailsMod ? await guardrailsMod.execute(tool, executorArgs) : await executeTool(tool, executorArgs);
    } finally {
      await lease.release();
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    activeDispatcher.beginShutdown();
    await adapter.stop();
    await jobs?.stop({ drainMs: dispatchConfig?.drainMs });
    await notifier?.stop();
    await ownDispatcher?.close();
    await stopFleet?.();
  };

  return { host: adapter, jobs, notifier, callTool, close, stop: close, config, registry: toolRegistry };
}

export function createHost(options = {}) {
  const overrides = { ...options };
  const builder = {
    tools(registry)    { overrides.registry = registry; return builder; },
    comm(commConfig)   {
      if (commConfig && typeof commConfig === 'object') {
        if ('port' in commConfig) overrides.port = commConfig.port;
        if ('host' in commConfig) overrides.bindHost = commConfig.host;
        if ('adapter' in commConfig) overrides.adapter = commConfig.adapter;
      }
      return builder;
    },
    runLoop(config)    { overrides.runLoop = { enabled: true, ...config }; return builder; },
    budget(config)     { overrides.budgets = config; return builder; },
    guardrails(config) { overrides.guardrails = config; return builder; },
    dispatch(config)   { overrides.dispatch = { enabled: true, ...config }; return builder; },
    notify(config)     { overrides.notify = config; return builder; },
    build() {
      const hostOptions = overrides;
      return {
        start: (startOpts = {}) => startHost({ ...hostOptions, ...startOpts }),
        run: async (task, runOpts = {}) => {
          const config = await loadConfig(hostOptions.configDir ?? defaultConfigDir(), hostOptions.env ?? process.env);
          const toolRegistry = hostOptions.registry ?? extendRegistry();
          const { runLoopEnabled, runLoopConfig, budgetsConfig, guardrailsMod } =
            createPhase2Modules(toolRegistry, resolveModules(config, hostOptions));
          if (!runLoopEnabled) throw new Error('run loop is not enabled');
          const api = hostOptions.fleetApi;
          const activeDispatcher = hostOptions.dispatcher;
          if (!api || !activeDispatcher) throw new Error('fleetApi and dispatcher are required for agent.run()');
          return executeHostedTask(task, { api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, signal: runOpts.signal });
        },
      };
    },
  };
  return builder;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startHost();
    const shutdown = async () => { await close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

Also: `buildMcpServer` now receives an extra `jobs` option it ignores until Task 10, and `adapter.start` receives `mcpServerFactory`, which Express and raw-http ignore and the Azure adapter (Task 12) uses. Delete the transitional legacy-handler branch from `comm/express.mjs`.

- [ ] **Step 8: Run tests**

Run: `node --test tests/host-routes.test.mjs tests/host-index.test.mjs && npm run test:host && npm run test:phase2`
Expected: PASS. The Phase 2 test "POST /task returns 404 when run loop is disabled" still passes (route absent → 404).

- [ ] **Step 9: Commit (with approval)**

```bash
git add host/index.mjs host/routes.mjs host/jobs/index.mjs comm/express.mjs tests/helpers/sse.mjs tests/host-routes.test.mjs tests/host-index.test.mjs
git commit -m "feat: wire async jobs, notifier, and route table into the host"
```

---

### Task 10: MCP tools `submit-task` and `job-status`

**Files:**
- Create: `host/tools/jobs-tools.mjs`
- Modify: `host/tools/registry.mjs` (export `withJobTools(registry, jobs)`)
- Modify: `mcp/server.mjs` (skip lease for tools tagged `jobs`; pass `jobs` in executor args)
- Modify: `host/index.mjs` (build the registry with job tools when dispatch is enabled)
- Test: `tests/host-jobs-tools.test.mjs`, `tests/host-index.test.mjs` (append one test)

**Interfaces:**
- Produces `jobTools` (array of two extended registry entries) and `withJobTools(registry, jobs) → registry` which appends them only when `jobs` is truthy. Both entries have `tags: ['jobs']`, `reversible: true`, and `run({ args, jobs })`.
- `buildMcpServer({ ..., jobs })`: for entries whose `tags` include `'jobs'`, `invoke` does not call `dispatcher.dispatch`; it calls `execute(entry, { args, jobs, signal, reportPhase })` (or `entry.run`).

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-jobs-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { jobTools, withJobTools } = await import('../host/tools/registry.mjs');

const fakeJobs = {
  submit: async (task, opts) => ({ jobId: 'job-9', status: 'queued', position: 1, _task: task, _opts: opts }),
  get: async (id) => (id === 'job-9' ? { id, status: 'completed', result: 42 } : null),
};

test('withJobTools appends the two tools only when jobs is present', () => {
  const base = [{ name: 'weather', tags: [] }];
  assert.equal(withJobTools(base, null).length, 1);
  const out = withJobTools(base, fakeJobs);
  assert.deepEqual(out.map(t => t.name), ['weather', 'submit-task', 'job-status']);
  for (const t of out.slice(1)) { assert.deepEqual(t.tags, ['jobs']); assert.equal(t.reversible, true); assert.ok(t.inputSchema); }
});

test('submit-task validates input and forwards callbackUrl', async () => {
  const tool = jobTools.find(t => t.name === 'submit-task');
  assert.equal(tool.inputSchema.safeParse({}).success, false);
  const out = await tool.run({ args: { goal: 'g', inputs: { a: 1 }, callbackUrl: 'https://cb.test/h' }, jobs: fakeJobs });
  assert.equal(out.jobId, 'job-9');
  assert.deepEqual(out._task, { goal: 'g', inputs: { a: 1 } });
  assert.equal(out._opts.callbackUrl, 'https://cb.test/h');
});

test('job-status returns the record or a not_found value', async () => {
  const tool = jobTools.find(t => t.name === 'job-status');
  assert.equal((await tool.run({ args: { jobId: 'job-9' }, jobs: fakeJobs })).result, 42);
  assert.deepEqual(await tool.run({ args: { jobId: 'zzz' }, jobs: fakeJobs }), { ok: false, error: 'not_found', jobId: 'zzz' });
});
```

Append to `tests/host-index.test.mjs`:

```js
test('MCP submit-task and job-status work without taking a worker lease', async () => {
  const dispatcher = await makeDispatcher();
  let dispatches = 0;
  const origDispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = async (o) => { dispatches += 1; return origDispatch(o); };
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  const client = new Client({ name: 't', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port()}/mcp`)));
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'submit-task') && tools.some(t => t.name === 'job-status'));
    const submitted = await client.callTool({ name: 'submit-task', arguments: { goal: 'Inspect members' } });
    const { jobId } = JSON.parse(submitted.content[0].text);
    assert.equal(dispatches, 0, 'submit-task must not take a lease');
    let record;
    for (let i = 0; i < 100; i++) {
      record = JSON.parse((await client.callTool({ name: 'job-status', arguments: { jobId } })).content[0].text);
      if (record.status === 'completed') break;
      await sleep(10);
    }
    assert.equal(record.status, 'completed');
    assert.equal(dispatches, 1, 'only the job itself takes a lease');
  } finally { try { await client.close(); } finally { await close(); } }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-tools.test.mjs`
Expected: FAIL (`jobTools` undefined).

- [ ] **Step 3: Create `host/tools/jobs-tools.mjs` and export from the registry**

```js
// host/tools/jobs-tools.mjs
import * as z from 'zod/v4';

export const jobTools = [
  {
    name: 'submit-task',
    description: 'Submit a task for asynchronous execution by this agent. Returns a job id; poll it with job-status. Use for work that may take more than a minute.',
    inputSchema: z.object({
      goal: z.string().min(1).describe('Natural-language description of the task'),
      inputs: z.record(z.string(), z.any()).optional().describe('Structured inputs for the task'),
      callbackUrl: z.string().url().optional().describe('HTTPS URL to POST the settled event to'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
    reversible: true, timeout: 10_000, retryable: false, tags: ['jobs'],
    async run({ args, jobs }) {
      const { callbackUrl, ...task } = args;
      return jobs.submit(task, { callbackUrl, metadata: { via: 'mcp' } });
    },
  },
  {
    name: 'job-status',
    description: 'Return the current record for a job submitted with submit-task: status, progress, and the result once finished.',
    inputSchema: z.object({ jobId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    reversible: true, timeout: 10_000, retryable: true, tags: ['jobs'],
    async run({ args, jobs }) {
      return (await jobs.get(args.jobId)) ?? { ok: false, error: 'not_found', jobId: args.jobId };
    },
  },
];
```

Append to `host/tools/registry.mjs`:

```js
import { jobTools } from './jobs-tools.mjs';
export { jobTools };

export function withJobTools(registry, jobs) {
  if (!jobs) return registry;
  return [...registry, ...extendRegistry(jobTools)];
}
```

- [ ] **Step 4: Update `mcp/server.mjs`**

Change the signature to `buildMcpServer({ fleetApi, dispatcher, registry = defaultRegistry, execute, jobs = null } = {})` and replace the start of `invoke`:

```js
    const invoke = async (args, ctx) => {
      const reportPhase = makePhaseReporter(ctx);

      // Job-control tools touch no Fleet member: no lease.
      if (entry.tags?.includes('jobs')) {
        if (!jobs) return { content: [{ type: 'text', text: 'jobs backend not enabled' }], isError: true };
        const executorArgs = { args, jobs, signal: ctx.mcpReq.signal, reportPhase, fleetApi: null };
        if (execute) {
          const execResult = await execute(entry, executorArgs);
          if (!execResult.ok) return { content: [{ type: 'text', text: JSON.stringify(execResult) }], isError: true };
          return toToolResult(execResult.result);
        }
        return toToolResult(await entry.run(executorArgs));
      }

      const lease = await dispatcher.dispatch({ signal: ctx.mcpReq.signal, reportPhase });
      // ...existing body unchanged from here...
```

- [ ] **Step 5: Register the tools in `host/index.mjs`**

The registry is built before `jobs` exists, so extend it after the backend is created. Change:

```js
  const toolRegistry = registry ?? extendRegistry();
```
to
```js
  const baseRegistry = registry ?? extendRegistry();
  const toolRegistry = [...baseRegistry];   // job tools appended below once jobs exists
```

and after `await jobs.start();` inside the `if (dispatchEnabled)` block add:

```js
    toolRegistry.push(...withJobTools([], jobs));
```

(`withJobTools([], jobs)` returns just the two extended entries.) Import `withJobTools` from `./tools/registry.mjs`. The guardrails module was created with `toolRegistry` by reference, so it sees the appended entries.

- [ ] **Step 6: Run tests**

Run: `node --test tests/host-jobs-tools.test.mjs tests/host-index.test.mjs && npm run test:host && npm run test:integration`
Expected: PASS. `tests/mcp.test.mjs` still passes because `jobs` defaults to `null` and no default-registry tool carries the `jobs` tag.

- [ ] **Step 7: Commit (with approval)**

```bash
git add host/tools/jobs-tools.mjs host/tools/registry.mjs mcp/server.mjs host/index.mjs tests/host-jobs-tools.test.mjs tests/host-index.test.mjs
git commit -m "feat: add submit-task and job-status MCP tools"
```

---

### Task 11: Durable Functions jobs backend

**Files:**
- Create: `host/jobs/durable.mjs`
- Test: `tests/host-jobs-durable.test.mjs`

**Interfaces:**
- Consumes: a Durable client with `startNew(name, { instanceId, input })`, `getStatus(id, { showHistory, showInput })`, `raiseEvent(id, name, data)`, `terminate(id, reason)`, `getStatusBy({ runtimeStatus })`. Runtime status strings: `Pending | Running | Completed | Failed | Terminated | Canceled | Suspended | ContinuedAsNew`.
- Produces: `createDurableJobs({ client, config, notifier, logger, allowHttpCallbacks, now }) → JobsBackend`, plus pure helpers `mapDurableStatus(status) → JobRecord` and `ORCHESTRATOR_NAME = 'runTaskOrchestrator'`. `customStatus` contract written by the orchestrator (Task 12):
  ```js
  { status, events: JobEvent[] /* ring of 50 */, progress: { iteration, message, at }, cancelRequested: boolean, startedAt, finishedAt }
  ```
  Activity output (the orchestration's `output`): `{ status, result, error, history, budget }` from `settleFromRunResult`.

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

test('submit starts an orchestration with the job id and task input', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: { warn() {} } });
  await jobs.start();
  const out = await jobs.submit({ goal: 'g', inputs: { a: 1 } }, { callbackUrl: 'https://cb.test/h' });
  assert.equal(out.status, 'queued');
  assert.match(out.jobId, /^job-/);
  const call = client.calls.startNew[0];
  assert.equal(call.name, ORCHESTRATOR_NAME);
  assert.equal(call.instanceId, out.jobId);
  assert.equal(call.input.task.goal, 'g');
  assert.equal(call.input.callbackUrl, 'https://cb.test/h');
  assert.equal(call.input.record.status, 'queued');
});

test('submit enforces maxQueueSize over Pending + Running', async () => {
  const client = fakeClient({ instances: { a: { runtimeStatus: 'Pending' }, b: { runtimeStatus: 'Running' } } });
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: { warn() {} } });
  await assert.rejects(() => jobs.submit({ goal: 'g' }), JobQueueFullError);
});

test('mapDurableStatus maps runtime statuses and merges customStatus + output', () => {
  const base = { instanceId: 'job-1', input: { record: { id: 'job-1', status: 'queued', task: { goal: 'g' }, submittedAt: 't0', attempts: 1, progress: { iteration: 0, message: null, at: null }, callbackUrl: null, metadata: {}, history: [], result: null, budget: null, error: null, startedAt: null, finishedAt: null } } };
  assert.equal(mapDurableStatus({ ...base, runtimeStatus: 'Pending' }).status, 'queued');
  const running = mapDurableStatus({ ...base, runtimeStatus: 'Running', customStatus: { status: 'processing', startedAt: 't1', progress: { iteration: 3, message: 'm', at: 't2' } } });
  assert.equal(running.status, 'processing'); assert.equal(running.startedAt, 't1'); assert.equal(running.progress.iteration, 3);
  const done = mapDurableStatus({ ...base, runtimeStatus: 'Completed', customStatus: { status: 'budget_exceeded', finishedAt: 't3' }, output: { status: 'budget_exceeded', result: { r: 1 }, error: null, history: [1], budget: { iterations: 6 } } });
  assert.equal(done.status, 'budget_exceeded'); assert.deepEqual(done.result, { r: 1 }); assert.deepEqual(done.history, [1]); assert.equal(done.finishedAt, 't3');
  const failed = mapDurableStatus({ ...base, runtimeStatus: 'Failed', output: 'boom' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'activity_failed');
  assert.equal(mapDurableStatus({ ...base, runtimeStatus: 'Terminated' }).status, 'cancelled');
  assert.equal(mapDurableStatus(null), null);
});

test('get returns mapped record or null', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: { warn() {} } });
  const { jobId } = await jobs.submit({ goal: 'g' });
  assert.equal((await jobs.get(jobId)).status, 'queued');
  assert.equal(await jobs.get('nope'), null);
});

test('cancel: Pending → terminate; Running → raiseEvent cancel; terminal → not ok', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: { warn() {} } });
  const a = await jobs.submit({ goal: 'a' });
  assert.deepEqual(await jobs.cancel(a.jobId), { ok: true, status: 'cancelled' });
  assert.equal(client.calls.terminate.length, 1);
  const b = await jobs.submit({ goal: 'b' });
  client.instances[b.jobId].runtimeStatus = 'Running';
  assert.deepEqual(await jobs.cancel(b.jobId), { ok: true, status: 'cancelling' });
  assert.deepEqual(client.calls.raiseEvent[0], { id: b.jobId, name: 'cancel', data: {} });
  client.instances[b.jobId].runtimeStatus = 'Completed'; client.instances[b.jobId].output = { status: 'completed' };
  assert.deepEqual(await jobs.cancel(b.jobId), { ok: false, status: 'completed' });
  assert.deepEqual(await jobs.cancel('nope'), { ok: false, status: null });
});

test('events reads customStatus.events with seq; subscribe polls and emits only new events', async () => {
  const client = fakeClient();
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: { warn() {} } });
  const { jobId } = await jobs.submit({ goal: 'g' });
  const inst = client.instances[jobId];
  const E = (type, extra = {}) => ({ type, jobId, at: 't', ...extra });
  inst.customStatus = { status: 'processing', events: [E('queued', { position: 1 }), E('started')] };
  assert.deepEqual((await jobs.events(jobId)).map(e => [e.seq, e.type]), [[1, 'queued'], [2, 'started']]);
  assert.deepEqual((await jobs.events(jobId, { afterSeq: 1 })).map(e => e.seq), [2]);
  const seen = [];
  const unsub = jobs.subscribe(jobId, e => seen.push(e.seq));
  await sleep(15);
  inst.customStatus = { status: 'processing', events: [...inst.customStatus.events, E('progress', { iteration: 1, message: 'm' })] };
  await sleep(15);
  inst.runtimeStatus = 'Completed'; inst.output = { status: 'completed', result: 1 };
  inst.customStatus = { status: 'completed', events: [...inst.customStatus.events, E('settled', { status: 'completed' })] };
  await sleep(20);
  unsub();
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('stats counts pending and running', async () => {
  const client = fakeClient({ instances: { a: { runtimeStatus: 'Pending' }, b: { runtimeStatus: 'Running' }, c: { runtimeStatus: 'Completed' } } });
  const jobs = createDurableJobs({ client, config: cfg, notifier: null, logger: { warn() {} } });
  await jobs.refreshStats();
  assert.deepEqual(jobs.stats(), { queued: 1, processing: 1, capacity: 1, maxQueueSize: 2 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-jobs-durable.test.mjs`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `host/jobs/durable.mjs`**

```js
// host/jobs/durable.mjs
// Jobs backend over Azure Durable Functions. The orchestration instance id IS the job id.
// State lives in the task hub; this module never keeps job state in memory beyond
// per-subscriber polling cursors. See comm/azure-functions/orchestrator.mjs for the
// customStatus contract this module reads.
import { JobQueueFullError, JobsClosedError, validateCallbackUrl } from './interface.mjs';
import { TERMINAL_STATUSES, createRecord, queuedEvent } from './record.mjs';

export const ORCHESTRATOR_NAME = 'runTaskOrchestrator';
export const ACTIVITY_NAME = 'runTaskActivity';
const ACTIVE = ['Pending', 'Running'];

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
    out.error = { code: 'activity_failed', message: typeof instance.output === 'string' ? instance.output : JSON.stringify(instance.output ?? 'orchestration failed') };
    out.finishedAt = out.finishedAt ?? instance.lastUpdatedTime ?? null;
  }
  if (TERMINAL_STATUSES.has(status) && !out.finishedAt) out.finishedAt = instance.lastUpdatedTime ?? null;
  return out;
}

function withSeq(events = []) {
  return events.map((e, i) => ({ seq: i + 1, ...e }));
}

export function createDurableJobs({ client, config, notifier = null, logger = console, allowHttpCallbacks = false, now = () => new Date() }) {
  if (!client) throw new Error('createDurableJobs requires a Durable client');
  const { maxQueueSize = 100, durable: { pollMs = 2000 } = {} } = config;
  let closed = false;
  let lastStats = { queued: 0, processing: 0 };
  const pollers = new Map(); // jobId → { timer, subs:Set, lastSeq }

  async function activeInstances() {
    return client.getStatusBy({ runtimeStatus: ACTIVE });
  }

  function startPoller(jobId) {
    const state = { subs: new Set(), lastSeq: 0, timer: null };
    const tick = async () => {
      try {
        const inst = await client.getStatus(jobId, { showHistory: false, showInput: true });
        const events = withSeq(inst?.customStatus?.events);
        for (const e of events) {
          if (e.seq > state.lastSeq) { state.lastSeq = e.seq; for (const fn of state.subs) { try { fn(e); } catch { /* subscriber */ } } }
        }
        const rec = mapDurableStatus(inst);
        if (!inst || TERMINAL_STATUSES.has(rec?.status)) {
          if (state.subs.size === 0 || events.at(-1)?.type === 'settled') stopPoller(jobId);
        }
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
  function stopPoller(jobId) {
    const s = pollers.get(jobId);
    if (!s) return;
    clearInterval(s.timer);
    pollers.delete(jobId);
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
        input: { task: { id: record.id, ...record.task }, record, callbackUrl: url, metadata: metadata ?? {}, queuedEvent: queuedEvent(record.id, position, now()) },
      });
      return { jobId: record.id, status: 'queued', position };
    },

    async get(jobId) {
      return mapDurableStatus(await client.getStatus(jobId, { showHistory: false, showInput: true }));
    },

    async cancel(jobId) {
      const inst = await client.getStatus(jobId, { showHistory: false, showInput: true });
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
      return () => { state.subs.delete(onEvent); if (state.subs.size === 0) stopPoller(jobId); };
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      const inst = await client.getStatus(jobId, { showHistory: false, showInput: true });
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

Note the spec's `events` ring: `withSeq` numbers whatever is in `customStatus.events`. When the orchestrator truncates progress events, numbering for older events would shift; to keep `Last-Event-ID` stable the orchestrator (Task 12) stores `seq` on each event it appends, and `withSeq` must prefer a stored `seq`. Change `withSeq` to:

```js
function withSeq(events = []) {
  return events.map((e, i) => ({ seq: e.seq ?? i + 1, ...e }));
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/host-jobs-durable.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit (with approval)**

```bash
git add host/jobs/durable.mjs tests/host-jobs-durable.test.mjs
git commit -m "feat: add Durable Functions jobs backend"
```

---

### Task 12: Azure Functions adapter, orchestrator, and activity

<!-- Task 0 MCP streamable transport exports: @modelcontextprotocol/server → WebStandardStreamableHTTPServerTransport; @modelcontextprotocol/node → NodeStreamableHTTPServerTransport -->

Before starting, fill in the MCP transport export names recorded in Task 0 Step 3.

**Files:**
- Create: `comm/azure-functions/http.mjs`
- Create: `comm/azure-functions/orchestrator.mjs`
- Create: `comm/azure-functions/activity.mjs`
- Create: `comm/azure-functions/index.mjs`
- Create: `comm/azure-functions/host.json`
- Create: `comm/azure-functions/local.settings.json.example`
- Create: `comm/azure-functions/main.mjs` (Functions entry: starts the host with the azure adapter)
- Test: `tests/comm-azure-orchestrator.test.mjs`, `tests/comm-azure-http.test.mjs`

**Interfaces:**
- Consumes: RouteDefs (Task 7), `mcpServerFactory` passed to `adapter.start` (Task 9), `executeHostedTask` (Task 4), `ORCHESTRATOR_NAME`/`ACTIVITY_NAME` and the customStatus contract (Task 11).
- Produces:
  - `createAzureFunctionsAdapter({ app } = {}) → { start({ routes, authenticate, mcpServerFactory }), stop(), port() → null, address() → null }`. `app` defaults to the lazily imported `@azure/functions` `app`; tests inject a fake.
  - `toNeutralRequest(httpRequest, params) → request` and `toHttpResponse(response) → HttpResponseInit` (pure, tested).
  - `runTaskOrchestrator(context)` generator and `buildOrchestrator({ ring, now })` for tests.
  - `createRunTaskActivity({ getHost, getClient, pollMs })` and `signalCancelActivity` (module-level cancel registry used only as a fast path; the authoritative signal is `customStatus.cancelRequested` polled from the task hub).

- [ ] **Step 1: Write the failing orchestrator test**

```js
// tests/comm-azure-orchestrator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');

// Minimal replay-free driver for a Durable orchestrator generator.
function fakeContext({ instanceId = 'job-1', input }) {
  const statuses = [];
  const tasks = [];
  const mk = (kind, name) => { const t = { kind, name, done: false, result: undefined }; tasks.push(t); return t; };
  const df = {
    instanceId,
    getInput: () => input,
    setCustomStatus: (s) => statuses.push(structuredClone(s)),
    callActivity: (name, inp) => mk('activity', name, inp),
    waitForExternalEvent: (name) => mk('event', name),
    Task: { any: (list) => ({ kind: 'any', list }) },
    currentUtcDateTime: new Date('2026-09-17T10:00:00.000Z'),
  };
  return { df, statuses, tasks };
}

// Drives the generator: each yielded Task.any is resolved by the test via `resolve(taskPredicate, result)`.
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

const input = { task: { id: 'job-1', goal: 'g' }, record: { id: 'job-1' }, callbackUrl: null, queuedEvent: { type: 'queued', jobId: 'job-1', at: 't0', position: 1 } };

test('orchestrator records queued, forwards progress, and settles from the activity output', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  assert.equal(ctx.statuses[0].status, 'queued');
  assert.deepEqual(ctx.statuses[0].events.map(e => e.type), ['queued']);
  assert.equal(ctx.statuses[0].events[0].seq, 1);

  d.resolve(t => t.kind === 'event' && t.name === 'progress', { type: 'progress', jobId: 'job-1', at: 't1', iteration: 1, message: 'm' });
  assert.equal(ctx.statuses.at(-1).status, 'processing');
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'progress']);
  assert.deepEqual(ctx.statuses.at(-1).progress, { iteration: 1, message: 'm', at: 't1' });

  const output = { status: 'completed', result: 'ok', error: null, history: [1], budget: null };
  d.resolve(t => t.kind === 'activity', output);
  assert.equal(d.done, true);
  assert.deepEqual(d.value, output);
  assert.equal(ctx.statuses.at(-1).status, 'completed');
  assert.equal(ctx.statuses.at(-1).events.at(-1).type, 'settled');
  assert.ok(ctx.statuses.at(-1).finishedAt);
});

test('orchestrator sets cancelRequested on cancel event and keeps waiting for the activity', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  d.resolve(t => t.kind === 'event' && t.name === 'cancel', {});
  assert.equal(ctx.statuses.at(-1).cancelRequested, true);
  assert.ok(d.pending.some(t => t.kind === 'activity'), 'activity still awaited');
  d.resolve(t => t.kind === 'activity', { status: 'cancelled', result: null, error: null, history: [], budget: null });
  assert.equal(ctx.statuses.at(-1).status, 'cancelled');
});

test('orchestrator ring keeps at most 50 events with stable seq', () => {
  const ctx = fakeContext({ input });
  const d = drive(buildOrchestrator()(ctx));
  for (let i = 1; i <= 70; i++) {
    d.resolve(t => t.kind === 'event' && t.name === 'progress', { type: 'progress', jobId: 'job-1', at: 't', iteration: i, message: `m${i}` });
  }
  const events = ctx.statuses.at(-1).events;
  assert.equal(events.length, 50);
  assert.equal(events[0].seq, 1); assert.equal(events[1].seq, 2);
  assert.equal(events.at(-1).seq, 72); // 1 queued + 1 started + 70 progress
});
```

- [ ] **Step 2: Write the failing HTTP adapter test**

```js
// tests/comm-azure-http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAzureFunctionsAdapter, toNeutralRequest, toHttpResponse } = await import('../comm/azure-functions/http.mjs');

// Fake @azure/functions `app`: records registrations so tests can invoke handlers.
function fakeApp() {
  const registered = {};
  return {
    registered,
    setup(opts) { registered.__setup = opts; },
    http(name, opts) { registered[name] = opts; },
  };
}
function fakeHttpRequest({ method = 'GET', url = 'http://f/api/jobs/j1?q=2', headers = {}, params = {}, body = null, signal } = {}) {
  return {
    method, url, params, query: new URL(url).searchParams,
    headers: new Headers(headers),
    async json() { return body; }, async text() { return body == null ? '' : JSON.stringify(body); },
    signal: signal ?? new AbortController().signal,
  };
}

test('toNeutralRequest maps method, path, params, query, headers, body', async () => {
  const r = await toNeutralRequest(fakeHttpRequest({ method: 'POST', url: 'http://f/api/task?wait=true', headers: { 'X-Test': 'a' }, body: { goal: 'g' } }), { id: 'j1' });
  assert.equal(r.method, 'POST'); assert.equal(r.path, '/task');
  assert.deepEqual(r.params, { id: 'j1' }); assert.deepEqual(r.query, { wait: 'true' });
  assert.equal(r.headers['x-test'], 'a'); assert.deepEqual(r.body, { goal: 'g' });
});

test('toHttpResponse maps JSON and stream responses', async () => {
  const j = toHttpResponse({ status: 202, headers: { 'retry-after': '30' }, body: { a: 1 } });
  assert.equal(j.status, 202); assert.equal(j.headers['retry-after'], '30'); assert.equal(j.jsonBody.a, 1);
  async function* gen() { yield 'a'; yield 'b'; }
  const s = toHttpResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen() });
  assert.equal(s.status, 200); assert.equal(s.headers['content-type'], 'text/event-stream');
  const chunks = []; for await (const c of s.body) chunks.push(c.toString());
  assert.deepEqual(chunks, ['a', 'b']);
});

test('adapter registers one function per route with api-prefix-free routes and applies auth', async () => {
  const app = fakeApp();
  const adapter = createAzureFunctionsAdapter({ app });
  await adapter.start({
    routes: {
      health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
      jobGet: { method: 'GET', path: '/jobs/:id', handler: async (r) => ({ status: 200, body: { id: r.params.id, user: r.user } }) },
      task: null,
      mcp: { method: 'POST', path: '/mcp', raw: true, handler: () => {} },
    },
    authenticate: (r) => (r.headers['x-deny'] ? null : { id: 'u' }),
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => {} }),
  });
  assert.equal(app.registered.__setup.enableHttpStream, true);
  assert.deepEqual(app.registered.jobGet.methods, ['GET']);
  assert.equal(app.registered.jobGet.route, 'jobs/{id}');
  assert.equal(app.registered.jobGet.authLevel, 'anonymous');
  const ok = await app.registered.jobGet.handler(fakeHttpRequest({ params: { id: 'j1' } }), {});
  assert.deepEqual(ok.jsonBody, { id: 'j1', user: { id: 'u' } });
  const denied = await app.registered.jobGet.handler(fakeHttpRequest({ params: { id: 'j1' }, headers: { 'x-deny': '1' } }), {});
  assert.equal(denied.status, 401);
  assert.ok(app.registered.mcp, 'mcp registered');
  assert.equal(adapter.port(), null);
  await adapter.stop();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/comm-azure-orchestrator.test.mjs tests/comm-azure-http.test.mjs`
Expected: FAIL, modules missing.

- [ ] **Step 4: Create `comm/azure-functions/orchestrator.mjs`**

```js
// comm/azure-functions/orchestrator.mjs
// One orchestration per job. Deterministic: it only reacts to Durable-delivered
// events (activity completion, 'progress', 'cancel'). The activity is the run loop.
//
// customStatus contract read by host/jobs/durable.mjs:
//   { status, events: [{ seq, ...JobEvent }] (ring of 50), progress, cancelRequested, startedAt, finishedAt }
import { ACTIVITY_NAME } from '../../host/jobs/durable.mjs';

const RING = 50;

function ring(events, max = RING) {
  if (events.length <= max) return events;
  const keep = events.filter(e => e.type !== 'progress');
  const room = Math.max(0, max - keep.length);
  const progress = events.filter(e => e.type === 'progress').slice(-room);
  return events.filter(e => e.type !== 'progress' || progress.includes(e));
}

export function buildOrchestrator({ ringSize = RING } = {}) {
  return function* runTaskOrchestrator(context) {
    const df = context.df;
    const input = df.getInput();
    const jobId = df.instanceId;
    const nowIso = () => (df.currentUtcDateTime ?? new Date()).toISOString();

    let seq = 0;
    const events = [];
    const push = (e) => { seq += 1; events.push({ seq, ...e }); };
    const state = { status: 'queued', events, progress: { iteration: 0, message: null, at: null }, cancelRequested: false, startedAt: null, finishedAt: null };
    const publish = () => df.setCustomStatus({ ...state, events: ring(events, ringSize) });

    push(input.queuedEvent ?? { type: 'queued', jobId, at: nowIso(), position: 1 });
    publish();

    const activity = df.callActivity(ACTIVITY_NAME, { ...input, jobId });
    let started = false;
    const markStarted = (at) => {
      if (started) return;
      started = true;
      state.status = 'processing'; state.startedAt = at;
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
      } else if (e.type === 'started') {
        // activity announces start explicitly when it begins before any progress
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

- [ ] **Step 5: Create `comm/azure-functions/activity.mjs`**

```js
// comm/azure-functions/activity.mjs
// The run loop inside a Durable activity. One Fleet child per Functions host
// instance, spawned lazily on first use and reused while the instance is warm.
import { executeHostedTask } from '../../host/tasks.mjs';
import { settleFromRunResult } from '../../host/jobs/record.mjs';

// Lazily built host context: { api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, notifier }
let hostContextPromise = null;
export function setHostContextFactory(factory) { hostContextPromise = null; getHostContext.factory = factory; }
export async function getHostContext() {
  if (!hostContextPromise) hostContextPromise = getHostContext.factory();
  return hostContextPromise;
}

export function createRunTaskActivity({ getClient, pollMs = 2000, getContext = getHostContext }) {
  return async function runTaskActivity(input, context) {
    const { jobId, task, callbackUrl } = input;
    const client = getClient(context);
    const hostCtx = await getContext();
    const controller = new AbortController();

    const raise = async (event) => {
      try { await client.raiseEvent(jobId, 'progress', event); }
      catch (err) { context.warn?.(`[activity] raiseEvent failed: ${err?.message ?? err}`); }
    };
    await raise({ type: 'started', jobId, at: new Date().toISOString() });

    // Authoritative cancel signal: the orchestrator's customStatus, polled from the task hub.
    const cancelPoll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId, { showHistory: false, showInput: false });
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* transient */ }
    }, pollMs);
    cancelPoll.unref?.();

    try {
      const run = await executeHostedTask({ ...task, id: jobId }, {
        ...hostCtx, signal: controller.signal,
        onProgress: ({ iteration, message }) => raise({ type: 'progress', jobId, at: new Date().toISOString(), iteration, message }),
      });
      const settled = settleFromRunResult(run);
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') settled.status = 'cancelled';
      if (hostCtx.notifier && callbackUrl) {
        await hostCtx.notifier.publish({ type: 'settled', jobId, at: new Date().toISOString(), status: settled.status, result: settled.result, error: settled.error }, { callbackUrl });
      }
      return settled;
    } finally {
      clearInterval(cancelPoll);
    }
  };
}
```

- [ ] **Step 6: Create `comm/azure-functions/http.mjs`**

```js
// comm/azure-functions/http.mjs
// Azure Functions v4 (Node) HTTP trigger adapter for the neutral comm contract.
import { Readable } from 'node:stream';
import { runHandler, lowerHeaders } from '../router.mjs';

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

const toFunctionsRoute = (path) => path.replace(/^\//, '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

export function createAzureFunctionsAdapter({ app: injectedApp } = {}) {
  let registered = false;
  return {
    async start({ routes, authenticate, mcpServerFactory }) {
      const app = injectedApp ?? (await import('@azure/functions')).app;
      app.setup({ enableHttpStream: true });

      for (const [name, route] of Object.entries(routes)) {
        if (!route) continue;
        const common = { methods: [route.method], route: toFunctionsRoute(route.path), authLevel: 'anonymous' };
        if (route.raw) {
          app.http(name, {
            ...common,
            handler: async (req) => {
              const request = await toNeutralRequest(req, req.params);
              const user = route.auth === false ? null : await authenticate(request);
              if (route.auth !== false && !user) return toHttpResponse({ status: 401, body: { ok: false, error: 'unauthorized' } });
              if (route.web) return route.web(req, user);
              // Fallback for MCP on Functions: web-standard transport from the MCP SDK.
              // REPLACE `WebStandardStreamableHTTPServerTransport` with the export name recorded in Task 0 Step 3.
              const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');
              const server = mcpServerFactory();
              const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
              try {
                await server.connect(transport);
                const webReq = new Request(req.url, { method: req.method, headers: req.headers, body: await req.text() });
                const webRes = await transport.handleRequest(webReq);
                return { status: webRes.status, headers: Object.fromEntries(webRes.headers), body: webRes.body ? Readable.fromWeb(webRes.body) : undefined };
              } finally { await server.close(); }
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
      registered = true;
    },
    async stop() { registered = false; },
    port() { return null; },
    address() { return null; },
  };
}
```

If Task 0 found no web-standard transport in the SDK, replace the fallback branch with: `return toHttpResponse({ status: 501, body: { ok: false, error: 'mcp_not_available_on_functions', message: 'use /task and /jobs on this deployment' } });` and record the limitation in `docs/deploy-azure-functions.md`.

- [ ] **Step 7: Create `comm/azure-functions/index.mjs` and `main.mjs`**

```js
// comm/azure-functions/index.mjs
// Registers orchestrator + activity with Durable Functions and exposes the Durable client input.
export async function registerDurableFunctions({ hostContextFactory }) {
  const df = await import('durable-functions');
  const { ORCHESTRATOR_NAME, ACTIVITY_NAME } = await import('../../host/jobs/durable.mjs');
  const { runTaskOrchestrator } = await import('./orchestrator.mjs');
  const { createRunTaskActivity, setHostContextFactory } = await import('./activity.mjs');

  setHostContextFactory(hostContextFactory);
  const clientInput = df.input.durableClient();
  df.app.orchestration(ORCHESTRATOR_NAME, runTaskOrchestrator);
  df.app.activity(ACTIVITY_NAME, {
    extraInputs: [clientInput],
    handler: createRunTaskActivity({ getClient: (context) => df.getClient(context) }),
  });
  return { df, clientInput };
}
```

```js
// comm/azure-functions/main.mjs
// Entry point for the Functions host. `func start` / the Functions base image load this file.
import { app } from '@azure/functions';
import * as df from 'durable-functions';
import { startHost } from '../../host/index.mjs';
import { registerDurableFunctions } from './index.mjs';

// Durable client for HTTP triggers is obtained per-invocation; wrap it so host/jobs/durable.mjs
// sees a stable object. Each method resolves the client from the current invocation context.
let currentContext = null;
const clientInput = df.input.durableClient();
const durableClient = new Proxy({}, {
  get: (_, method) => (...args) => df.getClient(currentContext)[method](...args),
});

// startHost registers HTTP functions via the azure-functions adapter. The adapter's
// handlers set `currentContext` before touching the Durable client.
app.hook.preInvocation((ctx) => { currentContext = ctx.invocationContext; });

const started = await startHost({ adapter: 'azure-functions', durableClient });
await registerDurableFunctions({
  hostContextFactory: async () => ({
    api: started.fleetApi, activeDispatcher: started.dispatcher, toolRegistry: started.registry,
    runLoopConfig: started.config.modules.runLoop, budgetsConfig: started.config.modules.budgets?.enabled ? started.config.modules.budgets : null,
    guardrailsMod: started.guardrailsMod, notifier: started.notifier,
  }),
});
app.hook.appTerminate(async () => { await started.close(); });
```

`startHost` must therefore also return `fleetApi: api`, `dispatcher: activeDispatcher`, and `guardrailsMod` in its result object. Add those three keys to the return statement in `host/index.mjs`, and register the `clientInput` as an `extraInputs` entry on every HTTP function the adapter registers (pass `extraInputs: [clientInput]` through `adapter.start` as an option and spread it into `common`). Tests inject a plain fake client, so none of this affects them.

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

Add to `package.json`: `"main": "comm/azure-functions/main.mjs"` is **not** set globally (it would affect Node resolution for the whole kit); instead the Functions Dockerfile (Task 14) sets `AzureWebJobsScriptRoot=/home/site/wwwroot` and a `package.json` there whose `main` points at `comm/azure-functions/main.mjs`. Record this in `docs/deploy-azure-functions.md`.

- [ ] **Step 8: Run tests**

Run: `node --test tests/comm-azure-orchestrator.test.mjs tests/comm-azure-http.test.mjs && npm run test:host`
Expected: PASS.

- [ ] **Step 9: Commit (with approval)**

```bash
git add comm/azure-functions host/index.mjs tests/comm-azure-orchestrator.test.mjs tests/comm-azure-http.test.mjs
git commit -m "feat: Azure Functions comm adapter with Durable orchestrator and run-loop activity"
```

---

### Task 13: Scripted fleet switch and the black-box e2e suite

**Files:**
- Create: `tests/helpers/scripted-fleet.mjs`
- Modify: `host/index.mjs` (env switch `FLEET_MOCK_SCRIPT`, `NODE_ENV=test` only)
- Create: `tests/e2e/scripted-llm.json`
- Create: `tests/e2e/scenarios/s01-tokyo-weather.json`, `s02-nyc-time-weather.json`, `s05-us-japan-currency.json`, `s10-europe-capitals.json`
- Create: `tests/e2e/webhook-receiver.mjs`
- Create: `tests/e2e/task.e2e.test.mjs`
- Test: `tests/host-scripted-fleet.test.mjs`

**Interfaces:**
- Produces `createScriptedFleetApi(script) → fleetApi` where `script = { tools: { [toolName]: jsonPayload }, goals: { [goalSubstring]: string[] /* prompt responses in order */ }, default: string[] }`. `executeCommand` returns the payload for whichever tool name appears in the command (`weather.py` → `tools.weather`); `executePrompt` matches the task goal quoted in the prompt against `goals` keys (first substring hit) and returns responses in order, repeating the last one.
- `startHost` reads `env.FLEET_MOCK_SCRIPT`; when set **and** `env.NODE_ENV === 'test'`, it loads the JSON and uses the scripted fleet instead of spawning Fleet. When set without `NODE_ENV=test` it throws.
- The e2e test reads `BASE_URL` (required), `E2E_MODE` (`scripted` default, or `live`), `E2E_TARGET` (`vm` | `durable`, informational; `vm` enables the restart case when `E2E_RESTART_CMD` is set), and `WEBHOOK_RECEIVER_PORT` (default 9000) / `WEBHOOK_RECEIVER_HOST` (the hostname the agent uses to reach the runner, default `e2e`).

- [ ] **Step 1: Write the failing helper test**

```js
// tests/host-scripted-fleet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createScriptedFleetApi } = await import('../tests/helpers/scripted-fleet.mjs');

const script = {
  tools: { weather: { ok: true, location: 'Tokyo', temp_c: '22' } },
  goals: { 'weather in Tokyo': ['```tool_call\n{"tool":"weather","args":{"city":"Tokyo"}}\n```', '```done\n{"result":"22C","summary":"s"}\n```'] },
  default: ['```done\n{"result":"default","summary":"s"}\n```'],
};

test('executeCommand returns the payload for the tool named in the command', async () => {
  const api = createScriptedFleetApi(script);
  const out = await api.executeCommand({ member_name: 'doer', command: 'python3 "/x/tools/weather/weather.py" "Tokyo"' });
  assert.equal(JSON.parse(out.structuredContent.stdout).location, 'Tokyo');
  const miss = await api.executeCommand({ member_name: 'doer', command: 'python3 nothing.py' });
  assert.equal(JSON.parse(miss.structuredContent.stdout).ok, false);
});

test('executePrompt walks the goal script then repeats the last response', async () => {
  const api = createScriptedFleetApi(script);
  const p = (text) => api.executePrompt({ member_name: 'doer', prompt: `Task: What is the weather in Tokyo?\n${text}` });
  assert.match((await p('')).structuredContent.response, /tool_call/);
  assert.match((await p('')).structuredContent.response, /done/);
  assert.match((await p('')).structuredContent.response, /done/);
  assert.match((await api.executePrompt({ member_name: 'doer', prompt: 'Task: something else' })).structuredContent.response, /default/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-scripted-fleet.test.mjs`
Expected: FAIL, module missing.

- [ ] **Step 3: Create the helper**

```js
// tests/helpers/scripted-fleet.mjs
// A fleetApi driven by a JSON script. Used by E2E_MODE=scripted and by unit tests.
import { createMockFleetApi, rosterNames } from './mock-fleet.mjs';

export function createScriptedFleetApi(script, { members = rosterNames(4) } = {}) {
  const cursors = new Map(); // goal key → index
  const toolFor = (command) => Object.keys(script.tools ?? {}).find(name => command.includes(`${name}.py`) || command.includes(`/${name}/`));

  const keyFor = (prompt) => Object.keys(script.goals ?? {}).find(k => prompt.includes(k)) ?? '__default__';

  const api = createMockFleetApi({
    members,
    commandPayload: (options) => {
      const name = toolFor(options.command ?? '');
      const payload = name ? script.tools[name] : { ok: false, error: `no scripted payload for command: ${options.command}` };
      return JSON.stringify(payload);
    },
    promptResponses: (options) => {
      const key = keyFor(String(options.prompt ?? ''));
      const list = key !== '__default__' ? script.goals[key] : (script.default ?? ['```done\n{"result":"no script","summary":"none"}\n```']);
      const i = cursors.get(key) ?? 0;
      cursors.set(key, i + 1);
      return list[Math.min(i, list.length - 1)];
    },
  });

  // Optional per-goal latency so e2e cancel/backpressure cases have a running job to act on.
  // script.delays = { [goalKey]: ms }
  const origPrompt = api.executePrompt.bind(api);
  api.executePrompt = async (options) => {
    const delay = script.delays?.[keyFor(String(options.prompt ?? ''))];
    if (delay) await new Promise(r => setTimeout(r, delay));
    return origPrompt(options);
  };
  return api;
}

export async function loadScript(path) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8'));
}
```

Note: the mock's per-goal cursor assumes the goal text appears in every prompt the strategies build; both Phase 2 strategies include the task goal in every prompt template, so this holds.

- [ ] **Step 4: Add the switch to `host/index.mjs`**

Replace the `if (!api) { ... spawnFleet ... }` block with:

```js
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

`createWorkerDispatcher({ fleetApi: api, env })` then provisions pool members against the mock, which records `registerMember` calls and succeeds.

- [ ] **Step 5: Write the scripted LLM file and the scenarios**

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

Two deliberate details. The `every capital city` goal carries a 1.5s delay per LLM prompt so that, in scripted mode, the e2e cancel and backpressure cases find the job still `processing` (three prompts ≈ 4.5s). And scenario 10 uses `maxIterations: 2` in scripted mode: plan and review prompts reach the cap, the seven tool steps execute without prompts, and the closing `done` prompt trips the budget check regardless of whether budgets compares with `>` or `>=`, so the outcome is `budget_exceeded` deterministically. In live mode the LLM's own long plan exhausts a 6-iteration budget.

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

- [ ] **Step 6: Create the webhook receiver**

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
    port: server.address().port, received,
    waitFor: (pred, timeoutMs = 60_000) => new Promise((res, rej) => {
      const hit = received.find(pred); if (hit) return res(hit);
      const t = setTimeout(() => rej(new Error('webhook not received in time')), timeoutMs);
      waiters.push((e) => { if (pred(e)) { clearTimeout(t); res(e); } else waiters.push(arguments[0]); });
    }),
    close: () => new Promise(r => server.close(r)),
  })));
}
```

- [ ] **Step 7: Write the e2e suite**

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
if (!BASE) throw new Error('BASE_URL is required, e.g. http://agent-vm:3000');
const MODE = process.env.E2E_MODE ?? 'scripted';
const TARGET = process.env.E2E_TARGET ?? 'vm';
const TIMEOUT = MODE === 'live' ? 600_000 : 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));

const api = {
  async post(p, body) { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; },
  async get(p) { const r = await fetch(`${BASE}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; },
  async del(p) { const r = await fetch(`${BASE}${p}`, { method: 'DELETE' }); return { status: r.status, body: await r.json().catch(() => null) }; },
  async follow(jobId) {
    const events = [];
    for await (const e of readSse(await fetch(`${BASE}/jobs/${jobId}/events`))) { events.push(e); if (e.event === 'settled') break; }
    return events;
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
    const settled = events.at(-1).data;

    const rec = (await api.get(`/jobs/${jobId}`)).body;
    assert.equal(rec.status, settled.status);
    assert.ok(s.expectedStatus.includes(rec.status), `status ${rec.status} not in ${s.expectedStatus}`);
    assert.ok(rec.finishedAt && rec.startedAt);
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
  // wait until started
  for (let i = 0; i < 300; i++) { const r = await api.get(`/jobs/${jobId}`); if (r.body.status === 'processing') break; await new Promise(r => setTimeout(r, 100)); }
  const del = await api.del(`/jobs/${jobId}`);
  assert.ok([200, 202].includes(del.status), JSON.stringify(del.body));
  const events = await api.follow(jobId);
  assert.equal(events.at(-1).data.status, 'cancelled');
  assert.equal((await api.get(`/jobs/${jobId}`)).body.status, 'cancelled');
});

test('backpressure returns 429 when the queue is full', { timeout: TIMEOUT }, async () => {
  // Agent is configured with JOBS_MAX_QUEUE_SIZE=1, JOBS_CONCURRENCY=1 in docker-compose.e2e.yml.
  const goal = 'Research every capital city in Europe - weather and country info for each.';
  const a = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  for (let i = 0; i < 300; i++) { const r = await api.get(`/jobs/${a.body.jobId}`); if (r.body.status === 'processing') break; await new Promise(r => setTimeout(r, 100)); }
  const b = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  const c = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  assert.equal(b.status, 202);
  assert.equal(c.status, 429);
  assert.equal(c.headers.get('retry-after'), '30');
  await api.del(`/jobs/${a.body.jobId}`); await api.del(`/jobs/${b.body.jobId}`);
  await api.follow(a.body.jobId);
});

test('webhook delivers exactly one settled event', { timeout: TIMEOUT }, async () => {
  const receiver = await startWebhookReceiver({ port: Number(process.env.WEBHOOK_RECEIVER_PORT ?? 9000) });
  try {
    const url = `http://${process.env.WEBHOOK_RECEIVER_HOST ?? 'e2e'}:${receiver.port}/hook`;
    const sub = await api.post('/task', { goal: 'What is the weather in Tokyo?', constraints: { maxIterations: 10 }, callbackUrl: url });
    assert.equal(sub.status, 202, JSON.stringify(sub.body));
    const hit = await receiver.waitFor(e => e.headers['x-fleet-job-id'] === sub.body.jobId, TIMEOUT - 5000);
    assert.equal(hit.body.type, 'settled');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(receiver.received.filter(e => e.headers['x-fleet-job-id'] === sub.body.jobId).length, 1);
  } finally { await receiver.close(); }
});

test('record survives an agent restart (vm only)', { skip: !(TARGET === 'vm' && process.env.E2E_RESTART_CMD), timeout: TIMEOUT }, async () => {
  const sub = await api.post('/task', { goal: 'What is the weather in Tokyo?', constraints: { maxIterations: 10 } });
  await api.follow(sub.body.jobId);
  execSync(process.env.E2E_RESTART_CMD, { stdio: 'inherit' });
  for (let i = 0; i < 120; i++) { try { if ((await api.get('/health')).status === 200) break; } catch { /* booting */ } await new Promise(r => setTimeout(r, 500)); }
  const rec = await api.get(`/jobs/${sub.body.jobId}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.status, 'completed');
});
```

- [ ] **Step 8: Run the helper test and a local e2e against a scripted host**

```bash
node --test tests/host-scripted-fleet.test.mjs
# terminal 1
NODE_ENV=test FLEET_MOCK_SCRIPT=tests/e2e/scripted-llm.json JOBS_MAX_QUEUE_SIZE=1 JOBS_CONCURRENCY=1 WEBHOOK_ALLOW_HTTP=true JOBS_DB_PATH=./workdir/e2e-jobs.db WORKER_POOL_SIZE=2 npm run host
# terminal 2
BASE_URL=http://127.0.0.1:3000 WEBHOOK_RECEIVER_HOST=127.0.0.1 node --test tests/e2e/task.e2e.test.mjs
```

On Windows PowerShell set the variables with `$env:NAME='value';` before each command. `host.config.mjs` must have `dispatch: { enabled: true }` for the 202 path; add that block (and `notify: {}`) to `host.config.mjs` as part of this task:

```js
    dispatch: { enabled: true, backend: 'in-process', maxQueueSize: 100, concurrency: 1 },
    notify: { sse: { enabled: true }, webhook: { enabled: true } },
```

Enabling dispatch in `host.config.mjs` means every `startHost()` call that does not pass its own `dispatch` option now also starts a SQLite-backed jobs backend at `./workdir/jobs.db`. In `tests/host-index.test.mjs`, add `dispatch: { enabled: false }` to the `startHost` calls that are not about jobs (the Phase 1 and Phase 2 tests), so they stay isolated and leave no database behind. Confirm `workdir/` is gitignored (it is today) so a local `jobs.db` never lands in a commit.

Expected: helper test PASS; e2e PASS for health, 4 scenarios, 404, cancel, 429, webhook; restart skipped.

- [ ] **Step 9: Commit (with approval)**

```bash
git add tests/helpers/scripted-fleet.mjs tests/host-scripted-fleet.test.mjs host/index.mjs host.config.mjs tests/e2e
git commit -m "feat: scripted fleet switch and black-box /task e2e suite"
```

---

### Task 14: Docker — e2e compose and the Functions image

**Files:**
- Create: `docker-compose.e2e.yml`
- Create: `deploy/azure-functions/Dockerfile`
- Create: `deploy/azure-functions/wwwroot-package.json`
- Create: `deploy/azure-functions/README.md`
- Modify: `Dockerfile` (no change to base; add `EXPOSE` unchanged; make sure `tests/` is copied, which `COPY . .` already does)
- Modify: `.dockerignore` (keep `docs` excluded; ensure `tests` is **not** excluded — it is not today)

- [ ] **Step 1: Verify the Functions base image tag**

```bash
docker manifest inspect mcr.microsoft.com/azure-functions/node:4-node22 > /dev/null && echo OK || echo MISSING
```

If MISSING, use `mcr.microsoft.com/azure-functions/node:4-node20` and add `RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs` before the npm installs.

- [ ] **Step 2: Create the Functions Dockerfile**

```dockerfile
# deploy/azure-functions/Dockerfile
# Same agent as the VM image, hosted by the Azure Functions runtime. Premium plan only.
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

Because the wwwroot `package.json` replaces the repo one after `npm ci`, dependencies are already installed; the replacement only changes `main`. Keep `"type": "module"` so `.mjs` semantics hold for any `.js` files.

- [ ] **Step 3: Create `docker-compose.e2e.yml`**

```yaml
# docker-compose.e2e.yml
# Profiles:  vm       → agent-vm (in-process jobs, SQLite)
#            durable  → azurite + agent-durable (Azure Functions host + Durable)
# Run:       docker compose -f docker-compose.e2e.yml --profile vm run --rm e2e
name: apra-agent-kit-e2e

x-agent-env: &agent-env
  NODE_ENV: ${E2E_NODE_ENV:-test}
  FLEET_MOCK_SCRIPT: ${FLEET_MOCK_SCRIPT:-/workspace/tests/e2e/scripted-llm.json}
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
  JOBS_MAX_QUEUE_SIZE: "1"
  JOBS_CONCURRENCY: "1"
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
      FLEET_MOCK_SCRIPT: ${FLEET_MOCK_SCRIPT:-/home/site/wwwroot/tests/e2e/scripted-llm.json}
      AzureWebJobsStorage: "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1;"
      JOBS_BACKEND: durable
      DURABLE_TASK_HUB: fleetjobs
      WORKER_POOL_SIZE: "0"
    # healthcheck inherited from the Dockerfile

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

The Azurite account key above is the public, well-known development key that Azurite documents; it is not a secret.

For the `durable` profile the runner needs `BASE_URL=http://agent-durable/api` and `E2E_TARGET=durable`; the CI job (Task 16) sets them. The Functions host prefixes routes with `/api`, and `toNeutralRequest` strips it, so the same test paths work.

Add `depends_on` for the runner per profile by running with explicit ordering in scripts: `docker compose --profile vm up -d --wait agent-vm` then `run --rm e2e`. Compose profiles cannot express profile-conditional `depends_on`, so the two-step invocation is the documented way.

- [ ] **Step 4: Write `deploy/azure-functions/README.md`**

```markdown
# Azure Functions deployment

Full guide: [docs/deploy-azure-functions.md](../../docs/deploy-azure-functions.md).

Quick reference:

    # build and run locally against Azurite (same as CI)
    docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable
    BASE_URL=http://localhost:7071/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e

    # push to Azure (Premium plan, custom container)
    az acr build -r <registry> -t apra-agent-kit-functions:latest -f deploy/azure-functions/Dockerfile .
    az functionapp create -g <rg> -n <app> -p <premium-plan> -s <storage> \
      --functions-version 4 --runtime node --image <registry>.azurecr.io/apra-agent-kit-functions:latest
    az functionapp config appsettings set -g <rg> -n <app> --settings \
      JOBS_BACKEND=durable DURABLE_TASK_HUB=fleetjobs WORKER_POOL_SIZE=0 WORKER_EPHEMERAL_MAX=2 \
      CLAUDE_CODE_OAUTH_TOKEN=<token>
```

- [ ] **Step 5: Bring up both profiles locally and run the suite**

```bash
docker compose -f docker-compose.e2e.yml --profile vm up -d --wait agent-vm
docker compose -f docker-compose.e2e.yml run --rm e2e
docker compose -f docker-compose.e2e.yml --profile vm down -v

docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable
BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e
docker compose -f docker-compose.e2e.yml --profile durable down -v
```

Expected: all e2e tests pass on both. If `agent-durable` never becomes healthy, run `docker compose -f docker-compose.e2e.yml --profile durable logs agent-durable` and check for extension-bundle download failures (needs outbound network) or `AzureWebJobsStorage` connection errors.

- [ ] **Step 6: Commit (with approval)**

```bash
git add docker-compose.e2e.yml deploy/azure-functions .dockerignore
git commit -m "feat: docker compose e2e profiles for VM and Durable targets, Functions image"
```

---

### Task 15: Acceptance suite and npm scripts

**Files:**
- Move: `tests/host.live.test.mjs` → `tests/acceptance/tool-server.acceptance.test.mjs`
- Move: `tests/host-phase2.live.test.mjs` → `tests/acceptance/sync-task.acceptance.test.mjs`
- Create: `tests/acceptance/async-job.acceptance.test.mjs`
- Modify: `package.json` scripts

- [ ] **Step 1: Move the two live files**

```bash
mkdir -p tests/acceptance
git mv tests/host.live.test.mjs tests/acceptance/tool-server.acceptance.test.mjs
git mv tests/host-phase2.live.test.mjs tests/acceptance/sync-task.acceptance.test.mjs
```

In both moved files fix the relative imports: `'./setup-fleet-modules.mjs'` → `'../setup-fleet-modules.mjs'`, `'../host/index.mjs'` → `'../../host/index.mjs'`. In `sync-task.acceptance.test.mjs` change both `httpPost(host.port(), '/task', ...)` calls to `'/task?wait=true'` so the test keeps asserting the synchronous shape once dispatch is enabled in `host.config.mjs`.

- [ ] **Step 2: Write the async-job acceptance test**

```js
// tests/acceptance/async-job.acceptance.test.mjs
// Real Fleet + real LLM. Answers: can the agent still run a task as a job?
import '../setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSse } from '../helpers/sse.mjs';

const { startHost } = await import('../../host/index.mjs');

const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

const opts = (dbPath) => ({
  port: 0,
  runLoop: { enabled: true, strategy: 'open-ended' },
  budgets: { maxIterations: 10, timeoutMs: 180_000 },
  guardrails: { defaultPolicy: 'allow', validateInputs: true },
  dispatch: { enabled: true, store: { kind: 'sqlite', dbPath }, maxQueueSize: 5, concurrency: 1 },
  notify: { sse: { enabled: true } },
});

test('submit → SSE to settled → GET matches → record survives restart', { timeout: 400_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-jobs-'));
  const dbPath = path.join(dir, 'jobs.db');
  let { host, close } = await startHost(opts(dbPath));
  let jobId;
  try {
    const res = await post(host.port(), '/task', { goal: 'What is the current weather in London?' });
    assert.equal(res.status, 202);
    ({ jobId } = await res.json());
    let settled;
    for await (const e of readSse(await fetch(`http://127.0.0.1:${host.port()}/jobs/${jobId}/events`))) { if (e.event === 'settled') { settled = e.data; break; } }
    assert.ok(['completed', 'budget_exceeded'].includes(settled.status));
    const rec = await get(host.port(), `/jobs/${jobId}`);
    assert.equal(rec.body.status, settled.status);
    assert.ok(rec.body.history.length > 0);
  } finally { await close(); }

  ({ host, close } = await startHost(opts(dbPath)));
  try {
    const rec = await get(host.port(), `/jobs/${jobId}`);
    assert.equal(rec.status, 200);
    assert.ok(['completed', 'budget_exceeded'].includes(rec.body.status));
  } finally { await close(); }
});

test('cancel mid-run settles cancelled', { timeout: 300_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-jobs-'));
  const { host, close } = await startHost(opts(path.join(dir, 'jobs.db')));
  try {
    const res = await post(host.port(), '/task', { goal: 'Compare the weather in London, Paris, Berlin, Madrid, Rome, Vienna and Oslo.', constraints: { maxIterations: 30 } });
    const { jobId } = await res.json();
    for (let i = 0; i < 600; i++) { if ((await get(host.port(), `/jobs/${jobId}`)).body.status === 'processing') break; await new Promise(r => setTimeout(r, 100)); }
    const del = await fetch(`http://127.0.0.1:${host.port()}/jobs/${jobId}`, { method: 'DELETE' });
    assert.ok([200, 202].includes(del.status));
    for await (const e of readSse(await fetch(`http://127.0.0.1:${host.port()}/jobs/${jobId}/events`))) { if (e.event === 'settled') { assert.equal(e.data.status, 'cancelled'); break; } }
  } finally { await close(); }
});
```

- [ ] **Step 3: Update `package.json` scripts**

Replace the `scripts` block with:

```json
  "scripts": {
    "test": "node --test tests/transport-stdio-fleet.test.mjs tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/pool-worker-pool.test.mjs tests/pool-config.test.mjs tests/pool-member-manager.test.mjs tests/pool-ephemeral-factory.test.mjs tests/pool-worker-dispatcher.test.mjs tests/pool-index.test.mjs tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs",
    "test:unit": "node --test tests/transport-stdio-fleet.test.mjs tests/pool-roster.test.mjs tests/pool-cleanup.test.mjs tests/pool-worker-lock.test.mjs tests/pool-fleet-text.test.mjs tests/pool-pooled-fleet-api.test.mjs tests/pool-worker-pool.test.mjs tests/pool-config.test.mjs tests/pool-member-manager.test.mjs tests/pool-ephemeral-factory.test.mjs tests/pool-worker-dispatcher.test.mjs tests/pool-index.test.mjs",
    "test:integration": "node --test tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs",
    "test:load": "node tests/load-test.mjs",
    "mcp": "node mcp/main.mjs",
    "host": "node host/index.mjs",
    "test:host": "node --test tests/host-config.test.mjs tests/host-registry.test.mjs tests/host-executor.test.mjs tests/comm-express.test.mjs tests/host-index.test.mjs tests/host-tasks.test.mjs tests/host-routes.test.mjs",
    "test:phase2": "node --test tests/host-response-parser.test.mjs tests/host-format-tools.test.mjs tests/host-budgets.test.mjs tests/host-guardrails.test.mjs tests/host-mock-fleet.test.mjs tests/host-prompts.test.mjs tests/host-strategy-open-ended.test.mjs tests/host-strategy-plan-execute.test.mjs tests/host-run-loop.test.mjs",
    "test:phase4": "node --test tests/host-jobs-record.test.mjs tests/host-jobs-store.test.mjs tests/host-jobs-in-process.test.mjs tests/host-jobs-durable.test.mjs tests/host-jobs-config.test.mjs tests/host-jobs-tools.test.mjs tests/host-notify.test.mjs tests/host-scripted-fleet.test.mjs tests/comm-contract.test.mjs tests/comm-azure-orchestrator.test.mjs tests/comm-azure-http.test.mjs",
    "test:acceptance": "node --test tests/acceptance/",
    "test:e2e": "node --test tests/e2e/task.e2e.test.mjs",
    "e2e:vm": "docker compose -f docker-compose.e2e.yml --profile vm up -d --wait agent-vm && docker compose -f docker-compose.e2e.yml run --rm e2e; docker compose -f docker-compose.e2e.yml --profile vm down -v",
    "e2e:durable": "docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable && BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e; docker compose -f docker-compose.e2e.yml --profile durable down -v"
  },
```

`test:host:live` and `test:phase2:live` are removed.

- [ ] **Step 4: Run**

```bash
npm run test:host && npm run test:phase2 && npm run test:phase4 && npm run test:unit && npm run test:integration
# with Fleet + token available:
npm run test:acceptance
```

Expected: all unit suites PASS; acceptance PASS (3 files, 5 tests) on a machine with Fleet and `CLAUDE_CODE_OAUTH_TOKEN`.

- [ ] **Step 5: Commit (with approval)**

```bash
git add package.json tests/acceptance
git commit -m "test: capability-named acceptance suite replaces phase live tests"
```

---

### Task 16: CI workflows

**Files:**
- Create: `.github/workflows/ci-e2e.yml`
- Modify: `.github/workflows/ci-host.yml`

- [ ] **Step 1: Update `ci-host.yml`**

Replace the two `docker run` steps under `host-integration-tests` with:

```yaml
      - name: Run host unit tests in Docker
        run: |
          docker run --rm apra-agent-kit-ci sh -c "npm run test:host && npm run test:phase2 && npm run test:phase4"

      - name: Run acceptance suite (real Fleet)
        if: ${{ env.HAS_OAUTH_TOKEN == 'true' }}
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN apra-agent-kit-ci npm run test:acceptance
```

Add to the `host-integration-tests` job (GitHub does not allow `secrets` in `if:` expressions; this mirrors the pattern already used in `ci.yml`):

```yaml
    env:
      HAS_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}
```

and add `npm run test:phase4` after `npm run test:host` in the `host-unit-tests` job.

- [ ] **Step 2: Create `ci-e2e.yml`**

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

Note on `FLEET_MOCK_SCRIPT: ""`: the compose file's `${FLEET_MOCK_SCRIPT:-default}` substitutes the default only when the variable is unset or empty, so an empty string would still pick the default. Use `${FLEET_MOCK_SCRIPT-default}` (no colon) in both places in `docker-compose.e2e.yml` so an explicitly empty value disables the mock. Update the compose file accordingly in this task, and in `host/index.mjs` treat an empty `FLEET_MOCK_SCRIPT` as unset (`if (!api && env.FLEET_MOCK_SCRIPT)` already does).

- [ ] **Step 3: Validate workflow syntax locally**

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color
```

Expected: no errors. (If `actionlint` is unavailable, push the branch and let GitHub validate; fix any parse errors before requesting review.)

- [ ] **Step 4: Commit (with approval)**

```bash
git add .github/workflows/ci-e2e.yml .github/workflows/ci-host.yml docker-compose.e2e.yml
git commit -m "ci: e2e workflow for VM and Durable targets; acceptance suite in host CI"
```

---

### Task 17: Documentation

**Files:**
- Create: `docs/jobs.md`
- Create: `docs/deploy-azure-functions.md`
- Modify: `docs/architecture.md`, `docs/mcp-interface.md`, `README.md`, `docs/README.md`

- [ ] **Step 1: Write `docs/jobs.md`**

Required sections, each with the exact content indicated:

1. **Overview** — one paragraph: `POST /task` returns `202 { jobId }`; three ways to get the result (poll, SSE, webhook); `?wait=true` for sync; the two backends and when each applies.
2. **Routes** — the table from the spec's "The `/task` route" section verbatim, plus one `curl` per route:
   ```bash
   curl -sX POST localhost:3000/task -H 'content-type: application/json' -d '{"goal":"What is the weather in Tokyo?"}'
   curl -s localhost:3000/jobs/job-abc123
   curl -N localhost:3000/jobs/job-abc123/events
   curl -sX DELETE localhost:3000/jobs/job-abc123
   curl -sX POST 'localhost:3000/task?wait=true' -H 'content-type: application/json' -d '{"goal":"..."}'
   ```
3. **Job record** — the JSON from the spec with a one-line description per field; the status state machine; the error code table.
4. **Events and SSE** — the four event types; wire format example; `Last-Event-ID` reconnect; heartbeat; a Node snippet using `EventSource`-style parsing (copy `tests/helpers/sse.mjs`).
5. **Webhook** — payload, headers (`X-Fleet-Job-Id`, `X-Fleet-Event-Seq`), retries, https rule and `WEBHOOK_ALLOW_HTTP`.
6. **Cancellation** — queued vs processing semantics; Durable latency bounded by `pollMs`.
7. **Backpressure, retention, restart** — 429 + `Retry-After`; `retentionMs`; `interrupted` on restart; one process per SQLite file.
8. **Configuration** — the `dispatch` and `notify` blocks and the env override table from the spec.
9. **MCP tools** — `submit-task` / `job-status` with a Claude Code walkthrough; note they take no lease.
10. **Testing** — how to run `test:phase4`, `test:acceptance`, `e2e:vm`, `e2e:durable`; scripted vs live mode.
11. **Deferred** — link to GitHub issue #30 (human-in-the-loop).

- [ ] **Step 2: Write `docs/deploy-azure-functions.md`**

Required sections:

1. **What is and is not supported** — Premium/Dedicated plan with custom Linux container; no Consumption; MCP over Functions depends on the web-standard transport (state the outcome of Task 0 Step 3).
2. **How it works** — the diagram: HTTP trigger → `startNew` → orchestrator → activity = run loop; one Fleet child per instance; progress via external events; cancel via `customStatus` polling.
3. **Image** — `deploy/azure-functions/Dockerfile`, `wwwroot-package.json` `main`, `host.json` (`functionTimeout: -1`, task hub from `DURABLE_TASK_HUB`).
4. **App settings** — table: `AzureWebJobsStorage`, `DURABLE_TASK_HUB`, `JOBS_BACKEND=durable`, `WORKER_POOL_SIZE=0`, `WORKER_EPHEMERAL_MAX`, `CLAUDE_CODE_OAUTH_TOKEN`, `JOBS_MAX_QUEUE_SIZE`, `WEBHOOK_ALLOW_HTTP` (never in prod).
5. **Local run** — the two compose commands from `deploy/azure-functions/README.md`; Azurite; `local.settings.json.example`.
6. **Deploy** — the `az` commands; scaling to 2 instances and verifying `GET /jobs/:id` from both.
7. **Limits and tuning** — `budgets.timeoutMs` vs `durable.maxActivityMs`; `pollMs`; ring of 50 events; SSE latency on Functions.
8. **Troubleshooting** — extension bundle download, storage connection, cold start vs healthcheck window, `Cannot find package '@azure/functions'` (optional deps not installed).

- [ ] **Step 3: Update existing docs**

- `docs/architecture.md`: add `host/jobs/`, `host/notify/`, `host/routes.mjs`, `host/tasks.mjs`, `comm/router.mjs`, `comm/raw-http.mjs`, `comm/azure-functions/` rows to the module map; replace the Express-specific "comm" text with the neutral contract; add an "An async task" data-flow section mirroring "An MCP tool call"; add the new env vars to the Configuration table; add the two seams to "Design decisions worth knowing".
- `docs/mcp-interface.md`: document `submit-task` and `job-status` (schemas, that they skip the lease, example call/response).
- `README.md`: an "Async tasks" quick start with the three `curl` commands and links to `docs/jobs.md` and `docs/deploy-azure-functions.md`; list new npm scripts.
- `docs/README.md`: add the two new docs to the index.

- [ ] **Step 4: Verify every code path and command in the docs**

Run each `curl` and `npm run` command in the docs against a locally started host (`NODE_ENV=test FLEET_MOCK_SCRIPT=tests/e2e/scripted-llm.json npm run host`) and fix any that do not behave as documented.

- [ ] **Step 5: Commit (with approval)**

```bash
git add docs README.md
git commit -m "docs: async jobs API, Azure Functions deployment, architecture updates for Phase 4"
```

---

## Self-review against the spec

**Spec coverage**

| Spec section | Task |
|---|---|
| Job record, transitions, error codes, retention | 1, 5 |
| Job events with `seq` | 1, 2, 5 |
| Jobs interface (`submit/get/cancel/subscribe/events/stats/start/stop`) | 1, 5, 11 |
| Run loop `onEvent` (implemented as `onProgress`/`onIteration`) and `host/tasks.mjs` | 4 |
| In-process backend: queue, concurrency clamp, SQLite + memory stores, restart, lease timeout, drain, atomic claim, one process per file | 2, 3, 5 |
| Durable backend: mapping, backpressure, cancel, poll-based subscribe, events ring, multi-instance correctness | 11, 12 |
| Functions layout, orchestrator, activity, Fleet per instance, `host.json` | 12, 14 |
| Notifier: SSE (replay, heartbeat, close), webhook (retries, https rule) | 6 |
| Neutral comm contract, express migration, raw-http, azure-functions adapter | 7, 12 |
| MCP tools without lease | 10 |
| Config + validation rules + env overrides | 8 |
| Host startup/shutdown order, routes, builder API, `agent.start()` returns `jobs` | 9 |
| Acceptance suite replacing phase live tests | 15 |
| E2E: black-box `/task` suite, scenarios, scripted/live, webhook receiver, restart case | 13 |
| Docker compose profiles, Functions image, Azurite | 14 |
| CI: `ci-e2e.yml`, `ci-host.yml` changes, PR comment | 16 |
| Docs: `jobs.md`, `deploy-azure-functions.md`, architecture, mcp-interface, README | 17 |
| Open risks: transport fallback, ring/progress cadence | 0 step 3, 12 step 6, 11 note |

**Known deviations from the spec, deliberate**
- The progress callback is named `onProgress` (host) / `onIteration` (run loop) rather than the spec's `onEvent`; the spec's name described the concept, these names describe the payload.
- Durable's `stats()` is refreshed lazily via `refreshStats()`; the route layer does not call it, so `stats()` is informational on Azure. `429` on Azure is enforced inside `submit` by counting live instances, which is what the spec requires.
- On Azure, `/mcp` uses the SDK's web-standard transport instead of a Node shim; if the SDK lacks it, `/mcp` returns 501 on Functions and this is documented (spec open risk, chosen fallback).

**Type consistency check** (names used across tasks): `createRecord`, `settleFromRunResult`, `queuedEvent/startedEvent/progressEvent/settledEvent`, `TERMINAL_STATUSES`, `JobQueueFullError/JobsClosedError/InvalidCallbackUrlError`, `validateCallbackUrl(url, { allowHttp })`, store methods `open/close/insert/get/update/claim/listByStatus/appendEvent/events/purgeFinishedBefore/countByStatus`, `createInProcessJobs({ store, runJob, notifier, config, logger, now, allowHttpCallbacks })`, `createDurableJobs({ client, config, notifier, logger, allowHttpCallbacks })`, `ORCHESTRATOR_NAME/ACTIVITY_NAME`, `createNotifier(config, { jobs, logger, fetchImpl }) → { publish, sseHandler, stop }`, `buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled })`, `executeHostedTask(task, { api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, signal, onProgress })`, `runHandler/buildRequest/writeNodeResponse/matchRoute/lowerHeaders/requestSignal`, `createAzureFunctionsAdapter({ app })`, `readSse(response)`, `createScriptedFleetApi(script)`, `withJobTools(registry, jobs)`. All verified consistent across Tasks 1–17.

