<p align="center">
  <img src="docs/apra-agent-kit-banner.png" alt="apra-agent-kit" />
</p>

A modular toolkit for building agents on [Apra Fleet](https://github.com/Apra-Labs/apra-fleet).
Enable the modules you need, write your tools and workflows, ship an agent.

**Minimal** — tool server. An external caller (Claude Code, another agent, a UI) does the
reasoning and calls tools directly via MCP.

**Full agent** — all modules enabled. The agent receives a task, plans, executes, observes,
replans, and returns a result autonomously.

**Custom** — any combination. Tools + guardrails but no planner, tools + budgets but no
memory, etc.

One container runs one agent. Scaling is horizontal: more containers, each with its own
agent.

<table align="center"><tr>
<td><img src="docs/chat-plan-steps.png" alt="Chat UI — plan with 9 tool steps" width="400" /></td>
<td><img src="docs/chat-answer.png" alt="Chat UI — final travel itinerary" width="400" /></td>
</tr><tr>
<td align="center"><em>9-step travel plan</em></td>
<td align="center"><em>Final itinerary</em></td>
</tr></table>

## Build your own agent

**[Getting Started Guide](docs/getting-started.md)** — configure, add tools, run, and
deploy your agent. No kit internals required.

### Quick start

```bash
git clone https://github.com/dsiddharth2/apra-agent-kit.git
cd apra-agent-kit
npm install
```

**Prerequisites:** Node.js 22.16+, Python 3, Apra Fleet (`npm install -g @apralabs/apra-fleet && apra-fleet install`)

**1. Configure** your agent in `host.config.mjs` — name, description, strategy, tools, budget limits.

**2. Add tools** — write a Python script in `tools/`, register it in `mcp/registry.mjs`.

**3. Run it:**

```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
node host/index.mjs
```

Open `http://localhost:3000/chat` — your agent is live.

Or with Docker:
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

### Use it

```bash
# Chat UI
open http://localhost:3000/chat

# Submit a task via API
curl -sX POST localhost:3000/task -H "content-type: application/json" \
  -d '{"goal":"What is the weather in Tokyo?"}'

# Stream progress
curl -N localhost:3000/jobs/<jobId>/events

# Connect via MCP
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp
```

See [docs/jobs.md](docs/jobs.md) for the full API. To deploy on Azure Functions with
horizontal scale, see [docs/deploy-azure-functions.md](docs/deploy-azure-functions.md).

---

## Contribute to the kit

### Testing

```bash
npm test    # mock tests — no Fleet binary, no tokens needed
```

### Docs

**For agent builders:**

| Document | Covers |
|---|---|
| **[docs/getting-started.md](docs/getting-started.md)** | **Config, tools, run, deploy — start here** |
| [docs/chat-ui.md](docs/chat-ui.md) | Chat page: theming, status pipeline, event stream |
| [docs/jobs.md](docs/jobs.md) | Async jobs: submit, poll, SSE, webhooks, cancellation |
| [docs/deploy-azure-functions.md](docs/deploy-azure-functions.md) | Azure Functions Premium deployment with Durable backend |

**For kit contributors:**

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layers, module map, data flow, design decisions |
| [docs/development.md](docs/development.md) | Setup, testing, adding workflows, conventions |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract, timeouts, auth |
| [docs/run-loop.md](docs/run-loop.md) | Autonomous agent: strategies, budgets, guardrails, `/task` API |
| [docs/concurrency.md](docs/concurrency.md) | Parallel task execution: worker pool, job queue, config, testing |
