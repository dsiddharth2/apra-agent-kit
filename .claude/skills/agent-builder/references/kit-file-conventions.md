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
  try { return JSON.parse(typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? ''); }
  catch { return { ok: false, error: 'parse failed', raw: String(text) }; }
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

## Deployment

- **Dockerfile**: Add any new apt/pip packages the tools need
- **docker-compose.yml**: Add new env vars under `environment:`
- **.env.example**: Document every env var with a comment
- If the agent needs new ports or volumes, add them to docker-compose.yml

## Build Order

When generating an implementation plan from a spec, tasks should follow this order
so the project stays runnable at every step:

1. **Tools** — no dependencies, pure Python scripts
2. **Workflows** — depend on tools, follow the triad pattern
3. **Registry** — imports workflows/tools, wires MCP interface
4. **Tests** — verify each piece with mock-fleet
5. **Deployment** — Docker, env vars, compose updates
6. **Integration test** — end-to-end run with Fleet (if available)
