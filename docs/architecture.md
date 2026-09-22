# Architecture

How this repo is put together. Read this before changing code.
If you just want to run something, start with the [Getting Started guide](getting-started.md).

> **Visual version:** open [architecture-diagram.html](architecture-diagram.html) in a browser
> for the interactive component diagram with color-coded layers.

## What this is

An autonomous AI agent server built on [Apra Fleet](https://github.com/Apra-Labs/apra-fleet).
You give it a task in plain English, it figures out what tools to use, runs them, and gives
you back the answer.

Three operating modes:

- **Minimal (Tool Server)** — external AI (Claude Code, another agent) drives reasoning,
  calls tools via MCP at `/mcp`
- **Full Agent** — receives a task at `/task`, plans, executes, observes, replans, returns
  autonomously
- **Custom** — any combination of modules

## Component diagram

<p align="center">
  <img src="architecture-diagram.svg" alt="Architecture component diagram" />
</p>

## Components

**HTTP Layer** (`comm/`) —
The front door. Accepts task requests, serves the MCP tool endpoint, and hosts the chat UI.
Swappable between Express (local/Docker), raw HTTP, or Azure Functions.

**Job Queue** (`host/jobs/`) —
Handles async tasks. When you fire-and-forget a task, it gets queued and a worker picks it up.
SQLite-backed locally, Azure Durable Functions in the cloud.
Jobs go through: `queued → processing → completed / failed / cancelled / budget_exceeded`.

**MCP Server** (`mcp/`) —
Exposes 15 tools as an MCP catalog so an external AI (like Claude Code) can call them directly,
without the agent doing its own planning.

**Strategy Engine** (`host/strategies/`) —
The brain. Two modes:

- **ReAct** — simple loop: ask the LLM what to do next, do it, repeat until done. Uses one
  worker (doer).
- **Plan-Execute** — doer creates a plan, reviewer approves it, steps execute one by one,
  replan on failure. Uses two workers (doer + reviewer).

**Budgets & Guardrails** (`host/budgets.mjs`, `host/guardrails.mjs`) —
Safety rails around the strategy loop. Default caps: 25 iterations, $5 cost, 500K tokens,
10 min timeout. Per-tool allow/deny policies and filesystem sandboxing.

**Worker Pool** (`pool/`) —
Manages Claude Code instances in three tiers:

1. **Pool** — 4 pre-provisioned doer/reviewer pairs, grabbed instantly
2. **Ephemeral** — up to 10 on-demand overflow pairs, self-destruct after use
3. **Wait Queue** — up to 20 pending requests, 5 min timeout

Each pair = a doer (does the work) + a reviewer (checks the plan).

**Notifications** (`host/notify/`) —
Pushes job progress out in real time. SSE stream for browser clients, webhook POST with
retry for server-to-server callbacks.

**Apra Fleet** (child process) —
The foundation. Runs as a child process over stdio (MCP JSON-RPC). Manages member workspaces,
OAuth credentials, and spawns Claude Code CLI instances for each worker.

**Python Tools** (`tools/`) —
15 tools (weather, currency, geocode, Wikipedia, etc.) — all plain Python using only stdlib,
executed on Fleet member machines via `executeCommand`.

## Data flow

### Sync task (`POST /task?wait=true`)

```
Client → HTTP → executeHostedTask → dispatch (acquire worker pair)
  → strategy loop (LLM picks tools, observes, replans)
  → return result in same HTTP response
  → release worker pair
```

### Async task (`POST /task`)

```
Client → HTTP → jobs.submit → SQLite queue → return 202 + jobId
  ↓ worker loop picks up
  executeHostedTask → strategy loop → progress events → settled
  ↓ fan-out
  SSE subscribers ← notifier → webhook POST

Client watches: GET /jobs/:id/events (SSE stream)
Client cancels:  DELETE /jobs/:id
```

### MCP tool call (`POST /mcp`)

```
External AI → picks tool from catalog → dispatch (acquire pair)
  → guardrails check → tool.run() → result → release pair
```

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe |
| `GET` | `/kit` | Agent identity + operational state |
| `POST` | `/mcp` | MCP tool server for external AI |
| `POST` | `/task` | Submit a task (sync with `?wait=true`, or async) |
| `GET` | `/jobs/:id` | Poll job status |
| `GET` | `/jobs/:id/events` | SSE event stream (replay + live) |
| `DELETE` | `/jobs/:id` | Cancel a running job |
| `GET` | `/chat` | Chat UI |

## Tool catalog

15 tools registered in `mcp/registry.mjs`, all Python scripts using only stdlib:

| Tool | What it does |
|------|-------------|
| `weather` | Current weather from wttr.in |
| `forecast` | Multi-day forecast from Open-Meteo |
| `timezone` | Local time from timeapi.io |
| `currency` | Exchange rates from ECB via frankfurter.app |
| `geocode` | City → lat/lon via Nominatim (OSM) |
| `country-info` | Country details from Wikipedia + Nominatim |
| `travel-advisory` | Safety advisories by country |
| `wikipedia-summary` | Wikipedia summary for any topic |
| `places-of-interest` | Tourist attractions from Wikipedia search |
| `route-distance` | Driving distance/time via OSRM |
| `public-holidays` | Public holidays from Nager.Date |
| `textstats` | Text character/word/sentence analysis |
| `demo` | End-to-end Fleet smoke test (workflow) |
| `city-briefing` | Weather + timezone + agent-composed briefing (workflow) |
| `inspect-members` | Reports on worker pair registration (workflow) |

## Directory structure

```
├── comm/                  HTTP adapters (Express, raw-http, Azure Functions)
├── host/                  Autonomous agent host
│   ├── strategies/        ReAct and Plan-Execute async generators
│   ├── prompts/           LLM prompt templates
│   ├── jobs/              Job queue backends + SQLite store
│   ├── notify/            SSE and webhook notification channels
│   ├── tools/             Tool registry + executor with timeout
│   └── chat/              Built-in chat UI
├── mcp/                   MCP tool server (registry, server builder, HTTP)
├── pool/                  Worker dispatch (pool, ephemeral, queue tiers)
├── transport/             Fleet stdio spawn + MCP client
├── tools/                 Python tool scripts
├── workflows/             Demo, city-briefing, inspect-members
└── host.config.mjs        Central configuration
```

## Configuration

All settings live in `host.config.mjs`:

```js
export default {
  name: 'apra-agent-kit',
  comm: { adapter: 'express' },        // or 'raw-http', 'azure-functions'
  modules: {
    runLoop: {
      strategy: 'plan-execute',         // or 'open-ended'
    },
    budgets: {
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      defaultPolicy: 'allow',
      policies: {},                     // per-tool: 'allow', 'deny', or 'approve'
    },
    dispatch: {
      backend: 'in-process',            // or 'durable' (requires azure-functions adapter)
      concurrency: 2,
    },
    notify: { sse: { enabled: true } },
    chat: { enabled: true },
  },
};
```

Key environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token for Fleet workers |
| `WORKER_POOL_SIZE` | `4` | Pre-provisioned doer/reviewer pairs |
| `WORKER_EPHEMERAL_MAX` | `10` | On-demand overflow pairs |
| `JOBS_CONCURRENCY` | `1` | Parallel worker loops |
| `JOBS_DB_PATH` | `./workdir/jobs.db` | SQLite database location |
| `PORT` | `3000` | Server listen port |

## Design decisions

**Two front doors, not one.** `/mcp` is for external AI that brings its own brain. `/task`
is for callers that want this server's brain. They share the same tool registry, worker pool,
and guardrails — the difference is who decides what to call.

**Fleet runs as a stdio child, not HTTP.** `spawnFleet()` launches `apra-fleet run --transport stdio`
and connects an MCP client. Every Fleet operation is one MCP tool call over stdin/stdout.

**Workers are registered at startup.** A fresh Fleet process starts empty. `MemberManager`
registers the pool roster (and ephemeral pairs on demand). Each member gets its own work
folder — two members sharing a folder will collide.

**`fleetApi` is injectable.** Both launchers accept a client and only spawn Fleet when one
isn't given. This makes mock tests possible with no Fleet binary, no members, and no token.

**Budgets are per-request.** Each `/task` creates a fresh budget, merging server defaults with
request overrides (stricter wins). Iteration count tracks LLM calls, not tool calls.

**Cancellation is cooperative.** In-process backends abort via `AbortSignal`. On Azure Durable
Functions, the activity polls `customStatus.cancelRequested` because DELETE may hit a different
instance.

**Backend pairing is enforced.** `in-process` (SQLite) pairs with `express` or `raw-http`.
`durable` requires `azure-functions`. Cross-pairing throws at startup.

## Further reading

| Document | Covers |
|---|---|
| [getting-started.md](getting-started.md) | Config, tools, run, deploy |
| [run-loop.md](run-loop.md) | Strategies, budgets, guardrails, `/task` API in detail |
| [jobs.md](jobs.md) | Async jobs: submit, poll, SSE, webhooks, cancellation |
| [concurrency.md](concurrency.md) | Worker pool, job queue, dispatch config |
| [mcp-interface.md](mcp-interface.md) | MCP tool catalog, registry contract |
| [chat-ui.md](chat-ui.md) | Chat page: theming, events, status pipeline |
| [deploy-azure-functions.md](deploy-azure-functions.md) | Azure Functions deployment |
| [development.md](development.md) | Setup, testing, adding workflows |
