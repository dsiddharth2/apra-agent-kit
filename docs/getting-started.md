# Getting Started

This guide is for **agent builders** — developers who want to create their own agent
using the kit. You do not need to understand the kit's internals; you need to know
what to configure, where to put your tools, and how to run it.

If you want to **contribute to the kit itself** (fix bugs, add modules, improve the
run loop), see [development.md](development.md) and [architecture.md](architecture.md)
instead.

---

## What you get

The kit gives you an agent that can:
- Receive a goal (via API, chat UI, or MCP)
- Plan a sequence of tool calls
- Execute them autonomously with review gates
- Stream progress to a real-time chat UI
- Respect cost, token, and time budgets

You supply: **the tools** and **the config**. The kit handles planning, execution,
review, error recovery, concurrency, and deployment.

---

## Prerequisites

| Requirement | Version / Notes |
|---|---|
| Node.js | **22.16+** |
| Python 3 | On `PATH` as `python3` (for tool scripts) |
| Apra Fleet | `npm install -g @apralabs/apra-fleet && apra-fleet install` |
| OAuth token | `export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"` |

**For Azure Functions deployment only:**
- Docker (to build the container image)
- Azure CLI (`az`)
- Azure Functions Core Tools (`func`) — for local dev

---

## Project structure

```
your-agent/
├── host.config.mjs          ← Your agent's identity and module config
├── mcp/
│   └── registry.mjs         ← Your tool catalog (the only file you edit here)
├── tools/
│   ├── my-tool/
│   │   └── my_tool.py       ← Tool implementation (Python, or any executable)
│   └── another-tool/
│       └── another_tool.py
├── workflows/                ← Multi-step workflows (optional, for complex tools)
├── host/                     ← Kit internals (don't edit)
├── deploy/
│   └── azure-functions/      ← Azure-specific config and Dockerfile
└── docs/
```

You work in three places:
1. **`host.config.mjs`** — agent identity, personality (`agentDescription`), and module config
2. **`mcp/registry.mjs`** — tool catalog (the only file you edit in `mcp/`)
3. **`tools/`** — tool implementations (Python scripts or any executable)

---

## Step 1: Configure your agent

Edit `host.config.mjs`. Here is a minimal config for local development:

```js
export default {
  name: 'my-agent',
  description: 'Short label for logs and the chat header.',

  // This is the agent's personality and domain knowledge. It becomes part of
  // the system prompt the LLM sees before every task. Be specific about what
  // the agent knows, what output format you expect, and any constraints.
  agentDescription: `You are a financial research assistant. You have expertise in:
- Stock market analysis and fundamentals
- Currency exchange rates
- Economic indicators

Always cite the tool that produced each data point. When data is unavailable,
say so explicitly rather than guessing.`,

  fleet: {},

  comm: {
    adapter: 'express',     // 'express' for local/VM, 'azure-functions' for Azure
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',   // or 'open-ended' for simple agents
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,        // set true to test without executing
    },
    dispatch: {
      enabled: true,
      store: { kind: 'sqlite', dbPath: './jobs.db' },
      concurrency: 2,
      maxQueueSize: 10,
    },
    notify: {
      sse: { enabled: true },
    },
    chat: {
      enabled: true,
      title: 'My Agent',
      themes: ['blue'],         // 'apra', 'blue', or both for a toggle
    },
  },
};
```

### Choosing a strategy

| Strategy | When to use |
|---|---|
| `plan-execute` | Most agents. The LLM creates a plan, a reviewer approves it, then steps execute one at a time. Replans on failure. Safer, auditable. |
| `open-ended` | Simple lookup agents. Act → observe → repeat with no upfront plan. Faster for single-tool tasks, less control. |

### Config reference

| Field | What it does |
|---|---|
| `name` | Agent identity — shown in logs, chat header, and system prompt as the agent's name |
| `description` | Short label for the chat UI title and log output |
| `agentDescription` | **The agent's personality and domain knowledge.** Injected into the system prompt. This is how you tell the LLM what it is, what it knows, and how it should respond. Can be a multi-line template literal. |
| `comm.adapter` | `'express'` (local/Docker) or `'azure-functions'` |
| `dispatch.backend` | `'in-process'` (default for express) or `'durable'` (Azure only) |
| `dispatch.store.kind` | `'sqlite'` (persists jobs) or `'memory'` (testing only) |
| `dispatch.concurrency` | Max parallel tasks |
| `budgets.*` | Cost and safety limits per task |
| `chat.themes` | `['blue']`, `['apra']`, or `['blue', 'apra']` for a toggle |

---

## Step 2: Write your tools

A tool is two things: an **implementation** (a script that does the work) and a
**registry entry** (metadata that tells the LLM what the tool does).

### 2a. Write the implementation

Create a script in `tools/your-tool/`. Python is typical but anything that reads
argv and prints JSON to stdout works.

```python
# tools/stock-price/stock_price.py
import json, sys, urllib.request

def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    try:
        # your API call here
        url = f"https://api.example.com/quote/{symbol}"
        req = urllib.request.Request(url, headers={"User-Agent": "my-agent/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        print(json.dumps({"ok": True, "symbol": symbol, "price": data["price"]}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
```

**Rules:**
- Print exactly one JSON object to stdout
- Include an `"ok": true/false` field
- Handle errors — don't let the script crash without output
- Use only stdlib or vendored dependencies (the script runs inside a Fleet worker)

### 2b. Register the tool

Add an entry to the `defaultRegistry` array in `mcp/registry.mjs`:

```js
import * as z from 'zod/v4';

// In the defaultRegistry array:
{
  name: 'stock-price',
  description:
    'Fetches the current stock price for a given ticker symbol. ' +
    'Returns the price in USD. Read-only, no LLM tokens.',
  inputSchema: z.object({
    symbol: z.string().describe('Ticker symbol (e.g. AAPL, MSFT).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run({ fleetApi, args }) {
    const symbol = shellEscape(args.symbol || 'AAPL');
    const script = path.join(toolsDir, 'stock-price', 'stock_price.py');
    const raw = await fleetApi.executeCommand({
      member_name: 'doer',
      command: `python3 "${script}" "${symbol}"`,
    });
    return parseToolOutput(raw);
  },
},
```

That's it. No changes to `server.mjs`, `routes.mjs`, or any other file. The registry
is the single source of truth for tools.

### Registry entry anatomy

| Field | Required | What it does |
|---|---|---|
| `name` | Yes | Tool identifier (kebab-case) |
| `description` | Yes | **Written for the LLM** that picks tools — be specific about what it returns and costs |
| `inputSchema` | No | Zod schema for arguments. Omit for no-arg tools. |
| `annotations` | No | `readOnlyHint`, `idempotentHint` — helps the reviewer gate decisions |
| `run()` | Yes | Receives `{ fleetApi, args, signal, reportPhase, workspace }` |

### Tool patterns

**Python script** (most common):
```js
async run({ fleetApi, args }) {
  const script = path.join(toolsDir, 'my-tool', 'my_tool.py');
  const raw = await fleetApi.executeCommand({
    member_name: 'doer',
    command: `python3 "${script}" "${shellEscape(args.input)}"`,
  });
  return parseToolOutput(raw);
},
```

**JavaScript workflow** (multi-step, uses agent reasoning):
```js
import { runMyWorkflow } from '../workflows/my-workflow/main.mjs';

async run({ fleetApi, args, signal, reportPhase, workspace }) {
  const result = await runMyWorkflow({ fleetApi, workspace, signal, reportPhase, ...args });
  return `workflow completed: ${JSON.stringify(result)}`;
},
```

**Direct HTTP call** (no Fleet worker needed):
```js
async run({ args }) {
  const res = await fetch(`https://api.example.com/data/${args.id}`);
  return await res.json();
},
```

---

## Step 3: Run your agent

### Local (express adapter)

```bash
npm install
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
node host/index.mjs
```

The agent starts on `http://localhost:3000`:
- **Chat UI** → `http://localhost:3000/chat`
- **Submit a task** → `POST http://localhost:3000/task` with `{ "goal": "..." }`
- **MCP endpoint** → `POST http://localhost:3000/mcp`
- **Job status** → `GET http://localhost:3000/jobs/{jobId}`
- **SSE stream** → `GET http://localhost:3000/jobs/{jobId}/events`

### Docker

```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

### Azure Functions

For production deployment with horizontal scaling, see
[deploy-azure-functions.md](deploy-azure-functions.md). The key config differences:

```js
// deploy/azure-functions/host.config.mjs
comm: { adapter: 'azure-functions' },
modules: {
  dispatch: { enabled: true, backend: 'durable' },
  // ...
}
```

| | Local / VM | Azure Functions |
|---|---|---|
| Adapter | `express` | `azure-functions` |
| Jobs backend | `in-process` (SQLite) | `durable` (Durable Functions) |
| Scaling | Single process | Horizontal (task hub is shared state) |
| Entry point | `node host/index.mjs` | `comm/azure-functions/main.mjs` |
| Workers | `WORKER_POOL_SIZE` (default 4) | `WORKER_EPHEMERAL_MAX` |

---

## Authentication

### Fleet workers (required)

Fleet workers need an OAuth token to operate. This is how the kit authenticates
with the underlying Claude Code workers that execute tool calls.

```bash
# Generate a token
claude setup-token

# Set it as an environment variable
export CLAUDE_CODE_OAUTH_TOKEN="the-token-from-above"
```

For Docker, pass it at launch:
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

For Azure Functions, set it as an app setting:
```bash
az functionapp config appsettings set \
  --name my-agent-app \
  --resource-group my-rg \
  --settings CLAUDE_CODE_OAUTH_TOKEN="your-token"
```

### API authentication (optional)

By default, the agent's HTTP endpoints (`/task`, `/jobs`, `/mcp`) are **open** —
no auth required. This is fine for local development.

For production, inject a custom authenticator when starting the host:

```js
// custom-auth.mjs
export function authenticateRequest(request) {
  const token = request.headers['authorization']?.replace('Bearer ', '');
  if (!token || token !== process.env.API_SECRET) return null; // rejected
  return { id: 'api-user' }; // accepted — returned as req.user
}
```

The kit calls your function on every request to auth-protected routes. Return a
user object to allow, or `null` to reject with 401. The chat UI routes (`/chat`,
`/chat/app.mjs`) and `/health` are always unauthenticated.

---

## Connect via MCP

Your agent exposes an MCP endpoint at `/mcp`. Any MCP-capable client can connect
to it and call your tools directly.

### Register with Claude Code

```bash
# Local agent
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp

# Azure Functions
claude mcp add --transport http my-agent https://my-agent-app.azurewebsites.net/api/mcp
```

Once registered, Claude Code can discover and call all your tools. Ask it
"what tools does my-agent have?" to verify.

### Register with other MCP clients

Any client that supports HTTP transport can connect:

```
Endpoint:  http://localhost:3000/mcp
Transport: HTTP (Streamable)
```

On Azure Functions, the MCP endpoint uses the web-standard transport
(`WebStandardStreamableHTTPServerTransport`) instead of the Express-specific one.

### With authentication

If you've added API auth, pass the header when registering:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer your-api-secret" \
  my-agent http://127.0.0.1:3000/mcp
```

### MCP vs. autonomous mode

| Mode | How it works | When to use |
|---|---|---|
| **MCP (tool server)** | External LLM calls your tools directly via `/mcp` | You want Claude Code or another AI to pick which tools to call |
| **Autonomous (`/task`)** | Your agent plans, reviews, and executes on its own | You want to submit a goal and get a complete answer back |
| **Both** | Both endpoints are live simultaneously | Most setups — let users choose |

---

## Step 4: Test it

### Via the chat UI

Open `http://localhost:3000/chat` and type a goal. The UI shows:

1. **Status pipeline** — Generating Plan → Reviewing → Approved → Running → Complete
2. **Plan card** — each tool step with status, expandable results
3. **Final answer** — rendered markdown

### Via curl

```bash
# Submit a task
curl -sX POST localhost:3000/task \
  -H "content-type: application/json" \
  -d '{"goal":"What is the weather in Tokyo?"}'

# Stream events
curl -N localhost:3000/jobs/<jobId>/events

# Poll result
curl -s localhost:3000/jobs/<jobId>
```

### Via MCP

Connect any MCP-capable client:

```bash
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp
```

---

## Step 5: Iterate

### Adding more tools

1. Create `tools/new-tool/new_tool.py`
2. Add a registry entry in `mcp/registry.mjs`
3. Restart the host

### Tuning the agent

| Want to... | Change |
|---|---|
| Make the agent more careful | Increase `maxReviewAttempts`, set `minReviewPolicy: 'always'` |
| Make the agent faster | Use `strategy: 'open-ended'`, reduce `maxIterations` |
| Increase cost limit | Raise `budgets.maxCostUsd` |
| Allow more parallel tasks | Raise `dispatch.concurrency` |
| Disable the planner | Set `runLoop.enabled: false` — tools-only MCP mode |

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (required) | Fleet worker authentication |
| `PORT` | `3000` | HTTP listen port |
| `WORKER_POOL_SIZE` | `4` | Persistent worker count |
| `WORKER_EPHEMERAL_MAX` | `10` | Max ephemeral workers for burst |
| `CHAT_ENABLED` | from config | Override chat on/off (`true`/`false`) |

---

## Two modes of operation

### Tool server only (no autonomous agent)

Disable the run loop. An external LLM (Claude Code, another agent) calls your tools
via MCP. You provide tools; the caller provides reasoning.

```js
modules: {
  runLoop: { enabled: false },
  // dispatch, chat, etc. disabled
}
```

Run with `npm run mcp` or `node mcp/main.mjs`.

### Full autonomous agent

Enable all modules. The agent receives a goal, plans, calls tools, reviews, and
returns a complete answer. This is the default configuration.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `chat enabled but dispatch disabled` | Enable both `dispatch` and `notify.sse` when chat is on |
| `durable backend requires azure-functions adapter` | Use `backend: 'in-process'` with the express adapter |
| Tool script hangs | Add a timeout in your Python script; the kit enforces `budgets.timeoutMs` at the task level |
| `City not found` / tool returns `ok: false` | Check your tool's error handling — the agent sees the error and replans |
| Workers not starting | Verify `CLAUDE_CODE_OAUTH_TOKEN` is set and valid |

---

## What's next

- [run-loop.md](run-loop.md) — deep dive into strategies, prompts, and review policies
- [jobs.md](jobs.md) — full async jobs API reference
- [chat-ui.md](chat-ui.md) — chat page internals and theming
- [deploy-azure-functions.md](deploy-azure-functions.md) — production deployment
- [architecture.md](architecture.md) — how the kit works internally (for contributors)
