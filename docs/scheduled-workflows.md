# Scheduled Workflows

A clock that calls `jobs.submit` for named workflows. Schedules live in `host.config.mjs`. The scheduler does not run tools itself — every tick becomes a normal job.

## Overview

When `modules.scheduler.enabled` is true, the host validates the schedule list at startup and starts a backend that matches the jobs backend. There is no separate scheduler backend.

- **`in-process`** (default, VM and Docker) — one [croner](https://github.com/Hexagon/croner) timer per schedule. Each schedule's IANA timezone is honored.
- **`durable`** (Azure Functions) — one Timer Trigger per schedule, named `schedule-<name>`. The trigger calls the same submit path when it fires.

A tick submits:

```js
jobs.submit(
  {
    goal: 'Scheduled workflow: <workflow>',
    workflow: '<workflow>',
    inputs: /* schedule.args */,
    strategy: 'workflow',
  },
  { metadata: { schedule: { name: '<name>', tick: '<ISO-8601>' } } },
);
```

Only named workflows are allowed. The workflow must already be in the tool registry and must have a `routing` config. Open-ended goals are not scheduled.

Results are ordinary jobs. Poll `GET /jobs/:id`, stream `GET /jobs/:id/events`, or attach a webhook the same way as a manual submit. See [Jobs API](jobs.md).

## Configuration

From `host.config.mjs`:

```js
dispatch: {
  enabled: true,   // required — the scheduler submits jobs
},
scheduler: {
  enabled: true,
  schedules: [
    {
      name: 'morning-brief',
      workflow: 'city-briefing',
      args: { city: 'Tokyo' },
      cron: '0 9 * * *',          // 09:00 every day
      timezone: 'Asia/Tokyo',
      overlap: 'queue',
    },
  ],
},
```

| Field | Required | Default | Example |
|---|---|---|---|
| `enabled` | no | `false` | `true` |
| `schedules[].name` | yes | — | `'morning-brief'` |
| `schedules[].workflow` | yes | — | `'city-briefing'` |
| `schedules[].args` | no | `{}` | `{ city: 'Tokyo' }` |
| `schedules[].cron` | yes | — | `'0 9 * * *'` |
| `schedules[].timezone` | yes | — | `'Asia/Tokyo'` |
| `schedules[].overlap` | no | `'queue'` | `'queue'` or `'skip'` |

Cron is **5 fields**: minute, hour, day of month, month, day of week.

| Expression | Meaning |
|---|---|
| `0 9 * * *` | 09:00 every day |
| `*/15 * * * *` | every 15 minutes |
| `0 9 * * 1-5` | 09:00 Monday through Friday |
| `30 18 1 * *` | 18:30 on the first of each month |

`timezone` is an IANA name (`UTC`, `America/New_York`, `Europe/London`). It is required even when you only care about UTC.

An unrecognized `overlap` value is treated as `queue`.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `SCHEDULER_ENABLED` | (unset) | `true` or `1` forces the scheduler on. `false` or `0` forces it off. Overrides `scheduler.enabled` in the config file. |
| `JOBS_BACKEND` | `in-process` | `in-process` or `durable`. The scheduler uses this same value. There is no `SCHEDULER_BACKEND`. |

`JOBS_BACKEND=durable` still requires `comm.adapter` `azure-functions`, same as the jobs backend.

## Overlap policies

Overlap looks at jobs whose `metadata.schedule.name` matches this schedule and whose status is `queued` or `processing`.

| Policy | Behavior |
|---|---|
| `queue` | Always submit. A slow run and the next tick can both be in the queue. |
| `skip` | Do not submit while a previous run of this schedule is still active. The host logs `[scheduler] skipping "<name>": previous run still active (job <id>)`. |

`skip` does not cancel the in-flight job. The next tick after that job reaches `completed`, `failed`, `cancelled`, or `budget_exceeded` submits again. Two different schedule names do not block each other.

## How scheduled jobs differ

The job record is the same shape as a manual job ([Jobs API](jobs.md)), with three fields set by the scheduler:

| Field | Value |
|---|---|
| `task.strategy` | `'workflow'` |
| `task.workflow` | the schedule's `workflow` |
| `task.inputs` | the schedule's `args` (persisted on the record) |
| `task.goal` | `Scheduled workflow: <workflow>` |
| `metadata.schedule.name` | schedule name |
| `metadata.schedule.tick` | ISO-8601 time of this fire |

`workflow` and `inputs` are stored on the job record, not only on the submit call. The run loop uses `strategy: 'workflow'` to invoke that workflow with `task.inputs` and does not route the goal through the strategy auto-router.

On the in-process backend, `tick` is the time the timer callback started. On Azure, `tick` is `timer.scheduleStatus.last` when the Functions host provides it, otherwise the time the handler ran.

A failed submit (for example a full queue) is logged as `[scheduler] tick "<name>" failed: …` and does not stop the other schedules.

## Routes

`GET /schedules` is mounted only while the scheduler is running (enabled, and dispatch started).

| Method | Path | Response |
|---|---|---|
| GET | `/schedules` | `200` JSON array of schedule objects |

```bash
curl.exe -s localhost:3000/schedules
```

Each object:

```js
{
  name: 'morning-brief',
  workflow: 'city-briefing',
  args: { city: 'Tokyo' },
  cron: '0 9 * * *',
  timezone: 'Asia/Tokyo',
  overlap: 'queue',
  nextRun: '2026-09-30T00:00:00.000Z',  // ISO-8601, or null
}
```

`nextRun` is the next fire time computed by croner in that schedule's timezone. It is not a record of the previous fire.

## Azure Functions

The Functions entrypoint calls `scheduler.registerTimerFunctions(app)` after the host starts. Each schedule becomes one timer:

| Schedule `name` | Function name | NCRONTAB |
|---|---|---|
| `morning-brief` | `schedule-morning-brief` | `0` + the 5-field cron |

A 5-field expression is converted to Azure's 6-field NCRONTAB by prefixing `0 ` (second = 0). `0 9 * * *` becomes `0 0 9 * * *`. An expression that already has six fields is passed through unchanged.

**Per-schedule IANA timezone cannot be set on `@azure/functions` v4 timers.** The `timezone` field is still required and is still returned by `GET /schedules` (croner uses it for `nextRun`), but the Timer Trigger itself runs in the app timezone:

- Set `WEBSITE_TIME_ZONE` (Linux App Service / Functions also honors `TZ`) to the zone you want the timers to use.
- If neither is set, timers run in UTC.

Use one app timezone for every Azure schedule, or run the in-process backend when each schedule needs its own zone. The in-process backend passes `timezone` to croner and fires in that zone.

`JOBS_BACKEND=durable` (or `dispatch.backend: 'durable'`) selects this path. Timer registration happens only in the Azure Functions host (`comm/azure-functions/main.mjs`).

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Process exits: `schedule "<name>" has invalid cron expression "…"` | Cron is not a croner expression. | Use 5 fields, for example `0 9 * * *`. |
| Process exits: `schedule "<name>" references unknown workflow "…"` | Name is not in the tool registry. | Register the workflow before enabling the schedule. |
| Process exits: `"<workflow>" is not a routable workflow (missing routing config)` | The tool exists but has no `routing` block. | Add routing, or schedule a workflow that already has it. |
| Process exits: `schedule "<name>" has invalid timezone "…"` | Not an IANA zone. | Use a name `Intl` accepts, such as `UTC` or `America/Los_Angeles`. |
| Process exits: `scheduler enabled but dispatch disabled` | Scheduler submits jobs. | Set `dispatch.enabled: true`, or set `scheduler.enabled` / `SCHEDULER_ENABLED` to false. |
| Log: `[host/config] scheduler enabled but no schedules configured` | `enabled: true` and `schedules` is missing or `[]`. | Add at least one schedule, or disable the scheduler. |
| A tick did not create a job | `overlap: 'skip'` and a previous run of that schedule is still `queued` or `processing`. | Wait for it to finish, or set `overlap: 'queue'`. The skip line names the active job id. |
| Azure timer fires in UTC, not `timezone` | v4 timers ignore per-schedule zones. | Set `WEBSITE_TIME_ZONE` or `TZ` for the app, or use the in-process backend. |
| `GET /schedules` is 404 | Scheduler is off, so the route is not mounted. | Enable the scheduler and restart. |
