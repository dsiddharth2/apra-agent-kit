# Kit File Conventions

Reference for the agent-builder skill. Maps agent spec sections to the concrete
files that need to be created or modified in a Fleet Agent Kit project.

## Workflow Triad

Every workflow consists of three files:

### 1. `workflows/<name>/workflow.json` — metadata

```json
{
  "name": "<name>",
  "entry": "<name>.js",
  "description": "One-line description of what this workflow does"
}
```

### 2. `workflows/<name>/<name>.js` — workflow body

Exports `meta` and `main(context)`. The context provides `{ phase, command, agent, log, args }`.

- `command(cmd, { member_name })` — run a shell command on a Fleet member
- `agent(prompt, { member_name })` — send an LLM prompt to a Fleet member
- `phase(name)` — mark workflow progress
- `log(message)` — log a message
- `args` — input arguments passed to the workflow

```javascript
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: '<name>' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const TOOL_PY = path.join(toolsDir, '<tool-name>', '<tool-name>.py');

function shellEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function safeJson(text) {
  let raw = typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? '';
  raw = String(raw).trim();
  // Strip markdown code fences that LLMs often wrap around JSON
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const m = raw.match(fenceRe);
  if (m) raw = m[1].trim();
  try { return JSON.parse(raw); }
  catch { return { ok: false, error: 'parse failed', raw }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;

  phase('fetch');
  const raw = await command(`python3 "${TOOL_PY}" "${shellEscape(args.input)}"`, { member_name: 'doer' });
  const data = safeJson(raw);
  log(`result: ${JSON.stringify(data)}`);

  phase('compose');
  const answer = await agent('Summarize this data: ' + JSON.stringify(data), { member_name: 'doer' });

  return { data, answer };
}
```

### 3. `workflows/<name>/main.mjs` — launcher

Boilerplate that imports `withStandaloneLease` and `ensureApralabs`, exports `run<Name>()` and `selfExecuting = true`.

```javascript
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../../transport/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, '<name>.js');

export const selfExecuting = true;

export async function run<Name>({ fleetApi, workspace, /* args */ signal, reportPhase } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => run<Name>({ ...ctx, /* args, */ reportPhase }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, {
    fleetApi,
    workspace,
    /* args, */
    signal,
    reportPhase,
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = await run<Name>();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

## Tool Script

A single Python file at `tools/<name>/<name>.py`. Uses only stdlib (no pip). Reads args from `sys.argv`. Prints JSON to stdout.

```python
import json
import sys
import urllib.request
import urllib.error

def fetch_data(input_arg):
    try:
        # Call external API or process data
        url = f"https://api.example.com/data?q={urllib.request.quote(input_arg)}"
        req = urllib.request.Request(url, headers={"User-Agent": "fleet-agent/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        return json.dumps({"ok": True, "result": data})
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": str(exc)})

if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "default"
    print(fetch_data(arg))
```

## MCP Registry Entry

Add to `mcp/registry.mjs`. Import the workflow's `run<Name>` function, then append an entry to `defaultRegistry`.

Host registry and guardrails (`docs/CONTRACT.md`): the host default is `reversible: true`. Mark writes `reversible: false` or they skip approval.

### Workflow tool (calls a workflow):
```javascript
import { run<Name> } from '../workflows/<name>/main.mjs';

// Add to defaultRegistry array:
{
  name: '<name>',
  description: 'Description for the model that decides which tool to call.',
  inputSchema: z.object({
    input: z.string().optional().describe('Description of the input.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false },
  reversible: true,
  async run({ fleetApi, args, signal, reportPhase, workspace }) {
    const result = await run<Name>({ fleetApi, workspace, input: args.input, signal, reportPhase });
    return `<name> completed: ${JSON.stringify(result)}`;
  },
},
```

### Simple tool (calls a Python script directly):
```javascript
// Add to defaultRegistry array:
{
  name: '<tool-name>',
  description: 'Description. Read-only, no LLM tokens.',
  inputSchema: z.object({
    arg: z.string().describe('Description.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  reversible: true,
  async run({ fleetApi, args }) {
    const escaped = shellEscape(args.arg);
    const script = path.join(toolsDir, '<tool-name>', '<tool-name>.py');
    const raw = await fleetApi.executeCommand({
      member_name: 'doer',
      command: `python3 "${script}" "${escaped}"`,
    });
    return parseToolOutput(raw);
  },
},
```

## Unit Tests

Use `node:test` and `node:assert/strict`. Test the **workflow body** (`<name>.js`),
not the launcher (`main.mjs`). The body receives a context with Fleet primitives, so
a fake context is all you need — no Fleet binary, no token, no network.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../workflows/<name>/<name>.js';

function fakeContext(args = {}) {
  const calls = { commands: [], prompts: [] };
  const context = {
    log: () => {},
    phase: () => {},
    args,
    async command(cmd, options) {
      calls.commands.push({ cmd, ...options });
      // Return whatever the workflow body expects from the command.
      return JSON.stringify({ ok: true, result: 'mock-data' });
    },
    async agent(prompt, options) {
      calls.prompts.push({ prompt, ...options });
      return 'Mock LLM response for: ' + prompt.slice(0, 50);
    },
  };
  return { context, calls };
}

test('<name> returns expected result', async () => {
  const { context, calls } = fakeContext({ input: 'test-input' });
  const result = await main(context);
  assert.ok(result);
  assert.equal(calls.commands[0].member_name, 'doer');
  assert.equal(calls.prompts[0].member_name, 'doer');
});

test('<name> addresses roles, not member names', async () => {
  const { context, calls } = fakeContext({ input: 'test-input' });
  await main(context);
  for (const call of [...calls.commands, ...calls.prompts]) {
    assert.equal(call.member_name, 'doer');
  }
});
```

Run tests: `node --test tests/<name>.test.mjs`

## Host Configuration

`host.config.mjs` in the project root. This is the runtime brain — it tells the
host which modules to enable, how the LLM should behave, and what strategy to use.

**The template ships with a bare minimum** (`name`, `fleet`, `comm`). The plan
MUST configure the full set for any agent that uses the run loop or chat.

```javascript
export default {
  name: '<agent-name>',
  description: '<one-line for humans — shows in chat title>',

  // This is the system prompt extension. It tells the LLM what it is,
  // which tools to use and when, and any domain rules. Be explicit —
  // "ALWAYS use the X tool" is better than "you can use X".
  agentDescription: `You are a <domain> agent. When users ask for <X>, ALWAYS use the <tool-name> tool. When they want <Y>, use the <other-tool> tool. Never generate <X> from scratch — always call the tools.

<Domain-specific rules, constraints, and output format instructions.>`,

  fleet: {},

  comm: {
    adapter: 'express',  // or 'azure-functions' for Azure deployment
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',  // or 'open-ended' for conversational agents
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
      dryRunMode: false,
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
      title: '<Agent Name>',
      themes: ['apra'],
    },
    router: {
      enabled: true,
      fallbackStrategy: 'open-ended',  // match runLoop.strategy
    },
  },
};
```

### Strategy selection

| Workflow shape | Strategy | Why |
|---|---|---|
| Linear pipeline, loop-until-done, fan-out | `plan-execute` | Structured steps, LLM creates a plan then executes it |
| Chat-driven, conversational, open-ended | `open-ended` | Free-form reasoning, no plan phase |
| Human-in-the-loop | `plan-execute` with `minReviewPolicy: 'all'` | Every step needs approval |

### `agentDescription` tips

- Be directive: "ALWAYS use the X tool" beats "you can use the X tool"
- List each tool by name and when to use it
- Include output format requirements
- Include domain-specific constraints and safety rules
- This replaces the generic system prompt — don't rely on `host/prompts/system.mjs`

## API Key Propagation

`executeCommand` does NOT inherit environment variables from the parent shell.
If a Python tool needs an API key, pass it via the command string:

```javascript
// In the workflow body or registry run function:
const apiKey = process.env.MY_API_KEY || args.apiKey || '';
const raw = await command(
  `MY_API_KEY="${shellEscape(apiKey)}" python3 "${TOOL_PY}" "${shellEscape(args.input)}"`,
  { member_name: 'doer' }
);
```

Or pass it as a JSON argument to the Python script:

```javascript
const input = JSON.stringify({ query: args.input, apiKey: process.env.MY_API_KEY });
const raw = await command(
  `python3 "${TOOL_PY}" '${input.replace(/'/g, "'\\''")}'`,
  { member_name: 'doer' }
);
```

Always document required env vars in `.env.example`.

## Stale Session Cleanup

Fleet worker sessions from previous runs persist and can poison new runs — the
agent resumes a stuck session instead of starting fresh. Before integration
testing, clear stale sessions:

```powershell
# PowerShell — clear doer session logs
$workerDir = "$env:USERPROFILE\.claude\projects\<project-hash>-workdir-worker-1-doer"
if (Test-Path $workerDir) { Remove-Item "$workerDir\*.jsonl" -Force -ErrorAction SilentlyContinue }
```

The plan should include this as a step before the integration test task.

## Deployment

- **Dockerfile**: Add any new apt/pip packages the tools need
- **docker-compose.yml**: Add new env vars under `environment:`
- **.env.example**: Document every env var with a comment
- If the agent needs new ports or volumes, add them to docker-compose.yml

## Agent README

After the agent is built, the plan must include a task to **replace** the starter
`README.md` with documentation specific to this agent. The README is the agent's
front door — it tells the next developer (or the author in six months) what this
agent does, how to run it, and what to configure.

### Structure

```markdown
# <Agent Name>

<One paragraph: what this agent does, who it's for, why it exists.>

## Quick Start

<Exact commands to install, configure, and run the agent. Include token setup.>

## Tools

<Table of tools the agent exposes: name, what it does, required env vars.>

| Tool | Description | Env vars |
|------|------------|----------|
| `tool-name` | What it does | `API_KEY` |

## Workflows

<For each workflow: name, what it does, trigger, and a one-line example.>

## Configuration

<Key `host.config.mjs` fields the user should know about: strategy, budgets,
agentDescription summary. Link to the full config file rather than duplicating it.>

## Environment Variables

<Table of every env var the agent needs, with descriptions and defaults.>

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | — | Fleet worker authentication |

## Testing

<How to run tests: `npm test` for mock tests, integration test commands.>

## Deployment

<Docker and/or Azure Functions instructions specific to this agent.>

## Architecture

<Brief: what strategy, how many members, link to kit docs for internals.>

Built on the [Fleet Agent Kit](https://github.com/dsiddharth2/workflow-kit).
See [docs/architecture.md](docs/architecture.md) for kit internals.
```

### Rules

- Write the README from the **spec**, not from generic boilerplate
- Every tool and workflow in the registry must appear in the README
- Every env var the agent needs must be listed
- The Quick Start must be copy-pasteable — a new developer runs the commands and the agent starts
- Do NOT include kit development docs (architecture internals, contributing guidelines) — those belong in `docs/` and are already shipped with the kit

## Build Order

When generating an implementation plan from a spec, tasks should follow this order
so the project stays runnable at every step:

1. **Tools** — no dependencies, pure Python scripts
2. **Workflows** — depend on tools, follow the triad pattern
3. **Registry** — imports workflows/tools, wires MCP interface
4. **Host config** — `host.config.mjs` with agentDescription, modules, strategy
5. **Tests** — verify each piece with mock-fleet
6. **Deployment** — Docker, env vars, compose updates
7. **Documentation** — generate `README.md` from the spec (see Agent README section above)
8. **Session cleanup + integration test** — clear stale sessions, then end-to-end run with Fleet
