# Documentation

### Build an agent

| Document | Read it when |
|---|---|
| [getting-started.md](getting-started.md) | **Start here.** You want to build your own agent — configure it, add tools, run it, deploy it. No kit internals required. |
| [roadmap.md](roadmap.md) | You want to see what's shipped, in progress, and planned. |

### Understand the system

| Document | Read it when |
|---|---|
| [architecture.md](architecture.md) | You want the big picture: component diagram, how the layers fit, data flow, and design decisions. |
| [architecture-diagram.html](architecture-diagram.html) | Visual component diagram — open in a browser for the color-coded interactive version. |
| [development.md](development.md) | You are setting up, running tests, adding a workflow, or debugging a failure. |
| [mcp-interface.md](mcp-interface.md) | You are setting up or extending the MCP server — tool catalog, registry contract, timeouts, auth, and hosting. |
| [run-loop.md](run-loop.md) | You want the detailed reference for the autonomous run loop: strategies, budgets, guardrails, prompt templates, and the `/task` API. |
| [chat-ui.md](chat-ui.md) | You want the built-in chat page: enabling it, what the card shows, the console event log, and its limits. |
| [jobs.md](jobs.md) | Async jobs API: submit, poll, SSE, webhooks, cancellation, and MCP job tools. |
| [deploy-azure-functions.md](deploy-azure-functions.md) | Deploy the agent on Azure Functions Premium with the Durable jobs backend. |

### Specs

Design documents for features that have been implemented or proposed.

| Spec | Status | Covers |
|---|---|---|
| [specs/stdio-transport-spec.md](specs/stdio-transport-spec.md) | Implemented | Spawning Fleet over stdio (the current downstream transport). |
| [specs/concurrency-spec.md](specs/concurrency-spec.md) | Implemented | Original shared worker pool design (superseded by tiered dispatch). |
| [specs/2026-09-10-tiered-worker-dispatch-design.md](specs/2026-09-10-tiered-worker-dispatch-design.md) | Implemented | Tiered worker dispatch: pool + ephemeral + queue. |
| [specs/2026-09-09-fleet-agent-kit-spec.md](specs/2026-09-09-fleet-agent-kit-spec.md) | Implemented | Vision spec for the modular agent kit. |
| [specs/2026-09-11-fleet-agent-kit-phase1-spec.md](specs/2026-09-11-fleet-agent-kit-phase1-spec.md) | Implemented | Host layer: config, tools, communication adapter. |
| [specs/2026-09-16-fleet-agent-kit-phase2-spec.md](specs/2026-09-16-fleet-agent-kit-phase2-spec.md) | Implemented | Run loop, strategies, budgets, guardrails. |
| [specs/2026-09-17-fleet-agent-kit-phase4-spec.md](specs/2026-09-17-fleet-agent-kit-phase4-spec.md) | Implemented | Async jobs API, notifier, Durable backend, Azure Functions adapter. |
| [specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md](specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md) | Implemented | Built-in chat page over the job SSE stream. |
| [specs/2026-09-18-fleet-agent-kit-phase3-memory-eval-spec.md](specs/2026-09-18-fleet-agent-kit-phase3-memory-eval-spec.md) | Approved | Memory (3 kinds) + eval harness. |
| [specs/2026-09-21-travel-agent-output-quality-spec.md](specs/2026-09-21-travel-agent-output-quality-spec.md) | Implemented | Prompt overhaul + new tools for travel agent quality. |

The [root README](../README.md) is the homepage: what the kit is, how to build an agent, and how to contribute.
