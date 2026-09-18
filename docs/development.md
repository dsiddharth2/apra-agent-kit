# Development guide

Day-to-day workflow for people writing code in this repo: getting set up, running
things, testing, and adding a workflow. For how the pieces fit together and why, read
[architecture.md](architecture.md) first.

## First-time setup

You need Node **22.16+**, `python3` on PATH for the tool scripts, and the
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI if you want live
`agent()` calls.

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install
```

`apra-fleet start` is not required. Launchers spawn `apra-fleet run --transport stdio`
for the duration of a run.

Then, in the repo:

```bash
npm install
```

`npm install` does **not** install Fleet's workflow packages. `@apralabs/apra-fleet-workflow`
resolves at runtime through a symlink created automatically by `ensureApralabs()`. It
checks `~/.apra-fleet/node_modules/@apralabs` first, then falls back to the npm global
prefix. Fleet is a machine install, not a project dependency.

### Members and OAuth

Node registers pool members (`WORKER-{i}-DOER` / `-REVIEWER`) when the dispatcher
starts. Workflows address `'doer'` and `'reviewer'` on the leased pair. Live
`agent()` calls need `CLAUDE_CODE_OAUTH_TOKEN` in the environment so
`MemberManager` can attach it via `provision_llm_auth`:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
```

There is no provisioning script on the startup path. Docker's entrypoint only
installs deps and execs Node; registration happens in `pool/member-manager.mjs`.

Re-export a fresh token when you see `OAuth session expired`.

If `apra-fleet` is not on PATH, set `APRA_FLEET_BIN` to the binary.

## Running things

| Command | Needs Fleet? | Needs token? |
|---|---|---|
| `npm test` | no | no |
| `npm run test:host` | no | no |
| `node workflows/demo/main.mjs` | yes | yes |
| `node workflows/city-briefing/main.mjs [city]` | yes | yes |
| `npm run mcp` | yes | only for demo |
| `node host/index.mjs` | yes | yes |
| `node --test tests/stdio-fleet.live.test.mjs` | yes (skips otherwise) | no |
| `node --test tests/demo.live.test.mjs` | yes | yes |
| `node tests/load-test.mjs --tool <name> --concurrency <n>` | no | no |
| `python3 tools/weather/weather.py [city]` | no | no |
| `npm run test:phase4` | no | no |
| `npm run test:acceptance` | yes | yes |
| `npm run test:e2e` | no (scripted) / yes (live) | no (scripted) / yes (live) |
| `npm run e2e:vm` | no (scripted default) | no |
| `npm run e2e:durable` | no (scripted default) | no |

A successful live workflow run prints `agent result: pong` and **returns to the shell**
with exit 0. If it prints `pong` and hangs, the transport was not stopped — check the
`finally` block in the launcher.

The MCP server listens on loopback at `PORT`, default 3000. Start it, then register it
with Claude Code from another terminal:

```bash
npm run mcp
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

See [mcp-interface.md](mcp-interface.md) for timeout, hosting, and authentication
configuration.

### Host with autonomous run loop

The host serves both `/mcp` and `/task`. Start it instead of the MCP-only server
when you want autonomous agent execution:

```bash
node host/index.mjs
```

Then POST a task:

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"goal":"Plan a trip to Tokyo","constraints":{"timeoutMs":300000}}'
```

The host reads `host.config.mjs` for strategy, budget, and guardrail settings.
See [run-loop.md](run-loop.md) for the full `/task` API reference.

In Docker:

```bash
docker compose run --rm -p 3000:3000 fleet node host/index.mjs
```

## Testing

Tests split into three tiers.

**Unit (mock)** — `npm test`, `npm run test:host`, and `npm run test:phase4`. No Fleet
binary, no tokens, no network for most files. Mock tests inject a fake `fleetApi`;
`test:phase4` covers jobs backends, notifier, comm adapters, and the scripted fleet switch.

**Acceptance (real Fleet, in-process)** — `npm run test:acceptance`. Spawns real Fleet
and spends LLM tokens against an in-process host with a memory jobs store. Run before
merging changes that touch Fleet integration or the run loop.

**E2E (containers over HTTP)** — `npm run test:e2e`, `npm run e2e:vm`, and
`npm run e2e:durable`. Black-box tests hit `/task` and `/jobs/*` over HTTP. Default
`E2E_MODE=scripted` uses `FLEET_MOCK_SCRIPT` (requires `NODE_ENV=test`); set
`E2E_MODE=live` and provide a token for real LLM runs.

The older split still applies within unit tests:

**Mock tests** (`tests/transport-stdio-fleet.test.mjs`, `tests/pool-*.test.mjs`,
`tests/demo.test.mjs`, `tests/inspect-members.test.mjs`) run anywhere — no Fleet
binary, no members, no tokens, no network. They work because the launchers accept an
injected `fleetApi`, and the transport wrapper is unit-tested against a fake MCP client.

`tests/mcp.test.mjs` also needs no Fleet binary or token. It drives a real MCP client
over a real ephemeral port against the HTTP application, with Fleet mocked underneath.
Those files are what `npm test` runs, and what you should run constantly.

The workflow mock is a hand-written object implementing the methods the body actually
uses (`fleetStatus`, `executeCommand`, `executePrompt`) and recording its calls. It
returns realistic MCP envelopes so the text-extraction paths get exercised.

**Live tests** split further. `tests/stdio-fleet.live.test.mjs` spawns a real Fleet
stdio child and calls `fleetStatus` / `listMembers`. It skips when `apra-fleet` is not
installed. `tests/demo.live.test.mjs` runs the full workflow against a real member with a
real token. `tests/dispatch.live.test.mjs` proves pool → ephemeral → queue against a real
Fleet. Run live tests before merging changes that touch the Fleet integration, not on
every save.

When you add behavior, prefer extending the mock over reaching for a live Fleet child.
If something can only be verified live, that is usually a hint that connection logic has
leaked into a workflow body.

## Adding a workflow

Follow the existing shape rather than inventing a new one.

**1. Create the launcher and body.** Copy the split from `workflows/demo/`: a
`main.mjs` that owns spawn, transport cleanup and the exported entry function, and
a body file that only knows how to do the work given the engine context. The entry
function must accept `{ fleetApi, workspace }` so it stays testable. Address
`'doer'` and `'reviewer'`, never a hardcoded member name.

```js
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../demo/ensure-apralabs.mjs';

export async function runMyWorkflow({ fleetApi, workspace, signal, reportPhase } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runMyWorkflow({ ...ctx, reportPhase }));
  }
  // ...execute the body
}
```

**2. Write a mock test first.** Reuse the mock-client pattern. Assert the calls you care
about — which roles, which commands, which prompts. Do not put registration in the
body; `withStandaloneLease` / MemberManager own spawn and registration.

**3. Expose it as an MCP tool, if it should be.** Append an entry to `defaultRegistry`
in `mcp/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'What this does and when a model should choose it.',
  inputSchema: z.object({ target: z.string().describe('What to act on') }),
  annotations: { readOnlyHint: true },
  async run({ fleetApi, args, signal, reportPhase, workspace }) {
    return await runMyWorkflow({ fleetApi, signal, reportPhase, workspace, target: args.target });
  },
}
```

No changes to `server.mjs` or `http.mjs` are needed — the registry is data.

**4. Workers are leased, not hardcoded.** Workflows address `'doer'` and `'reviewer'`.
The dispatcher registers pool members at startup. Do not put registration in the body,
and do not hardcode member names.

## Conventions

- **ESM everywhere.** `"type": "module"`, `.mjs` for launchers and MCP modules.
- **`node:test` and `node:assert/strict`.** No test framework dependency.
- **No `@apralabs/*` in `package.json`.** Fleet's workflow packages resolve through the symlink.
- **`@modelcontextprotocol/client` is a runtime dependency** — the stdio transport imports it.
- **Dependency injection over module-level singletons.** Anything that talks to Fleet
  takes `fleetApi` as an argument.
- **Dynamic `import()` for Fleet packages**, always after `ensureApralabs()`.
- **Secrets live in Fleet's credential store and `CLAUDE_CODE_OAUTH_TOKEN`**, never in
  source, never in an `agent()` payload, never in git.
- **Python tools use only stdlib.** No pip dependencies. Keep it that way so Docker
  needs only `python3`.

## Local state and git

`node_modules/`, `.claude/`, `.env`, `.cursor/` and leftover `.fleet/` / `.fleet-src/`
directories are all gitignored. The `.claude/settings.local.json` files that appear under
`workdir/` after registering members are machine state — leave them out of commits.

## Docker

Build once, run, done. The image installs Fleet, Claude Code, and project dependencies.
The entrypoint installs deps and links packages; it does **not** register members.
Node's `MemberManager` registers the worker pool and attaches `CLAUDE_CODE_OAUTH_TOKEN`
when the process starts.

### Quick start

```bash
docker compose up                    # MCP server on port 3000
```

Register the MCP server with Claude Code from the host:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Pass an OAuth token for live `agent()` calls:

```bash
CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" docker compose up
```

Override the host port with `MCP_PORT`:

```bash
MCP_PORT=4000 docker compose up
```

### Running workflows or tests in Docker

```bash
docker compose run --rm fleet node workflows/demo/main.mjs      # live workflow
docker compose run --rm fleet node --test tests/demo.test.mjs   # mock tests
```

### How the container works

The entrypoint runs automatically on every container start:

1. Installs project deps if the named volume is empty (first run)
2. Symlinks `@apralabs` packages so workflows resolve them
3. Execs the container command (MCP server by default)

Member registration and OAuth happen in Node after the process starts and spawns
`apra-fleet run --transport stdio`. The compose file sets `MCP_BIND_HOST=0.0.0.0` so the
server is reachable from the host.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `apra-fleet` not found / spawn error | Install Fleet (`npm install -g @apralabs/apra-fleet && apra-fleet install`) or set `APRA_FLEET_BIN`. |
| `Fleet MCP server is missing required tools` | The spawned binary is too old or not Fleet. Need a build that supports `run --transport stdio`. |
| `Cannot find package 'undici'` | Stale `node_modules/@apralabs` symlink. Delete it and re-run. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `OAuth session expired` | `claude setup-token`, export `CLAUDE_CODE_OAUTH_TOKEN`, re-run. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally`. |
| A tool is never chosen | Improve its registry `description` so the connected model knows when to use it. |
| A tool call times out | Set `"timeout"` in that server's `.mcp.json` entry. |
