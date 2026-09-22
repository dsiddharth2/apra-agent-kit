# Fleet Agent Kit — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add autonomous agent capabilities — a run loop that plans and executes tool calls via the LLM, budget enforcement, and guardrails — so the kit can receive a task and return a result without an external orchestrator.

**Architecture:** Three new modules (`host/run-loop.mjs`, `host/budgets.mjs`, `host/guardrails.mjs`) plug into the existing `host/index.mjs` entry point. Two strategy generators (`host/strategies/plan-execute.mjs`, `host/strategies/open-ended.mjs`) drive the loop. Prompt templates (`host/prompts/`) compose LLM calls. A response parser extracts structured JSON blocks from LLM text. Seven new Python tool scripts extend the Travel Research Agent tool set.

**Tech Stack:** Node 22, ESM, `node:test` runner, Zod v4, existing `pool/` and `transport/` modules, Python 3 stdlib for tool scripts.

**Spec:** `docs/specs/2026-09-16-fleet-agent-kit-phase2-spec.md`

---

## Task dependency graph

```
Tasks 1-5 are independent (parallel)
Task 6 depends on Tasks 1, 2
Tasks 7, 8 depend on Tasks 1, 5, 6
Task 9 depends on Tasks 3, 4, 7, 8
Tasks 10, 11 depend on Task 9
Task 12 is independent
Tasks 13-15 depend on all above
```

---

### Task 1: Response parser

Extracts fenced JSON blocks (`tool_call`, `plan`, `done`, `review`, `step_review`) from LLM response text. This is the foundation every strategy depends on.

**Files:**
- Create: `host/response-parser.mjs`
- Test: `tests/host-response-parser.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-response-parser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseResponse } = await import('../host/response-parser.mjs');

test('extracts tool_call block', () => {
  const text = `I need to check the weather.

\`\`\`tool_call
{"tool": "weather", "args": {"city": "London"}}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'tool_call');
  assert.deepEqual(result.payload, { tool: 'weather', args: { city: 'London' } });
  assert.equal(result.reasoning, 'I need to check the weather.');
});

test('extracts plan block', () => {
  const text = `Here is my plan.

\`\`\`plan
{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'plan');
  assert.equal(result.payload.steps.length, 1);
  assert.equal(result.payload.steps[0].tool, 'weather');
});

test('extracts done block', () => {
  const text = `All done.

\`\`\`done
{"result": "London is 15°C", "summary": "Weather check completed."}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'done');
  assert.equal(result.payload.result, 'London is 15°C');
  assert.equal(result.payload.summary, 'Weather check completed.');
});

test('extracts review block', () => {
  const text = `Plan looks good.

\`\`\`review
{"approved": true}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'review');
  assert.equal(result.payload.approved, true);
});

test('extracts review block with feedback', () => {
  const text = `Two problems found.

\`\`\`review
{"approved": false, "feedback": "Step 2 uses wrong tool."}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'review');
  assert.equal(result.payload.approved, false);
  assert.equal(result.payload.feedback, 'Step 2 uses wrong tool.');
});

test('extracts step_review block', () => {
  const text = `Result looks correct.

\`\`\`step_review
{"approved": true}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'step_review');
  assert.equal(result.payload.approved, true);
});

test('extracts step_review rejection', () => {
  const text = `Wrong city returned.

\`\`\`step_review
{"approved": false, "feedback": "Got London instead of Paris."}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'step_review');
  assert.equal(result.payload.approved, false);
  assert.equal(result.payload.feedback, 'Got London instead of Paris.');
});

test('returns thinking when no block found', () => {
  const text = 'Let me think about this for a moment...';
  const result = parseResponse(text);
  assert.equal(result.type, 'thinking');
  assert.equal(result.reasoning, text);
  assert.equal(result.payload, null);
});

test('returns error for malformed JSON inside block', () => {
  const text = `Here we go.

\`\`\`tool_call
{not valid json}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'error');
  assert.ok(result.message.includes('JSON'));
});

test('first block wins when multiple blocks present', () => {
  const text = `Doing both.

\`\`\`tool_call
{"tool": "weather", "args": {}}
\`\`\`

\`\`\`done
{"result": "done"}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'tool_call');
});

test('extracts reasoning text before block', () => {
  const text = `First I will check the weather.
Then I can compose a briefing.

\`\`\`tool_call
{"tool": "weather", "args": {"city": "Tokyo"}}
\`\`\``;
  const result = parseResponse(text);
  assert.ok(result.reasoning.includes('First I will check the weather'));
  assert.ok(result.reasoning.includes('Then I can compose'));
});

test('handles block with extra whitespace', () => {
  const text = `Ok.

\`\`\`  tool_call  
  {"tool": "weather", "args": {}}  
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'tool_call');
  assert.equal(result.payload.tool, 'weather');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-response-parser.test.mjs`
Expected: FAIL — `host/response-parser.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/response-parser.mjs

const BLOCK_TYPES = new Set(['tool_call', 'plan', 'done', 'review', 'step_review']);

const FENCE_RE = /```\s*(\w+)\s*\n([\s\S]*?)```/;

export function parseResponse(text) {
  const match = FENCE_RE.exec(text);
  if (!match) {
    return { type: 'thinking', reasoning: text.trim(), payload: null };
  }

  const blockType = match[1].trim();
  const jsonStr = match[2].trim();
  const reasoning = text.slice(0, match.index).trim();

  if (!BLOCK_TYPES.has(blockType)) {
    return { type: 'thinking', reasoning: text.trim(), payload: null };
  }

  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (err) {
    return { type: 'error', message: `Invalid JSON in ${blockType} block: ${err.message}`, reasoning };
  }

  return { type: blockType, payload, reasoning };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-response-parser.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/response-parser.mjs tests/host-response-parser.test.mjs
git commit -m "feat: add LLM response parser for fenced JSON blocks"
```

---

### Task 2: Format tools

Renders the tool registry into a text catalog the LLM reads when deciding which tool to call.

**Files:**
- Create: `host/prompts/format-tools.mjs`
- Test: `tests/host-format-tools.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-format-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';

const { formatTools } = await import('../host/prompts/format-tools.mjs');

const sampleTools = [
  {
    name: 'weather',
    description: 'Fetches current weather for a city.',
    inputSchema: z.object({ city: z.string().optional() }),
    reversible: true,
    tags: [],
  },
  {
    name: 'timezone',
    description: 'Fetches current local time and timezone.',
    inputSchema: z.object({ city: z.string().optional() }),
    reversible: true,
    tags: [],
  },
  {
    name: 'demo',
    description: 'Runs the demo workflow.',
    reversible: false,
    tags: [],
  },
];

test('includes all tool names', () => {
  const text = formatTools(sampleTools);
  assert.ok(text.includes('weather'));
  assert.ok(text.includes('timezone'));
  assert.ok(text.includes('demo'));
});

test('includes tool descriptions', () => {
  const text = formatTools(sampleTools);
  assert.ok(text.includes('Fetches current weather'));
  assert.ok(text.includes('Fetches current local time'));
  assert.ok(text.includes('Runs the demo workflow'));
});

test('marks irreversible tools', () => {
  const text = formatTools(sampleTools);
  assert.ok(/demo.*\[irreversible\]/i.test(text));
});

test('marks reversible tools', () => {
  const text = formatTools(sampleTools);
  assert.ok(/weather.*\[reversible\]/i.test(text));
});

test('renders parameter names from inputSchema', () => {
  const text = formatTools(sampleTools);
  assert.ok(/weather\(.*city/i.test(text));
});

test('renders no params for tools without inputSchema', () => {
  const text = formatTools(sampleTools);
  assert.ok(/demo\(\)/.test(text));
});

test('empty registry returns header only', () => {
  const text = formatTools([]);
  assert.ok(text.includes('Available tools'));
  assert.ok(!text.includes('- '));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-format-tools.test.mjs`
Expected: FAIL — `host/prompts/format-tools.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/prompts/format-tools.mjs

function schemaParams(tool) {
  if (!tool.inputSchema) return '';
  const shape = tool.inputSchema._zod?.def?.shape;
  if (!shape) return '';
  const params = Object.entries(shape).map(([key, field]) => {
    const optional = field._zod?.def?.optional || field.isOptional?.() ? '?' : '';
    return `${key}${optional}`;
  });
  return params.join(', ');
}

export function formatTools(tools) {
  const lines = ['Available tools:', ''];
  for (const tool of tools) {
    const params = schemaParams(tool);
    const sig = `${tool.name}(${params})`;
    const rev = tool.reversible === false ? '[irreversible]' : '[reversible]';
    lines.push(`- ${sig} — ${tool.description} ${rev}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-format-tools.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/prompts/format-tools.mjs tests/host-format-tools.test.mjs
git commit -m "feat: add tool catalog formatter for LLM prompts"
```

---

### Task 3: Budgets module

Tracks iteration count, tokens, estimated cost, and elapsed time. The run loop calls `record()` after each `executePrompt` and `check()` after each iteration.

**Files:**
- Create: `host/budgets.mjs`
- Test: `tests/host-budgets.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-budgets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createBudgets } = await import('../host/budgets.mjs');

test('fresh budget check returns ok', () => {
  const b = createBudgets({ maxIterations: 10 });
  assert.deepEqual(b.check(), { ok: true });
});

test('maxIterations triggers after N records', () => {
  const b = createBudgets({ maxIterations: 3 });
  b.record({ inputTokens: 100, outputTokens: 50 });
  b.record({ inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(b.check(), { ok: true });
  b.record({ inputTokens: 100, outputTokens: 50 });
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_iterations');
});

test('maxTokens triggers when total exceeds cap', () => {
  const b = createBudgets({ maxTokens: 500 });
  b.record({ inputTokens: 200, outputTokens: 100 });
  assert.deepEqual(b.check(), { ok: true });
  b.record({ inputTokens: 150, outputTokens: 100 });
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_tokens');
});

test('maxCostUsd triggers based on pricing', () => {
  const b = createBudgets({
    maxCostUsd: 0.01,
    pricing: { inputPer1k: 1.00, outputPer1k: 1.00 },
  });
  b.record({ inputTokens: 5, outputTokens: 5 });
  assert.deepEqual(b.check(), { ok: true });
  b.record({ inputTokens: 5, outputTokens: 5 });
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_cost');
});

test('timeoutMs triggers based on elapsed time', async () => {
  const b = createBudgets({ timeoutMs: 50 });
  assert.deepEqual(b.check(), { ok: true });
  await new Promise(r => setTimeout(r, 60));
  const result = b.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('snapshot returns accumulated values', () => {
  const b = createBudgets({ maxIterations: 100 });
  b.record({ inputTokens: 100, outputTokens: 50 });
  b.record({ inputTokens: 200, outputTokens: 100 });
  const snap = b.snapshot();
  assert.equal(snap.iterations, 2);
  assert.equal(snap.totalInputTokens, 300);
  assert.equal(snap.totalOutputTokens, 150);
  assert.equal(snap.totalTokens, 450);
  assert.equal(typeof snap.estimatedCostUsd, 'number');
  assert.equal(typeof snap.elapsedMs, 'number');
  assert.ok(snap.elapsedMs >= 0);
});

test('uses default pricing when none provided', () => {
  const b = createBudgets({ maxCostUsd: 100 });
  b.record({ inputTokens: 1000, outputTokens: 1000 });
  const snap = b.snapshot();
  assert.ok(snap.estimatedCostUsd > 0);
});

test('unconfigured caps are not enforced', () => {
  const b = createBudgets({});
  for (let i = 0; i < 100; i++) {
    b.record({ inputTokens: 10000, outputTokens: 10000 });
  }
  assert.deepEqual(b.check(), { ok: true });
});

test('estimates tokens from chars when counts are missing', () => {
  const b = createBudgets({ maxTokens: 100 });
  b.record({ responseChars: 200 });
  const snap = b.snapshot();
  assert.equal(snap.totalInputTokens, 0);
  assert.equal(snap.totalOutputTokens, 50);
  assert.equal(snap.totalTokens, 50);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-budgets.test.mjs`
Expected: FAIL — `host/budgets.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/budgets.mjs

const DEFAULT_PRICING = {
  inputPer1k: 0.003,
  outputPer1k: 0.015,
};

export function createBudgets(config = {}) {
  const pricing = config.pricing ?? DEFAULT_PRICING;
  const startTime = Date.now();
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  function record(usage = {}) {
    iterations++;
    if (typeof usage.inputTokens === 'number') {
      totalInputTokens += usage.inputTokens;
    }
    if (typeof usage.outputTokens === 'number') {
      totalOutputTokens += usage.outputTokens;
    } else if (typeof usage.responseChars === 'number') {
      totalOutputTokens += Math.ceil(usage.responseChars / 4);
    }
  }

  function snapshot() {
    const totalTokens = totalInputTokens + totalOutputTokens;
    const estimatedCostUsd =
      (totalInputTokens / 1000) * pricing.inputPer1k +
      (totalOutputTokens / 1000) * pricing.outputPer1k;
    return {
      iterations,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCostUsd,
      elapsedMs: Date.now() - startTime,
    };
  }

  function check() {
    if (typeof config.maxIterations === 'number' && iterations >= config.maxIterations) {
      return { ok: false, reason: 'max_iterations' };
    }
    const totalTokens = totalInputTokens + totalOutputTokens;
    if (typeof config.maxTokens === 'number' && totalTokens >= config.maxTokens) {
      return { ok: false, reason: 'max_tokens' };
    }
    if (typeof config.maxCostUsd === 'number') {
      const cost =
        (totalInputTokens / 1000) * pricing.inputPer1k +
        (totalOutputTokens / 1000) * pricing.outputPer1k;
      if (cost >= config.maxCostUsd) {
        return { ok: false, reason: 'max_cost' };
      }
    }
    if (typeof config.timeoutMs === 'number') {
      if (Date.now() - startTime >= config.timeoutMs) {
        return { ok: false, reason: 'timeout' };
      }
    }
    return { ok: true };
  }

  return { check, record, snapshot };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-budgets.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/budgets.mjs tests/host-budgets.test.mjs
git commit -m "feat: add budgets module with iteration/token/cost/time caps"
```

---

### Task 4: Guardrails module

Gates every tool call with per-tool policies (allow/deny/approve), approval callbacks, filesystem sandbox, dry-run mode, and input validation.

**Files:**
- Create: `host/guardrails.mjs`
- Test: `tests/host-guardrails.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-guardrails.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';

const { createGuardrails } = await import('../host/guardrails.mjs');

function makeTool(overrides = {}) {
  return {
    name: 'test-tool',
    reversible: true,
    timeout: 5000,
    run: async () => 'tool-result',
    ...overrides,
  };
}

const mockExecutor = async (tool, opts) => ({ ok: true, result: await tool.run(opts) });

test('allow policy lets tool execute', async () => {
  const g = createGuardrails({ defaultPolicy: 'allow' }, [], mockExecutor);
  const tool = makeTool();
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, true);
  assert.equal(result.result, 'tool-result');
});

test('deny policy blocks tool', async () => {
  const g = createGuardrails(
    { defaultPolicy: 'allow', policies: { 'blocked-tool': 'deny' } },
    [],
    mockExecutor,
  );
  const tool = makeTool({ name: 'blocked-tool' });
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'guardrail_denied');
  assert.equal(result.reason, 'policy_denied');
});

test('approve policy calls callback', async () => {
  let callbackCalled = false;
  const g = createGuardrails(
    {
      defaultPolicy: 'allow',
      policies: { 'gated-tool': 'approve' },
      approvalCallback: async () => { callbackCalled = true; return 'approve'; },
    },
    [],
    mockExecutor,
  );
  const tool = makeTool({ name: 'gated-tool' });
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.ok(callbackCalled);
  assert.equal(result.ok, true);
});

test('approve policy denies when callback denies', async () => {
  const g = createGuardrails(
    {
      defaultPolicy: 'allow',
      policies: { 'gated-tool': 'approve' },
      approvalCallback: async () => 'deny',
    },
    [],
    mockExecutor,
  );
  const tool = makeTool({ name: 'gated-tool' });
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'approval_denied');
});

test('approve policy denies when no callback configured', async () => {
  const g = createGuardrails(
    { defaultPolicy: 'allow', policies: { 'gated-tool': 'approve' } },
    [],
    mockExecutor,
  );
  const tool = makeTool({ name: 'gated-tool' });
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'approval_denied');
});

test('irreversible tool defaults to approve policy', async () => {
  const g = createGuardrails({ defaultPolicy: 'allow' }, [], mockExecutor);
  const tool = makeTool({ reversible: false });
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'approval_denied');
});

test('explicit allow overrides irreversible default', async () => {
  const g = createGuardrails(
    { defaultPolicy: 'allow', policies: { 'test-tool': 'allow' } },
    [],
    mockExecutor,
  );
  const tool = makeTool({ reversible: false });
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, true);
});

test('dryRunMode blocks all tools', async () => {
  const g = createGuardrails({ defaultPolicy: 'allow', dryRunMode: true }, [], mockExecutor);
  const tool = makeTool();
  const result = await g.execute(tool, { fleetApi: {}, args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dry_run');
});

test('dryRun() reflects config', () => {
  const g1 = createGuardrails({ dryRunMode: true }, [], mockExecutor);
  assert.equal(g1.dryRun(), true);
  const g2 = createGuardrails({ dryRunMode: false }, [], mockExecutor);
  assert.equal(g2.dryRun(), false);
});

test('validateInputs rejects bad args', async () => {
  const g = createGuardrails({ defaultPolicy: 'allow', validateInputs: true }, [], mockExecutor);
  const tool = makeTool({
    inputSchema: z.object({ city: z.string() }),
  });
  const result = await g.execute(tool, { fleetApi: {}, args: { city: 123 } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'guardrail_denied');
  assert.equal(result.reason, 'validation_failed');
});

test('validateInputs passes valid args', async () => {
  const g = createGuardrails({ defaultPolicy: 'allow', validateInputs: true }, [], mockExecutor);
  const tool = makeTool({
    inputSchema: z.object({ city: z.string() }),
  });
  const result = await g.execute(tool, { fleetApi: {}, args: { city: 'London' } });
  assert.equal(result.ok, true);
});

test('gate returns allowed/denied without executing', async () => {
  const g = createGuardrails(
    { defaultPolicy: 'allow', policies: { 'blocked': 'deny' } },
    [],
    mockExecutor,
  );
  const allowed = g.gate(makeTool(), {});
  assert.deepEqual(allowed, { allowed: true });

  const denied = g.gate(makeTool({ name: 'blocked' }), {});
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'policy_denied');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-guardrails.test.mjs`
Expected: FAIL — `host/guardrails.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/guardrails.mjs

function resolvePolicy(tool, config) {
  if (config.policies?.[tool.name]) {
    return config.policies[tool.name];
  }
  if (tool.reversible === false) {
    return 'approve';
  }
  return config.defaultPolicy ?? 'allow';
}

export function createGuardrails(config = {}, tools = [], executor) {
  function gate(tool, args) {
    if (config.validateInputs && tool.inputSchema) {
      const result = tool.inputSchema.safeParse(args);
      if (!result.success) {
        return { allowed: false, reason: 'validation_failed', details: result.error };
      }
    }

    const policy = resolvePolicy(tool, config);

    if (policy === 'deny') {
      return { allowed: false, reason: 'policy_denied', policy };
    }

    if (policy === 'approve') {
      return { allowed: false, reason: 'approval_denied', policy, needsCallback: true };
    }

    return { allowed: true };
  }

  async function execute(tool, executorArgs) {
    if (config.validateInputs && tool.inputSchema) {
      const result = tool.inputSchema.safeParse(executorArgs.args);
      if (!result.success) {
        return { ok: false, error: 'guardrail_denied', reason: 'validation_failed', details: result.error };
      }
    }

    const policy = resolvePolicy(tool, config);

    if (policy === 'deny') {
      return { ok: false, error: 'guardrail_denied', reason: 'policy_denied' };
    }

    if (policy === 'approve') {
      if (!config.approvalCallback) {
        return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
      }
      const decision = await config.approvalCallback({ tool, args: executorArgs.args, context: executorArgs });
      if (decision !== 'approve') {
        return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
      }
    }

    if (config.dryRunMode) {
      return { ok: false, error: 'guardrail_denied', reason: 'dry_run' };
    }

    return executor(tool, executorArgs);
  }

  function dryRun() {
    return config.dryRunMode === true;
  }

  return { gate, execute, dryRun };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-guardrails.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/guardrails.mjs tests/host-guardrails.test.mjs
git commit -m "feat: add guardrails module with policy gate, approval, dry-run"
```

---

### Task 5: Mock fleet extension

Update the mock fleet helper to support scripted `executePrompt` responses so strategies can be tested end-to-end without a real LLM.

**Files:**
- Modify: `tests/helpers/mock-fleet.mjs`
- Test: `tests/host-mock-fleet.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-mock-fleet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

test('default executePrompt returns pong', async () => {
  const api = createMockFleetApi({ members: ['DOER', 'REVIEWER'] });
  const result = await api.executePrompt({ member_name: 'DOER', prompt: 'hello' });
  assert.equal(result.content[0].text, 'pong');
});

test('custom promptResponses returns scripted responses in order', async () => {
  const api = createMockFleetApi({
    members: ['DOER', 'REVIEWER'],
    promptResponses: [
      'first response',
      'second response',
      'third response',
    ],
  });
  const r1 = await api.executePrompt({ member_name: 'DOER', prompt: 'q1' });
  assert.equal(r1.content[0].text, 'first response');
  const r2 = await api.executePrompt({ member_name: 'DOER', prompt: 'q2' });
  assert.equal(r2.content[0].text, 'second response');
  const r3 = await api.executePrompt({ member_name: 'DOER', prompt: 'q3' });
  assert.equal(r3.content[0].text, 'third response');
});

test('promptResponses cycles after exhaustion', async () => {
  const api = createMockFleetApi({
    members: ['DOER'],
    promptResponses: ['only-one'],
  });
  const r1 = await api.executePrompt({ member_name: 'DOER', prompt: 'q1' });
  assert.equal(r1.content[0].text, 'only-one');
  const r2 = await api.executePrompt({ member_name: 'DOER', prompt: 'q2' });
  assert.equal(r2.content[0].text, 'only-one');
});

test('function promptResponses receives options', async () => {
  const api = createMockFleetApi({
    members: ['DOER'],
    promptResponses: (options) => `echo: ${options.prompt}`,
  });
  const r = await api.executePrompt({ member_name: 'DOER', prompt: 'hello' });
  assert.equal(r.content[0].text, 'echo: hello');
});

test('promptCalls records all prompt calls', async () => {
  const api = createMockFleetApi({
    members: ['DOER'],
    promptResponses: ['r1'],
  });
  await api.executePrompt({ member_name: 'DOER', prompt: 'p1' });
  await api.executePrompt({ member_name: 'DOER', prompt: 'p2' });
  assert.equal(api.promptCalls.length, 2);
  assert.equal(api.promptCalls[0].prompt, 'p1');
  assert.equal(api.promptCalls[1].prompt, 'p2');
});
```

- [ ] **Step 2: Run tests to verify they fail (some will fail, some may pass)**

Run: `node --test tests/host-mock-fleet.test.mjs`
Expected: The `promptResponses` tests FAIL; the default `executePrompt` test may pass (it already returns 'pong').

- [ ] **Step 3: Update the implementation**

Add `promptResponses` support to `createMockFleetApi` in `tests/helpers/mock-fleet.mjs`. The change is in the `executePrompt` method:

Replace the existing `executePrompt` method in `createMockFleetApi`:

```js
    async executePrompt(options) {
      promptCalls.push(options);
      let text = 'pong';
      if (typeof promptResponses === 'function') {
        text = promptResponses(options);
      } else if (Array.isArray(promptResponses) && promptResponses.length > 0) {
        const idx = Math.min(promptCalls.length - 1, promptResponses.length - 1);
        text = promptResponses[idx];
      }
      return {
        content: [{ type: 'text', text }],
        structuredContent: { response: text },
      };
    },
```

And destructure `promptResponses` from the options parameter — add it to the destructuring at the top of the function:

```js
export function createMockFleetApi({
  members = [],
  tools = ['remove_member', 'provision_llm_auth'],
  registerFails = [],
  commandPayload = 'hello-from-python',
  promptResponses,          // NEW: string[] | (options) => string
} = {}) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-mock-fleet.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `node --test tests/demo.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs tests/host-index.test.mjs`
Expected: All PASS — the default `executePrompt` still returns 'pong' when `promptResponses` is not provided.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/mock-fleet.mjs tests/host-mock-fleet.test.mjs
git commit -m "feat: add scripted promptResponses support to mock fleet"
```

---

### Task 6: Prompt templates

All prompt template functions. Each is a pure function: structured inputs → prompt string.

**Files:**
- Create: `host/prompts/system.mjs`
- Create: `host/prompts/plan.mjs`
- Create: `host/prompts/review.mjs`
- Create: `host/prompts/step-review.mjs`
- Create: `host/prompts/execute.mjs`
- Create: `host/prompts/resolve-args.mjs`
- Create: `host/prompts/reason.mjs`
- Create: `host/prompts/replan.mjs`
- Create: `host/prompts/act.mjs`
- Create: `host/prompts/index.mjs`
- Test: `tests/host-prompts.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-prompts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildSystemPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildStepReviewPrompt,
  buildExecutePrompt,
  buildResolveArgsPrompt,
  buildReasonPrompt,
  buildReplanPrompt,
  buildActPrompt,
} = await import('../host/prompts/index.mjs');
const { formatTools } = await import('../host/prompts/format-tools.mjs');

const sampleTools = [
  { name: 'weather', description: 'Get weather.', reversible: true },
  { name: 'timezone', description: 'Get time.', reversible: true },
];
const toolCatalog = formatTools(sampleTools);
const sampleTask = { id: 't-1', goal: 'Check the weather in London' };
const samplePlan = {
  steps: [
    { type: 'tool', tool: 'weather', args: { city: 'London' }, reason: 'Get weather', review: false },
  ],
};
const sampleHistory = [
  { type: 'observation', tool: 'weather', result: { ok: true, result: { temp_c: '15' } } },
];

test('buildSystemPrompt includes role and response format', () => {
  const p = buildSystemPrompt({ agentName: 'travel-agent', agentDescription: 'A travel helper' });
  assert.ok(p.includes('autonomous agent'));
  assert.ok(p.includes('tool_call'));
  assert.ok(p.includes('plan'));
  assert.ok(p.includes('done'));
  assert.ok(p.includes('review'));
  assert.ok(p.includes('travel-agent'));
});

test('buildPlanPrompt includes task goal and tools', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildPlanPrompt({ task: sampleTask, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('Check the weather in London'));
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('plan'));
});

test('buildReviewPrompt includes plan steps and task', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReviewPrompt({ task: sampleTask, plan: samplePlan, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('Check the weather'));
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('review'));
});

test('buildStepReviewPrompt includes step and result', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = samplePlan.steps[0];
  const p = buildStepReviewPrompt({
    task: sampleTask, step, result: { ok: true, result: { temp_c: '15' } },
    history: sampleHistory, systemPrompt: sys,
  });
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('step_review'));
});

test('buildExecutePrompt includes step index and observation', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildExecutePrompt({
    task: sampleTask, plan: samplePlan, stepIndex: 0,
    observation: { ok: true, result: { temp_c: '15' } }, systemPrompt: sys,
  });
  assert.ok(p.includes('step'));
  assert.ok(p.includes('15'));
});

test('buildResolveArgsPrompt includes step and history', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = { type: 'tool', tool: 'textstats', args: {}, reason: 'Analyze text', review: false };
  const p = buildResolveArgsPrompt({ task: sampleTask, step, history: sampleHistory, systemPrompt: sys });
  assert.ok(p.includes('textstats'));
  assert.ok(p.includes('tool_call'));
});

test('buildReasonPrompt includes step prompt and history', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = { type: 'reason', prompt: 'Compose a briefing from the data', review: false };
  const p = buildReasonPrompt({ task: sampleTask, step, history: sampleHistory, systemPrompt: sys });
  assert.ok(p.includes('Compose a briefing'));
  assert.ok(p.includes('15'));
});

test('buildReplanPrompt includes failure info and history', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReplanPrompt({
    task: sampleTask, plan: samplePlan, history: sampleHistory,
    failedStep: samplePlan.steps[0], reviewerFeedback: 'Wrong city used',
    systemPrompt: sys,
  });
  assert.ok(p.includes('Wrong city'));
  assert.ok(p.includes('plan'));
});

test('buildActPrompt includes task, history, and tools', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildActPrompt({ task: sampleTask, history: sampleHistory, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('Check the weather'));
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('tool_call'));
  assert.ok(p.includes('done'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-prompts.test.mjs`
Expected: FAIL — prompt modules do not exist.

- [ ] **Step 3: Write the implementations**

```js
// host/prompts/system.mjs
export function buildSystemPrompt({ agentName, agentDescription }) {
  return `You are "${agentName}", an autonomous agent executing tasks using available tools.
${agentDescription ? agentDescription + '\n' : ''}
## Response format

Wrap every decision in a fenced JSON block. Always include your reasoning BEFORE the block.

### To call a tool:
\`\`\`tool_call
{"tool": "<tool_name>", "args": {<arguments>}}
\`\`\`

### To propose a plan (plan-execute strategy):
\`\`\`plan
{"steps": [
  {"type": "tool", "tool": "<name>", "args": {}, "reason": "why", "review": false},
  {"type": "reason", "prompt": "what to think about", "review": true}
]}
\`\`\`

Step types:
- "tool": call a tool. Provide args when known. Use empty args {} when values depend on prior steps — you will be asked to fill them in at execution time.
- "reason": LLM reasoning step — analyze data, compose text, make decisions without calling a tool.

Set "review": true for irreversible actions, results feeding critical downstream steps, and complex reasoning. Set "review": false for simple factual lookups.

### To signal completion:
\`\`\`done
{"result": <final_answer>, "summary": "one-line summary"}
\`\`\`

### When reviewing a plan:
\`\`\`review
{"approved": true}
\`\`\`
or
\`\`\`review
{"approved": false, "feedback": "what needs to change"}
\`\`\`

### When reviewing a step result:
\`\`\`step_review
{"approved": true}
\`\`\`
or
\`\`\`step_review
{"approved": false, "feedback": "what is wrong"}
\`\`\`

## Rules
- One tool call per turn.
- Always include reasoning before the block.
- Never call tools that do not exist.
- If a tool is denied by guardrails, choose an alternative or report that the task cannot be completed.`;
}
```

```js
// host/prompts/plan.mjs
export function buildPlanPrompt({ task, tools, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}
${task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : ''}

## Available tools

${tools}

## Instructions

Create a plan to accomplish this task. Respond with a \`plan\` block containing the steps. Each step should have a type ("tool" or "reason"), and a "review" flag.`;
}
```

```js
// host/prompts/review.mjs
export function buildReviewPrompt({ task, plan, tools, systemPrompt }) {
  return `${systemPrompt}

## Your role

You are the reviewer. Evaluate the proposed plan for completeness, correct tool selection, safety, and whether the review flags are set appropriately.

## Task

Goal: ${task.goal}

## Proposed plan

${JSON.stringify(plan, null, 2)}

## Available tools

${tools}

## Instructions

Respond with a \`review\` block. Approve if the plan is sound. Reject with feedback if there are issues — include suggestions for review flag adjustments if needed.`;
}
```

```js
// host/prompts/step-review.mjs
export function buildStepReviewPrompt({ task, step, result, history, systemPrompt }) {
  return `${systemPrompt}

## Your role

You are the reviewer. Verify that this step's result is correct and appropriate for the task.

## Task

Goal: ${task.goal}

## Step executed

${JSON.stringify(step, null, 2)}

## Step result

${JSON.stringify(result, null, 2)}

## History so far

${JSON.stringify(history, null, 2)}

## Instructions

Respond with a \`step_review\` block. Approve if the result is correct. Reject with feedback explaining what is wrong.`;
}
```

```js
// host/prompts/execute.mjs
export function buildExecutePrompt({ task, plan, stepIndex, observation, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Current plan

${JSON.stringify(plan, null, 2)}

## Completed step ${stepIndex + 1}

Result: ${JSON.stringify(observation, null, 2)}

## Instructions

The previous step has completed. Continue with the next step in the plan, or respond with a \`done\` block if all steps are complete.`;
}
```

```js
// host/prompts/resolve-args.mjs
export function buildResolveArgsPrompt({ task, step, history, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Current step

Tool: ${step.tool}
Reason: ${step.reason}
Planned args: ${JSON.stringify(step.args)}

## Observation history

${JSON.stringify(history, null, 2)}

## Instructions

This step has empty or partial args that depend on prior results. Given the observation history, provide the concrete arguments for this tool call. Respond with a \`tool_call\` block.`;
}
```

```js
// host/prompts/reason.mjs
export function buildReasonPrompt({ task, step, history, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Reasoning step

${step.prompt}

## Observation history

${JSON.stringify(history, null, 2)}

## Instructions

Perform the reasoning described above using the observation history. Respond with your analysis directly — do not wrap it in a fenced block. Your response will be recorded as an observation for subsequent steps.`;
}
```

```js
// host/prompts/replan.mjs
export function buildReplanPrompt({ task, plan, history, failedStep, reviewerFeedback, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Previous plan

${JSON.stringify(plan, null, 2)}

## Execution history

${JSON.stringify(history, null, 2)}

${failedStep ? `## Failed step\n\n${JSON.stringify(failedStep, null, 2)}` : ''}

${reviewerFeedback ? `## Reviewer feedback\n\n${reviewerFeedback}` : ''}

## Instructions

The previous plan could not be completed. Create a revised plan for the remaining work, accounting for what has already been done and the feedback above. Respond with a \`plan\` block.`;
}
```

```js
// host/prompts/act.mjs
export function buildActPrompt({ task, history, tools, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}
${task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : ''}

## Available tools

${tools}

## Observation history

${JSON.stringify(history, null, 2)}

## Instructions

Decide what to do next. You can:
- Call a tool: respond with a \`tool_call\` block.
- Finish: respond with a \`done\` block.

Choose the action that best advances the task toward completion.`;
}
```

```js
// host/prompts/index.mjs
export { buildSystemPrompt } from './system.mjs';
export { buildPlanPrompt } from './plan.mjs';
export { buildReviewPrompt } from './review.mjs';
export { buildStepReviewPrompt } from './step-review.mjs';
export { buildExecutePrompt } from './execute.mjs';
export { buildResolveArgsPrompt } from './resolve-args.mjs';
export { buildReasonPrompt } from './reason.mjs';
export { buildReplanPrompt } from './replan.mjs';
export { buildActPrompt } from './act.mjs';
export { formatTools } from './format-tools.mjs';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/prompts/system.mjs host/prompts/plan.mjs host/prompts/review.mjs host/prompts/step-review.mjs host/prompts/execute.mjs host/prompts/resolve-args.mjs host/prompts/reason.mjs host/prompts/replan.mjs host/prompts/act.mjs host/prompts/index.mjs tests/host-prompts.test.mjs
git commit -m "feat: add prompt templates for run loop strategies"
```

---

### Task 7: Open-ended strategy

The simpler strategy: each iteration sends the full history to the LLM and asks "what next?" No upfront plan. No reviewer.

**Files:**
- Create: `host/strategies/open-ended.mjs`
- Test: `tests/host-strategy-open-ended.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-strategy-open-ended.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createOpenEndedStrategy } = await import('../host/strategies/open-ended.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15', city: 'London' }) },
  ];
}

function makeFleetApi(responses) {
  return createMockFleetApi({ members: rosterNames(1), promptResponses: responses });
}

test('single tool_call then done completes', async () => {
  const api = makeFleetApi([
    'Let me check.\n\n```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
    'Got it.\n\n```done\n{"result": "15°C in London", "summary": "Done"}\n```',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const types = events.map(e => e.type);
  assert.ok(types.includes('action'));
  assert.ok(types.includes('observation'));
  assert.ok(types.includes('done'));
});

test('thinking turns increment no-action counter', async () => {
  const api = makeFleetApi([
    'Hmm let me think...',
    'Still thinking...',
    'Still thinking more...',
    'Still thinking even more...',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const last = events[events.length - 1];
  assert.equal(last.type, 'error');
  assert.ok(last.reason.includes('no_action'));
});

test('unknown tool name yields error observation', async () => {
  const api = makeFleetApi([
    '```tool_call\n{"tool": "nonexistent", "args": {}}\n```',
    '```done\n{"result": "gave up", "summary": "done"}\n```',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const errObs = events.find(e => e.type === 'observation' && e.error);
  assert.ok(errObs);
  assert.ok(errObs.error.includes('not found'));
});

test('history accumulates observations', async () => {
  const api = makeFleetApi([
    '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
    '```done\n{"result": "done", "summary": "done"}\n```',
  ]);
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  assert.ok(strategy.history().length > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-strategy-open-ended.test.mjs`
Expected: FAIL — `host/strategies/open-ended.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/strategies/open-ended.mjs
import { parseResponse } from '../response-parser.mjs';
import { buildSystemPrompt, buildActPrompt, formatTools } from '../prompts/index.mjs';

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

export function createOpenEndedStrategy({
  task,
  tools,
  fleetApi,
  guardrails,
  maxNoActionTurns = 3,
  agentName = 'agent',
  agentDescription = '',
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription });
  const toolCatalog = formatTools(tools);
  const observations = [];
  let noActionCount = 0;

  async function executeTool(name, args) {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found in registry.` };
    }
    if (guardrails) {
      return guardrails.execute(tool, { fleetApi, args });
    }
    const { executeTool: exec } = await import('../tools/executor.mjs');
    return exec(tool, { fleetApi, args });
  }

  async function* iterate() {
    while (true) {
      const prompt = buildActPrompt({ task, history: observations, tools: toolCatalog, systemPrompt });
      const raw = await fleetApi.executePrompt({ member_name: 'doer', prompt });
      const text = extractText(raw);
      const parsed = parseResponse(text);

      yield { type: 'prompt_usage', text };

      if (parsed.type === 'done') {
        yield { type: 'done', result: parsed.payload.result, summary: parsed.payload.summary };
        return;
      }

      if (parsed.type === 'tool_call') {
        noActionCount = 0;
        const { tool, args } = parsed.payload;
        yield { type: 'action', tool, args, reasoning: parsed.reasoning };
        const result = await executeTool(tool, args);
        observations.push({ type: 'observation', tool, args, result });
        yield { type: 'observation', tool, args, ...result };
        continue;
      }

      if (parsed.type === 'thinking' || parsed.type === 'error') {
        noActionCount++;
        observations.push({ type: 'thinking', text: parsed.reasoning ?? parsed.message });
        if (noActionCount >= maxNoActionTurns) {
          yield { type: 'error', reason: 'no_action', message: `${maxNoActionTurns} consecutive turns with no tool call or done block` };
          return;
        }
        continue;
      }

      noActionCount++;
      observations.push({ type: 'thinking', text });
      if (noActionCount >= maxNoActionTurns) {
        yield { type: 'error', reason: 'no_action', message: `${maxNoActionTurns} consecutive turns with no tool call or done block` };
        return;
      }
    }
  }

  return {
    iterate,
    history: () => [...observations],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-strategy-open-ended.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/strategies/open-ended.mjs tests/host-strategy-open-ended.test.mjs
git commit -m "feat: add open-ended strategy for run loop"
```

---

### Task 8: Plan-execute strategy

The full strategy: plan → review → execute (with tool/reason steps, dynamic args, step review) → replan.

**Files:**
- Create: `host/strategies/plan-execute.mjs`
- Test: `tests/host-strategy-plan-execute.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-strategy-plan-execute.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createPlanExecuteStrategy } = await import('../host/strategies/plan-execute.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async ({ args }) => ({ temp_c: '15', city: args.city ?? 'London' }) },
    { name: 'textstats', description: 'Text stats', reversible: true, timeout: 5000,
      run: async ({ args }) => ({ word_count: 5, text: args.text ?? '' }) },
  ];
}

test('simple plan: one tool step, review approved, done', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}\n```',
      // reviewer: approve plan
      '```review\n{"approved": true}\n```',
      // doer: done after execution
      '```done\n{"result": "London is 15°C", "summary": "Done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const types = events.map(e => e.type);
  assert.ok(types.includes('plan'));
  assert.ok(types.includes('review'));
  assert.ok(types.includes('observation'));
  assert.ok(types.includes('done'));
});

test('reviewer rejects plan, doer replans', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: first plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {}, "reason": "bad plan", "review": false}]}\n```',
      // reviewer: reject
      '```review\n{"approved": false, "feedback": "Missing city arg"}\n```',
      // doer: revised plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "fixed", "review": false}]}\n```',
      // reviewer: approve
      '```review\n{"approved": true}\n```',
      // doer: done
      '```done\n{"result": "15°C", "summary": "Done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Weather' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const reviews = events.filter(e => e.type === 'review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].approved, false);
  assert.equal(reviews[1].approved, true);
});

test('reason step records observation from doer', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan with reason step
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "data", "review": false}, {"type": "reason", "prompt": "Compose briefing", "review": false}]}\n```',
      // reviewer: approve
      '```review\n{"approved": true}\n```',
      // doer: reason step response (plain text, no block)
      'London is 15°C and cloudy. A light jacket is recommended.',
      // doer: done
      '```done\n{"result": "briefing complete", "summary": "done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Briefing' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const reasonObs = events.find(e => e.type === 'observation' && e.stepType === 'reason');
  assert.ok(reasonObs);
  assert.ok(reasonObs.text.includes('15°C'));
});

test('dynamic args: doer resolves empty args at execution time', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan with empty args on step 2
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "data", "review": false}, {"type": "tool", "tool": "textstats", "args": {}, "reason": "analyze", "review": false}]}\n```',
      // reviewer: approve
      '```review\n{"approved": true}\n```',
      // doer: resolve args for textstats
      '```tool_call\n{"tool": "textstats", "args": {"text": "London is 15 degrees"}}\n```',
      // doer: done
      '```done\n{"result": "done", "summary": "done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  const observations = events.filter(e => e.type === 'observation');
  assert.ok(observations.length >= 2);
});

test('step review: reviewer rejects step, doer retries', async () => {
  const callCount = { weather: 0 };
  const tools = [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async ({ args }) => {
        callCount.weather++;
        return { temp_c: callCount.weather === 1 ? 'WRONG' : '15', city: args.city };
      },
    },
  ];
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      // doer: plan
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "Paris"}, "reason": "data", "review": true}]}\n```',
      // reviewer: approve plan
      '```review\n{"approved": true}\n```',
      // reviewer: reject step result
      '```step_review\n{"approved": false, "feedback": "Result says WRONG"}\n```',
      // doer: retry tool call
      '```tool_call\n{"tool": "weather", "args": {"city": "Paris"}}\n```',
      // reviewer: approve step result
      '```step_review\n{"approved": true}\n```',
      // doer: done
      '```done\n{"result": "Paris is 15°C", "summary": "done"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Paris weather' },
    tools,
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  const events = [];
  for await (const event of strategy.iterate()) {
    events.push(event);
  }
  assert.equal(callCount.weather, 2);
  const stepReviews = events.filter(e => e.type === 'step_review');
  assert.equal(stepReviews.length, 2);
});

test('history returns all observations', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "x", "review": false}]}\n```',
      '```review\n{"approved": true}\n```',
      '```done\n{"result": "ok", "summary": "ok"}\n```',
    ],
  });
  const strategy = createPlanExecuteStrategy({
    task: { id: 't-1', goal: 'Test' },
    tools: makeTools(),
    fleetApi: api,
    maxReplanAttempts: 3,
    maxReviewAttempts: 2,
    maxStepReviewAttempts: 2,
    maxNoActionTurns: 3,
  });
  for await (const _ of strategy.iterate()) { /* drain */ }
  assert.ok(strategy.history().length > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-strategy-plan-execute.test.mjs`
Expected: FAIL — `host/strategies/plan-execute.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/strategies/plan-execute.mjs
import { parseResponse } from '../response-parser.mjs';
import {
  buildSystemPrompt, buildPlanPrompt, buildReviewPrompt, buildStepReviewPrompt,
  buildResolveArgsPrompt, buildReasonPrompt, buildReplanPrompt, buildExecutePrompt,
  formatTools,
} from '../prompts/index.mjs';

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

function hasEmptyArgs(step) {
  return step.type === 'tool' && (!step.args || Object.keys(step.args).length === 0);
}

export function createPlanExecuteStrategy({
  task,
  tools,
  fleetApi,
  guardrails,
  maxReplanAttempts = 3,
  maxReviewAttempts = 2,
  maxStepReviewAttempts = 2,
  maxNoActionTurns = 3,
  minReviewPolicy = 'irreversible',
  agentName = 'agent',
  agentDescription = '',
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription });
  const toolCatalog = formatTools(tools);
  const observations = [];

  function shouldReview(step) {
    if (step.review) return true;
    if (minReviewPolicy === 'irreversible' && step.type === 'tool') {
      const tool = tools.find(t => t.name === step.tool);
      if (tool && tool.reversible === false) return true;
    }
    return false;
  }

  async function callPrompt(memberName, prompt) {
    const raw = await fleetApi.executePrompt({ member_name: memberName, prompt });
    return extractText(raw);
  }

  async function runTool(name, args) {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found in registry.` };
    }
    if (guardrails) {
      return guardrails.execute(tool, { fleetApi, args });
    }
    const { executeTool } = await import('../tools/executor.mjs');
    return executeTool(tool, { fleetApi, args });
  }

  async function* iterate() {
    let replanCount = 0;
    let currentPlan = null;

    // Phase 1: Plan
    planLoop: while (true) {
      const planPrompt = currentPlan
        ? buildReplanPrompt({
            task, plan: currentPlan, history: observations,
            failedStep: null, reviewerFeedback: null, systemPrompt,
          })
        : buildPlanPrompt({ task, tools: toolCatalog, systemPrompt });

      const planText = await callPrompt('doer', planPrompt);
      yield { type: 'prompt_usage', text: planText };
      const planParsed = parseResponse(planText);

      if (planParsed.type !== 'plan') {
        yield { type: 'error', reason: 'invalid_plan', message: 'Doer did not produce a plan block' };
        return;
      }

      currentPlan = planParsed.payload;
      yield { type: 'plan', plan: currentPlan };

      // Phase 2: Review plan
      for (let reviewRound = 0; reviewRound < maxReviewAttempts; reviewRound++) {
        const reviewPrompt = buildReviewPrompt({ task, plan: currentPlan, tools: toolCatalog, systemPrompt });
        const reviewText = await callPrompt('reviewer', reviewPrompt);
        yield { type: 'prompt_usage', text: reviewText };
        const reviewParsed = parseResponse(reviewText);

        if (reviewParsed.type !== 'review') {
          yield { type: 'review', approved: true, note: 'Reviewer did not produce review block, treating as approved' };
          break;
        }

        const { approved, feedback } = reviewParsed.payload;
        yield { type: 'review', approved, feedback };

        if (approved) break;

        replanCount++;
        if (replanCount > maxReplanAttempts) {
          yield { type: 'error', reason: 'max_replans', message: `Exceeded ${maxReplanAttempts} replan attempts` };
          return;
        }

        const replanPrompt = buildReplanPrompt({
          task, plan: currentPlan, history: observations,
          failedStep: null, reviewerFeedback: feedback, systemPrompt,
        });
        const replanText = await callPrompt('doer', replanPrompt);
        yield { type: 'prompt_usage', text: replanText };
        const replanParsed = parseResponse(replanText);

        if (replanParsed.type !== 'plan') {
          yield { type: 'error', reason: 'invalid_replan', message: 'Doer did not produce a revised plan block' };
          return;
        }
        currentPlan = replanParsed.payload;
        yield { type: 'plan', plan: currentPlan };
      }

      break planLoop;
    }

    // Phase 3: Execute steps
    const steps = currentPlan.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      if (step.type === 'tool') {
        let args = step.args;

        if (hasEmptyArgs(step)) {
          const resolvePrompt = buildResolveArgsPrompt({ task, step, history: observations, systemPrompt });
          const resolveText = await callPrompt('doer', resolvePrompt);
          yield { type: 'prompt_usage', text: resolveText };
          const resolved = parseResponse(resolveText);
          if (resolved.type === 'tool_call') {
            args = resolved.payload.args;
          }
        }

        let result = await runTool(step.tool, args);
        observations.push({ type: 'observation', stepType: 'tool', tool: step.tool, args, result });
        yield { type: 'observation', stepType: 'tool', tool: step.tool, args, ...result };

        // Step review
        if (shouldReview(step)) {
          for (let retryRound = 0; retryRound <= maxStepReviewAttempts; retryRound++) {
            const srPrompt = buildStepReviewPrompt({ task, step, result, history: observations, systemPrompt });
            const srText = await callPrompt('reviewer', srPrompt);
            yield { type: 'prompt_usage', text: srText };
            const srParsed = parseResponse(srText);

            const approved = srParsed.type === 'step_review' ? srParsed.payload.approved : true;
            const feedback = srParsed.type === 'step_review' ? srParsed.payload.feedback : undefined;
            yield { type: 'step_review', approved, feedback, step: step.tool };

            if (approved) break;

            if (retryRound >= maxStepReviewAttempts) {
              replanCount++;
              if (replanCount > maxReplanAttempts) {
                yield { type: 'error', reason: 'max_replans', message: 'Exceeded replan attempts after step review rejection' };
                return;
              }
              const replanPrompt = buildReplanPrompt({
                task, plan: currentPlan, history: observations,
                failedStep: step, reviewerFeedback: feedback, systemPrompt,
              });
              const rpText = await callPrompt('doer', replanPrompt);
              yield { type: 'prompt_usage', text: rpText };
              const rpParsed = parseResponse(rpText);
              if (rpParsed.type === 'plan') {
                currentPlan = rpParsed.payload;
                yield { type: 'plan', plan: currentPlan };
              }
              break;
            }

            // Retry: ask doer to redo
            const retryPrompt = buildResolveArgsPrompt({ task, step: { ...step, reason: `Retry: ${feedback}` }, history: observations, systemPrompt });
            const retryText = await callPrompt('doer', retryPrompt);
            yield { type: 'prompt_usage', text: retryText };
            const retryParsed = parseResponse(retryText);
            if (retryParsed.type === 'tool_call') {
              args = retryParsed.payload.args;
            }
            result = await runTool(step.tool, args);
            observations.push({ type: 'observation', stepType: 'tool', tool: step.tool, args, result, retry: retryRound + 1 });
            yield { type: 'observation', stepType: 'tool', tool: step.tool, args, ...result };
          }
        }
      } else if (step.type === 'reason') {
        const reasonPrompt = buildReasonPrompt({ task, step, history: observations, systemPrompt });
        const reasonText = await callPrompt('doer', reasonPrompt);
        yield { type: 'prompt_usage', text: reasonText };
        observations.push({ type: 'observation', stepType: 'reason', text: reasonText });
        yield { type: 'observation', stepType: 'reason', text: reasonText };

        if (shouldReview(step)) {
          const srPrompt = buildStepReviewPrompt({ task, step, result: { text: reasonText }, history: observations, systemPrompt });
          const srText = await callPrompt('reviewer', srPrompt);
          yield { type: 'prompt_usage', text: srText };
          const srParsed = parseResponse(srText);
          const approved = srParsed.type === 'step_review' ? srParsed.payload.approved : true;
          const feedback = srParsed.type === 'step_review' ? srParsed.payload.feedback : undefined;
          yield { type: 'step_review', approved, feedback, step: 'reason' };
        }
      }
    }

    // Phase 4: Done
    const donePrompt = buildExecutePrompt({
      task, plan: currentPlan, stepIndex: steps.length - 1,
      observation: observations[observations.length - 1], systemPrompt,
    });
    const doneText = await callPrompt('doer', donePrompt);
    yield { type: 'prompt_usage', text: doneText };
    const doneParsed = parseResponse(doneText);

    if (doneParsed.type === 'done') {
      yield { type: 'done', result: doneParsed.payload.result, summary: doneParsed.payload.summary };
    } else {
      yield { type: 'done', result: doneText, summary: 'Plan execution completed' };
    }
  }

  return {
    iterate,
    history: () => [...observations],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-strategy-plan-execute.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/strategies/plan-execute.mjs tests/host-strategy-plan-execute.test.mjs
git commit -m "feat: add plan-execute strategy with review, reason steps, dynamic args"
```

---

### Task 9: Run loop

Drives the strategy generator. Checks budgets and signal after each yield. Returns the final result with status.

**Files:**
- Create: `host/run-loop.mjs`
- Test: `tests/host-run-loop.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// tests/host-run-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runTask } = await import('../host/run-loop.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15' }) },
  ];
}

test('open-ended: completes a simple task', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather in London' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.result, '15°C');
  assert.ok(result.history.length > 0);
});

test('plan-execute: completes with plan and review', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "x", "review": false}]}\n```',
      '```review\n{"approved": true}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'plan-execute', tools: makeTools(), fleetApi: api },
  );
  assert.equal(result.status, 'completed');
});

test('budget exceeded stops the run', async () => {
  const { createBudgets } = await import('../host/budgets.mjs');
  const budgets = createBudgets({ maxIterations: 1 });
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```tool_call\n{"tool": "weather", "args": {"city": "Paris"}}\n```',
      '```done\n{"result": "done", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, budgets },
  );
  assert.equal(result.status, 'budget_exceeded');
  assert.ok(result.budget);
  assert.equal(result.budget.iterations, 1);
});

test('signal cancellation stops the run', async () => {
  const ac = new AbortController();
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: (opts) => {
      ac.abort();
      return '```tool_call\n{"tool": "weather", "args": {}}\n```';
    },
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, signal: ac.signal },
  );
  assert.equal(result.status, 'cancelled');
});

test('failed strategy returns failed status', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['thinking...', 'still thinking...', 'more thinking...', 'yet more...'],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, maxNoActionTurns: 3 },
  );
  assert.equal(result.status, 'failed');
});

test('guardrails are passed to strategy', async () => {
  const { createGuardrails } = await import('../host/guardrails.mjs');
  const { executeTool } = await import('../host/tools/executor.mjs');
  const guardrails = createGuardrails(
    { defaultPolicy: 'allow', policies: { weather: 'deny' } },
    [],
    executeTool,
  );
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "denied", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, guardrails },
  );
  assert.equal(result.status, 'completed');
  const denied = result.history.find(o => o.error === 'guardrail_denied');
  assert.ok(denied);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-run-loop.test.mjs`
Expected: FAIL — `host/run-loop.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// host/run-loop.mjs
import { createOpenEndedStrategy } from './strategies/open-ended.mjs';
import { createPlanExecuteStrategy } from './strategies/plan-execute.mjs';

export async function runTask(task, {
  strategy = 'open-ended',
  tools,
  fleetApi,
  signal,
  budgets,
  guardrails,
  maxReplanAttempts = 3,
  maxReviewAttempts = 2,
  maxStepReviewAttempts = 2,
  maxNoActionTurns = 3,
  minReviewPolicy = 'irreversible',
  agentName,
  agentDescription,
} = {}) {
  const strategyOpts = {
    task, tools, fleetApi, guardrails,
    maxReplanAttempts, maxReviewAttempts, maxStepReviewAttempts,
    maxNoActionTurns, minReviewPolicy, agentName, agentDescription,
  };

  const strat = strategy === 'plan-execute'
    ? createPlanExecuteStrategy(strategyOpts)
    : createOpenEndedStrategy(strategyOpts);

  let result = null;
  let status = 'failed';

  try {
    for await (const event of strat.iterate()) {
      if (signal?.aborted) {
        status = 'cancelled';
        break;
      }

      if (event.type === 'prompt_usage' && budgets) {
        const chars = typeof event.text === 'string' ? event.text.length : 0;
        budgets.record({ responseChars: chars });
        const check = budgets.check();
        if (!check.ok) {
          status = 'budget_exceeded';
          break;
        }
      }

      if (event.type === 'done') {
        result = event.result;
        status = 'completed';
        break;
      }

      if (event.type === 'error') {
        status = 'failed';
        result = { error: event.reason, message: event.message };
        break;
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      status = 'cancelled';
    } else {
      status = 'failed';
      result = { error: 'unexpected', message: String(err?.message ?? err) };
    }
  }

  return {
    status,
    result,
    history: strat.history(),
    budget: budgets?.snapshot() ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-run-loop.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/run-loop.mjs tests/host-run-loop.test.mjs
git commit -m "feat: add run loop that drives strategies with budgets and signal"
```

---

### Task 10: Config evolution

Update `host/config.mjs` to recognize Phase 2 modules and validate their configuration.

**Files:**
- Modify: `host/config.mjs`
- Modify: `tests/host-config.test.mjs`

- [ ] **Step 1: Write the new failing tests**

Add to the end of `tests/host-config.test.mjs`:

```js
test('runLoop module accepted when enabled', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true, strategy: 'plan-execute' } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const config = await loadConfig(dir);
    assert.equal(config.modules.runLoop.enabled, true);
    assert.ok(!warnings.some(w => /runLoop/i.test(w) && /not implemented/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('budgets module accepted when enabled', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { budgets: { enabled: true, maxIterations: 25 } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
    assert.ok(!warnings.some(w => /budgets/i.test(w) && /not implemented/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('guardrails module accepted when enabled', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { guardrails: { enabled: true, defaultPolicy: 'allow' } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
    assert.ok(!warnings.some(w => /guardrails/i.test(w) && /not implemented/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('budgets without runLoop logs dependency warning', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { budgets: { enabled: true } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
    assert.ok(warnings.some(w => /budgets/i.test(w) && /runLoop/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/host-config.test.mjs`
Expected: The new Phase 2 module tests FAIL (modules still show "not implemented" warnings).

- [ ] **Step 3: Update the implementation**

In `host/config.mjs`, change:

```js
const IMPLEMENTED_MODULES = new Set([]); // Phase 1: none
```

to:

```js
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails']);
```

And add dependency warnings after the existing module loop. After the closing `}` of the `for` loop, add:

```js
    if (raw.modules?.budgets?.enabled && !raw.modules?.runLoop?.enabled) {
      console.warn(
        '[host/config] budgets enabled but runLoop disabled — budget enforcement will not run; disable budgets or enable runLoop',
      );
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-config.test.mjs`
Expected: All PASS (including new Phase 2 tests).

- [ ] **Step 5: Commit**

```bash
git add host/config.mjs tests/host-config.test.mjs
git commit -m "feat: config recognizes Phase 2 modules (runLoop, budgets, guardrails)"
```

---

### Task 11: Host integration

Wire up Phase 2 modules into `startHost`, add the `/task` route, extend the builder API with `.runLoop()`, `.budget()`, `.guardrails()`, and `.run()`.

**Files:**
- Modify: `host/index.mjs`
- Modify: `tests/host-index.test.mjs`

- [ ] **Step 1: Write the new failing tests**

Add to the end of `tests/host-index.test.mjs`:

```js
import { createBudgets } from '../host/budgets.mjs';
import { createGuardrails } from '../host/guardrails.mjs';
import { runTask } from '../host/run-loop.mjs';

test('POST /task executes a task through the run loop', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "inspected", "summary": "ok"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({
    fleetApi, dispatcher, port: 0,
    runLoop: { enabled: true, strategy: 'open-ended' },
  });

  try {
    const res = await httpPost(host.port(), '/task', { goal: 'Inspect members' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'completed');
    assert.ok(body.result);
  } finally {
    await close();
  }
});

test('POST /task returns 404 when run loop is disabled', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(2) });
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const res = await httpPost(host.port(), '/task', { goal: 'test' });
    assert.notEqual(res.status, 200);
  } finally {
    await close();
  }
});

test('builder .runLoop().budget().guardrails() builds and starts', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(2) });
  const dispatcher = await makeDispatcher();
  const agent = createHost({ fleetApi, dispatcher })
    .runLoop({ strategy: 'open-ended' })
    .budget({ maxIterations: 10 })
    .guardrails({ defaultPolicy: 'allow' })
    .build();

  const { host, close } = await agent.start({ port: 0 });
  try {
    assert.ok(host.port() > 0);
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/host-index.test.mjs`
Expected: New tests FAIL — `startHost` doesn't accept `runLoop` option, `/task` is null, builder lacks `.runLoop()`.

- [ ] **Step 3: Update the implementation**

Add imports at the top of `host/index.mjs`:

```js
import { runTask } from './run-loop.mjs';
import { createBudgets } from './budgets.mjs';
import { createGuardrails } from './guardrails.mjs';
```

In the `startHost` function, add `runLoop`, `budgetsConfig`, `guardrailsConfig` to the destructured parameters:

```js
export async function startHost({
  fleetApi,
  dispatcher,
  port,
  bindHost: bindHostOption,
  adapter: adapterName,
  createAdapter,
  env = process.env,
  registry,
  configDir,
  authenticate = defaultAuthenticate,
  runLoop: runLoopConfig,
  budgets: budgetsConfig,
  guardrails: guardrailsConfig,
} = {}) {
```

After `const toolRegistry = registry ?? extendRegistry();`, add module initialization:

```js
  const runLoopEnabled = runLoopConfig?.enabled ?? !!runLoopConfig?.strategy;
  const guardrailsMod = guardrailsConfig
    ? createGuardrails(guardrailsConfig, toolRegistry, executeTool)
    : null;
  const budgetsMod = budgetsConfig ? createBudgets(budgetsConfig) : null;
```

Replace the `routes.task: null` in the adapter start with:

```js
      task: runLoopEnabled
        ? async (req, res) => {
            const task = {
              id: `t-${Date.now().toString(36)}`,
              ...req.body,
            };
            let lease;
            try {
              lease = await activeDispatcher.dispatch({});
            } catch (err) {
              res.status(503).json({ ok: false, error: 'dispatch_failed', message: String(err?.message ?? err) });
              return;
            }
            try {
              const pooledApi = createPooledFleetApi(api, lease);
              const result = await runTask(task, {
                strategy: runLoopConfig.strategy ?? 'open-ended',
                tools: toolRegistry,
                fleetApi: pooledApi,
                budgets: budgetsMod,
                guardrails: guardrailsMod,
                ...runLoopConfig,
              });
              res.json({ taskId: task.id, ...result });
            } finally {
              await lease.release();
            }
          }
        : null,
```

Extend the builder in `createHost`:

```js
  const builder = {
    tools(registry)   { overrides.registry = registry; return builder; },
    comm(commConfig)  {
      if (commConfig && typeof commConfig === 'object') {
        if ('port' in commConfig) overrides.port = commConfig.port;
        if ('host' in commConfig) overrides.bindHost = commConfig.host;
        if ('adapter' in commConfig) overrides.adapter = commConfig.adapter;
      }
      return builder;
    },
    runLoop(config)    { overrides.runLoop = { enabled: true, ...config }; return builder; },
    budget(config)     { overrides.budgets = config; return builder; },
    guardrails(config) { overrides.guardrails = config; return builder; },
    build() {
      return {
        start: (startOpts = {}) => startHost({ ...overrides, ...startOpts }),
      };
    },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-index.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Run all existing tests for regression check**

Run: `npm run test:host`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add host/index.mjs tests/host-index.test.mjs
git commit -m "feat: wire Phase 2 modules into host, add /task route and builder extensions"
```

---

### Task 12: New Python tool scripts

Seven new Python tools following the existing `tools/<name>/<name>.py` convention, plus their registry entries.

**Files:**
- Create: `tools/currency/currency.py`
- Create: `tools/country-info/country_info.py`
- Create: `tools/travel-advisory/travel_advisory.py`
- Create: `tools/geocode/geocode.py`
- Create: `tools/forecast/forecast.py`
- Create: `tools/wikipedia-summary/wikipedia_summary.py`
- Create: `tools/public-holidays/public_holidays.py`
- Modify: `mcp/registry.mjs`

- [ ] **Step 1: Create currency tool**

```python
# tools/currency/currency.py
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_rate(from_currency, to_currency, amount=1):
    try:
        url = (
            f"https://api.frankfurter.app/latest"
            f"?from={urllib.request.quote(from_currency.upper())}"
            f"&to={urllib.request.quote(to_currency.upper())}"
            f"&amount={amount}"
        )
        data = _get(url)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"currency fetch failed: {exc}"})

    rates = data.get("rates", {})
    converted = rates.get(to_currency.upper())
    return json.dumps({
        "ok": True,
        "from": from_currency.upper(),
        "to": to_currency.upper(),
        "amount": amount,
        "rate": converted / amount if converted and amount else None,
        "converted": converted,
        "date": data.get("date"),
    })


if __name__ == "__main__":
    from_c = sys.argv[1] if len(sys.argv) > 1 else "USD"
    to_c = sys.argv[2] if len(sys.argv) > 2 else "EUR"
    amt = float(sys.argv[3]) if len(sys.argv) > 3 else 1
    print(fetch_rate(from_c, to_c, amt))
```

- [ ] **Step 2: Create country-info tool**

```python
# tools/country-info/country_info.py
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_country(name):
    try:
        data = _get(f"https://restcountries.com/v3.1/name/{urllib.request.quote(name)}?fields=name,capital,region,subregion,population,languages,currencies,timezones,flags")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"country fetch failed: {exc}"})

    if not isinstance(data, list) or len(data) == 0:
        return json.dumps({"ok": False, "error": f"Country not found: {name}"})

    c = data[0]
    langs = list((c.get("languages") or {}).values())
    currs = c.get("currencies") or {}
    currency_list = [{"code": k, "name": v.get("name"), "symbol": v.get("symbol")} for k, v in currs.items()]

    return json.dumps({
        "ok": True,
        "name": c.get("name", {}).get("common", name),
        "official_name": c.get("name", {}).get("official", ""),
        "capital": (c.get("capital") or [None])[0],
        "region": c.get("region"),
        "subregion": c.get("subregion"),
        "population": c.get("population"),
        "languages": langs,
        "currencies": currency_list,
        "timezones": c.get("timezones", []),
    })


if __name__ == "__main__":
    country = sys.argv[1] if len(sys.argv) > 1 else "Japan"
    print(fetch_country(country))
```

- [ ] **Step 3: Create travel-advisory tool**

```python
# tools/travel-advisory/travel_advisory.py
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_advisory(country_code):
    try:
        data = _get(f"https://www.travel-advisory.info/api?countrycode={urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"advisory fetch failed: {exc}"})

    api_status = data.get("api_status", {})
    if api_status.get("reply", {}).get("code") != 200:
        return json.dumps({"ok": False, "error": f"API error for {country_code}"})

    entry = (data.get("data") or {}).get(country_code.upper())
    if not entry:
        return json.dumps({"ok": False, "error": f"No data for country code: {country_code}"})

    advisory = entry.get("advisory", {})
    return json.dumps({
        "ok": True,
        "country": entry.get("name", country_code),
        "country_code": country_code.upper(),
        "score": advisory.get("score"),
        "message": advisory.get("message", ""),
        "updated": advisory.get("updated", ""),
        "source": advisory.get("source", ""),
    })


if __name__ == "__main__":
    cc = sys.argv[1] if len(sys.argv) > 1 else "JP"
    print(fetch_advisory(cc))
```

- [ ] **Step 4: Create geocode tool**

```python
# tools/geocode/geocode.py
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def geocode_city(city):
    try:
        data = _get(
            f"https://nominatim.openstreetmap.org/search"
            f"?q={urllib.request.quote(city)}&format=json&limit=1&addressdetails=1"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"geocode failed: {exc}"})

    if not data:
        return json.dumps({"ok": False, "error": f"Location not found: {city}"})

    place = data[0]
    return json.dumps({
        "ok": True,
        "query": city,
        "display_name": place.get("display_name"),
        "lat": place.get("lat"),
        "lon": place.get("lon"),
        "type": place.get("type"),
        "address": place.get("address", {}),
    })


def reverse_geocode(lat, lon):
    try:
        data = _get(
            f"https://nominatim.openstreetmap.org/reverse"
            f"?lat={lat}&lon={lon}&format=json&zoom=16"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"reverse geocode failed: {exc}"})

    return json.dumps({
        "ok": True,
        "lat": str(lat),
        "lon": str(lon),
        "display_name": data.get("display_name"),
        "address": data.get("address", {}),
    })


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        try:
            lat, lon = float(sys.argv[1]), float(sys.argv[2])
            print(reverse_geocode(lat, lon))
        except ValueError:
            print(geocode_city(sys.argv[1]))
    else:
        city = sys.argv[1] if len(sys.argv) > 1 else "London"
        print(geocode_city(city))
```

- [ ] **Step 5: Create forecast tool**

```python
# tools/forecast/forecast.py
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_forecast(city, days=7):
    try:
        geo = _get(
            f"https://geocoding-api.open-meteo.com/v1/search"
            f"?name={urllib.request.quote(city)}&count=1&language=en"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"geocoding failed: {exc}"})

    results = geo.get("results")
    if not results:
        return json.dumps({"ok": False, "error": f"City not found: {city}"})

    place = results[0]
    lat, lon = place["latitude"], place["longitude"]

    try:
        data = _get(
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            f"&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max"
            f"&forecast_days={days}&timezone=auto"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"forecast fetch failed: {exc}"})

    daily = data.get("daily", {})
    dates = daily.get("time", [])
    forecast_days = []
    for i, date in enumerate(dates):
        forecast_days.append({
            "date": date,
            "temp_max_c": daily.get("temperature_2m_max", [None])[i],
            "temp_min_c": daily.get("temperature_2m_min", [None])[i],
            "precipitation_mm": daily.get("precipitation_sum", [None])[i],
            "weather_code": daily.get("weather_code", [None])[i],
            "wind_max_kmph": daily.get("wind_speed_10m_max", [None])[i],
        })

    return json.dumps({
        "ok": True,
        "location": f"{place.get('name', city)}, {place.get('country', '')}",
        "days": forecast_days,
    })


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "London"
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    print(fetch_forecast(city, days))
```

- [ ] **Step 6: Create wikipedia-summary tool**

```python
# tools/wikipedia-summary/wikipedia_summary.py
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_summary(topic):
    slug = topic.strip().replace(" ", "_")
    try:
        data = _get(f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.request.quote(slug)}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"wikipedia fetch failed: {exc}"})

    if data.get("type") == "disambiguation":
        return json.dumps({"ok": True, "title": data.get("title"), "extract": data.get("extract", ""), "disambiguation": True})

    return json.dumps({
        "ok": True,
        "title": data.get("title", topic),
        "extract": data.get("extract", ""),
        "description": data.get("description", ""),
        "thumbnail": (data.get("thumbnail") or {}).get("source"),
    })


if __name__ == "__main__":
    topic = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "London"
    print(fetch_summary(topic))
```

- [ ] **Step 7: Create public-holidays tool**

```python
# tools/public-holidays/public_holidays.py
import json
import ssl
import sys
import urllib.request
import urllib.error
from datetime import datetime

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "apra-agent-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_holidays(country_code, year=None):
    if year is None:
        year = datetime.now().year
    try:
        data = _get(f"https://date.nager.at/api/v3/PublicHolidays/{year}/{urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"holidays fetch failed: {exc}"})

    if not isinstance(data, list):
        return json.dumps({"ok": False, "error": f"No holiday data for {country_code} {year}"})

    holidays = []
    for h in data:
        holidays.append({
            "date": h.get("date"),
            "name": h.get("localName"),
            "name_en": h.get("name"),
            "fixed": h.get("fixed"),
            "global": h.get("global"),
            "types": h.get("types", []),
        })

    return json.dumps({
        "ok": True,
        "country_code": country_code.upper(),
        "year": year,
        "count": len(holidays),
        "holidays": holidays,
    })


if __name__ == "__main__":
    cc = sys.argv[1] if len(sys.argv) > 1 else "US"
    yr = int(sys.argv[2]) if len(sys.argv) > 2 else None
    print(fetch_holidays(cc, yr))
```

- [ ] **Step 8: Add registry entries**

Add the following entries to `mcp/registry.mjs`, after the `textstats` entry in the `defaultRegistry` array:

```js
  {
    name: 'currency',
    description:
      'Converts between currencies using live exchange rates from the European Central Bank. ' +
      'Returns the rate and converted amount. Read-only, no LLM tokens.',
    inputSchema: z.object({
      from: z.string().optional().describe('Source currency code (e.g. USD). Defaults to USD.'),
      to: z.string().optional().describe('Target currency code (e.g. EUR). Defaults to EUR.'),
      amount: z.number().optional().describe('Amount to convert. Defaults to 1.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const from = args.from || 'USD';
      const to = args.to || 'EUR';
      const amount = args.amount ?? 1;
      const script = path.join(toolsDir, 'currency', 'currency.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${from}" "${to}" ${amount}`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'country-info',
    description:
      'Fetches country information: capital, region, population, languages, currencies, and timezones. ' +
      'Read-only, no LLM tokens.',
    inputSchema: z.object({
      country: z.string().describe('Country name (e.g. Japan, France).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const script = path.join(toolsDir, 'country-info', 'country_info.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${args.country}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'travel-advisory',
    description:
      'Fetches travel safety advisories for a country by ISO country code. ' +
      'Returns a safety score and advisory message. Read-only, no LLM tokens.',
    inputSchema: z.object({
      country: z.string().describe('ISO 3166-1 alpha-2 country code (e.g. JP, FR, US).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const script = path.join(toolsDir, 'travel-advisory', 'travel_advisory.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${args.country}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'geocode',
    description:
      'Geocodes a city name to lat/lon coordinates, or reverse-geocodes coordinates to a location name. ' +
      'Uses OpenStreetMap Nominatim. Read-only, no LLM tokens. Rate limited to 1 request per second.',
    inputSchema: z.object({
      city: z.string().optional().describe('City name to geocode.'),
      lat: z.number().optional().describe('Latitude for reverse geocoding.'),
      lon: z.number().optional().describe('Longitude for reverse geocoding.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const script = path.join(toolsDir, 'geocode', 'geocode.py');
      let command;
      if (typeof args.lat === 'number' && typeof args.lon === 'number') {
        command = `python3 "${script}" ${args.lat} ${args.lon}`;
      } else {
        const city = args.city || 'London';
        command = `python3 "${script}" "${city}"`;
      }
      const raw = await fleetApi.executeCommand({ member_name: 'doer', command });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'forecast',
    description:
      'Fetches a multi-day weather forecast for a city. Returns daily high/low temperatures, ' +
      'precipitation, and weather codes. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z.string().optional().describe('City name. Defaults to London.'),
      days: z.number().optional().describe('Number of forecast days (1-16). Defaults to 7.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = args.city || 'London';
      const days = args.days ?? 7;
      const script = path.join(toolsDir, 'forecast', 'forecast.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${city}" ${days}`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'wikipedia-summary',
    description:
      'Fetches a Wikipedia summary extract for any topic — cities, landmarks, people, concepts. ' +
      'Returns title, extract text, and description. Read-only, no LLM tokens.',
    inputSchema: z.object({
      topic: z.string().describe('The topic to look up (e.g. Tokyo, Eiffel Tower).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const script = path.join(toolsDir, 'wikipedia-summary', 'wikipedia_summary.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${args.topic}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'public-holidays',
    description:
      'Fetches public holidays for a country and year. Returns holiday names, dates, and types. ' +
      'Read-only, no LLM tokens.',
    inputSchema: z.object({
      country: z.string().describe('ISO 3166-1 alpha-2 country code (e.g. JP, US, GB).'),
      year: z.number().optional().describe('Year to check. Defaults to current year.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const yr = args.year ?? new Date().getFullYear();
      const script = path.join(toolsDir, 'public-holidays', 'public_holidays.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${args.country}" ${yr}`,
      });
      return parseToolOutput(raw);
    },
  },
```

- [ ] **Step 9: Run existing tests to check for regressions**

Run: `npm run test`
Expected: All PASS — the new registry entries don't break existing tool tests because `run()` is only called during live tests.

- [ ] **Step 10: Commit**

```bash
git add tools/currency/currency.py tools/country-info/country_info.py tools/travel-advisory/travel_advisory.py tools/geocode/geocode.py tools/forecast/forecast.py tools/wikipedia-summary/wikipedia_summary.py tools/public-holidays/public_holidays.py mcp/registry.mjs
git commit -m "feat: add 7 travel research tools (currency, country-info, advisory, geocode, forecast, wikipedia, holidays)"
```

---

### Task 13: npm scripts and config update

Add Phase 2 test scripts and update the host config.

**Files:**
- Modify: `package.json`
- Modify: `host.config.mjs`

- [ ] **Step 1: Add npm scripts**

Add these to the `"scripts"` block in `package.json`:

```json
"test:phase2": "node --test tests/host-response-parser.test.mjs tests/host-format-tools.test.mjs tests/host-budgets.test.mjs tests/host-guardrails.test.mjs tests/host-mock-fleet.test.mjs tests/host-prompts.test.mjs tests/host-strategy-open-ended.test.mjs tests/host-strategy-plan-execute.test.mjs tests/host-run-loop.test.mjs",
"test:phase2:live": "node --test tests/host-phase2.live.test.mjs"
```

- [ ] **Step 2: Update host.config.mjs with Phase 2 modules**

```js
// host.config.mjs
export default {
  name: 'apra-agent-kit',
  description: 'Fleet Agent Kit — travel research agent',

  fleet: {},

  comm: {
    adapter: 'express',
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
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
  },
};
```

- [ ] **Step 3: Run all Phase 2 tests**

Run: `npm run test:phase2`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json host.config.mjs
git commit -m "feat: add Phase 2 npm scripts and config with run loop, budgets, guardrails"
```

---

### Task 14: Live integration test

End-to-end test requiring Docker/Fleet. Submits a task to `/task` and verifies autonomous execution.

**Files:**
- Create: `tests/host-phase2.live.test.mjs`

- [ ] **Step 1: Write the live test**

```js
// tests/host-phase2.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const { startHost } = await import('../host/index.mjs');

function httpPost(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('POST /task executes a simple open-ended weather task', { timeout: 300000 }, async () => {
  const { host, close } = await startHost({
    port: 0,
    runLoop: { enabled: true, strategy: 'open-ended' },
    budgets: { maxIterations: 10, timeoutMs: 120_000 },
    guardrails: { defaultPolicy: 'allow', validateInputs: true },
  });

  try {
    const res = await httpPost(host.port(), '/task', {
      goal: 'What is the current weather in London?',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(['completed', 'budget_exceeded'].includes(body.status));
    assert.ok(body.taskId);
    assert.ok(body.history.length > 0);
  } finally {
    await close();
  }
});

test('POST /task executes a plan-execute task with review', { timeout: 300000 }, async () => {
  const { host, close } = await startHost({
    port: 0,
    runLoop: { enabled: true, strategy: 'plan-execute', maxReplanAttempts: 2 },
    budgets: { maxIterations: 15, timeoutMs: 180_000 },
    guardrails: { defaultPolicy: 'allow', validateInputs: true },
  });

  try {
    const res = await httpPost(host.port(), '/task', {
      goal: 'What time is it in New York and what is the weather?',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(['completed', 'budget_exceeded'].includes(body.status));
    assert.ok(body.history.length >= 2);
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Verify test file is syntactically correct**

Run: `node -e "import('./tests/host-phase2.live.test.mjs').catch(e => console.log('parse ok'))"`
Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add tests/host-phase2.live.test.mjs
git commit -m "feat: add Phase 2 live integration tests"
```

---

### Task 15: Final verification

**Files:** None — verification only.

- [ ] **Step 1: Run all Phase 2 unit tests**

Run: `npm run test:phase2`
Expected: All PASS.

- [ ] **Step 2: Run all Phase 1 tests (regression check)**

Run: `npm run test:host`
Expected: All PASS.

- [ ] **Step 3: Run all existing tests (full regression check)**

Run: `npm run test`
Expected: All PASS.

- [ ] **Step 4: Verify Phase 2 file tree**

Run: `find host/ -name "*.mjs" | sort` and `find tools/ -name "*.py" | sort`

Expected new files:
```
host/budgets.mjs
host/guardrails.mjs
host/prompts/act.mjs
host/prompts/execute.mjs
host/prompts/format-tools.mjs
host/prompts/index.mjs
host/prompts/plan.mjs
host/prompts/reason.mjs
host/prompts/replan.mjs
host/prompts/resolve-args.mjs
host/prompts/review.mjs
host/prompts/step-review.mjs
host/prompts/system.mjs
host/response-parser.mjs
host/run-loop.mjs
host/strategies/open-ended.mjs
host/strategies/plan-execute.mjs
tools/country-info/country_info.py
tools/currency/currency.py
tools/forecast/forecast.py
tools/geocode/geocode.py
tools/public-holidays/public_holidays.py
tools/travel-advisory/travel_advisory.py
tools/wikipedia-summary/wikipedia_summary.py
```

- [ ] **Step 5: Verify both entry points still work**

Run: `npm run test:host` — verifies host path.
Run: `npm run test` — verifies MCP path.
Expected: Identical tool sets, all tests pass.

---

## Summary

| Task | Files | Tests | Depends on |
|------|-------|-------|------------|
| 1. Response parser | `host/response-parser.mjs` | `tests/host-response-parser.test.mjs` | — |
| 2. Format tools | `host/prompts/format-tools.mjs` | `tests/host-format-tools.test.mjs` | — |
| 3. Budgets | `host/budgets.mjs` | `tests/host-budgets.test.mjs` | — |
| 4. Guardrails | `host/guardrails.mjs` | `tests/host-guardrails.test.mjs` | — |
| 5. Mock fleet ext | `tests/helpers/mock-fleet.mjs` | `tests/host-mock-fleet.test.mjs` | — |
| 6. Prompt templates | `host/prompts/*.mjs` | `tests/host-prompts.test.mjs` | 1, 2 |
| 7. Open-ended strategy | `host/strategies/open-ended.mjs` | `tests/host-strategy-open-ended.test.mjs` | 1, 5, 6 |
| 8. Plan-execute strategy | `host/strategies/plan-execute.mjs` | `tests/host-strategy-plan-execute.test.mjs` | 1, 5, 6 |
| 9. Run loop | `host/run-loop.mjs` | `tests/host-run-loop.test.mjs` | 3, 4, 7, 8 |
| 10. Config evolution | `host/config.mjs` | `tests/host-config.test.mjs` | 9 |
| 11. Host integration | `host/index.mjs` | `tests/host-index.test.mjs` | 9 |
| 12. Python tools | `tools/*/*.py`, `mcp/registry.mjs` | — | — |
| 13. npm scripts + config | `package.json`, `host.config.mjs` | — | 1-12 |
| 14. Live integration test | `tests/host-phase2.live.test.mjs` | self | 1-13 |
| 15. Final verification | — | — | All |

Tasks 1-5 are independent and can be implemented in parallel. Task 6 depends on 1 and 2. Tasks 7 and 8 depend on 1, 5, and 6. Task 9 depends on 3, 4, 7, and 8. Tasks 10-12 can be done in parallel after 9. Tasks 13-15 are sequential at the end.
