# Architecture

How this repo is put together and why. Read this before changing code. If you just want
to get something running, start with the [README](../README.md); if you are about to add
a workflow or a test, continue to the [development guide](development.md).

## What this repo is

A toolkit for driving [Apra Fleet](https://github.com/Apra-Labs/apra-fleet) **from your
own Node process**. You clone it, keep the shape, and replace the demo workflows with real
work. It can serve as a passive MCP tool server (external AI picks the tools) or as an
autonomous agent (the kit's own LLM plans and executes).

It is deliberately **not** a Fleet CLI workflow. Nothing here is meant to be registered
with `apra-fleet workflow ...`. The entry point is an ordinary exported async function:

```js
import { runDemo } from './workflows/demo/main.mjs';

await runDemo();               // live — spawns Fleet over stdio
await runDemo({ fleetApi });   // tests — inject a mock client
```

That single design choice drives most of what follows: because the workflow is a plain
function taking an injectable client, it can be called from a web server, from a test,
or from another workflow, and it can be tested without spawning Fleet or an API token.

## Fleet concepts you need first

If you have never used Fleet, these five terms explain almost everything in this repo.

**Fleet process.** Launchers spawn `apra-fleet run --transport stdio` as a child process
for the duration of a run, then tear it down. There is no `apra-fleet start` prerequisite.
The child owns the member registry and the credential store for that process, and it is
what actually spawns LLM CLIs. `APRA_FLEET_BIN` overrides the binary when it is not on
PATH.

**MCP.** The Model Context Protocol is used on both sides of this process. On top, this
repo is an MCP **server**: it exposes each entry in `mcp/registry.mjs` as a tool for
Claude Code. Underneath, it is an MCP **client** to the spawned Fleet process, whose
tools include `execute_command`, `execute_prompt`, `list_members`, `register_member`,
and `fleet_status`. Every Fleet operation ultimately becomes one MCP tool call, and each
result returns in MCP's envelope shape (`content[]` / `structuredContent`), which is why
text extraction is a shared helper rather than inline property access.

**Member.** A named agent workspace registered with Fleet: a name, a type (`local` or
`remote`), an LLM (`claude`), and a working folder on disk. Fleet runs commands and
prompts *as* a member, inside that member's folder. Workflows address members as
`'doer'` and `'reviewer'`. Node's `MemberManager` registers real names at startup:
pool pairs `WORKER-{i}-DOER` / `-REVIEWER`, plus ephemeral `EPHEMERAL-{id}-*` pairs
created when the pool is busy.

**Work folder.** The directory a member operates in. Each member needs its **own**
folder — two local members sharing a `cwd` collide. Pool folders live under the
configured pool root; ephemeral folders live under `os.tmpdir()` and are deleted on
release. Fleet may drop a `.claude/settings.local.json` into them at registration
time; that is local machine state and is gitignored.

**Credential store.** Where OAuth tokens live, attached to a specific member. The
spawned child inherits `CLAUDE_CODE_OAUTH_TOKEN` from the parent environment, and
`MemberManager` calls Fleet's `provision_llm_auth` tool for each registered member.
Exporting the token in your shell is how a live `agent()` call is authenticated —
the Claude process is spawned by Fleet, not by your Node process. Nearly every
"works interactively, fails unattended" problem traces back to a missing token.

## The layers

```text
┌──────────────────────────────────────────────────────────────────┐
│  Your Node process                                               │
│                                                                  │
│   host/              POST /task — autonomous agent endpoint       │
│     │                POST /mcp  — MCP tool server                │
│     │                GET /health  GET /jobs/:id/events           │
│     │                                                            │
│     ├─ jobs/         POST /task → backend → executeHostedTask    │
│     │   ├─ in-process  SQLite queue + worker loops (VM/Docker)   │
│     │   └─ durable     Azure Durable orchestrator + activity     │
│     ├─ notify/       SSE + webhook fan-out from job events       │
│     ├─ routes.mjs    /task, /jobs/*, /mcp, /health               │
│     ├─ tasks.mjs     executeHostedTask — shared by sync + async  │
│     │                                                            │
│     ├─ run-loop       runTask() — drives a strategy to completion│
│     │   ├─ strategies/  open-ended (ReAct) or plan-execute       │
│     │   ├─ prompts/     prompt templates for LLM interaction     │
│     │   └─ response-parser  fenced JSON block extraction         │
│     │                                                            │
│     ├─ budgets        iteration / token / cost / time caps       │
│     ├─ guardrails     per-tool policies, sandbox, validation     │
│     └─ tools/         registry + executor with timeout & retry   │
│                                                                  │
│   mcp/             tool catalog — registry entries for both      │
│     │              /mcp (external LLM picks tools) and           │
│     │              /task (internal LLM picks tools)              │
│   comm/            adapter: express | raw-http | azure-functions │
│     │                                                            │
│     ▼                                                            │
│   workflows/       runDemo(), runInspectMembers(), etc.           │
│     │                                                            │
│   tools/           Python scripts — weather, forecast, currency, │
│     │              country-info, geocode, wikipedia, holidays    │
│     ▼                                                            │
│   pool/            worker dispatch: pool → ephemeral → queue     │
│     │              MemberManager, leases, cleanup                │
│     ▼                                                            │
│   transport/       spawnFleet() — StdioClientTransport            │
│                    fleetApi wrapper over tools/call               │
└─────┼────────────────────────────────────────────────────────────┘
      │ MCP JSON-RPC over stdin/stdout
      ▼
┌──────────────────────────────────────────────────────────────────┐
│  apra-fleet child     `run --transport stdio`                    │
│                                                                  │
│   pool WORKER-i + ephemeral EPHEMERAL-id pairs                   │
│   doer + reviewer folders       registered by MemberManager      │
│   Claude Code + OAuth                                            │
└──────────────────────────────────────────────────────────────────┘
```

There are two front doors. **`/mcp`** is for external AI agents: they see the tool catalog
and drive their own logic. **`/task`** is for humans and apps: they send a goal and the
host's own LLM plans and executes autonomously. Both share the same tool registry, worker
pool, and guardrails — the difference is who decides what to call.

The dependency arrow points one way only: `host/` imports from `mcp/` (for the registry)
and `pool/` (for dispatch). `mcp/` imports from `workflows/`. Nothing under `workflows/`
imports upward. The transport module is the downstream Fleet client.

## Module map

### `transport/`

| File | Responsibility |
|---|---|
| `stdio-fleet.mjs` | Spawns Fleet over stdio, connects an MCP client, and returns `{ fleetApi, stop() }`. Member registration and OAuth are `MemberManager`'s job. |

`createFleetApi(client)` is the seam: it calls `client.listTools()`, verifies the five
required Fleet tools, and maps `executeCommand` / `executePrompt` / `listMembers` /
`registerMember` / `fleetStatus` onto `client.callTool()`. Workflow bodies and the MCP
server never see the transport. `spawnFleet()` is skipped entirely when a `fleetApi` is
injected (tests).

### `pool/`

| File | Responsibility |
|---|---|
| `index.mjs` | Barrel export and `createWorkerDispatcher()` — the startup lifecycle that builds a `MemberManager`, provisions the roster, and wires pool + ephemeral + dispatcher. |
| `config.mjs` | Reads `WORKER_*` env vars, returns typed config objects for pool, ephemeral, and dispatch tiers. |
| `roster.mjs` | Builds the pool roster: `WORKER-{i}-DOER` / `-REVIEWER` names, folders, and lock targets. |
| `member-manager.mjs` | The single owner of member lifecycle. Registers members, provisions OAuth via `provision_llm_auth`, tears down pairs. Nothing else in the kit may call `registerMember` or `removeMember`. |
| `worker-pool.mjs` | Pre-provisioned roster of N pairs. Lease-based acquisition with `proper-lockfile`, FIFO queueing, heartbeats. |
| `ephemeral-factory.mjs` | On-demand doer/reviewer pairs for overflow. Each pair has a unique UUID, lives under `os.tmpdir()`, and self-destructs on release. TTL safety net prevents leaks. |
| `worker-dispatcher.mjs` | Tiered dispatch: pool → ephemeral → queue → reject. Owns the shared FIFO wait queue. |
| `pooled-fleet-api.mjs` | Proxy that remaps `'doer'`/`'reviewer'` keywords to the lease's actual member names. |
| `worker-lock.mjs` | `proper-lockfile` wrapper with stale detection and heartbeat updates. |
| `cleanup.mjs` | Wipes a worker folder's contents on acquire and release, preserving `.claude/`. |
| `fleet-text.mjs` | Text extraction from Fleet MCP envelopes, member presence check, and failure detection. |

### `mcp/`

| File | Responsibility |
|---|---|
| `main.mjs` | Server launcher. Spawns Fleet when no `fleetApi` is injected, listens on loopback, and wires SIGINT/SIGTERM shutdown. |
| `server.mjs` | Builds the MCP server and registers one tool for each registry entry. Converts returned values to tool results and emits progress when requested. |
| `http.mjs` | Creates the Express app. Provides `GET /health` and a stateless `POST /mcp`. |
| `registry.mjs` | The tool catalog: demo, inspect-members, city-briefing, weather, timezone, textstats, currency, country-info, forecast, geocode, wikipedia-summary, public-holidays. Each entry has `{ name, description, inputSchema?, annotations?, run }`. |
| `auth.mjs` | Pass-through auth stub. Replace by injection, not by editing. |
| `fleet-text.mjs` | Pulls plain text out of Fleet MCP tool results. |

### `workflows/`

| File | Responsibility |
|---|---|
| `standalone.mjs` | Shared helper for CLI runs. `withStandaloneLease(run)` spawns Fleet, builds a dispatcher, takes one lease, runs, releases, tears down. |
| `demo/main.mjs` | Demo launcher. Spawns Fleet when no `fleetApi` is injected, runs status → command → transform → agent. |
| `demo/demo.js` | Demo body. Receives engine context and exercises Fleet primitives. |
| `inspect-members/main.mjs` | Reports on the worker pair: registration, work folders. |
| `city-briefing/main.mjs` | Fetches weather + timezone, composes a briefing with an agent, analyzes with textstats. |

### `host/`

The autonomous agent host. Wires the run loop, strategies, budgets, and guardrails into
a single HTTP server that serves both `/mcp` and `/task`.

| File | Responsibility |
|---|---|
| `index.mjs` | `startHost()` and `createHost()` builder. Boots Fleet, dispatcher, loads config, mounts routes. |
| `config.mjs` | Loads `host.config.mjs`, validates module sections (`runLoop`, `budgets`, `guardrails`). |
| `run-loop.mjs` | `runTask()` — selects strategy, iterates events, checks budgets on each LLM call, returns `{ status, result, history, budget }`. |
| `budgets.mjs` | `createBudgets()` — tracks iterations, tokens, cost, elapsed time. `check()` returns which cap was hit. |
| `guardrails.mjs` | `createGuardrails()` — per-tool policy gate (`allow`/`deny`/`approve`), input validation, filesystem sandbox, dry-run mode. |
| `response-parser.mjs` | Extracts fenced JSON blocks from LLM responses. |
| `tools/registry.mjs` | Extends the MCP registry with reversibility, timeout, and retry metadata. |
| `tools/executor.mjs` | Runs a tool with validation, timeout, and error handling. |
| `routes.mjs` | Route table: `/health`, `/mcp`, `/task`, `/jobs/:id`, `/jobs/:id/events`. |
| `tasks.mjs` | `executeHostedTask()` — dispatch lease, budgets, run loop; shared by sync and async paths. |

#### `host/jobs/`

| File | Responsibility |
|---|---|
| `interface.mjs` | Backend contract, error types, `validateCallbackUrl()`. |
| `record.mjs` | `JobRecord` shape, status transitions, event helpers, `ringEvents()`. |
| `in-process.mjs` | SQLite-backed queue with worker loops for VM/Docker. |
| `durable.mjs` | Durable Functions backend — orchestrator status, poll-based subscribe. |
| `index.mjs` | `createJobsBackend()` factory. |
| `config.mjs` | Resolves `dispatch` config and env overrides. |
| `store/interface.mjs` | Store contract for records and events. |
| `store/sqlite.mjs` | WAL-mode SQLite persistence. |
| `store/memory.mjs` | In-memory store for unit tests. |

#### `host/notify/`

| File | Responsibility |
|---|---|
| `index.mjs` | `createNotifier()` — fans out events to SSE and webhook channels. |
| `sse.mjs` | `GET /jobs/:id/events` handler with replay, subscribe, and heartbeat. |
| `webhook.mjs` | POSTs `settled` (and optional `progress`) to `callbackUrl`. |

#### `host/strategies/`

| File | Responsibility |
|---|---|
| `open-ended.mjs` | ReAct loop: the doer LLM sees the task + tools + observation history, picks a tool or finishes. |
| `plan-execute.mjs` | Multi-phase: doer plans → reviewer approves/rejects → steps execute one at a time → step-level review for irreversible tools → replan on failure. |

Both strategies are async generators that yield events (`prompt_usage`, `observation`,
`done`, `error`). The run loop consumes them uniformly.

#### `host/prompts/`

Prompt builders. Each returns a string sent to the doer or reviewer via
`fleetApi.executePrompt()`.

| File | Used by | Purpose |
|---|---|---|
| `system.mjs` | Both | Agent identity, response format rules, fenced-block grammar |
| `act.mjs` | Open-ended | Task + tools + history → pick a tool or finish |
| `plan.mjs` | Plan-execute | Task + tools → create an ordered plan |
| `review.mjs` | Plan-execute | Proposed plan → approve or reject with feedback |
| `execute.mjs` | Plan-execute | Completed step → continue or finish |
| `step-review.mjs` | Plan-execute | Step result → approve or reject |
| `resolve-args.mjs` | Plan-execute | Empty/partial args + history → concrete args |
| `reason.mjs` | Plan-execute | Reasoning step → analysis text |
| `replan.mjs` | Plan-execute | Failed plan + feedback → revised plan |
| `format-tools.mjs` | Both | Tool registry → text catalog with names, params, reversibility |

### `comm/`

| File | Responsibility |
|---|---|
| `router.mjs` | Neutral request/response routing, param matching, auth hook. |
| `raw-http.mjs` | Node `http` adapter implementing the comm contract. |
| `express.mjs` | Express adapter (default for VM/Docker). |
| `azure-functions/http.mjs` | Functions HTTP triggers, `/api` prefix strip, MCP web-standard transport. |
| `azure-functions/orchestrator.mjs` | Durable orchestrator — records events in `customStatus`. |
| `azure-functions/activity.mjs` | Durable activity wrapping `executeHostedTask`. |
| `azure-functions/main.mjs` | Functions entry — `startHost()`, registers triggers and durable functions. |

### `tools/`

Python scripts called via `fleetApi.executeCommand()` on the doer member. All use only
stdlib (`urllib.request`, `json`, `sys`) plus optional `certifi` for SSL.

| File | Responsibility |
|---|---|
| `weather/weather.py` | Current weather from wttr.in. |
| `forecast/forecast.py` | Multi-day forecast from Open-Meteo (1-16 days). |
| `timezone/timezone.py` | Local time from timeapi.io. |
| `textstats/textstats.py` | Text analysis: character, word, sentence counts. |
| `currency/currency.py` | Live exchange rates from the ECB via frankfurter.app. |
| `country-info/country_info.py` | Country info from Wikipedia + Nominatim. |
| `travel-advisory/travel_advisory.py` | Travel safety advisories by country code. |
| `geocode/geocode.py` | City → lat/lon or reverse, via Nominatim. |
| `wikipedia-summary/wikipedia_summary.py` | Wikipedia summary extract for any topic. |
| `public-holidays/public_holidays.py` | Public holidays by country/year from Nager.Date. |

## Data flow

### A workflow run (CLI)

```text
runDemo()
  ├─ ensureApralabs()                       symlink @apralabs packages
  ├─ withStandaloneLease() when no fleetApi  (CLI: spawn + dispatcher + lease)
  │    ├─ spawnFleet()                      → { fleetApi, stop }
  │    ├─ createWorkerDispatcher()          MemberManager provisions pool
  │    └─ dispatch() → PooledFleetApi + workspace
  ├─ new WorkflowEngine(new FleetWorkflow(api))
  ├─ engine.executeFile('demo.js', { fleetApi, workspace })
  │    status → command → transform → agent
  └─ finally: release lease / close dispatcher / stop Fleet
```

### An MCP tool call (POST /mcp)

```text
Claude Code chooses a tool from tools/list
  └─ POST /mcp tools/call
       ├─ authenticate
       ├─ create a fresh MCP server + HTTP transport
       ├─ guardrails.execute() if enabled
       ├─ dispatcher.dispatch() → acquire lease
       ├─ entry.run({ fleetApi, args, signal, reportPhase })
       ├─ return one final MCP tool result → Claude
       └─ lease.release()
```

### A synchronous task (POST /task?wait=true)

```text
POST /task?wait=true { goal, constraints, budget }
  ├─ mergeBudgetConfig()              server defaults ∩ request (stricter wins)
  ├─ executeHostedTask()              host/tasks.mjs
  │    ├─ dispatcher.dispatch()       acquire lease → doer + reviewer pair
  │    └─ runTask()                   strategy → budgets → guardrails
  └─ return { taskId, status, result, history, budget }
       └─ lease.release()
```

### An async task (POST /task)

```text
POST /task { goal, callbackUrl? }
  └─ jobs.submit()
       ├─ store record (queued)        emit queued event
       ├─ notifier.publish()           SSE subscribers + webhook (if configured)
       │
       ├─ in-process backend           worker loop picks head → processing
       │    or durable backend          startNew(orchestrator) → activity
       │
       ├─ executeHostedTask()          same run loop as sync path
       │    onProgress → progress events with kind (plan, step_started, …)
       │
       ├─ emit started → progress* → settled
       └─ notifier.publish()           fan-out to SSE + webhook

GET /jobs/:id          → poll JobRecord
GET /jobs/:id/events   → SSE stream (replay + live)
DELETE /jobs/:id       → cancel (cooperative abort)
```

## Design decisions

**Downstream Fleet is stdio, not HTTP.** Launchers call `spawnFleet()` from
`transport/stdio-fleet.mjs`. The wrapper discovers Fleet's tool names via `listTools()`
at connect time and maps camelCase `fleetApi` methods onto those names. A missing required
tool fails at spawn, not on first call. `executeCommand` / `executePrompt` strip
`timeoutMs`, `signal`, and `failSoft` from the tool payload and pass them as MCP client
options. The client timeout defaults to 15 minutes, not the SDK's 60s.

**Registration happens in Node at dispatcher startup.** A freshly spawned Fleet process
starts empty. `createWorkerDispatcher()` uses `MemberManager` to register the pool
roster (and ephemeral pairs later). Injected test clients do not need a `registerMember`
method.

**OAuth is inherited, then attached.** The child environment copies the parent and sets
`CLAUDE_CODE_OAUTH_TOKEN` when a token is available. After registration, `MemberManager`
calls `provision_llm_auth` for each member. A missing token does not block spawn;
`agent()` will fail later if Fleet has nothing to authenticate with.

**`@apralabs` packages resolve through a symlink.** The root `package.json` deliberately
does not depend on any `@apralabs/*` package; Fleet is a machine install, not a project
dependency. `ensureApralabs()` links `node_modules/@apralabs` to whichever location
actually contains the packages. It uses `'junction'` so Windows does not require admin
rights.

**`fleetApi` is injected, never imported.** Both launchers accept a client and only
spawn when one isn't supplied. This is what makes the mock tests possible — they run
with no Fleet binary, no members, and no token.

**There is no internal router for MCP.** The model connected over MCP already sees the
tool names, descriptions, and schemas and decides which one to call. Tool descriptions
are part of the interface.

**`/mcp` and `/task` are separate interfaces, not nested.** Exposing the run loop as an
MCP tool would create agent-inside-agent: double token spend, lost visibility, and two
brains fighting over strategy. `/mcp` is for external agents that bring their own brain;
`/task` is for callers that want this server's brain.

**Strategy selection is static.** Set in `host.config.mjs`, every task uses it. Dynamic
selection would require a classifier prompt for marginal benefit.

**Guardrails are checked on both paths.** MCP tool calls and run-loop tool calls both
go through `guardrails.execute()`.

**Budgets are per-request, not per-server.** Each `/task` request creates a fresh budget
instance, merging server defaults with request overrides. The merge picks the stricter
value.

**Iteration count tracks LLM calls, not tool calls.** Only `prompt_usage` events
increment the counter. A run with 9 tools and 4 LLM calls counts as 4 iterations.

**Auth is replaced by injection.** `createMcpHttpApp({ authenticate })` takes middleware.
Routes depend only on `req.user`, so real auth drops in without editing `auth.mjs`.

**Teardown is idempotent `stop()`.** Safe to call twice. Unexpected child exit rejects
the in-flight `callTool`; the process is not restarted.

**Two seams: comm adapter vs jobs backend.** The comm layer (`express`, `raw-http`,
`azure-functions`) translates HTTP into neutral routes. The jobs backend (`in-process`,
`durable`) owns queueing, records, and cancellation. Either backend can pair with any
adapter that mounts the same route table.

**Progress events are rich.** Progress SSE/webhook payloads include a `kind` field
(`plan`, `step_started`, `step_completed`, …) and `stepIndex` so a UI can render the
plan and step timeline without parsing LLM output.

**Cancellation is cooperative and polled on Azure.** In-process backends abort via
`AbortSignal` when the run loop yields. On Durable Functions, the activity polls
`customStatus.cancelRequested` at `pollMs` because DELETE may hit a different instance
than the activity.

## Where state lives

| State | Location | Lifetime |
|---|---|---|
| Member registry | Fleet data dir (`~/.apra-fleet/data`) | Shared across stdio children on the same machine. |
| OAuth tokens | Fleet credential store, per member | Until the token expires. |
| Member scratch space | pool root / ephemeral tmpdir | On disk; `.claude/` inside is gitignored local state. |

The MCP layer holds no state: every HTTP request gets a fresh MCP server and transport.
The downstream Fleet child lives for the MCP server process, not per HTTP request.

## Configuration

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (none) | OAuth token passed into spawned Fleet processes. |
| `WORKER_POOL_SIZE` | `4` | Pre-registered doer/reviewer pairs. |
| `WORKER_EPHEMERAL_MAX` | `10` | Extra pairs created under `os.tmpdir()` when the pool is busy. |
| `WORKER_DISPATCH_QUEUE_SIZE` | `20` | Calls waiting when both tiers are busy. |
| `WORKER_POOL_ROOT` | `./workdir` | Base folder for pool worker dirs and locks. |
| `WORKER_POOL_ACQUIRE_TIMEOUT_MS` | `300000` | Timeout for pool-internal `acquire()`. |
| `WORKER_EPHEMERAL_ROOT` | `os.tmpdir()/apra-agent-kit` | Base folder for ephemeral worker dirs. |
| `WORKER_EPHEMERAL_TTL_MS` | `600000` | Force-teardown safety net for ephemeral workers. |
| `WORKER_DISPATCH_QUEUE_TIMEOUT_MS` | `300000` | Timeout for queued dispatch waiters. |
| `APRA_FLEET_BIN` | `apra-fleet` on PATH | Path to the Fleet binary when it is not on PATH. |
| `PORT` | `3000` | Server listen port. |
| `MCP_BIND_HOST` | `127.0.0.1` | Server bind address. Compose sets `0.0.0.0`. |
| `JOBS_BACKEND` | `in-process` | Jobs backend: `in-process` or `durable`. |
| `JOBS_MAX_QUEUE_SIZE` | `100` | Max queued jobs before `429`. |
| `JOBS_CONCURRENCY` | `1` | In-process worker loops. |
| `JOBS_DB_PATH` | `./workdir/jobs.db` | SQLite database path. |
| `JOBS_RETENTION_MS` | `86400000` | Terminal record retention (24 h). |
| `DURABLE_TASK_HUB` | `fleetjobs` | Durable Functions task hub name. |
| `DURABLE_POLL_MS` | `2000` | Cancel/SSE poll interval on Azure. |
| `WEBHOOK_ALLOW_HTTP` | (unset) | Allow `http:` callback URLs (dev only). |

### Host config (`host.config.mjs`)

```js
export default {
  name: 'apra-agent-kit',
  fleet: {},
  comm: { adapter: 'express' },
  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',     // or 'open-ended'
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      policies: {},
      validateInputs: true,
      sandboxFs: false,
      dryRunMode: false,
    },
    dispatch: {
      enabled: true,
      store: { kind: 'sqlite', dbPath: './jobs.db' },
      concurrency: 2,
      maxQueueSize: 10,
    },
    notify: {
      sse: { enabled: true },
    },
  },
};
```

When `runLoop` is enabled, the host mounts `POST /task` and, when `dispatch.enabled`
is true, the async jobs API (`/jobs/*`). When disabled, only `/mcp` + `/health` are
served.

## Extension points

| You want to | Do this |
|---|---|
| Real Python work | Replace `dummy.py`, keep the `command()` call |
| Real LLM work | Change the `agent()` prompt, keep `member_name` |
| A second agent | Address `'reviewer'` on the leased pair |
| Your own pool size | Set `WORKER_POOL_SIZE` / `WORKER_EPHEMERAL_MAX` |
| A new MCP tool | Append its entry to `mcp/registry.mjs` — no server or HTTP changes |
| A new Python tool | Add a script to `tools/`, expose it in `mcp/registry.mjs` |
| Real authentication | Pass middleware to `createMcpHttpApp({ authenticate })` |
| Switch agent strategy | Set `modules.runLoop.strategy` in `host.config.mjs` |
| Limit token spend | Set `modules.budgets.maxCostUsd` or pass `budget.maxCostUsd` in `/task` |
| Block a tool | Add `'tool-name': 'deny'` to `modules.guardrails.policies` |
| Require approval | Add `'tool-name': 'approve'` and provide an `approvalCallback` |
| Dry-run mode | Set `modules.guardrails.dryRunMode: true` — all tools are blocked |
| Build programmatically | Use `createHost().runLoop().budget().guardrails().build()` |

The stdio design is specified in [specs/stdio-transport-spec.md](specs/stdio-transport-spec.md).
The run loop, strategies, budgets, and guardrails are detailed in [run-loop.md](run-loop.md).
