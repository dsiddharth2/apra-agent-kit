# Strategy Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each incoming task to the fastest viable execution path — a predefined workflow, open-ended strategy, or plan-execute strategy — using a single LLM classifier call on the doer member, cutting simple question response times from ~5 minutes to ~10 seconds.

**Architecture:** A new `host/router.mjs` module classifies each task goal via a short prompt to the doer. The classifier picks one of three paths: a named workflow (predefined tool sequence + 1 LLM compose), open-ended (1-3 LLM calls), or plan-execute (4-8+ LLM calls). The pool lease is acquired with only the DOER member; the REVIEWER is registered on-demand only when plan-execute is chosen, saving ~3.5s on every other path.

**Tech Stack:** Node.js (ESM, >=22.16), `node:test` for testing, Fleet MCP API, existing workflow engine (`@apralabs/apra-fleet-workflow`)

**Spec:** `docs/specs/2026-09-21-strategy-router-spec.md`

## Global Constraints

- Node >= 22.16, ESM modules only (`"type": "module"`)
- All tests use `node:test` + `node:assert` — no third-party test framework
- Mock fleet via `tests/helpers/mock-fleet.mjs` — no real Fleet calls in unit tests
- Workflows use `@apralabs/apra-fleet-workflow` engine pattern (see `workflows/city-briefing/`)
- Tool scripts are Python, called via `fleetApi.executeCommand` on the doer
- Registry is `mcp/registry.mjs` — single source of truth for tools and workflows
- Config validation lives in `host/config.mjs`
- No changes to strategies, prompts, run-loop, comm, jobs, or notify modules

---

### Task 1: Pool Lease — Deferred Reviewer Registration

**Files:**
- Modify: `pool/member-manager.mjs` (add `provisionDoer`, `provisionReviewer`)
- Modify: `pool/ephemeral-factory.mjs` (add `members` option, `upgradeToReviewer`)
- Test: `tests/pool-member-manager.test.mjs` (add cases)
- Test: `tests/pool-ephemeral-factory.test.mjs` (add cases)

**Interfaces:**
- Consumes: existing `MemberManager.provisionPair()`, `EphemeralWorkerFactory.create()`
- Produces:
  - `MemberManager.provisionDoer(prefix, workRoot) → { doer: { name, folder } }`
  - `MemberManager.provisionReviewer(prefix, workRoot) → { reviewer: { name, folder } }`
  - `EphemeralWorkerFactory.create({ signal, members? })` — `members` defaults to `['doer', 'reviewer']`; passing `['doer']` skips reviewer
  - `lease.upgradeToReviewer() → void` — registers reviewer on existing lease, sets `lease.reviewer`

- [ ] **Step 1: Write failing tests for MemberManager.provisionDoer**

In `tests/pool-member-manager.test.mjs`, add:

```js
test('provisionDoer registers only the doer member', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const tmpDir = path.join(os.tmpdir(), `test-prov-doer-${Date.now()}`);
  try {
    const result = await manager.provisionDoer('TEST-DOER', tmpDir);
    assert.ok(result.doer, 'should return doer');
    assert.equal(result.doer.name, 'TEST-DOER-DOER');
    assert.ok(!result.reviewer, 'should not return reviewer');
    const registered = [...fleetApi.present];
    assert.ok(registered.includes('TEST-DOER-DOER'), 'doer should be registered');
    assert.ok(!registered.includes('TEST-DOER-REVIEWER'), 'reviewer should NOT be registered');
    assert.ok(fleetApi.authCalls.some(c => c.member_name === 'TEST-DOER-DOER'), 'doer auth provisioned');
    assert.ok(!fleetApi.authCalls.some(c => c.member_name === 'TEST-DOER-REVIEWER'), 'reviewer auth NOT provisioned');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('provisionReviewer adds reviewer to existing doer prefix', async () => {
  const fleetApi = createMockFleetApi();
  const manager = new MemberManager(fleetApi, { oauthToken: 'tok' });
  const tmpDir = path.join(os.tmpdir(), `test-prov-rev-${Date.now()}`);
  try {
    await manager.provisionDoer('TEST-REV', tmpDir);
    const result = await manager.provisionReviewer('TEST-REV', tmpDir);
    assert.ok(result.reviewer, 'should return reviewer');
    assert.equal(result.reviewer.name, 'TEST-REV-REVIEWER');
    const registered = [...fleetApi.present];
    assert.ok(registered.includes('TEST-REV-DOER'));
    assert.ok(registered.includes('TEST-REV-REVIEWER'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pool-member-manager.test.mjs`
Expected: FAIL — `provisionDoer` and `provisionReviewer` are not defined

- [ ] **Step 3: Implement provisionDoer and provisionReviewer in MemberManager**

In `pool/member-manager.mjs`, add two new methods after the existing `provisionPair`:

```js
async provisionDoer(prefix, workRoot) {
  const doer = { name: `${prefix}-DOER`, folder: path.join(workRoot, 'doer') };
  try {
    await this.#ensureRegistered(doer);
    await this.#provisionAuth(doer.name);
    return { doer };
  } catch (err) {
    await fs.rm(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }).catch(() => {});
    await this.#tryRemove(doer.name);
    throw err;
  }
}

async provisionReviewer(prefix, workRoot) {
  const reviewer = { name: `${prefix}-REVIEWER`, folder: path.join(workRoot, 'reviewer') };
  try {
    await this.#ensureRegistered(reviewer);
    await this.#provisionAuth(reviewer.name);
    return { reviewer };
  } catch (err) {
    await this.#tryRemove(reviewer.name);
    throw err;
  }
}
```

- [ ] **Step 4: Run MemberManager tests to verify they pass**

Run: `node --test tests/pool-member-manager.test.mjs`
Expected: All PASS

- [ ] **Step 5: Write failing tests for EphemeralWorkerFactory doer-only lease and upgradeToReviewer**

In `tests/pool-ephemeral-factory.test.mjs`, add:

```js
test('create with members: ["doer"] returns lease with reviewer: null', async () => {
  const factory = makeFactory();
  const lease = await factory.create({ members: ['doer'] });
  assert.ok(lease, 'should return lease');
  assert.ok(lease.doer, 'should have doer');
  assert.strictEqual(lease.reviewer, null, 'reviewer should be null');
  assert.equal(typeof lease.upgradeToReviewer, 'function', 'should have upgradeToReviewer');
  await lease.release();
});

test('upgradeToReviewer registers the reviewer on an existing lease', async () => {
  const factory = makeFactory();
  const lease = await factory.create({ members: ['doer'] });
  assert.strictEqual(lease.reviewer, null);
  await lease.upgradeToReviewer();
  assert.ok(lease.reviewer, 'reviewer should now be set');
  assert.ok(lease.reviewer.name.includes('REVIEWER'), 'reviewer name should contain REVIEWER');
  await lease.release();
});

test('create with no members option defaults to doer+reviewer (backward compat)', async () => {
  const factory = makeFactory();
  const lease = await factory.create();
  assert.ok(lease.doer, 'should have doer');
  assert.ok(lease.reviewer, 'should have reviewer');
  assert.strictEqual(lease.upgradeToReviewer, undefined, 'no upgrade needed when both present');
  await lease.release();
});
```

- [ ] **Step 6: Run ephemeral factory tests to verify they fail**

Run: `node --test tests/pool-ephemeral-factory.test.mjs`
Expected: FAIL

- [ ] **Step 7: Implement members option and upgradeToReviewer in EphemeralWorkerFactory**

In `pool/ephemeral-factory.mjs`, modify `create()` to accept `members`:

```js
async create({ signal, members } = {}) {
  // ... existing guard checks ...
  const doerOnly = Array.isArray(members) && members.length === 1 && members[0] === 'doer';
  // pass doerOnly through to #finishCreate
  const pending = this.#finishCreate({ signal, shortId, prefix, workRoot, entry, doerOnly });
  // ...
}
```

In `#finishCreate`, branch on `doerOnly`:

```js
async #finishCreate({ signal, shortId, prefix, workRoot, entry, doerOnly }) {
  let pair;
  try {
    if (doerOnly) {
      pair = await this.#manager.provisionDoer(prefix, workRoot);
      pair.reviewer = null;
    } else {
      pair = await this.#manager.provisionPair(prefix, workRoot);
    }
  } catch (err) {
    // ... existing error handling ...
  }
  // ... existing controller/ttl setup ...

  const lease = {
    workerId: `ephemeral-${shortId}`,
    doer: pair.doer,
    reviewer: pair.reviewer,
    signal: controller.signal,
    release,
  };

  if (doerOnly) {
    lease.upgradeToReviewer = async () => {
      const { reviewer } = await this.#manager.provisionReviewer(prefix, workRoot);
      lease.reviewer = reviewer;
    };
  }

  return lease;
}
```

Update the `release` function to teardown only what was provisioned (use `teardownPair` — it already handles missing members gracefully).

- [ ] **Step 8: Run all pool tests to verify pass + no regressions**

Run: `node --test tests/pool-member-manager.test.mjs tests/pool-ephemeral-factory.test.mjs tests/pool-worker-dispatcher.test.mjs tests/pool-index.test.mjs`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add pool/member-manager.mjs pool/ephemeral-factory.mjs tests/pool-member-manager.test.mjs tests/pool-ephemeral-factory.test.mjs
git commit -m "feat(pool): deferred reviewer registration — doer-only lease with upgradeToReviewer"
```

---

### Task 2: Router Module — Classifier and Workflow Executor

**Files:**
- Create: `host/router.mjs`
- Test: `tests/host-router.test.mjs`

**Interfaces:**
- Consumes: `fleetApi.executePrompt({ member_name, prompt })`, tool registry entries with `routing` blocks
- Produces:
  - `buildClassifierPrompt(goal, routableWorkflows) → string`
  - `parseClassifierResponse(text, { routableNames, fallbackStrategy }) → { path, workflow?, args? }`
  - `classify(goal, { fleetApi, lease, registry, fallbackStrategy }) → { path, workflow?, args? }`
  - `executeWorkflow(name, args, { fleetApi, toolRegistry, signal, onProgress }) → { status, result, history, budget }`

- [ ] **Step 1: Write failing tests for buildClassifierPrompt**

Create `tests/host-router.test.mjs`:

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const { buildClassifierPrompt, parseClassifierResponse, classify, executeWorkflow } =
  await import('../host/router.mjs');

describe('buildClassifierPrompt', () => {
  test('includes workflow names and descriptions from routing blocks', () => {
    const registry = [
      { name: 'quick-weather', routing: { description: 'weather for a city', args: { city: { extract: 'city name' } } } },
      { name: 'weather', description: 'raw weather tool' },
    ];
    const prompt = buildClassifierPrompt('weather in Tokyo', registry);
    assert.ok(prompt.includes('quick-weather'), 'should include routable workflow');
    assert.ok(prompt.includes('weather for a city'), 'should include routing description');
    assert.ok(!prompt.includes('raw weather tool'), 'should NOT include non-routable tool description');
    assert.ok(prompt.includes('weather in Tokyo'), 'should include user goal');
    assert.ok(prompt.includes('open-ended'), 'should mention open-ended strategy');
    assert.ok(prompt.includes('plan-execute'), 'should mention plan-execute strategy');
  });

  test('returns minimal prompt when no routable workflows exist', () => {
    const prompt = buildClassifierPrompt('hello', []);
    assert.ok(prompt.includes('hello'));
    assert.ok(prompt.includes('open-ended'));
    assert.ok(prompt.includes('plan-execute'));
  });
});
```

- [ ] **Step 2: Write failing tests for parseClassifierResponse**

Add to `tests/host-router.test.mjs`:

```js
describe('parseClassifierResponse', () => {
  const routableNames = new Set(['quick-weather', 'city-briefing']);

  test('parses valid workflow response', () => {
    const result = parseClassifierResponse(
      '{"path":"workflow","workflow":"quick-weather","args":{"city":"Tokyo"}}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'workflow', workflow: 'quick-weather', args: { city: 'Tokyo' } });
  });

  test('parses valid open-ended response', () => {
    const result = parseClassifierResponse(
      '{"path":"open-ended"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });

  test('parses valid plan-execute response', () => {
    const result = parseClassifierResponse(
      '{"path":"plan-execute"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'plan-execute' });
  });

  test('strips markdown fences before parsing', () => {
    const result = parseClassifierResponse(
      '```json\n{"path":"workflow","workflow":"quick-weather","args":{"city":"London"}}\n```',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.equal(result.path, 'workflow');
    assert.equal(result.workflow, 'quick-weather');
  });

  test('falls back on invalid JSON', () => {
    const result = parseClassifierResponse(
      'I think you should use the weather tool',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });

  test('falls back on unknown workflow name', () => {
    const result = parseClassifierResponse(
      '{"path":"workflow","workflow":"nonexistent","args":{}}',
      { routableNames, fallbackStrategy: 'plan-execute' },
    );
    assert.deepEqual(result, { path: 'plan-execute' });
  });

  test('falls back on invalid path value', () => {
    const result = parseClassifierResponse(
      '{"path":"something-else"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });

  test('falls back when path is workflow but workflow field is missing', () => {
    const result = parseClassifierResponse(
      '{"path":"workflow"}',
      { routableNames, fallbackStrategy: 'open-ended' },
    );
    assert.deepEqual(result, { path: 'open-ended' });
  });
});
```

- [ ] **Step 3: Write failing tests for classify**

Add to `tests/host-router.test.mjs`:

```js
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

describe('classify', () => {
  test('sends classifier prompt to doer and returns parsed route', async () => {
    const fleetApi = createMockFleetApi({
      promptResponses: () => '{"path":"workflow","workflow":"quick-weather","args":{"city":"Tokyo"}}',
    });
    const registry = [
      { name: 'quick-weather', routing: { description: 'weather for a city', args: { city: { extract: 'city name' } } } },
    ];
    const result = await classify('weather in Tokyo', {
      fleetApi, registry, fallbackStrategy: 'open-ended',
    });
    assert.equal(result.path, 'workflow');
    assert.equal(result.workflow, 'quick-weather');
    assert.deepEqual(result.args, { city: 'Tokyo' });
    assert.equal(fleetApi.promptCalls.length, 1);
    assert.equal(fleetApi.promptCalls[0].member_name, 'doer');
  });

  test('returns fallback when doer returns invalid JSON', async () => {
    const fleetApi = createMockFleetApi({
      promptResponses: () => 'I am not sure what to do',
    });
    const result = await classify('something weird', {
      fleetApi, registry: [], fallbackStrategy: 'plan-execute',
    });
    assert.deepEqual(result, { path: 'plan-execute' });
  });
});
```

- [ ] **Step 4: Write failing tests for executeWorkflow**

Add to `tests/host-router.test.mjs`:

```js
describe('executeWorkflow', () => {
  test('runs the named workflow and returns completed result', async () => {
    const registry = [
      {
        name: 'test-wf',
        routing: { description: 'test', args: {} },
        async run({ args }) { return { answer: `hello ${args.city}` }; },
      },
    ];
    const result = await executeWorkflow('test-wf', { city: 'Tokyo' }, {
      fleetApi: {}, toolRegistry: registry, signal: null, onProgress: null,
    });
    assert.equal(result.status, 'completed');
    assert.ok(result.result.includes('Tokyo'));
  });

  test('returns failed for unknown workflow', async () => {
    const result = await executeWorkflow('nonexistent', {}, {
      fleetApi: {}, toolRegistry: [], signal: null, onProgress: null,
    });
    assert.equal(result.status, 'failed');
  });

  test('returns cancelled when workflow throws AbortError', async () => {
    const registry = [
      {
        name: 'abort-wf',
        routing: { description: 'test', args: {} },
        async run() { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
      },
    ];
    const result = await executeWorkflow('abort-wf', {}, {
      fleetApi: {}, toolRegistry: registry, signal: null, onProgress: null,
    });
    assert.equal(result.status, 'cancelled');
  });
});
```

- [ ] **Step 5: Run tests to verify they all fail**

Run: `node --test tests/host-router.test.mjs`
Expected: FAIL — module `host/router.mjs` does not exist

- [ ] **Step 6: Implement host/router.mjs**

Create `host/router.mjs`:

```js
const VALID_PATHS = new Set(['workflow', 'open-ended', 'plan-execute']);

export function buildClassifierPrompt(goal, registry) {
  const routable = registry.filter(t => t.routing);
  const workflowLines = routable.map(t => {
    const argDesc = Object.entries(t.routing.args ?? {})
      .map(([k, v]) => `${k}: ${v.extract}`)
      .join(', ');
    return `- ${t.name}: ${t.routing.description}${argDesc ? ` (extract: ${argDesc})` : ''}`;
  }).join('\n');

  const workflowSection = routable.length > 0
    ? `Available workflows (predefined, fastest — pick one if the goal is a direct match):\n${workflowLines}\n\n`
    : '';

  return `You are a task router for a travel assistant. Given the user's goal, decide the best execution path.

${workflowSection}Available strategies (flexible, for goals that don't match a workflow):
- open-ended: Good for simple questions needing 1-2 tool calls or conversational replies.
- plan-execute: For complex multi-step tasks that need planning, multiple tools in a dynamic order, and review. Use only when the task genuinely requires it.

User's goal: "${goal}"

Respond with ONLY a JSON object, no other text:
{"path":"workflow|open-ended|plan-execute","workflow":"name-if-workflow","args":{extracted args if workflow}}`;
}

export function parseClassifierResponse(text, { routableNames, fallbackStrategy }) {
  const fallback = { path: fallbackStrategy };
  if (!text || typeof text !== 'string') return fallback;

  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return fallback;
  }

  if (!parsed || typeof parsed !== 'object') return fallback;
  if (!VALID_PATHS.has(parsed.path)) return fallback;

  if (parsed.path === 'workflow') {
    if (!parsed.workflow || !routableNames.has(parsed.workflow)) return fallback;
    return { path: 'workflow', workflow: parsed.workflow, args: parsed.args ?? {} };
  }

  return { path: parsed.path };
}

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

export async function classify(goal, { fleetApi, registry, fallbackStrategy }) {
  const routableNames = new Set(registry.filter(t => t.routing).map(t => t.name));
  const prompt = buildClassifierPrompt(goal, registry);

  try {
    const raw = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const text = extractText(raw);
    return parseClassifierResponse(text, { routableNames, fallbackStrategy });
  } catch {
    return { path: fallbackStrategy };
  }
}

export async function executeWorkflow(name, args, { fleetApi, toolRegistry, signal, onProgress }) {
  const entry = toolRegistry.find(t => t.name === name && t.routing);
  if (!entry) {
    return { status: 'failed', result: { error: 'workflow_not_found', message: `Workflow "${name}" not found` }, history: [], budget: null };
  }
  try {
    const result = await entry.run({ fleetApi, args: args ?? {}, signal, reportPhase: onProgress });
    return {
      status: 'completed',
      result: typeof result === 'string' ? result : JSON.stringify(result),
      history: [],
      budget: null,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 'cancelled', result: null, history: [], budget: null };
    }
    return { status: 'failed', result: { error: 'workflow_failed', message: String(err?.message ?? err) }, history: [], budget: null };
  }
}
```

- [ ] **Step 7: Run router tests to verify they pass**

Run: `node --test tests/host-router.test.mjs`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add host/router.mjs tests/host-router.test.mjs
git commit -m "feat(router): classifier prompt builder, response parser, classify, and executeWorkflow"
```

---

### Task 3: Config Validation and Host Wiring

**Files:**
- Modify: `host/config.mjs` (add `router` to known/implemented modules, validation rules, env overrides)
- Modify: `host/index.mjs` (pass `routerConfig` to `executeHostedTask`)
- Modify: `host/tasks.mjs` (add routing step in `executeHostedTask`)
- Modify: `host.config.mjs`, `host.config.local-functions.mjs`, `deploy/azure-functions/host.config.mjs` (add `modules.router`)
- Test: `tests/host-config.test.mjs` (add router validation cases)
- Test: `tests/host-tasks-routing.test.mjs` (new — integration test)

**Interfaces:**
- Consumes: `classify()`, `executeWorkflow()` from Task 2; `lease.upgradeToReviewer()` from Task 1; `createPooledFleetApi` from `pool/pooled-fleet-api.mjs`
- Produces: `executeHostedTask` now accepts `routerConfig` and returns `routedTo` field in result

- [ ] **Step 1: Write failing config validation tests**

In `tests/host-config.test.mjs`, add:

```js
test('router.enabled with runLoop disabled throws', async () => {
  await assert.rejects(
    () => loadConfig(configDir({ modules: { router: { enabled: true }, runLoop: { enabled: false } } })),
    /runLoop/,
  );
});

test('router.fallbackStrategy must be open-ended or plan-execute', async () => {
  await assert.rejects(
    () => loadConfig(configDir({
      modules: { router: { enabled: true, fallbackStrategy: 'invalid' }, runLoop: { enabled: true } },
    })),
    /fallbackStrategy/,
  );
});

test('router.enabled: false is accepted without error', async () => {
  const config = await loadConfig(configDir({
    modules: { router: { enabled: false }, runLoop: { enabled: true } },
  }));
  assert.ok(config);
});

test('router config resolves from env overrides', async () => {
  const config = await loadConfig(configDir({
    modules: { runLoop: { enabled: true } },
  }), { ...process.env, ROUTER_ENABLED: 'true', ROUTER_FALLBACK_STRATEGY: 'plan-execute' });
  assert.equal(config.modules.router.enabled, true);
  assert.equal(config.modules.router.fallbackStrategy, 'plan-execute');
});
```

Note: adapt the `configDir` helper to match the existing test pattern in this file — it writes a temp `host.config.mjs` and returns the directory.

- [ ] **Step 2: Run config tests to verify they fail**

Run: `node --test tests/host-config.test.mjs`
Expected: FAIL on the new tests

- [ ] **Step 3: Implement config validation for router**

In `host/config.mjs`:

Add `'router'` to both `KNOWN_MODULES` and `IMPLEMENTED_MODULES` sets.

In the `validate()` function, after the existing `modules.dispatch` block but before `modules.notify`, add:

```js
const routerRaw = modules.router ?? {};
const routerEnabled = routerRaw.enabled
  ?? (String(env.ROUTER_ENABLED ?? '').toLowerCase() === 'true')
  || (env.ROUTER_ENABLED === '1');
const routerFallback = env.ROUTER_FALLBACK_STRATEGY ?? routerRaw.fallbackStrategy ?? 'open-ended';

if (routerEnabled && !runLoopEnabled) {
  throw new Error('router enabled but runLoop disabled — the router needs the run loop as a fallback; enable runLoop or disable router');
}
if (routerEnabled && !['open-ended', 'plan-execute'].includes(routerFallback)) {
  throw new Error(`router.fallbackStrategy must be "open-ended" or "plan-execute", got "${routerFallback}"`);
}

modules.router = Object.freeze({ enabled: routerEnabled, fallbackStrategy: routerFallback });

if (routerEnabled) {
  console.warn('[host/config] router enabled — tasks will be classified before execution');
}
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `node --test tests/host-config.test.mjs`
Expected: All PASS (new and existing)

- [ ] **Step 5: Add modules.router to all three config files**

In `host.config.mjs`, `host.config.local-functions.mjs`, and `deploy/azure-functions/host.config.mjs`, add inside `modules:`:

```js
router: {
  enabled: true,
  fallbackStrategy: 'open-ended',
},
```

- [ ] **Step 6: Write failing integration test for routing in executeHostedTask**

Create `tests/host-tasks-routing.test.mjs`:

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

describe('executeHostedTask routing', () => {
  function makeMockDispatcher(fleetApi) {
    return {
      capacity: 1,
      async dispatch({ members } = {}) {
        const doerOnly = Array.isArray(members) && members.length === 1 && members[0] === 'doer';
        return {
          workerId: 'test-worker',
          doer: { name: 'TEST-DOER' },
          reviewer: doerOnly ? null : { name: 'TEST-REVIEWER' },
          signal: null,
          release: async () => {},
          upgradeToReviewer: async () => {},
        };
      },
    };
  }

  test('routes to workflow when classifier returns workflow path', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: (opts) => {
        if (opts.prompt.includes('task router')) {
          return '{"path":"workflow","workflow":"test-wf","args":{"city":"Tokyo"}}';
        }
        return '```done\nresult: hello Tokyo\n```';
      },
    });
    const registry = [{
      name: 'test-wf',
      routing: { description: 'test workflow', args: { city: { extract: 'city' } } },
      async run({ args }) { return { answer: `hello ${args.city}` }; },
    }];
    const result = await executeHostedTask(
      { goal: 'weather in Tokyo' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: registry,
        runLoopConfig: { strategy: 'plan-execute' },
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.routedTo, 'workflow:test-wf');
  });

  test('task.strategy override bypasses router', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: () => '```done\nresult: direct\n```',
    });
    const result = await executeHostedTask(
      { goal: 'anything', strategy: 'open-ended' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: [],
        runLoopConfig: { strategy: 'plan-execute' },
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.routedTo, 'open-ended');
    const classifierCalls = fleetApi.promptCalls.filter(c => c.prompt?.includes('task router'));
    assert.equal(classifierCalls.length, 0, 'classifier should not be called when strategy is explicit');
  });

  test('router.enabled: false falls back to runLoopConfig.strategy', async () => {
    const { executeHostedTask } = await import('../host/tasks.mjs');
    const fleetApi = createMockFleetApi({
      promptResponses: () => '```done\nresult: planned\n```',
    });
    const result = await executeHostedTask(
      { goal: 'plan something' },
      {
        api: fleetApi, activeDispatcher: makeMockDispatcher(fleetApi),
        toolRegistry: [],
        runLoopConfig: { strategy: 'open-ended' },
        routerConfig: { enabled: false, fallbackStrategy: 'open-ended' },
        budgetsConfig: null, guardrailsMod: null, jobs: null,
      },
    );
    assert.equal(result.routedTo, 'open-ended');
  });
});
```

- [ ] **Step 7: Run integration tests to verify they fail**

Run: `node --test tests/host-tasks-routing.test.mjs`
Expected: FAIL — `executeHostedTask` does not accept `routerConfig` or return `routedTo`

- [ ] **Step 8: Implement routing in host/tasks.mjs**

In `host/tasks.mjs`, add the import at the top:

```js
import { classify, executeWorkflow } from './router.mjs';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
```

Modify `executeHostedTask` signature to accept `routerConfig`:

```js
export async function executeHostedTask(task, {
  api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig,
  budgetsConfig, guardrailsMod, jobs, signal, onProgress,
}) {
```

After the lease is obtained and before the `runTask` call, add the routing logic:

```js
let strategy = task.strategy ?? null;
let workflowName = null;
let workflowArgs = null;
let routedTo = null;

if (!strategy && routerConfig?.enabled) {
  const route = await classify(task.goal ?? task.id, {
    fleetApi: createPooledFleetApi(api, lease),
    registry: toolRegistry,
    fallbackStrategy: routerConfig.fallbackStrategy ?? 'open-ended',
  });
  if (route.path === 'workflow') {
    workflowName = route.workflow;
    workflowArgs = route.args;
    strategy = 'workflow';
  } else {
    strategy = route.path;
  }
}

strategy ??= runLoopConfig.strategy ?? 'open-ended';
routedTo = workflowName ? `workflow:${workflowName}` : strategy;

if (strategy === 'plan-execute' && lease.upgradeToReviewer && !lease.reviewer) {
  await lease.upgradeToReviewer();
}

if (strategy === 'workflow') {
  const wfResult = await executeWorkflow(workflowName, workflowArgs, {
    fleetApi: createPooledFleetApi(api, lease),
    toolRegistry,
    signal: combined?.signal ?? signal,
    onProgress,
  });
  return { taskId: fullTask.id, traceId, routedTo, ...wfResult };
}
```

Add `routedTo` to the existing return at the end:

```js
return { taskId: fullTask.id, routedTo, ...result };
```

- [ ] **Step 9: Wire routerConfig through host/index.mjs**

In `host/index.mjs`, in the `startHost` function, after `runLoopConfig` is built (~line 112), add:

```js
const routerConfig = config.modules?.router ?? { enabled: false };
```

Pass it to both `runSync` and `runJob`:

```js
const runSync = (task, { signal } = {}) => executeHostedTask(task, {
  api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig, budgetsConfig, guardrailsMod, jobs, signal,
});
const runJob = (task, { signal, onProgress }) => settleWhenAborted(
  executeHostedTask(task, {
    api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig, budgetsConfig, guardrailsMod, jobs, signal, onProgress,
  }),
  signal,
);
```

Also update the `callTool` function's internal call and the builder's `.run()` method if they call `executeHostedTask` — add `routerConfig: { enabled: false }` to those since they are tool calls, not task routing.

- [ ] **Step 10: Run all routing and host tests**

Run: `node --test tests/host-tasks-routing.test.mjs tests/host-config.test.mjs tests/host-index.test.mjs tests/host-tasks.test.mjs`
Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add host/config.mjs host/index.mjs host/tasks.mjs host.config.mjs host.config.local-functions.mjs deploy/azure-functions/host.config.mjs tests/host-config.test.mjs tests/host-tasks-routing.test.mjs
git commit -m "feat(router): classify tasks and route to workflow/open-ended/plan-execute"
```

---

### Task 4: Starter Workflows + Registry Routing Metadata

**Files:**
- Create: `workflows/quick-weather/workflow.json`, `workflows/quick-weather/quick-weather.js`, `workflows/quick-weather/main.mjs`
- Create: `workflows/destination-overview/workflow.json`, `workflows/destination-overview/destination-overview.js`, `workflows/destination-overview/main.mjs`
- Create: `workflows/travel-prep/workflow.json`, `workflows/travel-prep/travel-prep.js`, `workflows/travel-prep/main.mjs`
- Create: `workflows/route-check/workflow.json`, `workflows/route-check/route-check.js`, `workflows/route-check/main.mjs`
- Modify: `workflows/city-briefing/workflow.json` (add routing block)
- Modify: `mcp/registry.mjs` (add routing blocks + register 4 new workflows)
- Test: `tests/host-workflow-runner.test.mjs` (new)
- Test: `tests/host-registry-routing.test.mjs` (new)

**Interfaces:**
- Consumes: `fleetApi.executeCommand()`, `fleetApi.executePrompt()`, `@apralabs/apra-fleet-workflow` engine, tool scripts in `tools/`
- Produces: 5 routable workflows visible via `registry.filter(t => t.routing)`, each with `async run({ fleetApi, args, signal, reportPhase })`

- [ ] **Step 1: Write failing registry routing metadata test**

Create `tests/host-registry-routing.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRegistry } from '../mcp/registry.mjs';

test('routable workflows have routing.description and routing.args', () => {
  const routable = defaultRegistry.filter(t => t.routing);
  assert.ok(routable.length >= 5, `expected at least 5 routable workflows, got ${routable.length}`);
  for (const entry of routable) {
    assert.ok(typeof entry.routing.description === 'string' && entry.routing.description.length > 0,
      `${entry.name} missing routing.description`);
    assert.ok(typeof entry.routing.args === 'object',
      `${entry.name} missing routing.args`);
  }
});

test('non-routable tools do not have routing blocks', () => {
  const nonRoutable = defaultRegistry.filter(t => !t.routing);
  const toolNames = nonRoutable.map(t => t.name);
  assert.ok(toolNames.includes('weather'), 'weather tool should not be routable');
  assert.ok(toolNames.includes('timezone'), 'timezone tool should not be routable');
  assert.ok(toolNames.includes('demo'), 'demo should not be routable');
});

test('each routable workflow has a run function', () => {
  const routable = defaultRegistry.filter(t => t.routing);
  for (const entry of routable) {
    assert.equal(typeof entry.run, 'function', `${entry.name} missing run()`);
  }
});
```

- [ ] **Step 2: Write failing workflow runner tests**

Create `tests/host-workflow-runner.test.mjs`:

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

describe('quick-weather workflow', () => {
  test('calls weather and forecast tools then composes via agent', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: (opts) => {
        if (opts.command.includes('weather.py')) return '{"ok":true,"temp":"25C","condition":"sunny"}';
        if (opts.command.includes('forecast.py')) return '{"ok":true,"days":[{"high":26,"low":18}]}';
        return '{}';
      },
      promptResponses: () => 'Sunny in Tokyo, 25C today with highs of 26C tomorrow.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'quick-weather');
    assert.ok(wf, 'quick-weather should be in registry');

    const result = await wf.run({ fleetApi, args: { city: 'Tokyo' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 2, 'should call at least 2 tools');
    assert.ok(fleetApi.promptCalls.length >= 1, 'should call agent to compose');
    assert.ok(typeof result === 'string' || (typeof result === 'object' && result !== null));
  });
});

describe('destination-overview workflow', () => {
  test('calls wikipedia-summary and places-of-interest then composes', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: (opts) => {
        if (opts.command.includes('wikipedia_summary.py')) return '{"ok":true,"title":"Port Blair","extract":"Capital of Andaman"}';
        if (opts.command.includes('places_of_interest.py')) return '{"ok":true,"places":[{"title":"Cellular Jail"}]}';
        return '{}';
      },
      promptResponses: () => 'Port Blair is the capital of Andaman. Visit Cellular Jail.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'destination-overview');
    assert.ok(wf);
    const result = await wf.run({ fleetApi, args: { destination: 'Port Blair' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 2);
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});

describe('travel-prep workflow', () => {
  test('calls country-info, travel-advisory, currency, public-holidays then composes', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: () => '{"ok":true}',
      promptResponses: () => 'Japan travel prep: visa required, use JPY.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'travel-prep');
    assert.ok(wf);
    const result = await wf.run({ fleetApi, args: { country: 'Japan' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 4, 'should call 4 tools');
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});

describe('route-check workflow', () => {
  test('calls route-distance then composes', async () => {
    const fleetApi = createMockFleetApi({
      commandPayload: () => '{"ok":true,"distance_km":530,"duration_hours":10.5}',
      promptResponses: () => 'Delhi to Manali is 530km, about 10.5 hours driving.',
    });
    const { defaultRegistry } = await import('../mcp/registry.mjs');
    const wf = defaultRegistry.find(t => t.name === 'route-check');
    assert.ok(wf);
    const result = await wf.run({ fleetApi, args: { from: 'Delhi', to: 'Manali' }, workspace: { doer: { name: 'DOER' } } });
    assert.ok(fleetApi.commandCalls.length >= 1);
    assert.ok(fleetApi.promptCalls.length >= 1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/host-registry-routing.test.mjs tests/host-workflow-runner.test.mjs`
Expected: FAIL — workflows not yet registered, routing blocks missing

Note: The workflow `main.mjs` files import `@apralabs/apra-fleet-workflow`. The workflow runner tests call `entry.run()` from the registry, which calls the `run` wrapper in `mcp/registry.mjs` — not the engine directly. The mock fleet API handles `executeCommand` and `executePrompt` so no real Fleet or engine is needed. However, the registry imports (`import { runQuickWeather } from '...'`) will fail if the `@apralabs/apra-fleet-workflow` package is not resolvable. The existing `tests/setup-fleet-modules.mjs` and `workflows/demo/ensure-apralabs.mjs` handle this — run `node tests/setup-fleet-modules.mjs` first if imports fail, same as existing workflow tests.

- [ ] **Step 4: Create quick-weather workflow files**

`workflows/quick-weather/workflow.json`:
```json
{
  "name": "quick-weather",
  "entry": "quick-weather.js",
  "description": "Fetches current weather and 3-day forecast for a city"
}
```

`workflows/quick-weather/quick-weather.js`:
```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'quick-weather' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const WEATHER_PY = path.join(toolsDir, 'weather', 'weather.py');
const FORECAST_PY = path.join(toolsDir, 'forecast', 'forecast.py');

function safeJson(text) {
  try { return JSON.parse(typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? ''); }
  catch { return { ok: false, error: 'parse failed', raw: String(text) }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const city = args.city || 'London';
  const signal = args.signal;
  const cancelled = () => signal?.aborted === true;

  phase('weather');
  const weatherRaw = await command(`python3 "${WEATHER_PY}" "${city}"`, { member_name: 'doer', failSoft: true });
  const weather = safeJson(weatherRaw);
  log(`weather: ${JSON.stringify(weather)}`);
  if (cancelled()) return { cancelled: true, weather };

  phase('forecast');
  const forecastRaw = await command(`python3 "${FORECAST_PY}" "${city}" 3`, { member_name: 'doer', failSoft: true });
  const forecast = safeJson(forecastRaw);
  log(`forecast: ${JSON.stringify(forecast)}`);
  if (cancelled()) return { cancelled: true, weather, forecast };

  phase('compose');
  const prompt = [
    `You are a concise travel weather assistant. Given the data below, write a short 3-4 sentence weather summary for ${city}.`,
    `Include current conditions, temperature, and the 3-day outlook. End with one practical tip.`,
    '', `Weather: ${JSON.stringify(weather)}`, `Forecast: ${JSON.stringify(forecast)}`,
    '', 'Reply with ONLY the summary text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { city, weather, forecast, answer };
}
```

`workflows/quick-weather/main.mjs`: follow the exact pattern of `workflows/city-briefing/main.mjs`, replacing `runCityBriefing` with `runQuickWeather`, importing the `quick-weather.js` engine script, and passing `city` as the arg.

- [ ] **Step 5: Create destination-overview, travel-prep, and route-check workflows**

Follow the same three-file pattern (`workflow.json`, `<name>.js`, `main.mjs`) for each. The `.js` files follow the same structure as quick-weather:

**destination-overview.js**: calls `wikipedia_summary.py` with `args.destination`, then `places_of_interest.py` with `args.destination`, then LLM compose.

**travel-prep.js**: calls `country_info.py` with `args.country`, `travel_advisory.py` with `args.country`, `currency.py` with `"INR" "${args.country}"`, `public_holidays.py` with `args.country`, then LLM compose.

**route-check.js**: calls `route_distance.py` with `"${args.from}" "${args.to}"`, then LLM compose.

Each compose prompt should instruct the LLM to write a concise, practical summary using the tool data.

- [ ] **Step 6: Add routing blocks to mcp/registry.mjs**

Add routing blocks to the existing `city-briefing` entry:

```js
routing: {
  description: 'Weather + local time + short briefing for a city',
  args: { city: { extract: 'city name from the goal' } },
},
```

Add 4 new workflow entries to the `defaultRegistry` array with their routing blocks. Each entry imports its `run` function from the workflow's `main.mjs` and wraps it the same way `city-briefing` does:

```js
import { runQuickWeather } from '../workflows/quick-weather/main.mjs';
import { runDestinationOverview } from '../workflows/destination-overview/main.mjs';
import { runTravelPrep } from '../workflows/travel-prep/main.mjs';
import { runRouteCheck } from '../workflows/route-check/main.mjs';
```

Each entry:
```js
{
  name: 'quick-weather',
  description: 'Fetches current weather and 3-day forecast for a city. Uses weather and forecast tools plus one agent compose call.',
  routing: {
    description: 'Current weather + short forecast for a single city',
    args: { city: { extract: 'city name from the goal' } },
  },
  inputSchema: z.object({ city: z.string().optional().describe('City name. Defaults to London.') }),
  annotations: { readOnlyHint: true, idempotentHint: false },
  async run({ fleetApi, args, signal, reportPhase, workspace }) {
    const result = await runQuickWeather({ fleetApi, workspace, city: args.city, signal, reportPhase });
    return `quick weather completed: ${JSON.stringify(result)}`;
  },
},
```

Repeat for destination-overview (arg: `destination`), travel-prep (arg: `country`), route-check (args: `from`, `to`).

- [ ] **Step 7: Update workflows/city-briefing/workflow.json**

Add routing block:
```json
{
  "name": "city-briefing",
  "entry": "city-briefing.js",
  "description": "Weather + local time + short city briefing",
  "routing": {
    "description": "Weather + local time + short briefing for a city",
    "args": { "city": "city name from the goal" }
  }
}
```

- [ ] **Step 8: Run all workflow and registry tests**

Run: `node --test tests/host-registry-routing.test.mjs tests/host-workflow-runner.test.mjs`
Expected: All PASS

- [ ] **Step 9: Run full existing test suite to check for regressions**

Run: `node --test tests/host-config.test.mjs tests/host-registry.test.mjs tests/mcp.test.mjs tests/host-index.test.mjs`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add workflows/quick-weather/ workflows/destination-overview/ workflows/travel-prep/ workflows/route-check/ workflows/city-briefing/workflow.json mcp/registry.mjs tests/host-registry-routing.test.mjs tests/host-workflow-runner.test.mjs
git commit -m "feat(workflows): 4 starter workflows + routing metadata on registry entries"
```

---

### Task 5: npm Script + Full Regression + E2E Scenario Updates

**Files:**
- Modify: `package.json` (add `test:router` script)
- Modify: `tests/e2e/scenarios/s01-tokyo-weather.json`, `s02-nyc-time-weather.json`, `s05-us-japan-currency.json`, `s10-europe-capitals.json` (add `expectedRoute`)

**Interfaces:**
- Consumes: all prior tasks
- Produces: `npm run test:router` script; updated e2e fixtures

- [ ] **Step 1: Add test:router npm script**

In `package.json`, add to `"scripts"`:

```json
"test:router": "node --test tests/host-router.test.mjs tests/host-tasks-routing.test.mjs tests/host-workflow-runner.test.mjs tests/host-registry-routing.test.mjs"
```

- [ ] **Step 2: Update e2e scenario fixtures**

In each scenario JSON, add the `expectedRoute` field:

`s01-tokyo-weather.json`: add `"expectedRoute": "workflow:quick-weather"`
`s02-nyc-time-weather.json`: add `"expectedRoute": "workflow:city-briefing"`
`s05-us-japan-currency.json`: add `"expectedRoute": "workflow:travel-prep"`
`s10-europe-capitals.json`: add `"expectedRoute": "plan-execute"`

These fields are informational for now — the e2e test runner can optionally assert on them when the router is enabled.

- [ ] **Step 3: Run the full test:router suite**

Run: `npm run test:router`
Expected: All PASS

- [ ] **Step 4: Run the complete existing test suites for regression**

Run: `npm test && npm run test:host && npm run test:phase2 && npm run test:phase4 && npm run test:chat`
Expected: All PASS — no regressions

- [ ] **Step 5: Commit**

```bash
git add package.json tests/e2e/scenarios/
git commit -m "chore: add test:router script and expectedRoute to e2e scenarios"
```
