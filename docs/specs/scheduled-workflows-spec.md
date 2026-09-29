# Fleet Agent Kit — Scheduled Workflows Spec

Status: proposed

## What exists today

The kit has three ways to trigger work:

1. **Chat** — a person types in the UI, which calls `POST /task`
2. **API** — a caller sends `POST /task` (sync or async)
3. **MCP** — another agent calls `POST /mcp`

All three are demand-driven: someone asks, the agent responds. There is no way
to have the agent do something on its own at a recurring time.

The roadmap identifies this as the fourth "door" under Communication layer
improvements:

> Schedule (cron fires) — Not started. Azure cron job or Logic App → calls
> `/task` endpoint. Needs overlap policy and idempotency key.

## What this ships

A config-driven scheduler that fires named workflows on cron schedules. Each
tick submits a job through the existing jobs pipeline — the scheduler is a
clock, nothing more. Everything downstream (queuing, worker dispatch, execution,
SSE events, webhooks) is reused unchanged.

### Milestone

A schedule defined in `host.config.mjs` fires a named workflow at the
configured cron time. The resulting job is indistinguishable from a manually
submitted one — it appears in `GET /jobs/:id`, streams events over SSE, and
delivers results via webhook. The scheduler works on both deployment targets:
VM/Docker (in-process) and Azure Functions (durable).

### Does not ship

- CRUD API for schedules (schedules come from config only)
- Chat UI for schedule management
- Scheduling arbitrary free-text goals (only named workflows)
- Persistent schedule history beyond what the jobs backend already stores
- Retry-on-failure for scheduled runs (the next cron tick fires a fresh run)
- Batch mode (one schedule = one workflow invocation; multiple cities = multiple
  schedule entries)

---

## Architecture

```
          host.config.mjs
          schedules: [{ name, workflow, args, cron, timezone, overlap }]
                │
                ▼
    scheduler backend (host/scheduler/interface.mjs)
  ┌─────────────┴──────────────┐
in-process (VM/Docker)    durable (Azure Functions)
croner timers in Node     Azure Timer Trigger per schedule
  └─────────────┬──────────────┘
                │  on tick
                ▼
        overlap check
        (is previous run for this schedule still active?)
                │
                ▼
        jobs.submit({ workflow, inputs, strategy: 'workflow', metadata })
                │
                ▼
        ┌── existing jobs pipeline (unchanged) ──┐
        │ queue → worker picks up                │
        │ → executeWorkflow() (direct, no router)│
        │ → result settles                       │
        │ → SSE events + webhook fire            │
        └────────────────────────────────────────┘
```

### Design decisions

**The scheduler only submits jobs.** It does not execute workflows directly. This
means every scheduled run gets the same lifecycle guarantees as a manual one:
queuing, backpressure, cancellation, SSE, webhooks, and job record persistence.
The scheduler has no execution logic of its own.

**Direct workflow execution, no router.** Since the config specifies the exact
workflow name and args, there is nothing to classify. The submitted job carries
`strategy: 'workflow'` and `workflow: '<name>'` so the runner bypasses the
router and calls `executeWorkflow()` directly. This saves the token cost of an
LLM classification call on every tick.

**Two backends, same pattern as jobs.** The kit already runs in two environments
that have fundamentally different runtime models:

- **VM/Docker** — a long-running Node process. Cron timers live in memory.
- **Azure Functions** — serverless, no persistent process. Azure Timer Triggers
  are the native cron mechanism.

The scheduler follows the same adapter pattern as `host/jobs/`: a shared
interface, a factory that picks the backend based on `JOBS_BACKEND`, and two
implementations that do the same thing differently.

**Backend follows jobs backend.** There is no separate `SCHEDULER_BACKEND` env
var. If `JOBS_BACKEND=durable`, the scheduler uses Azure Timer Triggers. If
`JOBS_BACKEND=in-process`, it uses croner. This avoids impossible combinations
(e.g., croner timers submitting to a durable jobs backend on a serverless host
that may recycle).

**Timer Triggers, not a Durable timer loop.** Azure Durable Functions has
`createTimer()` for delays, but using an eternal orchestration as a cron engine
is an anti-pattern — it accumulates replay history, costs storage, and cannot
be updated without termination. Azure Timer Triggers are the platform's built-in
cron primitive and handle timezone, missed executions, and reliability natively.

---

## Configuration

New `scheduler` section under `modules` in `host.config.mjs`:

```js
modules: {
  scheduler: {
    enabled: true,
    schedules: [
      {
        name: 'morning-tokyo-briefing',
        workflow: 'city-briefing',
        args: { city: 'Tokyo' },
        cron: '0 9 * * 1',
        timezone: 'Asia/Tokyo',
        overlap: 'queue',
      },
      {
        name: 'london-weekday-briefing',
        workflow: 'city-briefing',
        args: { city: 'London' },
        cron: '0 8 * * 1-5',
        timezone: 'Europe/London',
        overlap: 'skip',
      },
    ],
  },
}
```

### Schedule entry fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Unique identifier for this schedule. Used in job metadata and the `/schedules` endpoint. |
| `workflow` | string | yes | — | Name of the workflow to run. Must match a registered workflow in the tool registry. |
| `args` | object | no | `{}` | Arguments passed to the workflow. Same shape as the workflow's `routing.args`. |
| `cron` | string | yes | — | Standard 5-field cron expression (minute, hour, day-of-month, month, day-of-week). |
| `timezone` | string | yes | — | IANA timezone identifier (e.g., `Asia/Tokyo`, `Europe/London`, `UTC`). |
| `overlap` | string | no | `'queue'` | What to do when the previous run is still active. `queue` — submit anyway. `skip` — log and skip this tick. |

### Environment overrides

| Env var | Maps to | Default |
|---------|---------|---------|
| `SCHEDULER_ENABLED` | `scheduler.enabled` | `false` |

No environment override for individual schedules — they are config-only.

### Validation rules

| Condition | Result |
|-----------|--------|
| `scheduler.enabled` and not `dispatch.enabled` | **error**: scheduler requires the jobs backend |
| schedule `workflow` not in tool registry | **error** at startup: `schedule "<name>" references unknown workflow "<workflow>"` |
| schedule `cron` does not parse | **error** at startup: `schedule "<name>" has invalid cron expression` |
| schedule `timezone` is not a valid IANA zone | **error** at startup: `schedule "<name>" has invalid timezone` |
| duplicate schedule `name` | **error** at startup: `duplicate schedule name "<name>"` |
| `scheduler.enabled` with no schedules | **warning**: scheduler enabled but no schedules configured |

Validation fails fast at startup — a bad schedule prevents the host from
starting, since a silently ignored schedule is worse than a loud failure.

---

## The scheduler interface

```js
// host/scheduler/interface.mjs — every backend implements this shape
{
  async start(),                     // activate schedules (create timers / register triggers)
  async stop(),                      // deactivate (clear timers / no-op for durable)
  getSchedules(),                    // → [{ name, workflow, args, cron, timezone, overlap, nextRun }]
}
```

Both backends are constructed by a factory in `host/scheduler/index.mjs`:

```js
createSchedulerBackend(schedulerConfig, {
  jobs,           // the jobs backend — scheduler calls jobs.submit()
  toolRegistry,   // for workflow validation
  logger,
})
```

The factory reads `schedulerConfig.backend` (set from `JOBS_BACKEND`) and
returns either `createInProcessScheduler` or `createDurableScheduler`.

---

## In-process backend

`host/scheduler/in-process.mjs`. For VM and Docker deployments.

Uses `croner` (MIT, ~5KB, zero dependencies, timezone-aware cron). Each
configured schedule becomes one `Cron` instance. On tick:

1. **Overlap check** — query `jobs` for active (non-terminal) jobs whose
   `metadata.schedule.name` matches this schedule's name.
   - If `overlap: 'queue'` — proceed to submit.
   - If `overlap: 'skip'` and an active job exists — log
     `[scheduler] skipping "<name>": previous run still active (job <id>)` and
     return.
2. **Submit** — call `jobs.submit()` with:
   ```js
   {
     goal: `Scheduled workflow: ${workflow}`,
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
   }
   ```
3. **Log** — `[scheduler] fired "<name>" → job <jobId>`

`start()` creates all cron instances. `stop()` calls `.stop()` on each.
`getSchedules()` returns each schedule's config plus `nextRun` from croner's
`.nextRun()`.

### Error handling

If `jobs.submit()` throws (e.g., `JobQueueFullError`), the tick logs the error
and continues. The next cron tick will try again. The scheduler never crashes
the host.

---

## Durable backend

`host/scheduler/durable.mjs`. For Azure Functions deployments.

Azure Functions natively supports Timer Triggers with cron expressions and IANA
timezone support. Instead of reimplementing cron, we register a Timer Trigger
function for each configured schedule.

### Registration

At startup, `registerSchedulerFunctions()` is called from
`comm/azure-functions/main.mjs` (alongside `registerDurableFunctions()`). For
each schedule entry:

```js
app.timer(`schedule-${schedule.name}`, {
  schedule: schedule.cron,
  ...(schedule.timezone !== 'UTC' ? { scheduleMonitor: { timezone: schedule.timezone } } : {}),
  handler: async (timer, context) => {
    // overlap check + jobs.submit() — same logic as in-process
  },
});
```

Azure handles timezone conversion, missed-schedule catch-up, and trigger
reliability.

### Lifecycle

- `start()` — registers the timer functions. On Azure, this is a one-time
  registration at module load; the functions are active as long as the Function
  App is running.
- `stop()` — no-op. Azure manages timer lifecycle. The scheduler does not need
  to deregister functions; the Function App shutdown handles that.
- `getSchedules()` — returns schedule configs with next fire times computed
  from croner (used only for the `/schedules` endpoint; Azure's own scheduling
  is the source of truth for actual firing).

### Overlap check

Same as in-process: query the jobs backend (which is the durable backend) for
active jobs with matching `metadata.schedule.name`. The durable jobs backend
already supports `getStatusBy` for listing active instances.

---

## Job metadata for scheduled runs

Jobs created by the scheduler carry identifying metadata:

```js
{
  id: 'job-a1b2c3',
  status: 'queued',
  task: {
    goal: 'Scheduled workflow: city-briefing',
    workflow: 'city-briefing',
    inputs: { city: 'Tokyo' },
    strategy: 'workflow',
  },
  metadata: {
    schedule: {
      name: 'morning-tokyo-briefing',
      tick: '2026-09-29T00:00:00.000Z',
    },
  },
  // ... rest is standard job record fields
}
```

The `strategy: 'workflow'` field tells `executeHostedTask` to bypass the router
and call `executeWorkflow()` directly with the named workflow and inputs.

---

## Overlap check

`host/scheduler/overlap.mjs` — shared by both backends.

```js
export async function shouldRun(scheduleName, overlapPolicy, { jobs, logger }) {
  if (overlapPolicy === 'queue') return true;
  // overlapPolicy === 'skip'
  // Check if any active job exists for this schedule
  // ... query jobs for non-terminal status with metadata.schedule.name === scheduleName
  // If found, log and return false
  // Otherwise return true
}
```

### How overlap queries work on each backend

- **In-process**: The SQLite store already holds the full job record as JSON in
  the `record` column. The overlap check queries non-terminal records and filters
  client-side by parsing `metadata.schedule.name`. Since non-terminal records are
  bounded by `maxQueueSize + concurrency` (typically < 15), this is a small scan.
  No new index or schema change is needed.
- **Durable**: `client.getStatusBy({ runtimeStatus: ['Pending', 'Running'] })`
  returns active instances. Filter client-side by `input.metadata.schedule.name`.

---

## Host integration

### Startup order (additions in bold)

```
Config loaded and validated (including scheduler validation)
  → Tools registry loaded
  → Fleet transport ready
  → Worker dispatcher created
  → Guardrails, budgets config, run loop config
  → Notifier created
  → Jobs backend created and started
  → **Scheduler created and started (after jobs is ready)**
  → Route table built (includes GET /schedules)
  → Comm adapter starts
```

### Shutdown order (additions in bold)

```
SIGINT / SIGTERM
  → dispatcher.beginShutdown()
  → **scheduler.stop() (stop scheduling before draining jobs)**
  → adapter.stop()
  → jobs.stop({ drainMs })
  → notifier.stop()
  → dispatcher.close(), Fleet stop
```

### The `/task` route — workflow strategy bypass

When a submitted task has `strategy: 'workflow'` and a `workflow` field,
`executeHostedTask` skips the router classification and calls `executeWorkflow()`
directly. This path is used by the scheduler but is not exclusive to it — a
manual `POST /task` with `strategy: 'workflow'` and `workflow: 'city-briefing'`
would also bypass the router. This is consistent: the caller knows what to run.

### HTTP endpoint

| Method | Path | Response |
|--------|------|----------|
| GET | `/schedules` | `200 [{ name, workflow, args, cron, timezone, overlap, nextRun, lastRun }]` |

`lastRun` is derived by querying the jobs backend for the most recent terminal
job with `metadata.schedule.name` matching the schedule name. It includes
`{ jobId, status, finishedAt }` or `null` if no run has completed yet.

This is a read-only observability endpoint. No authentication beyond what the
host already applies.

---

## Dependencies

### New

| Package | Version | License | Size | Purpose |
|---------|---------|---------|------|---------|
| `croner` | `^9.0.0` | MIT | ~5KB | Timezone-aware cron scheduling. Used by in-process backend and for `nextRun` computation on both backends. |

`croner` has zero dependencies, is widely used (5M+ weekly npm downloads), and
supports IANA timezones natively via `Intl.DateTimeFormat`. No polyfills needed
on Node 22.

### Existing (no changes)

- `durable-functions` — already an `optionalDependency`. The durable scheduler
  uses `@azure/functions` `app.timer()` which is part of the same Azure
  Functions v4 SDK.

---

## Agent builder integration

The agent-builder skill guides new agent creation through an interview → spec →
plan pipeline. It needs to know about scheduled workflows so agents can be built
with schedules from day one.

### Three files updated

**1. `agent-spec-template.md`** — new `Scheduled Workflows` section:

```markdown
## Scheduled Workflows

{{Fill if the agent needs recurring runs. Omit this section if no schedules.}}

| Schedule | Workflow | Args | Cron | Timezone | Overlap |
|----------|----------|------|------|----------|---------|
| {{name}} | {{workflow}} | {{args}} | {{cron expression}} | {{IANA tz}} | {{queue or skip}} |

- **Why scheduled**: {{why this workflow needs to run on a timer}}
- **Result delivery**: {{webhook URL, or "poll via jobs API", or "SSE"}}
```

**2. `kit-file-conventions.md`** — new `Scheduler Configuration` section after
the Memory Module Configuration section:

Documents the `modules.scheduler` config block with the same level of detail as
the existing memory config section: fields, defaults, overlap policies, and a
note that the scheduler requires `dispatch.enabled`.

Adds a new entry to the Build Order list (between step 5 "Memory config" and
step 6 "Tests"):

```
5.5. **Scheduler config** — configure `modules.scheduler` with schedule entries
     (name, workflow, args, cron, timezone, overlap)
```

**3. `template/host.config.mjs`** — commented-out `scheduler` block (same
pattern as the existing memory block):

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

### Interview question

The agent-builder's Phase 1 Stage A wizard (structured questions) gains one
optional question after the deployment target question:

> **"Does this agent need to run any workflows on a schedule?"**
> - No (default)
> - Yes — daily/weekly reports
> - Yes — periodic monitoring/checks
> - Yes — other recurring tasks

If yes, Stage B grilling probes: which workflows, what frequency, what timezone,
what happens with results, what if a run is still going when the next tick fires.

---

## File tree

```
host/
  scheduler/
    interface.mjs            ← NEW — contract + assertSchedulerBackend()
    config.mjs               ← NEW — resolveSchedulerConfig(), defaults, validation
    index.mjs                ← NEW — createSchedulerBackend() factory
    in-process.mjs           ← NEW — croner-based scheduler
    durable.mjs              ← NEW — Azure Timer Trigger registration
    overlap.mjs              ← NEW — shared overlap check logic
    validate.mjs             ← NEW — schedule entry validation (cron, tz, workflow)
  tasks.mjs                  ← CHANGED — handle strategy: 'workflow' with workflow field
                                         (bypass router, call executeWorkflow directly)
  config.mjs                 ← CHANGED — scheduler validation rules
host.config.mjs              ← CHANGED — add scheduler section (disabled by default)
comm/
  express.mjs                ← CHANGED — add GET /schedules route
  azure-functions/
    main.mjs                 ← CHANGED — call registerSchedulerFunctions()
template/
  host.config.mjs            ← CHANGED — add commented-out scheduler block
.claude/skills/agent-builder/
  references/
    agent-spec-template.md   ← CHANGED — add Scheduled Workflows section
    kit-file-conventions.md  ← CHANGED — add Scheduler Configuration + build order step
tests/
  host-scheduler.test.mjs    ← NEW — unit tests for both backends
docs/
  scheduled-workflows.md     ← NEW — user-facing documentation
  architecture.md            ← CHANGED — add scheduler to component diagram
  roadmap.md                 ← CHANGED — mark Schedule as shipped
package.json                 ← CHANGED — add croner dependency
```

---

## Testing strategy

### Unit tests (no Fleet, no token)

`tests/host-scheduler.test.mjs`:

| Area | Covers |
|------|--------|
| Config validation | Missing workflow rejects, bad cron rejects, bad timezone rejects, duplicate name rejects, scheduler without dispatch rejects, empty schedules warns |
| In-process tick | Mock jobs backend: tick calls `jobs.submit()` with correct task shape and metadata; overlap `skip` with active job does not submit; overlap `queue` with active job submits anyway |
| In-process lifecycle | `start()` activates timers, `stop()` clears them, `getSchedules()` returns next run times |
| Durable registration | Mock `app.timer()`: each schedule produces one timer registration with correct cron and timezone |
| Overlap check | Unit test `shouldRun()` with mock jobs returning active/terminal records |
| Workflow bypass | Submit with `strategy: 'workflow'` + `workflow` field → `executeWorkflow()` called directly, router not invoked |

### Integration test

A schedule with `cron: '* * * * * *'` (every second, using croner's 6-field
support for testing) fires within 2 seconds. Verify a job appears in the
in-process jobs backend with the correct metadata.

### Manual verification

- Azure: deploy with a schedule that fires every minute, confirm Timer Trigger
  fires and a Durable orchestration starts via Application Insights.
- VM/Docker: start the host with a schedule, confirm jobs appear in
  `GET /jobs/:id` at the expected times.

---

## Open risks

- **Azure Timer Trigger timezone support** requires the `WEBSITE_TIME_ZONE` app
  setting or the `scheduleMonitor` configuration. If the per-function timezone
  setting proves unreliable, the fallback is to compute the UTC-equivalent cron
  expression at config load time using croner's timezone conversion.
- **Overlap check cost on durable** requires listing active orchestration
  instances on every tick. For a small number of schedules (tens, not hundreds)
  this is well within Azure's limits. If the number of concurrent orchestrations
  grows large, the overlap check can be optimized by tagging instances with the
  schedule name as a custom property.
- **No CRUD API** means adding or changing a schedule requires a config change
  and a restart (or redeployment on Azure). This is deliberate for the first
  version — config-driven schedules are simpler, auditable, and match how most
  infrastructure cron is managed. A CRUD API is a natural follow-up if dynamic
  scheduling becomes a need.
