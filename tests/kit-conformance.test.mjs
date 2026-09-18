// tests/kit-conformance.test.mjs
//
// The contract a clone must not break.
//
// The adoption flow encourages an adopter to delete the demo tools and agents
// and edit freely. That is the point of a kit — but it means safety properties
// can be removed by accident, and nothing notices. These tests assert the
// properties that must survive editing. A clone that fails this file has
// changed something it should not have.
//
// See docs/CONTRACT.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createGuardrails } = await import('../host/guardrails.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');
const { kitInfo } = await import('../host/kit-info.mjs');

function tool(overrides = {}) {
  return {
    name: 't',
    reversible: true,
    timeout: 5000,
    run: async () => 'ok',
    ...overrides,
  };
}

const executor = async (t, opts) => ({ ok: true, result: await t.run(opts) });

// ---------------------------------------------------------------------------
// 1. Irreversible tools are gated by default
// ---------------------------------------------------------------------------

test('conformance: an irreversible tool is not executable without an approver', async () => {
  const g = createGuardrails({}, [], executor);
  const res = await g.execute(tool({ reversible: false }), { args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'guardrail_denied');
  assert.equal(res.reason, 'approval_denied');
});

test('conformance: defaultPolicy allow does not un-gate an irreversible tool', async () => {
  const g = createGuardrails({ defaultPolicy: 'allow' }, [], executor);
  const res = await g.execute(tool({ reversible: false }), { args: {} });
  assert.equal(res.ok, false, 'defaultPolicy must not override the reversible:false gate');
});

test('conformance: a reversible tool still runs without ceremony', async () => {
  const g = createGuardrails({}, [], executor);
  const res = await g.execute(tool(), { args: {} });
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// 2. Registry defaults stay safe
// ---------------------------------------------------------------------------

test('conformance: registry default for reversible is true, and is explicit', async () => {
  const [t] = extendRegistry([{ name: 'x', run: async () => 1 }]);
  assert.equal(t.reversible, true, 'a tool that says nothing is treated as reversible');
});

test('conformance: an explicit reversible:false survives registry extension', async () => {
  const [t] = extendRegistry([{ name: 'x', reversible: false, run: async () => 1 }]);
  assert.equal(t.reversible, false, 'the registry must never overwrite an explicit flag');
});

// ---------------------------------------------------------------------------
// 3. Denials are values, not exceptions
// ---------------------------------------------------------------------------

test('conformance: every denial path returns error-as-value', async () => {
  // Each case pairs a config with a tool that actually reaches that gate.
  // Order matters in the guardrail: freeze, then policy, then approval, then
  // sandbox, then dry-run — so a dry-run case must use a tool that is not
  // already stopped by the approval gate.
  const cases = [
    [{ policies: { t: 'deny' } }, tool({ reversible: false, name: 't' }), 'policy_denied'],
    [{ freeze: true }, tool({ reversible: false, name: 't' }), 'frozen'],
    [{ approvalCallback: async () => 'deny' }, tool({ reversible: false, name: 't' }), 'approval_denied'],
    [{ dryRunMode: true }, tool({ name: 't' }), 'dry_run'],
  ];
  for (const [config, subject, expected] of cases) {
    const g = createGuardrails(config, [], executor);
    const res = await g.execute(subject, { args: {} });
    assert.equal(res.ok, false);
    assert.equal(res.reason, expected, `expected reason ${expected}`);
    assert.equal(typeof res.error, 'string', 'denial must not throw');
  }
});

test('conformance: dry-run stops a tool that would otherwise be allowed', async () => {
  const g = createGuardrails({ dryRunMode: true, defaultPolicy: 'allow' }, [], executor);
  const res = await g.execute(tool(), { args: {} });
  assert.equal(res.ok, false, 'dryRunMode must prevent execution of even a plain reversible tool');
  assert.equal(res.reason, 'dry_run');
});

// ---------------------------------------------------------------------------
// 4. The kill switch
// ---------------------------------------------------------------------------

test('conformance: freeze denies irreversible tools but leaves reads working', async () => {
  const g = createGuardrails({ freeze: true, defaultPolicy: 'allow' }, [], executor);

  const write = await g.execute(tool({ reversible: false, name: 'w' }), { args: {} });
  assert.equal(write.ok, false);
  assert.equal(write.reason, 'frozen');

  const read = await g.execute(tool({ name: 'r' }), { args: {} });
  assert.equal(read.ok, true, 'freezing writes must not stop reads');
});

test('conformance: freeze overrides an explicit allow policy', async () => {
  const g = createGuardrails({ freeze: true, policies: { w: 'allow' } }, [], executor);
  const res = await g.execute(tool({ reversible: false, name: 'w' }), { args: {} });
  assert.equal(res.ok, false, 'freeze is a kill switch — per-tool policy must not defeat it');
  assert.equal(res.reason, 'frozen');
});

test('conformance: guardrails report whether they are frozen', async () => {
  assert.equal(createGuardrails({ freeze: true }, [], executor).frozen(), true);
  assert.equal(createGuardrails({}, [], executor).frozen(), false);
});

// ---------------------------------------------------------------------------
// 5. Approval carries enough context to decide
// ---------------------------------------------------------------------------

test('conformance: approvalCallback receives the tool and the args', async () => {
  let seen = null;
  const g = createGuardrails({
    approvalCallback: async (ctx) => { seen = ctx; return 'approve'; },
  }, [], executor);

  await g.execute(tool({ reversible: false, name: 'w' }), { args: { city: 'London' } });

  assert.ok(seen, 'the callback must actually be called');
  assert.equal(seen.tool.name, 'w', 'an approver cannot decide without knowing the tool');
  assert.deepEqual(seen.args, { city: 'London' }, 'an approver cannot decide without the args');
});

test('conformance: anything other than "approve" denies', async () => {
  for (const decision of ['deny', 'maybe', '', null, undefined]) {
    const g = createGuardrails({ approvalCallback: async () => decision }, [], executor);
    const res = await g.execute(tool({ reversible: false }), { args: {} });
    assert.equal(res.ok, false, `decision ${JSON.stringify(decision)} must not permit execution`);
  }
});

// ---------------------------------------------------------------------------
// 6. Trace ids reach tool execution
// ---------------------------------------------------------------------------

test('conformance: traceId reaches tool.run through the executor', async () => {
  const { executeTool } = await import('../host/tools/executor.mjs');
  let seen;
  const t = tool({ run: async (o) => { seen = o.traceId; return 'ok'; } });
  const res = await executeTool(t, { fleetApi: {}, args: {}, traceId: 'tr-direct' });
  assert.equal(res.ok, true);
  assert.equal(seen, 'tr-direct', 'a tool must be able to forward the trace id downstream');
});

test('conformance: traceId survives the guardrail layer', async () => {
  const { executeTool } = await import('../host/tools/executor.mjs');
  let seen;
  const g = createGuardrails({ defaultPolicy: 'allow' }, [], executeTool);
  const t = tool({ run: async (o) => { seen = o.traceId; return 'ok'; } });
  await g.execute(t, { fleetApi: {}, args: {}, traceId: 'tr-gated' });
  assert.equal(seen, 'tr-gated', 'guardrails must not strip the trace id');
});

test('conformance: a run always reports a traceId, generated when absent', async () => {
  const { runTask } = await import('../host/run-loop.mjs');
  const fleetApi = {
    executePrompt: async () => ({ content: [{ type: 'text', text: 'no action' }] }),
  };

  const given = await runTask({ goal: 'x' }, {
    strategy: 'open-ended', tools: [], fleetApi, traceId: 'tr-supplied', maxNoActionTurns: 1,
  });
  assert.equal(given.traceId, 'tr-supplied', 'a caller-supplied trace id must be preserved');

  const generated = await runTask({ goal: 'x' }, {
    strategy: 'open-ended', tools: [], fleetApi, maxNoActionTurns: 1,
  });
  assert.equal(typeof generated.traceId, 'string');
  assert.ok(generated.traceId.length > 0, 'a run must never report an empty trace id');
});

// ---------------------------------------------------------------------------
// 7. Kit identity is discoverable
// ---------------------------------------------------------------------------

test('conformance: the kit reports a version', async () => {
  const info = await kitInfo();
  assert.equal(typeof info.version, 'string');
  assert.notEqual(info.version, '0.0.0', 'package.json must carry a version for clones to record');
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});
