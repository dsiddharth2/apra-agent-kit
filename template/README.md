# {{PROJECT_NAME}}

An agent built on [Apra Fleet](https://github.com/Apra-Labs/apra-fleet) with the
[workflow kit](https://github.com/dsiddharth2/workflow-kit).

## Run it

```bash
npm run doctor     # check your environment
npm test           # mock tests — no Fleet, no token needed
npm run hello      # run the starter workflow for real
docker compose up  # start the MCP server on :3000
```

Register the MCP server with Claude Code:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

## Write your first workflow

Copy `workflows/hello/` and rename it. The body (`hello.js`) does the work; the
launcher (`main.mjs`) spawns Fleet and leases a worker pair. Address the pair as
`'doer'` and `'reviewer'` — never by member name.

Then append one entry to `mcp/registry.mjs` and it becomes an MCP tool. No
changes to `server.mjs` or `http.mjs` are needed.

## Your code and the kit's

You own every file here. `mcp/`, `pool/`, `host/`, `transport/` and `comm/` came
from the kit — `.kit-version` records which version. Yours to change; nothing
updates them for you.

| Path | What |
|---|---|
| `workflows/` | Your workflow bodies and launchers |
| `tools/` | Python tool scripts (stdlib only, no keys) |
| `mcp/registry.mjs` | Your tool catalog |
| `docs/` | Kit architecture and development reference |
| `scripts/doctor.mjs` | Environment check |

## Token

`agent()` calls need an OAuth token:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
```

`npm test` does not need one. `npm run hello` does.

`docker compose` forwards `CLAUDE_CODE_OAUTH_TOKEN` into the container. Live
`agent()` calls inside Compose depend on that env; the kit's host-session
wrapper is not copied into a generated project.
