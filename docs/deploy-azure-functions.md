# Deploy on Azure Functions

Run apra-agent-kit as a horizontally scalable agent on Azure Functions with the Durable Task backend.

## Supported and unsupported

**Supported:** Azure Functions **Premium** or **Dedicated** plan with a **custom Linux container** (`deploy/azure-functions/Dockerfile`). The container bundles Node 22, `apra-fleet`, Claude Code, and the full agent kit.

**Not supported:** Consumption plan. Durable orchestrations, unbounded activity duration (`functionTimeout: -1`), and a long-lived Fleet child process require Premium or Dedicated.

**MCP on Functions:** `POST /mcp` uses the MCP SDK's web-standard transport (`WebStandardStreamableHTTPServerTransport`), not the Express-specific handler used on the VM image.

## How it works

```text
HTTP trigger (POST /task)
  └─ durableClient.startNew(orchestrator, { input })
       └─ orchestrator (deterministic generator)
            ├─ callActivity(runTask)  ──► activity.mjs
            │                              └─ executeHostedTask → run loop
            ├─ waitForExternalEvent('progress')  ◄── raiseEvent from activity
            └─ waitForExternalEvent('cancel')      ◄── raiseEvent on DELETE (Running)

One Fleet child per Functions instance, spawned when comm/azure-functions/main.mjs loads.
Progress: activity calls client.raiseEvent('progress', { type, iteration, kind, ... }).
Cancel: DELETE → Pending → client.terminate; Running → raiseEvent('cancel') sets
        customStatus.cancelRequested; activity polls getStatus every pollMs.
Events: orchestrator keeps customStatus.events as a ring of 50 with stable seq
        (queued, started, settled always retained).
```

Any instance can answer `GET /jobs/:id` or `GET /jobs/:id/events` — the task hub is shared state.

## Image

Built from `deploy/azure-functions/Dockerfile`:

1. Base: `mcr.microsoft.com/azure-functions/node:4-node22`
2. Installs Fleet, Claude Code, Python tool deps
3. `npm ci --include=optional` (pulls `@azure/functions`, `durable-functions`)
4. Copies the repo; replaces `package.json` with `deploy/azure-functions/wwwroot-package.json` so `"main": "comm/azure-functions/main.mjs"`
5. Copies `comm/azure-functions/host.json` and `deploy/azure-functions/host.config.mjs`

**`host.json`:** `functionTimeout: -1`; task hub name from `%DURABLE_TASK_HUB%`; extension bundle 4.x.

**`host.config.mjs` in the image** replaces the repo config: `comm.adapter = 'azure-functions'`, `dispatch.backend = 'durable'`.

## App settings

| Setting | Required | Purpose |
|---|---|---|
| `AzureWebJobsStorage` | yes | Storage account connection for the Functions host and Durable hub |
| `DURABLE_TASK_HUB` | yes | Task hub name (must match `host.json`) |
| `JOBS_BACKEND` | yes | Set to `durable` |
| `WORKER_POOL_SIZE` | yes | Set to `0` — no pre-provisioned pool on Functions |
| `WORKER_EPHEMERAL_MAX` | yes | Max ephemeral doer/reviewer pairs per instance (e.g. `2`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | OAuth for LLM calls via Fleet |
| `JOBS_MAX_QUEUE_SIZE` | no | Queue depth before `429` (default `100`) |
| `DURABLE_POLL_MS` | no | Cancel poll and SSE refresh interval (default `2000`) |
| `WEBHOOK_ALLOW_HTTP` | no | **Never in production.** Dev only for `http:` callbacks |

## Local run

Same flow as CI — Azurite plus the Functions image:

```bash
docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable
BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e
docker compose -f docker-compose.e2e.yml --profile durable down -v
```

Azurite provides `AzureWebJobsStorage`. Routes are prefixed with `/api` inside the container.

For Azure Functions Core Tools on the host (without Docker), copy `comm/azure-functions/local.settings.json.example` to `local.settings.json` and fill in `AzureWebJobsStorage` and `CLAUDE_CODE_OAUTH_TOKEN`.

## Deploy

```bash
az acr build -r <registry> -t apra-agent-kit-functions:latest -f deploy/azure-functions/Dockerfile .
az functionapp create -g <rg> -n <app> -p <premium-plan> -s <storage> \
  --functions-version 4 --runtime node --image <registry>.azurecr.io/apra-agent-kit-functions:latest
az functionapp config appsettings set -g <rg> -n <app> --settings \
  JOBS_BACKEND=durable DURABLE_TASK_HUB=fleetjobs WORKER_POOL_SIZE=0 WORKER_EPHEMERAL_MAX=2 \
  CLAUDE_CODE_OAUTH_TOKEN=<token>
```

Scale to 2 instances and verify both answer `GET /jobs/:id` for the same job id — the task hub is authoritative.

## Limits and tuning

- **`budgets.timeoutMs`** vs **`dispatch.durable.maxActivityMs`**: Durable here does not enforce `maxActivityMs` (`host.json` sets `functionTimeout: -1`). `budgets.timeoutMs` is the actual run-loop limit. `maxActivityMs` is configuration only.
- **`pollMs`** (`DURABLE_POLL_MS`): lower values improve cancel and SSE latency but increase task-hub reads.
- **Event ring:** orchestrator keeps the last 50 events in `customStatus.events`; `queued`, `started`, and `settled` are always retained.
- **SSE idle cut:** Azure closes idle connections after ~230 s. The server emits `: ping` every 25 s; clients that disconnect reconnect with `Last-Event-ID` and miss nothing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extension bundle download slow or failing | Wait for cold start; Dockerfile healthcheck uses 90 s `start_period` |
| `AzureWebJobsStorage` connection errors | Verify storage account, connection string, and Azurite when local |
| Health check fails during cold start | First boot downloads extension bundle; allow up to 90 s |
| `Cannot find package '@azure/functions'` | Rebuild with `npm ci --include=optional` |
| `dispatch.backend "durable" requires comm.adapter "azure-functions"` | Wrong `host.config.mjs` in the image — use `deploy/azure-functions/host.config.mjs` |

See also [jobs.md](jobs.md) for the HTTP API and [architecture.md](architecture.md) for module layout.
