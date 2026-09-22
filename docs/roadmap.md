# Roadmap

What's built, what's next, and what's on the horizon.

Last updated: 2026-09-22

## Shipped

These are live in the kit today.

| Feature | Status | Spec |
|---------|--------|------|
| Stdio transport (Fleet over MCP) | Done | [stdio-transport-spec](specs/stdio-transport-spec.md) |
| MCP tool server (`/mcp` endpoint) | Done | [mcp-interface](mcp-interface.md) |
| Host layer + config system | Done | [phase1-spec](specs/2026-09-11-fleet-agent-kit-phase1-spec.md) |
| Run loop + strategies (ReAct, Plan-Execute) | Done | [phase2-spec](specs/2026-09-16-fleet-agent-kit-phase2-spec.md) |
| Budgets (iteration, cost, token, time caps) | Done | [run-loop](run-loop.md) |
| Guardrails (per-tool policies, sandbox, dry-run) | Done | [run-loop](run-loop.md) |
| Tiered worker dispatch (pool + ephemeral + queue) | Done | [tiered-dispatch](specs/2026-09-10-tiered-worker-dispatch-design.md) |
| Async jobs API (SQLite queue, SSE, webhooks) | Done | [phase4-spec](specs/2026-09-17-fleet-agent-kit-phase4-spec.md) |
| Azure Durable Functions backend | Done | [deploy-azure](deploy-azure-functions.md) |
| Chat UI | Done | [chat-ui-spec](specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md) |
| 15 Python tools (weather, geocode, currency, etc.) | Done | — |
| Communication adapters (Express, raw-http, Azure Functions) | Done | — |
| Travel agent output quality (prompts + 2 new tools) | Done | [output-quality-spec](specs/2026-09-21-travel-agent-output-quality-spec.md) |

## In Progress

| Feature | Status | Notes |
|---------|--------|-------|
| Strategy auto-router | Design | Classifies tasks and picks the best strategy (ReAct vs Plan-Execute) automatically instead of static config. Branch: `feature/strategy-auto-router` |

## Next Up — Phase 3: Memory + Eval

Specced and approved, not yet implemented. See [phase3-spec](specs/2026-09-18-fleet-agent-kit-phase3-memory-eval-spec.md).

### Memory (three kinds)

The PPT calls out that conflating these is the most common agent design mistake:

| Kind | What it is | Priority |
|------|-----------|----------|
| **Working context** | What's in the LLM window during a run. Needs a compaction plan or long runs degrade. | High — runs already suffer on complex tasks |
| **Run state** | Checkpoint that lets a crash resume. Pair with idempotency keys. | High — critical for distributed workers |
| **Long-term memory** | Facts carried across separate runs. | Low — most task agents don't need this early |

### Eval harness

The piece teams regret skipping. The agent is the thing under test, unchanged.

- 20-50 real tasks with graded outcomes
- Run on every prompt or model change
- Compares results, never inspects internals
- Ships in the kit — or nobody adds it later

## Planned

Features identified from the PPT vision and codebase gaps. Not yet specced.

### Communication layer improvements

The PPT describes "four doors, one room" — none of them should live inside the agent:

| Door | Status | What's needed |
|------|--------|---------------|
| Chat input (person types) | Done | Chat UI ships today |
| Queue (another service sends) | Partial | Job queue exists; needs Redis Streams consumer group for production dispatch |
| Schedule (cron fires) | Not started | Azure cron job or Logic App → calls `/task` endpoint. Needs overlap policy and idempotency key |
| MCP (another agent calls) | Done | `/mcp` endpoint ships today |

### Authentication

- Real auth middleware for `/task` and `/mcp` endpoints (currently a pass-through stub)
- API key or OAuth bearer token validation
- Rate limiting per caller

### Task triage

The PPT distinguishes questions from tasks:
- "What is our leave policy?" → one model call, no agent needed
- "Find the mismatched invoices" → many steps, several tools, agent needed

A triage layer at the chat/input boundary should classify: question vs task vs too vague, and route accordingly.

### Workflow-as-tool pattern

The PPT's key insight: if you already know the steps, write it as plain code and expose it to the agent as a tool. The kit already supports this pattern but needs:
- More examples of deterministic workflows exposed as tools
- Documentation on when to use workflows vs agent reasoning
- Templates for common workflow patterns

### Multi-provider support

The PPT notes: "We can use Claude or OpenAI or Cursor in the same workflow because we can register members that way."
- Abstract the LLM interface so workers can be backed by different providers
- Cost optimization by routing simpler steps to cheaper models

### Observability

- Structured logging for run loop iterations
- Cost tracking dashboard
- Latency breakdowns per tool call
- Error rate monitoring

## Future / Exploration

These are longer-term ideas, not committed.

| Idea | Notes |
|------|-------|
| Redis Streams dispatch | Production-grade consumer groups; workers claim messages, ack on completion, unacked work reclaimed on death |
| Human-in-the-loop approval | For irreversible actions — the guardrails layer already classifies reversibility |
| Agent-to-agent communication | One agent calling another agent's `/task` endpoint as a tool |
| Horizontal scaling patterns | Documentation and examples for multi-container deployments |
| Plugin system | Third-party tool packages that register into the MCP catalog |
| API-only agents (no Fleet) | For tasks that are pure API calls with no filesystem — the PPT notes Fleet binding is vestigial for these |
