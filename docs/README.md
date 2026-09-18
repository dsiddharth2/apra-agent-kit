# Documentation

| Document | Read it when |
|---|---|
| [architecture.md](architecture.md) | You want to understand what this repo is, how the layers fit together, and why the non-obvious decisions were made. Includes a primer on Fleet concepts. |
| [development.md](development.md) | You are setting up, running tests, adding a workflow, or debugging a failure. |
| [mcp-interface.md](mcp-interface.md) | You are setting up or extending the MCP server — tool catalog, registry contract, timeouts, auth, and hosting. |
| [run-loop.md](run-loop.md) | You want the detailed reference for the autonomous run loop: strategies, budgets, guardrails, prompt templates, and the `/task` API. |
| [chat-ui.md](chat-ui.md) | You want the built-in chat page: enabling it, what the card shows, the console event log, and its limits. |

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
| [specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md](specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md) | Implemented | Built-in chat page over the job SSE stream. |

The [root README](../README.md) is the quickstart: prerequisites, provisioning, and the commands to run things.
