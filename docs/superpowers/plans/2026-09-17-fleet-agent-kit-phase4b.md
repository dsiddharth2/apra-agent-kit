# Fleet Agent Kit — Phase 4b Implementation Plan

## Azure adapters + CI + documentation

**Prerequisite:** Phase 4a must be merged. Phase 4b builds on the jobs backend, comm
contract, and notifier that 4a ships.

**Goal:** The same agent runs unchanged on Azure Functions (Premium plan) with jobs
persisted by Durable Functions. E2e tests run in CI against both VM and Azure containers.
Documentation covers the full Phase 4 surface.

**Scope — Tasks from the full Phase 4 plan:**

| Task | What | Steps |
|------|------|-------|
| 11 | Durable Functions jobs backend | 8 |
| 12 | Azure Functions adapter + orchestrator + activity | 12 |
| 13 | Scripted fleet switch + e2e suite | 9 |
| 14 | Docker: e2e compose + Functions Dockerfile | 5 |
| 16 | CI workflows | 4 |
| 17 | Documentation | 5 |
| — | **Total** | **~43** |

**Source plan:** `docs/superpowers/plans/2026-09-17-fleet-agent-kit-phase4.md`

---

## Execution order

### Batch 1: Durable Functions backend (Task 11)

Implements the same jobs backend contract as the in-process backend, but delegates
queueing and persistence to Azure Durable Functions. Uses `durable-functions` v3
(lazy-loaded). Tested against Azurite.

---

### Batch 2: Azure Functions adapter (Task 12)

Framework-neutral comm adapter for `@azure/functions` v4. Orchestrator function
starts jobs, activity function runs the task executor. Web-standard MCP transport
if available, else custom adapter. Tested with the Azurite emulator.

---

### Batch 3: E2e test infrastructure (Tasks 13, 14)

**Task 13** — Scripted fleet (mock that runs in Docker without a real Fleet binary) +
SSE test helper + black-box e2e suite that drives `/task` over HTTP.

**Task 14** — `docker-compose.e2e.yml` with VM and Durable profiles.
`Dockerfile.functions` for the Azure Functions container image.

---

### Batch 4: CI + docs (Tasks 16, 17)

**Task 16** — GitHub Actions workflows: `ci-e2e.yml` runs the e2e suite against both
containers on every PR. Updates `ci-host.yml` to include Phase 4 test scripts.

**Task 17** — Documentation updates: architecture.md, development.md, phase2-run-loop.md
(rename to cover Phase 4), mcp-interface.md (new tools), and a deployment guide.

---

## What ships

After Phase 4b, the agent deploys to Azure Functions on a Premium plan with:
- Durable Functions job persistence (no SQLite needed)
- The same `/task`, `/jobs`, `/mcp` endpoints
- E2e tests in CI against both VM and Azure containers
- Full documentation
