# Roadmap

What's built, what's next, and what's on the horizon.

Last updated: 2026-09-23

## Shipped

These are live in the kit today.

| Feature | Status | Spec |
|---------|--------|------|
| Stdio transport (Fleet over MCP) | Done | [stdio-transport-spec](specs/stdio-transport-spec.md) |
| MCP tool server (`/mcp` endpoint) | Done | [mcp-interface](mcp-interface.md) |
| Host layer + config system | Done | [phase1-host-layer-spec](specs/phase1-host-layer-spec.md) |
| Run loop + strategies (ReAct, Plan-Execute) | Done | [phase2-run-loop-spec](specs/phase2-run-loop-spec.md) |
| Budgets (iteration, cost, token, time caps) | Done | [run-loop](run-loop.md) |
| Guardrails (per-tool policies, sandbox, dry-run) | Done | [run-loop](run-loop.md) |
| Tiered worker dispatch (pool + ephemeral + queue) | Done | [tiered-worker-dispatch-spec](specs/tiered-worker-dispatch-spec.md) |
| Async jobs API (SQLite queue, SSE, webhooks) | Done | [phase4-jobs-durable-spec](specs/phase4-jobs-durable-spec.md) |
| Azure Durable Functions backend | Done | [deploy-azure](deploy-azure-functions.md) |
| Chat UI | Done | [chat-ui-spec](specs/chat-ui-spec.md) |
| 12 Python tools (weather, geocode, currency, forecast, etc.) | Done | — |
| Communication adapters (Express, raw-http, Azure Functions) | Done | — |
| Travel agent output quality (prompts + 2 new tools) | Done | [travel-agent-quality-spec](specs/travel-agent-quality-spec.md) |
| Strategy auto-router | Done | [strategy-router-spec](specs/2026-09-21-strategy-router-spec.md) |
| `npm create` scaffolding CLI | Done | [create-command-spec](specs/create-command-spec.md) |
| Agent-builder skill (`/agent-builder`) | Done | [agent-builder-spec](specs/2026-09-22-agent-builder-skill-spec.md) |
| Trace IDs (end-to-end correlation) | Done | [CONTRACT](CONTRACT.md) |
| Kill switch (disable all writes without redeploy) | Done | [CONTRACT](CONTRACT.md) |
| Concurrency acceptance tests | Done | [concurrency](concurrency.md) |

## In Progress

| Feature | Status | Notes |
|---------|--------|-------|
| `npm create` — npm registry publish | Pending | The create CLI works from the GitHub repo (`npx github:dsiddharth2/workflow-kit`). Publish to npm as `@dsiddharth2/create-fleet-agent` so `npm create @dsiddharth2/fleet-agent` works without the GitHub specifier. |

## Next Up — Phase 3: Memory + Eval

Specced and approved, not yet implemented. See [phase3-memory-eval-spec](specs/phase3-memory-eval-spec.md).

### Memory (three kinds)

Conflating these is the most common agent design mistake:

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

Features identified from the vision and codebase gaps. Not yet specced.

### Connectors (LLM Providers)

The kit currently provisions Claude Code instances via Fleet. To support more providers:

| Connector | What it does | Priority |
|-----------|-------------|----------|
| **OpenAI** | Register members backed by GPT-4o / o3. Route cheaper reasoning steps to OpenAI, keep complex planning on Claude. | High |
| **Azure OpenAI** | Same as OpenAI but through Azure endpoints — needed for enterprise deployments with data residency. | High |
| **Gemini** | Google's models as an alternative provider. Register members backed by Gemini. | Medium |
| **Ollama / Local models** | Self-hosted models for air-gapped environments or cost-sensitive workloads. | Medium |
| **Cursor** | The PPT notes Fleet can register Cursor as a member type. | Low |

This requires abstracting the LLM interface so `fleetApi.executePrompt()` routes to the right provider based on the member's type. The dispatcher already manages doer/reviewer pairs — each pair could use a different provider.

Cost optimization: route simpler reasoning steps to cheaper models (e.g. GPT-4o-mini for argument resolution) and reserve expensive models (Claude Opus) for complex planning.

### Communication layer improvements

Four doors, one room — none of them should live inside the agent:

| Door | Status | What's needed |
|------|--------|---------------|
| Chat input (person types) | Done | Chat UI ships today |
| Queue (another service sends) | Partial | Job queue exists; needs Redis Streams consumer group for production dispatch |
| Schedule (cron fires) | Not started | Azure cron job or Logic App → calls `/task` endpoint. Needs overlap policy and idempotency key |
| MCP (another agent calls) | Done | `/mcp` endpoint ships today |

### Authentication

The auth injection point exists (`mcp/auth.mjs`) and `getting-started.md` documents how to plug in a custom authenticator. Still needed:

- A shipped middleware implementation (API key or OAuth bearer token validation)
- Rate limiting per caller
- Auth for the chat UI (currently always unauthenticated)

### Task triage

A triage layer at the chat/input boundary should classify: question vs task vs too vague:
- "What is our leave policy?" → one model call, no agent needed
- "Find the mismatched invoices" → many steps, several tools, agent needed

The strategy auto-router classifies between workflows, open-ended, and plan-execute — but doesn't yet distinguish "no agent needed" questions from agent-worthy tasks.

### Observability

Trace IDs are shipped (end-to-end correlation from request through run loop). Still needed:

- Structured logging for run loop iterations
- Cost tracking dashboard (per-run budgets exist; trend/alert across runs does not)
- Latency breakdowns per tool call
- Error rate monitoring

### Safety and provenance

Kill switch is shipped (disable all writes across a deployment without a redeploy). Still needed:

- **Provenance convention for agent-written data** — mark records created by the agent so they're distinguishable from human-created ones. Cannot be retrofitted after records are written.

## Future / Exploration

These are longer-term ideas, not committed.

| Idea | Notes |
|------|-------|
| Redis Streams dispatch | Production-grade consumer groups; workers claim messages, ack on completion, unacked work reclaimed on death |
| Human-in-the-loop approval | For irreversible actions — the guardrails layer already classifies reversibility |
| Agent-to-agent communication | One agent calling another agent's `/task` endpoint as a tool |
| Horizontal scaling patterns | Documentation and examples for multi-container deployments |
| Plugin system | Third-party tool packages that register into the MCP catalog |
| API-only agents (no Fleet) | For tasks that are pure API calls with no filesystem — Fleet binding is vestigial for these |
