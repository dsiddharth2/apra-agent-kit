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

<p align="center">
  <img src="docs/chat-plan-steps.png" alt="Chat UI — plan with 9 tool steps" width="420" />
  <img src="docs/chat-answer.png" alt="Chat UI — final travel itinerary" width="420" />
</p>
<p align="center"><em>Chat UI: a 9-step travel plan (left) and the final itinerary (right)</em></p>

## Quick start

```bash
git clone https://github.com/dsiddharth2/apra-agent-kit.git
cd apra-agent-kit
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

## Without Docker

```bash
npm install -g @apralabs/apra-fleet && apra-fleet install
npm install
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
npm run mcp
```

## Testing

```bash
npm test    # mock tests — no Fleet binary, no tokens needed
```

## Docs

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layers, module map, data flow, design decisions |
| [docs/development.md](docs/development.md) | Setup, testing, adding workflows, conventions |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract, timeouts, auth |
| [docs/run-loop.md](docs/run-loop.md) | Autonomous agent: strategies, budgets, guardrails, `/task` API |
| [docs/chat-ui.md](docs/chat-ui.md) | Built-in chat page: turn on `modules.chat`, open `/chat` |
| [docs/concurrency.md](docs/concurrency.md) | Parallel task execution: worker pool, job queue, config, testing |
