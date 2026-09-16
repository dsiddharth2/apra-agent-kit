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
