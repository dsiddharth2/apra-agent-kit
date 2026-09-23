<p align="center">
  <img src="docs/apra-agent-kit-banner.png" alt="apra-agent-kit" />
</p>

<h3 align="center">A modular toolkit for building autonomous AI agents on <a href="https://github.com/Apra-Labs/apra-fleet">Apra Fleet</a></h3>

<p align="center">
  <a href="https://github.com/dsiddharth2/apra-agent-kit/actions/workflows/ci.yml"><img src="https://github.com/dsiddharth2/apra-agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.16-brightgreen" alt="Node.js >= 22.16" />
  <img src="https://img.shields.io/badge/platform-Fleet-blue" alt="Platform: Apra Fleet" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" />
  <img src="https://img.shields.io/badge/PRs-welcome-orange" alt="PRs welcome" />
</p>

<p align="center">
  <a href="#write-your-own-agent"><strong>Write Your Own Agent</strong></a> · 
  <a href="#contributing"><strong>Contribute</strong></a> · 
  <a href="docs/architecture.md"><strong>Architecture</strong></a> · 
  <a href="docs/roadmap.md"><strong>Roadmap</strong></a>
</p>

---

## Write Your Own Agent

### Quick Start

Scaffold a new agent project from this repository:

```bash
npx --yes github:dsiddharth2/workflow-kit my-agent
cd my-agent
```

> **Note:** The package is not yet published to npm. The command above installs
> directly from the GitHub repository.

The command copies the kit, writes a starter workflow, and offers to install
Fleet and the Claude CLI. It explains each step before it asks.

Then set the token and start the server:

**Bash / macOS / Linux:**
```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
node host/index.mjs
```

**PowerShell (Windows):**
```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"
node host/index.mjs
```

Open [http://localhost:3000/chat](http://localhost:3000/chat) — your agent is live.

Or with Docker:
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

The MCP server listens on `http://localhost:3000/mcp`. Register it with Claude Code:

```bash
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp
```

Run `npm run doctor` in your project at any time to see what is missing.

---

### The Agent Builder Skill

The fastest way to go from an idea to a running agent. Instead of manually
writing config, tools, and registry entries, the **agent-builder** skill walks
you through the entire process interactively.

In Claude Code, type:

```
/agent-builder
```

The skill runs four phases:

| Phase | What happens |
|-------|-------------|
| **Interview** | 4 rounds of structured questions about what your agent does, its domain, tools, workflow shape, and Fleet members. Then a Socratic grilling phase probes edge cases and failure modes. |
| **Spec** | A complete agent specification is written to `docs/specs/`. Every section is filled — no TODOs or blanks. |
| **Plan** | A task-by-task implementation plan is written to `docs/plans/`, covering tools, workflows, registry, host config, system prompt, tests, and deployment — in the correct build order. |
| **Build** | Choose how to execute: subagent-driven development (current session), Fleet Sprint (parallel agents), or build it yourself from the plan. |

The guided path handles things that are easy to forget when building manually:

- **Host configuration** — sets up `host.config.mjs` with the right strategy,
  modules, and an `agentDescription` that steers the LLM to use your tools
- **API key propagation** — `executeCommand` doesn't inherit env vars from the
  parent shell; the plan shows how to pass keys through
- **Session cleanup** — clears stale Fleet worker sessions before integration
  testing so the agent starts fresh

After the build completes, your agent is ready to run.

---

### Configuration

Your agent's identity and behavior are defined in a single file: `host.config.mjs`.

```js
export default {
  name: 'my-agent',
  description: 'Short label for logs and the chat header.',
  agentDescription: `You are a helpful assistant that...
This is the system prompt the LLM sees. Be specific about what the agent
knows, what tools to use, and any domain-specific rules.`,

  fleet: {},

  comm: {
    adapter: 'express',       // 'express' for local/VM, 'azure-functions' for Azure
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',   // or 'open-ended'
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
      timeoutMs: 600_000,         // 10 minutes
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,          // set true to test without executing
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
    chat: {
      enabled: true,
      title: 'My Agent',
      themes: ['blue'],           // 'apra', 'blue', or both for a toggle
    },
  },
};
```

#### Key configuration fields

| Field | What it does |
|---|---|
| `name` | Agent identity — shown in logs, chat header, and system prompt |
| `description` | Short label for the chat UI title and log output |
| `agentDescription` | **The agent's personality and domain knowledge.** Injected into the system prompt. Multi-line template literal. |
| `comm.adapter` | `'express'` (local/Docker) or `'azure-functions'` |
| `modules.runLoop.strategy` | `'plan-execute'` (multi-step, reviewed) or `'open-ended'` (simple lookup agents) |
| `modules.budgets.*` | Cost and safety limits per task |
| `modules.guardrails.defaultPolicy` | `'allow'`, `'deny'`, or `'approve'` (human-in-the-loop) |
| `modules.dispatch.concurrency` | Max parallel tasks |
| `modules.chat.themes` | `['blue']`, `['apra']`, or `['blue', 'apra']` for a toggle |

#### Choosing a strategy

| Strategy | When to use |
|---|---|
| `plan-execute` | Most agents. The LLM creates a plan, a reviewer approves it, then steps execute one at a time. Replans on failure. Safer and auditable. |
| `open-ended` | Simple lookup agents. Act → observe → repeat with no upfront plan. Faster for single-tool tasks, less control. |

#### Adding tools

A tool is a script (Python, Node, or any executable) plus a registry entry:

1. Write the implementation in `tools/your-tool/your_tool.py`
2. Register it in `mcp/registry.mjs` with a name, description, input schema, and `run()` function
3. Restart the host

See the full **[Getting Started guide](docs/getting-started.md)** for tool patterns,
authentication, MCP integration, Azure Functions deployment, and environment variables.

#### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (required) | Fleet worker authentication |
| `PORT` | `3000` | HTTP listen port |
| `WORKER_POOL_SIZE` | `4` | Persistent worker count |
| `WORKER_EPHEMERAL_MAX` | `10` | Max ephemeral workers for burst |
| `CHAT_ENABLED` | from config | Override chat on/off (`true`/`false`) |

---

## What is the Agent Kit?

An agent takes in a task and gets it over the finish line. Everything else — chat, MCP,
schedules, queues — is a door into that one function.

This kit gives you that function, pre-wired with everything a production agent needs:

<p align="center">
  <img src="docs/architecture-diagram.svg" alt="Architecture component diagram" />
</p>

**Three operating modes:**

- **Full Agent** — receives a task at `POST /task`, plans, executes tools, observes results,
  replans on failure, returns autonomously
- **Tool Server** — external AI (Claude Code, Cursor, another agent) drives reasoning,
  calls tools via MCP at `POST /mcp`
- **Custom** — enable only the modules you need

One container runs one agent. Scaling is horizontal: more containers, each with its own agent.

<table align="center"><tr>
<td><img src="docs/chat-plan-steps.png" alt="Chat UI — plan with 9 tool steps" width="400" /></td>
<td><img src="docs/chat-answer.png" alt="Chat UI — final travel itinerary" width="400" /></td>
</tr><tr>
<td align="center"><em>9-step travel plan</em></td>
<td align="center"><em>Final itinerary</em></td>
</tr></table>

---

## What an agent is made of

A task goes in, a result comes out. Six parts inside the boundary make that happen.

<p align="center">
  <img src="docs/agent-anatomy.svg" alt="Agent anatomy — 6 parts inside the boundary" />
</p>

| # | Part | What it does | Status |
|---|------|-------------|--------|
| 1 | **Run Loop** | The core. Decides the next step and calls tools until done. Two strategies: **ReAct** (decide each turn) and **Plan-Execute** (plan upfront, replan on failure). | Shipped |
| 2 | **Memory** | Three kinds: working context (what's in the LLM window), run state (crash recovery), long-term (cross-run facts). | Working context shipped. Run state + long-term in Phase 3. |
| 3 | **Workflows** | Known sequences written as plain code and exposed as tools. If you already know the steps, don't make the agent figure them out. | Shipped |
| 4 | **Tools** | Typed schemas, model-facing descriptions. Errors are returned, not thrown. 15 Python tools ship out of the box. | Shipped |
| 5 | **Budgets & Stops** | Iteration cap (25), cost ceiling ($5), token limit (500K), wall-clock timeout (10 min), explicit definition of done. | Shipped |
| 6 | **Guardrails** | Per-tool allow/deny policies, reversibility classification, filesystem sandboxing, input validation, dry-run mode. | Shipped |
| — | **Evals** | Sits outside the boundary — a harness that calls the whole box and grades what comes out. 20-50 real tasks with graded outcomes. | Phase 3 |

---

## How the System Works

A task enters through one of four doors (the communication layer), hits the agent's run
loop, and comes out as a result. See the full
**[Architecture Guide](docs/architecture.md)** for details.

**The run loop** picks a strategy:
- **Plan-Execute** — doer writes a plan, reviewer approves it, steps execute one by one.
  If a step fails, it replans. Best for multi-step tasks.
- **ReAct (Open-Ended)** — decides what to do next each turn based on what just happened.
  Handles surprises. Costs more.

**The worker pool** manages Claude Code instances in three tiers: 4 pre-provisioned pairs,
up to 10 ephemeral overflow pairs, then a wait queue.

**The job queue** handles async tasks with real-time progress via SSE and webhook callbacks.
Two backends: SQLite (local/Docker) or Azure Durable Functions (cloud).

| Document | Covers |
|---|---|
| **[docs/architecture.md](docs/architecture.md)** | Component diagram, layers, data flow, design decisions |
| [docs/run-loop.md](docs/run-loop.md) | Strategies, budgets, guardrails, `/task` API |
| [docs/jobs.md](docs/jobs.md) | Async jobs: submit, poll, SSE, webhooks, cancellation |
| [docs/concurrency.md](docs/concurrency.md) | Worker pool, job queue, dispatch config |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract |
| [docs/chat-ui.md](docs/chat-ui.md) | Chat page: theming, events, status pipeline |
| [docs/deploy-azure-functions.md](docs/deploy-azure-functions.md) | Azure Functions deployment |

---

## Contributing

We welcome contributions. Here's how:

### Working on the kit itself

Clone this repository instead of scaffolding:

```bash
git clone https://github.com/dsiddharth2/workflow-kit.git
cd workflow-kit && npm install
```

### Fork and PR workflow

1. **Fork** the repo on GitHub
2. **Clone** your fork: `git clone https://github.com/<you>/workflow-kit.git`
3. **Create a branch**: `git checkout -b feature/your-feature`
4. **Make your changes** — follow the conventions in [docs/development.md](docs/development.md)
5. **Run tests**: `npm test` (mock tests — no Fleet binary or tokens needed)
6. **Push** to your fork: `git push origin feature/your-feature`
7. **Open a PR** against `main`

### What to contribute

- **New tools** — write a Python script, register it in the catalog
- **Bug fixes** — especially around edge cases in the run loop or job queue
- **Documentation** — improvements, examples, tutorials
- **Tests** — more mock tests for strategies, guardrails, budgets
- **New strategies** — implement a different planning/execution approach

See [docs/development.md](docs/development.md) for the full setup, testing guide, and conventions.

---

## Roadmap

See the full **[Roadmap](docs/roadmap.md)** for what's shipped, in progress, and planned.

**Recently shipped:**
- Strategy auto-router — classifies tasks and routes to the right strategy automatically
- `npm create` scaffolding CLI — scaffold a new agent project in one command
- Agent-builder skill (`/agent-builder`) — interview → spec → plan → build
- Trace IDs and kill switch — end-to-end correlation and emergency write disable

**Next up — Phase 3: Memory + Eval**
- Three kinds of memory: working context, run state, long-term
- Eval harness: 20-50 real tasks with graded outcomes, runs on every prompt/model change

---

## FAQ

**Q: Do I need Apra Fleet installed to run tests?**
No. `npm test` uses mock Fleet clients — no binary, no members, no OAuth token required.
You only need Fleet installed to run the agent live.

**Q: What's the difference between `/mcp` and `/task`?**
`/mcp` is for external AI that brings its own brain — it picks tools from the catalog and
calls them. `/task` is for callers that want this agent's brain — it plans and executes
autonomously. Both share the same tools, worker pool, and guardrails.

**Q: Can I use OpenAI or other providers instead of Claude?**
Fleet supports registering members with different LLM providers. The kit's architecture
doesn't lock you into Claude — though today the worker pool provisions Claude Code instances.
Multi-provider support is on the roadmap.

**Q: How much does a task cost?**
Depends on the task complexity and strategy. Budget defaults cap at $5 per task, 500K tokens,
and 25 LLM iterations. You can override these per-request or in config. A typical 5-tool
travel briefing costs around $0.50-1.00.

**Q: What happens if the agent crashes mid-task?**
On restart, the in-process job backend fails any `processing` jobs (marks them failed) and
re-queues any `queued` jobs. Run-state memory for crash resumption is coming in Phase 3.

**Q: Can I run multiple agents?**
Yes. One container runs one agent. Scale horizontally with more containers, each configured
for a different domain (travel agent, data agent, etc.) or as replicas of the same agent.

**Q: Why Python for tools instead of JavaScript?**
Tools run via `fleetApi.executeCommand()` on a Fleet member's machine — they're shell commands,
not imported modules. Python was chosen because most data/API scripts are simpler in Python
with stdlib (`urllib`, `json`, `sys`). You can write tools in any language that reads args
from `sys.argv` and prints JSON to stdout.

**Q: How do I deploy to production?**
Two paths: Docker Compose on a VM (uses Express + SQLite backend), or Azure Functions Premium
(uses Durable Functions backend for managed scaling). See
[docs/deploy-azure-functions.md](docs/deploy-azure-functions.md).

**Q: What's the difference between workflows and agent reasoning?**
If you already know the steps, write a workflow (plain code, exposed as a tool). It's faster,
cheaper, and predictable. Use the agent for tasks where the path is unknown — it decides each
step from what happened. Bad pattern: an agent walking a fixed sequence you already knew.

---

## License

MIT
