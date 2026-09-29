# Scheduled Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a config-driven scheduler that fires named workflows on cron schedules, submitting each tick as a job through the existing jobs pipeline.

**Architecture:** Two scheduler backends (in-process using croner, durable using Azure Timer Triggers) behind a shared interface, mirroring the `host/jobs/` adapter pattern. The scheduler is a clock — it only calls `jobs.submit()`, reusing the entire existing pipeline for execution, events, and delivery.

**Tech Stack:** Node 22, `croner` ^9.0.0 (timezone-aware cron), `@azure/functions` v4 (Timer Triggers, already an optionalDependency)

**Spec:** `docs/specs/scheduled-workflows-spec.md`

## Global Constraints

- Node ≥ 22.16 (repo minimum; `node:sqlite` stable from 22.13)
- `croner` is the only new dependency; zero transitive deps
- Scheduler module must never crash the host — every tick is wrapped in try/catch
- Backend selection follows `JOBS_BACKEND` env var (no separate `SCHEDULER_BACKEND`)
- Schedules are config-only, no CRUD API
- Only named workflows can be scheduled (no free-text goals)

## Review Focus

1. **Invalid cron with valid-looking syntax** (e.g., `60 * * * *` — minute 60 doesn't exist): croner should reject, but verify it doesn't silently fire at the wrong time.
2. **Timezone DST transitions** (e.g., a schedule at 2:30am in `America/New_York` during spring-forward): croner skips the non-existent time — verify the scheduler doesn't error or double-fire.
3. **Overlap check race** — two ticks fire close together and both pass the overlap check before either's job is persisted: verify the `queue` policy handles this gracefully (worst case: two jobs run, not a crash).
4. **Scheduler start with jobs backend not yet ready** — `scheduler.start()` must be called after `jobs.start()`: verify the startup order is enforced and a misordering throws a clear error.
5. **Config with zero schedules but `enabled: true`** — should warn, not error, and the scheduler should start cleanly with nothing to do.

---

### Task 1: Install croner and add scheduler config resolution

**Files:**
- Modify: `package.json` — add `croner` dependency
- Create: `host/scheduler/config.mjs` — config defaults, merge, validation
- Modify: `host/config.mjs:8` — add `scheduler` to `KNOWN_MODULES` and `IMPLEMENTED_MODULES`
- Modify: `host/config.mjs:125-163` — add scheduler validation block
- Test: `tests/host-scheduler-config.test.mjs`

**Interfaces:**
- Consumes: `host/config.mjs` validate function pattern, `host/jobs/config.mjs` `resolveDispatchConfig` pattern
- Produces: `resolveSchedulerConfig(raw, { env, dispatchConfig }) → { enabled, backend, schedules }` — used by Task 3 factory and Task 5 host integration

- [ ] **Step 1: Install croner**

```bash
npm install croner@^9
```

- [ ] **Step 2: Write the failing config tests**

Create `tests/host-scheduler-config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveSchedulerConfig } = await import('../host/scheduler/config.mjs');

const VALID_SCHEDULE = {
  name: 'test-schedule',
  workflow: 'city-briefing',
  args: { city: 'Tokyo' },
  cron: '0 9 * * *',
  timezone: 'UTC',
  overlap: 'queue',
};

test('resolveSchedulerConfig returns defaults when raw is empty', () => {
  const config = resolveSchedulerConfig({}, { env: {}, dispatchConfig: { backend: 'in-process' } });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.schedules, []);
  assert.equal(config.backend, 'in-process');
});

test('resolveSchedulerConfig merges raw config', () => {
  const config = resolveSchedulerConfig(
    { enabled: true, schedules: [VALID_SCHEDULE] },
    { env: {}, dispatchConfig: { backend: 'in-process' } },
  );
  assert.equal(config.enabled, true);
  assert.equal(config.schedules.length, 1);
  assert.equal(config.schedules[0].name, 'test-schedule');
});

test('SCHEDULER_ENABLED env override', () => {
  const config = resolveSchedulerConfig(
    { enabled: false },
    { env: { SCHEDULER_ENABLED: 'true' }, dispatchConfig: { backend: 'in-process' } },
  );
  assert.equal(config.enabled, true);
});

test('backend follows JOBS_BACKEND', () => {
  const config = resolveSchedulerConfig(
    { enabled: true },
    { env: { JOBS_BACKEND: 'durable' }, dispatchConfig: { backend: 'durable' } },
  );
  assert.equal(config.backend, 'durable');
});

test('overlap defaults to queue', () => {
  const schedule = { ...VALID_SCHEDULE };
  delete schedule.overlap;
  const config = resolveSchedulerConfig(
    { enabled: true, schedules: [schedule] },
    { env: {}, dispatchConfig: { backend: 'in-process' } },
  );
  assert.equal(config.schedules[0].overlap, 'queue');
});

test('args defaults to empty object', () => {
  const schedule = { ...VALID_SCHEDULE };
  delete schedule.args;
  const config = resolveSchedulerConfig(
    { enabled: true, schedules: [schedule] },
    { env: {}, dispatchConfig: { backend: 'in-process' } },
  );
  assert.deepEqual(config.schedules[0].args, {});
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
node --test tests/host-scheduler-config.test.mjs
```

Expected: FAIL — module not found

- [ ] **Step 4: Implement resolveSchedulerConfig**

Create `host/scheduler/config.mjs`:

```js
export const SCHEDULER_DEFAULTS = {
  enabled: false,
  schedules: [],
};

const OVERLAP_POLICIES = new Set(['queue', 'skip']);

export function resolveSchedulerConfig(raw = {}, { env = process.env, dispatchConfig } = {}) {
  const merged = { ...SCHEDULER_DEFAULTS, ...raw };

  const flag = String(env.SCHEDULER_ENABLED ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') merged.enabled = true;
  else if (flag === '0' || flag === 'false') merged.enabled = false;

  merged.backend = dispatchConfig?.backend ?? env.JOBS_BACKEND ?? 'in-process';

  merged.schedules = (merged.schedules ?? []).map(s => ({
    ...s,
    args: s.args ?? {},
    overlap: OVERLAP_POLICIES.has(s.overlap) ? s.overlap : 'queue',
  }));

  return merged;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test tests/host-scheduler-config.test.mjs
```

Expected: all PASS

- [ ] **Step 6: Add scheduler to KNOWN_MODULES and IMPLEMENTED_MODULES in host/config.mjs**

In `host/config.mjs`, add `'scheduler'` to both sets:

```js
const KNOWN_MODULES = new Set(['runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch', 'notify', 'chat', 'router', 'scheduler']);
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat', 'router', 'memory', 'evals', 'scheduler']);
```

- [ ] **Step 7: Add scheduler validation to host/config.mjs validate function**

After the router validation block (after line 175 `}`), add:

```js
  if (modules.scheduler?.enabled) {
    if (!modules.dispatch?.enabled) {
      throw new Error('scheduler enabled but dispatch disabled — the scheduler submits jobs; enable dispatch or disable scheduler');
    }
    if (!Array.isArray(modules.scheduler.schedules) || modules.scheduler.schedules.length === 0) {
      console.warn('[host/config] scheduler enabled but no schedules configured');
    }
  }
```

- [ ] **Step 8: Add host/config.mjs validation tests**

Add to `tests/host-scheduler-config.test.mjs`:

```js
const { loadConfig } = await import('../host/config.mjs');
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function configInTmpDir(config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-test-'));
  await fs.writeFile(
    path.join(dir, 'host.config.mjs'),
    `export default ${JSON.stringify(config)};`,
  );
  return dir;
}

const BASE_CONFIG = {
  name: 'test', fleet: {}, comm: { adapter: 'express' },
  modules: {
    runLoop: { enabled: true, strategy: 'open-ended' },
    dispatch: { enabled: true, store: { kind: 'memory' } },
    notify: { sse: { enabled: true } },
    chat: { enabled: false, title: 'test' },
  },
};

test('loadConfig rejects scheduler without dispatch', async () => {
  const dir = await configInTmpDir({
    ...BASE_CONFIG,
    modules: { ...BASE_CONFIG.modules, dispatch: { enabled: false }, scheduler: { enabled: true, schedules: [] } },
  });
  await assert.rejects(loadConfig(dir, { NODE_ENV: 'test' }), /scheduler enabled but dispatch disabled/);
});
```

- [ ] **Step 9: Run full config tests**

```bash
node --test tests/host-scheduler-config.test.mjs
```

Expected: all PASS

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json host/scheduler/config.mjs host/config.mjs tests/host-scheduler-config.test.mjs
git commit -m "feat(scheduler): add croner dependency and config resolution"
```

---

### Task 2: Scheduler interface, validation, and overlap check

**Files:**
- Create: `host/scheduler/interface.mjs` — interface contract and assertion
- Create: `host/scheduler/validate.mjs` — schedule entry validation (cron, timezone, workflow)
- Create: `host/scheduler/overlap.mjs` — shared overlap check logic
- Test: `tests/host-scheduler-core.test.mjs`

**Interfaces:**
- Consumes: `croner` `Cron` class for cron parsing; tool registry array `[{ name, routing }]`; jobs backend `get()` and `listByStatus()` / in-memory scan
- Produces:
  - `assertSchedulerBackend(obj) → obj` — validates backend shape
  - `validateSchedules(schedules, toolRegistry) → void | throws` — used by Task 3 factory and Task 5 host integration
  - `shouldRun(scheduleName, overlapPolicy, { jobs, logger }) → Promise<boolean>` — used by Task 3 in-process and Task 4 durable

- [ ] **Step 1: Write the failing tests**

Create `tests/host-scheduler-core.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { assertSchedulerBackend } = await import('../host/scheduler/interface.mjs');
const { validateSchedules } = await import('../host/scheduler/validate.mjs');
const { shouldRun } = await import('../host/scheduler/overlap.mjs');

// --- interface ---

test('assertSchedulerBackend rejects missing methods', () => {
  assert.throws(() => assertSchedulerBackend({}), /missing/);
});

test('assertSchedulerBackend accepts valid backend', () => {
  const backend = {
    start: async () => {},
    stop: async () => {},
    getSchedules: () => [],
  };
  assert.equal(assertSchedulerBackend(backend), backend);
});

// --- validate ---

const REGISTRY = [
  { name: 'city-briefing', routing: { description: 'briefing', args: { city: 'city name' } } },
  { name: 'weather', routing: null },
];

test('validateSchedules accepts valid schedule', () => {
  assert.doesNotThrow(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY));
});

test('validateSchedules rejects unknown workflow', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'nonexistent', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY), /unknown workflow/);
});

test('validateSchedules rejects workflow without routing', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'weather', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY), /not a routable workflow/);
});

test('validateSchedules rejects invalid cron', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: 'not-a-cron', timezone: 'UTC' },
  ], REGISTRY), /invalid cron/);
});

test('validateSchedules rejects invalid timezone', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'Mars/Olympus' },
  ], REGISTRY), /invalid timezone/);
});

test('validateSchedules rejects duplicate names', () => {
  assert.throws(() => validateSchedules([
    { name: 'dup', workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'UTC' },
    { name: 'dup', workflow: 'city-briefing', cron: '0 10 * * *', timezone: 'UTC' },
  ], REGISTRY), /duplicate schedule name/);
});

test('validateSchedules rejects missing name', () => {
  assert.throws(() => validateSchedules([
    { workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY), /name.*required/i);
});

test('validateSchedules rejects missing cron', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', timezone: 'UTC' },
  ], REGISTRY), /cron.*required/i);
});

test('validateSchedules rejects missing timezone', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: '0 9 * * *' },
  ], REGISTRY), /timezone.*required/i);
});

// --- overlap ---

function mockJobs(records) {
  return {
    async get(id) { return records.find(r => r.id === id) ?? null; },
    _records: records,
  };
}

test('shouldRun returns true for queue policy regardless', async () => {
  const result = await shouldRun('test', 'queue', {
    jobs: mockJobs([{ id: 'j1', status: 'processing', metadata: { schedule: { name: 'test' } } }]),
    logger: { info() {} },
  });
  assert.equal(result, true);
});

test('shouldRun returns true for skip policy when no active jobs', async () => {
  const result = await shouldRun('test', 'skip', {
    jobs: mockJobs([{ id: 'j1', status: 'completed', metadata: { schedule: { name: 'test' } } }]),
    logger: { info() {} },
  });
  assert.equal(result, true);
});

test('shouldRun returns false for skip policy when active job exists', async () => {
  const result = await shouldRun('test', 'skip', {
    jobs: mockJobs([{ id: 'j1', status: 'processing', metadata: { schedule: { name: 'test' } } }]),
    logger: { info() {}, warn() {} },
  });
  assert.equal(result, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/host-scheduler-core.test.mjs
```

Expected: FAIL — modules not found

- [ ] **Step 3: Implement interface.mjs**

Create `host/scheduler/interface.mjs`:

```js
const REQUIRED = ['start', 'stop', 'getSchedules'];

export function assertSchedulerBackend(obj) {
  const missing = REQUIRED.filter(k => typeof obj?.[k] !== 'function');
  if (missing.length) throw new Error(`scheduler backend missing: ${missing.join(', ')}`);
  return obj;
}
```

- [ ] **Step 4: Implement validate.mjs**

Create `host/scheduler/validate.mjs`:

```js
import { Cron } from 'croner';

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isValidCron(expr) {
  try {
    new Cron(expr, { timezone: 'UTC' });
    return true;
  } catch {
    return false;
  }
}

export function validateSchedules(schedules, toolRegistry) {
  const names = new Set();
  const routableWorkflows = new Set(
    toolRegistry.filter(t => t.routing).map(t => t.name),
  );

  for (const s of schedules) {
    if (!s.name || typeof s.name !== 'string') {
      throw new Error('schedule name is required (non-empty string)');
    }
    if (names.has(s.name)) {
      throw new Error(`duplicate schedule name "${s.name}"`);
    }
    names.add(s.name);

    if (!s.workflow || typeof s.workflow !== 'string') {
      throw new Error(`schedule "${s.name}": workflow is required`);
    }
    if (!toolRegistry.some(t => t.name === s.workflow)) {
      throw new Error(`schedule "${s.name}" references unknown workflow "${s.workflow}"`);
    }
    if (!routableWorkflows.has(s.workflow)) {
      throw new Error(`schedule "${s.name}": "${s.workflow}" is not a routable workflow (missing routing config)`);
    }

    if (!s.cron || typeof s.cron !== 'string') {
      throw new Error(`schedule "${s.name}": cron is required (non-empty string)`);
    }
    if (!isValidCron(s.cron)) {
      throw new Error(`schedule "${s.name}" has invalid cron expression "${s.cron}"`);
    }

    if (!s.timezone || typeof s.timezone !== 'string') {
      throw new Error(`schedule "${s.name}": timezone is required (non-empty string)`);
    }
    if (!isValidTimezone(s.timezone)) {
      throw new Error(`schedule "${s.name}" has invalid timezone "${s.timezone}"`);
    }
  }
}
```

- [ ] **Step 5: Implement overlap.mjs**

Create `host/scheduler/overlap.mjs`:

```js
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

export async function shouldRun(scheduleName, overlapPolicy, { jobs, logger }) {
  if (overlapPolicy === 'queue') return true;

  const records = jobs._records ?? [];
  const active = records.filter(
    r => !TERMINAL_STATUSES.has(r.status) && r.metadata?.schedule?.name === scheduleName,
  );

  if (active.length > 0) {
    logger.info?.(`[scheduler] skipping "${scheduleName}": previous run still active (job ${active[0].id})`);
    return false;
  }
  return true;
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
node --test tests/host-scheduler-core.test.mjs
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add host/scheduler/interface.mjs host/scheduler/validate.mjs host/scheduler/overlap.mjs tests/host-scheduler-core.test.mjs
git commit -m "feat(scheduler): add interface contract, validation, and overlap check"
```

---

### Task 3: In-process scheduler backend

**Files:**
- Create: `host/scheduler/in-process.mjs` — croner-based scheduler
- Create: `host/scheduler/index.mjs` — factory
- Test: `tests/host-scheduler-in-process.test.mjs`

**Interfaces:**
- Consumes:
  - `resolveSchedulerConfig()` from Task 1 — the resolved config
  - `validateSchedules()` from Task 2 — called in `start()`
  - `shouldRun()` from Task 2 — called on each tick
  - `jobs.submit(task, { metadata })` — the existing jobs backend interface
- Produces:
  - `createInProcessScheduler(config, { jobs, toolRegistry, logger }) → SchedulerBackend` — implements `{ start(), stop(), getSchedules() }`
  - `createSchedulerBackend(config, deps) → SchedulerBackend` — factory that returns in-process or durable based on `config.backend`

- [ ] **Step 1: Write the failing tests**

Create `tests/host-scheduler-in-process.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessScheduler } = await import('../host/scheduler/in-process.mjs');

const REGISTRY = [
  { name: 'city-briefing', routing: { description: 'briefing', args: { city: 'city name' } } },
];

function mockJobs() {
  const submitted = [];
  return {
    submitted,
    _records: [],
    async submit(task, opts) {
      const id = `job-${submitted.length + 1}`;
      const record = { id, status: 'queued', task, metadata: opts?.metadata ?? {} };
      submitted.push(record);
      this._records.push(record);
      return { jobId: id, status: 'queued', position: 1 };
    },
  };
}

test('start validates schedules', async () => {
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'bad', workflow: 'nonexistent', cron: '* * * * *', timezone: 'UTC' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await assert.rejects(scheduler.start(), /unknown workflow/);
});

test('tick submits a job with correct shape', async () => {
  const jobs = mockJobs();
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: { city: 'Tokyo' }, cron: '* * * * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  try {
    await sleep(1500);
    assert.ok(jobs.submitted.length >= 1, `expected at least 1 submission, got ${jobs.submitted.length}`);
    const task = jobs.submitted[0].task;
    assert.equal(task.workflow, 'city-briefing');
    assert.deepEqual(task.inputs, { city: 'Tokyo' });
    assert.equal(task.strategy, 'workflow');
    assert.ok(task.goal.includes('city-briefing'));
    const meta = jobs.submitted[0].metadata;
    assert.equal(meta.schedule.name, 'test');
    assert.ok(meta.schedule.tick);
  } finally {
    await scheduler.stop();
  }
});

test('overlap skip prevents submission when active job exists', async () => {
  const jobs = mockJobs();
  jobs._records.push({ id: 'existing', status: 'processing', metadata: { schedule: { name: 'test' } } });
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '* * * * * *', timezone: 'UTC', overlap: 'skip' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  try {
    await sleep(1500);
    assert.equal(jobs.submitted.length, 0, 'should not have submitted');
  } finally {
    await scheduler.stop();
  }
});

test('getSchedules returns schedule info with nextRun', async () => {
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  try {
    const schedules = scheduler.getSchedules();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].name, 'test');
    assert.equal(schedules[0].workflow, 'city-briefing');
    assert.ok(schedules[0].nextRun instanceof Date || typeof schedules[0].nextRun === 'string');
  } finally {
    await scheduler.stop();
  }
});

test('stop clears all timers', async () => {
  const jobs = mockJobs();
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '* * * * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  await scheduler.stop();
  const countBefore = jobs.submitted.length;
  await sleep(1500);
  assert.equal(jobs.submitted.length, countBefore, 'no new submissions after stop');
});

test('submit error does not crash scheduler', async () => {
  const jobs = mockJobs();
  jobs.submit = async () => { throw new Error('queue full'); };
  const logged = [];
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '* * * * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn(msg) { logged.push(msg); } } },
  );
  await scheduler.start();
  try {
    await sleep(1500);
    assert.ok(logged.some(m => m.includes('queue full')), 'should have logged the error');
  } finally {
    await scheduler.stop();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/host-scheduler-in-process.test.mjs
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement in-process.mjs**

Create `host/scheduler/in-process.mjs`:

```js
import { Cron } from 'croner';
import { validateSchedules } from './validate.mjs';
import { shouldRun } from './overlap.mjs';

export function createInProcessScheduler(config, { jobs, toolRegistry, logger }) {
  const crons = [];
  let started = false;

  async function tick(schedule) {
    const tickTime = new Date();
    try {
      const canRun = await shouldRun(schedule.name, schedule.overlap, { jobs, logger });
      if (!canRun) return;

      const { jobId } = await jobs.submit(
        {
          goal: `Scheduled workflow: ${schedule.workflow}`,
          workflow: schedule.workflow,
          inputs: schedule.args,
          strategy: 'workflow',
        },
        {
          metadata: {
            schedule: {
              name: schedule.name,
              tick: tickTime.toISOString(),
            },
          },
        },
      );
      logger.info?.(`[scheduler] fired "${schedule.name}" → job ${jobId}`);
    } catch (err) {
      logger.warn?.(`[scheduler] tick "${schedule.name}" failed: ${err?.message ?? err}`);
    }
  }

  return {
    async start() {
      if (started) return;
      validateSchedules(config.schedules, toolRegistry);
      for (const schedule of config.schedules) {
        const job = new Cron(schedule.cron, { timezone: schedule.timezone }, () => tick(schedule));
        crons.push({ schedule, job });
      }
      started = true;
      logger.info?.(`[scheduler] started ${crons.length} schedule(s)`);
    },

    async stop() {
      for (const { job } of crons) job.stop();
      crons.length = 0;
      started = false;
    },

    getSchedules() {
      return crons.map(({ schedule, job }) => ({
        name: schedule.name,
        workflow: schedule.workflow,
        args: schedule.args,
        cron: schedule.cron,
        timezone: schedule.timezone,
        overlap: schedule.overlap,
        nextRun: job.nextRun()?.toISOString() ?? null,
      }));
    },
  };
}
```

- [ ] **Step 4: Implement the factory in index.mjs**

Create `host/scheduler/index.mjs`:

```js
import { assertSchedulerBackend } from './interface.mjs';
import { createInProcessScheduler } from './in-process.mjs';

export async function createSchedulerBackend(config, { jobs, toolRegistry, logger }) {
  if (config.backend === 'durable') {
    try {
      const { createDurableScheduler } = await import('./durable.mjs');
      return assertSchedulerBackend(createDurableScheduler(config, { jobs, toolRegistry, logger }));
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('scheduler backend "durable" is not available in this build');
      }
      throw err;
    }
  }
  return assertSchedulerBackend(createInProcessScheduler(config, { jobs, toolRegistry, logger }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test tests/host-scheduler-in-process.test.mjs
```

Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add host/scheduler/in-process.mjs host/scheduler/index.mjs tests/host-scheduler-in-process.test.mjs
git commit -m "feat(scheduler): add in-process backend with croner timers"
```

---

### Task 4: Durable scheduler backend (Azure Timer Triggers)

**Files:**
- Create: `host/scheduler/durable.mjs` — Azure Timer Trigger registration
- Test: `tests/host-scheduler-durable.test.mjs`

**Interfaces:**
- Consumes:
  - `validateSchedules()` from Task 2
  - `shouldRun()` from Task 2
  - `jobs.submit()` — durable jobs backend
  - `@azure/functions` `app.timer()` — Timer Trigger registration API
- Produces: `createDurableScheduler(config, { jobs, toolRegistry, logger }) → SchedulerBackend`

- [ ] **Step 1: Write the failing tests**

Create `tests/host-scheduler-durable.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createDurableScheduler } = await import('../host/scheduler/durable.mjs');

const REGISTRY = [
  { name: 'city-briefing', routing: { description: 'briefing', args: { city: 'city name' } } },
];

function mockJobs() {
  const submitted = [];
  return {
    submitted,
    _records: [],
    async submit(task, opts) {
      const id = `job-${submitted.length + 1}`;
      submitted.push({ id, task, metadata: opts?.metadata ?? {} });
      return { jobId: id, status: 'queued', position: 1 };
    },
  };
}

test('registerTimerFunctions registers one timer per schedule', () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const scheduler = createDurableScheduler(
    {
      enabled: true,
      schedules: [
        { name: 'morning', workflow: 'city-briefing', args: { city: 'Tokyo' }, cron: '0 9 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' },
        { name: 'evening', workflow: 'city-briefing', args: { city: 'London' }, cron: '0 18 * * *', timezone: 'Europe/London', overlap: 'skip' },
      ],
    },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, 'schedule-morning');
  assert.equal(registered[0].schedule, '0 9 * * *');
  assert.equal(registered[1].name, 'schedule-evening');
});

test('timer handler submits job on fire', async () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const jobs = mockJobs();
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: { city: 'Tokyo' }, cron: '0 9 * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  await registered[0].handler({ scheduleStatus: { last: '2026-09-29T09:00:00Z' } }, {});
  assert.equal(jobs.submitted.length, 1);
  assert.equal(jobs.submitted[0].task.workflow, 'city-briefing');
  assert.equal(jobs.submitted[0].metadata.schedule.name, 'test');
});

test('getSchedules returns schedule info', () => {
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  const list = scheduler.getSchedules();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'test');
  assert.ok(list[0].nextRun);
});

test('start validates schedules', async () => {
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'bad', workflow: 'nonexistent', cron: '* * * * *', timezone: 'UTC' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await assert.rejects(scheduler.start(), /unknown workflow/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/host-scheduler-durable.test.mjs
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement durable.mjs**

Create `host/scheduler/durable.mjs`:

```js
import { Cron } from 'croner';
import { validateSchedules } from './validate.mjs';
import { shouldRun } from './overlap.mjs';

export function createDurableScheduler(config, { jobs, toolRegistry, logger }) {
  let started = false;

  async function tick(schedule, timer) {
    const tickTime = timer?.scheduleStatus?.last ?? new Date().toISOString();
    try {
      const canRun = await shouldRun(schedule.name, schedule.overlap, { jobs, logger });
      if (!canRun) return;

      const { jobId } = await jobs.submit(
        {
          goal: `Scheduled workflow: ${schedule.workflow}`,
          workflow: schedule.workflow,
          inputs: schedule.args,
          strategy: 'workflow',
        },
        {
          metadata: {
            schedule: {
              name: schedule.name,
              tick: typeof tickTime === 'string' ? tickTime : new Date(tickTime).toISOString(),
            },
          },
        },
      );
      logger.info?.(`[scheduler] fired "${schedule.name}" → job ${jobId}`);
    } catch (err) {
      logger.warn?.(`[scheduler] tick "${schedule.name}" failed: ${err?.message ?? err}`);
    }
  }

  return {
    async start() {
      if (started) return;
      validateSchedules(config.schedules, toolRegistry);
      started = true;
      logger.info?.(`[scheduler] started (durable) with ${config.schedules.length} schedule(s)`);
    },

    async stop() {
      started = false;
    },

    registerTimerFunctions(app) {
      for (const schedule of config.schedules) {
        const timerConfig = {
          schedule: schedule.cron,
          handler: async (timer, context) => tick(schedule, timer),
        };
        if (schedule.timezone && schedule.timezone !== 'UTC') {
          timerConfig.runOnStartup = false;
        }
        app.timer(`schedule-${schedule.name}`, timerConfig);
      }
    },

    getSchedules() {
      return config.schedules.map(schedule => {
        let nextRun = null;
        try {
          const cron = new Cron(schedule.cron, { timezone: schedule.timezone });
          nextRun = cron.nextRun()?.toISOString() ?? null;
        } catch { /* best-effort */ }
        return {
          name: schedule.name,
          workflow: schedule.workflow,
          args: schedule.args,
          cron: schedule.cron,
          timezone: schedule.timezone,
          overlap: schedule.overlap,
          nextRun,
        };
      });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/host-scheduler-durable.test.mjs
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add host/scheduler/durable.mjs tests/host-scheduler-durable.test.mjs
git commit -m "feat(scheduler): add durable backend with Azure Timer Trigger registration"
```

---

### Task 5: Host integration — wire scheduler into startup/shutdown, add workflow bypass, `/schedules` route

**Files:**
- Modify: `host/index.mjs` — create and start scheduler after jobs, stop before jobs
- Modify: `host/tasks.mjs:148-200` — handle `strategy: 'workflow'` with `workflow` field to bypass router
- Modify: `host/routes.mjs` — add `GET /schedules` route
- Modify: `comm/azure-functions/main.mjs` — call `registerTimerFunctions()` for durable scheduler
- Modify: `host.config.mjs` — add disabled scheduler section as example
- Test: `tests/host-scheduler-integration.test.mjs`

**Interfaces:**
- Consumes:
  - `createSchedulerBackend()` from Task 3 — factory
  - `resolveSchedulerConfig()` from Task 1 — config resolution
  - `executeWorkflow()` from `host/router.mjs` — called when `strategy === 'workflow'`
  - All existing host startup/shutdown machinery
- Produces:
  - Modified `startHost()` return adds `scheduler` field
  - `GET /schedules` route
  - `executeHostedTask()` now handles `task.strategy === 'workflow'` + `task.workflow` to bypass router

- [ ] **Step 1: Write the failing integration tests**

Create `tests/host-scheduler-integration.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { executeHostedTask } = await import('../host/tasks.mjs');
const { executeWorkflow } = await import('../host/router.mjs');

test('executeHostedTask with strategy=workflow bypasses router', async () => {
  let routerCalled = false;
  let workflowCalled = false;
  const task = {
    id: 'test-1',
    goal: 'Scheduled workflow: city-briefing',
    strategy: 'workflow',
    workflow: 'city-briefing',
    inputs: { city: 'Tokyo' },
  };

  const mockDispatcher = {
    dispatch: async () => ({
      workerId: 'w1', doer: 'doer', reviewer: null,
      signal: new AbortController().signal,
      release: async () => {},
    }),
  };

  const toolRegistry = [
    {
      name: 'city-briefing',
      routing: { description: 'briefing', args: { city: 'city name' } },
      async run() { workflowCalled = true; return 'done'; },
    },
  ];

  const result = await executeHostedTask(task, {
    api: {},
    activeDispatcher: mockDispatcher,
    toolRegistry,
    runLoopConfig: { strategy: 'open-ended' },
    routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
    budgetsConfig: null,
    guardrailsMod: null,
    jobs: null,
    signal: null,
    onProgress: null,
    memory: null,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.routedTo, 'workflow:city-briefing');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/host-scheduler-integration.test.mjs
```

Expected: FAIL — `strategy: 'workflow'` with `workflow` field not handled

- [ ] **Step 3: Add workflow bypass to executeHostedTask in host/tasks.mjs**

In `host/tasks.mjs`, after line 183 (`let strategy = task.strategy ?? null;`), before the router classification block, add handling for the `workflow` strategy:

```js
    if (strategy === 'workflow' && task.workflow) {
      workflowName = task.workflow;
      workflowArgs = task.inputs ?? {};
    }
```

This makes the existing `if (!strategy && routerConfig?.enabled)` block skip (since `strategy` is already set), and the existing `if (strategy === 'workflow')` block on line 291 fires the workflow directly.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/host-scheduler-integration.test.mjs
```

Expected: PASS

- [ ] **Step 5: Add GET /schedules route to host/routes.mjs**

In `host/routes.mjs`, modify `buildRoutes` to accept `scheduler`:

```js
export function buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled, chatRoutes = null, guardrails = null, memoryRoutes = null, scheduler = null }) {
```

After the `jobEvents` route block, add:

```js
  if (scheduler) {
    routes.schedules = {
      method: 'GET', path: '/schedules', auth: false,
      handler: async () => json(200, scheduler.getSchedules()),
    };
  }
```

- [ ] **Step 6: Wire scheduler into host/index.mjs**

Add import at the top of `host/index.mjs`:

```js
import { createSchedulerBackend } from './scheduler/index.mjs';
import { resolveSchedulerConfig } from './scheduler/config.mjs';
```

After the `jobs.start()` block (around line 198), add:

```js
  let scheduler = null;
  const schedulerConfig = resolveSchedulerConfig(config.modules?.scheduler, { env, dispatchConfig });
  if (schedulerConfig.enabled && jobs) {
    try {
      scheduler = await createSchedulerBackend(schedulerConfig, {
        jobs, toolRegistry, logger,
      });
      await scheduler.start();
    } catch (err) {
      try { await scheduler?.stop(); } catch { /* preserve original error */ }
      try { await jobs?.stop({ drainMs: 0 }); } catch { /* preserve */ }
      try { await memory?.close(); } catch { /* preserve */ }
      try { await ownDispatcher?.close(); } catch { /* preserve */ }
      try { await stopFleet?.(); } catch { /* preserve */ }
      throw err;
    }
  }
```

Pass `scheduler` to `buildRoutes`:

```js
  const routes = buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb: null, runLoopEnabled, chatRoutes, guardrails: guardrailsMod, memoryRoutes: memory?.routes ?? null, scheduler });
```

In the `close` function, add `scheduler.stop()` before `jobs.stop()`:

```js
    await scheduler?.stop();
    await jobs?.stop({ drainMs: dispatchConfig?.drainMs });
```

Add `scheduler` to the return object:

```js
  return {
    host: adapter, jobs, notifier, memory, scheduler, callTool, close, stop: close, ...
  };
```

- [ ] **Step 7: Wire durable scheduler in comm/azure-functions/main.mjs**

After the `registerDurableFunctions()` call, add:

```js
if (started.scheduler?.registerTimerFunctions) {
  const { app } = await import('@azure/functions');
  started.scheduler.registerTimerFunctions(app);
}
```

- [ ] **Step 8: Add disabled scheduler section to host.config.mjs**

In `host.config.mjs`, add a commented-out scheduler block inside `modules`:

```js
    // scheduler: {
    //   enabled: false,
    //   schedules: [],
    // },
```

- [ ] **Step 9: Run all scheduler tests**

```bash
node --test tests/host-scheduler-config.test.mjs tests/host-scheduler-core.test.mjs tests/host-scheduler-in-process.test.mjs tests/host-scheduler-durable.test.mjs tests/host-scheduler-integration.test.mjs
```

Expected: all PASS

- [ ] **Step 10: Run existing host tests to verify no regressions**

```bash
node --test tests/host-config.test.mjs tests/host-index.test.mjs
```

Expected: all PASS

- [ ] **Step 11: Commit**

```bash
git add host/index.mjs host/tasks.mjs host/routes.mjs host.config.mjs comm/azure-functions/main.mjs tests/host-scheduler-integration.test.mjs
git commit -m "feat(scheduler): wire into host lifecycle, add workflow bypass and /schedules route"
```

---

### Task 6: Agent builder updates, template, and documentation

**Files:**
- Modify: `template/host.config.mjs` — add commented-out scheduler block
- Modify: `.claude/skills/agent-builder/references/agent-spec-template.md` — add Scheduled Workflows section
- Modify: `.claude/skills/agent-builder/references/kit-file-conventions.md` — add Scheduler Configuration section and build order step
- Modify: `docs/architecture.md` — add scheduler to component diagram and components list
- Modify: `docs/roadmap.md` — mark Schedule as shipped
- Create: `docs/scheduled-workflows.md` — user-facing documentation

**Interfaces:**
- Consumes: All modules from Tasks 1-5 (documents their usage)
- Produces: Documentation and templates for users and the agent-builder skill

- [ ] **Step 1: Add commented-out scheduler to template/host.config.mjs**

After the `router` block and before the memory comment block, add:

```js
    // -- Scheduler (uncomment to enable recurring workflow runs) --
    //
    // scheduler: {
    //   enabled: true,
    //   schedules: [
    //     {
    //       name: 'example-schedule',
    //       workflow: 'hello',           // must match a registered workflow
    //       args: {},                     // workflow arguments
    //       cron: '0 9 * * *',           // 9am daily
    //       timezone: 'UTC',             // IANA timezone
    //       overlap: 'queue',            // 'queue' or 'skip'
    //     },
    //   ],
    // },
```

- [ ] **Step 2: Add Scheduled Workflows section to agent-spec-template.md**

After the `## Memory Configuration` section and before `## Error Handling`, add:

```markdown
## Scheduled Workflows

{{Fill if the agent needs recurring runs. Omit this entire section if no schedules.}}

| Schedule | Workflow | Args | Cron | Timezone | Overlap |
|----------|----------|------|------|----------|---------|
| {{name}} | {{workflow}} | {{args}} | {{cron expression}} | {{IANA tz}} | {{queue or skip}} |

- **Why scheduled**: {{why this workflow needs to run on a timer}}
- **Result delivery**: {{webhook URL, or "poll via jobs API", or "SSE"}}
```

- [ ] **Step 3: Add Scheduler Configuration section to kit-file-conventions.md**

After the `## Memory Module Configuration` section, add a `## Scheduler Configuration` section documenting the `modules.scheduler` config block, its fields, defaults, overlap policies, and the note that it requires `dispatch.enabled`.

In the `## Build Order` list, add between step 5 and step 6:

```
5.5. **Scheduler config** — configure `modules.scheduler` with schedule entries
     (name, workflow, args, cron, timezone, overlap). Requires dispatch enabled.
```

- [ ] **Step 4: Update docs/architecture.md**

Add scheduler to the component diagram and the Components section. Add a new paragraph:

```markdown
**Scheduler** (`host/scheduler/`) —
Fires named workflows on cron schedules. Config-driven (schedules live in
`host.config.mjs`). Each tick submits a job through the jobs pipeline — the
scheduler is a clock, nothing more. Two backends: in-process (croner timers
in Node) for VM/Docker, Azure Timer Triggers for Functions.
```

- [ ] **Step 5: Update docs/roadmap.md**

Move `Schedule (cron fires)` from "Not started" to "Done" in the communication layer table. Add to the Shipped table:

```markdown
| Scheduled workflows | Done | [scheduled-workflows-spec](specs/scheduled-workflows-spec.md) |
```

- [ ] **Step 6: Create docs/scheduled-workflows.md**

Create user-facing documentation covering:
- Overview (what it does, how it works)
- Configuration reference (all schedule entry fields with examples)
- Overlap policies
- How scheduled jobs differ from manual ones (metadata)
- `GET /schedules` endpoint
- Azure Functions deployment notes
- Troubleshooting (invalid cron, timezone issues, overlap behavior)

- [ ] **Step 7: Commit**

```bash
git add template/host.config.mjs .claude/skills/agent-builder/references/agent-spec-template.md .claude/skills/agent-builder/references/kit-file-conventions.md docs/architecture.md docs/roadmap.md docs/scheduled-workflows.md
git commit -m "docs: add scheduled workflows documentation, update agent-builder and roadmap"
```

---

### Task 7: Link scheduled workflows into README and getting-started

**Files:**
- Modify: `README.md` — add Scheduled Workflows to the features section and docs links
- Modify: `docs/getting-started.md` — add a Scheduled Workflows section explaining how to configure schedules
- Modify: `docs/architecture.md` — add cross-link to `docs/scheduled-workflows.md`

**Interfaces:**
- Consumes: `docs/scheduled-workflows.md` created in Task 6
- Produces: All three entry-point docs link to the detailed scheduled workflows page

- [ ] **Step 1: Add Scheduled Workflows to README.md**

In the top navigation links (`<p align="center">`), add a link:

```html
<a href="docs/scheduled-workflows.md"><strong>Scheduled Workflows</strong></a>
```

In the features/capabilities section of the README (wherever the kit's features are listed), add:

```markdown
- **Scheduled workflows** — fire named workflows on cron schedules with timezone support and overlap policies. Config-driven, works on VM/Docker and Azure Functions. See [docs/scheduled-workflows.md](docs/scheduled-workflows.md).
```

- [ ] **Step 2: Add Scheduled Workflows section to docs/getting-started.md**

After the existing "What you get" section's bullet list (around the "Receive a goal" items), add scheduled workflows to the capabilities list:

```markdown
- Run workflows on a schedule (cron-based, timezone-aware)
```

Add a new section after the Memory configuration section (or after the appropriate config section):

```markdown
## Scheduled Workflows

Run any registered workflow on a cron schedule. Scheduled runs create normal jobs
— they appear in `GET /jobs/:id`, stream events over SSE, and deliver results via
webhook.

```js
// host.config.mjs
modules: {
  scheduler: {
    enabled: true,
    schedules: [
      {
        name: 'morning-briefing',
        workflow: 'city-briefing',
        args: { city: 'Tokyo' },
        cron: '0 9 * * *',          // 9am daily
        timezone: 'Asia/Tokyo',
        overlap: 'queue',            // or 'skip'
      },
    ],
  },
}
```

The scheduler requires `dispatch` to be enabled (it submits jobs through the jobs
pipeline). See [scheduled-workflows.md](scheduled-workflows.md) for the full
reference.
```

- [ ] **Step 3: Add cross-link in docs/architecture.md**

In the Scheduler component description added in Task 6, append:

```markdown
See [scheduled-workflows.md](scheduled-workflows.md) for configuration and usage.
```

- [ ] **Step 4: Verify all links resolve**

```bash
grep -r 'scheduled-workflows.md' README.md docs/getting-started.md docs/architecture.md
```

Expected: three files reference the doc, and `docs/scheduled-workflows.md` exists from Task 6.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/getting-started.md docs/architecture.md
git commit -m "docs: link scheduled workflows from README, getting-started, and architecture"
```

---

Plan written and saved to `docs/plans/scheduled-workflows-plan.md`.

**Plan complete and saved to `docs/plans/scheduled-workflows-plan.md`. Please review the plan. Which execution approach would you prefer?**

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

**For this plan I recommend native**, because the tasks have tight sequential dependencies (each backend builds on the interface/validation/overlap from earlier tasks, and the host integration wires everything together), there are only 6 tasks, and the cost of a shipped mistake is low (this is a new additive feature with no changes to existing execution paths). Does the plan capture what you want, and which approach should we use?