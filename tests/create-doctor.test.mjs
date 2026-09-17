// tests/create-doctor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_MIN, runChecks, formatChecks } from '../create/doctor.mjs';

// A probe set where everything passes. Each test degrades one thing.
function healthyProbes(overrides = {}) {
  return {
    which: (bin) => ['python3', 'apra-fleet', 'claude'].includes(bin),
    version: (bin) => {
      if (bin === 'python3') return 'Python 3.11.2';
      if (bin === 'apra-fleet') return '1.4.0';
      if (bin === 'claude') return '2.0.1';
      return null;
    },
    exists: () => true,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-test', npm_config_x: '1' },
    cwd: '/project',
    nodeVersion: 'v22.18.0',
    ...overrides,
  };
}

function byId(checks, id) {
  const check = checks.find((c) => c.id === id);
  assert.ok(check, `no check with id ${id}`);
  return check;
}

test('a healthy environment passes all six checks', () => {
  const checks = runChecks(healthyProbes());
  assert.equal(checks.length, 6);
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.deepEqual(
    checks.map((c) => c.id),
    ['node', 'python3', 'apra-fleet', 'claude', 'apralabs', 'token'],
  );
});

test('node below the floor fails with the floor in the fix', () => {
  const checks = runChecks(healthyProbes({ nodeVersion: 'v20.11.0' }));
  const node = byId(checks, 'node');
  assert.equal(node.ok, false);
  assert.match(node.fix, new RegExp(NODE_MIN.replace(/\./g, '\\.')));
});

test('node at exactly the floor passes', () => {
  const checks = runChecks(healthyProbes({ nodeVersion: `v${NODE_MIN}` }));
  assert.equal(byId(checks, 'node').ok, true);
});

test('a missing apra-fleet explains that workflows cannot run', () => {
  const checks = runChecks(healthyProbes({ which: (bin) => bin !== 'apra-fleet' }));
  const fleet = byId(checks, 'apra-fleet');
  assert.equal(fleet.ok, false);
  assert.match(fleet.consequence, /workflow/i);
  assert.match(fleet.fix, /npm i -g @apralabs\/apra-fleet/);
});

test('APRA_FLEET_BIN satisfies the apra-fleet check when the binary is off PATH', () => {
  const checks = runChecks(healthyProbes({
    which: (bin) => bin !== 'apra-fleet',
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-test', APRA_FLEET_BIN: '/opt/fleet/bin/apra-fleet' },
  }));
  assert.equal(byId(checks, 'apra-fleet').ok, true);
});

test('a missing claude fails but says mock tests still pass', () => {
  const checks = runChecks(healthyProbes({ which: (bin) => bin !== 'claude' }));
  const claude = byId(checks, 'claude');
  assert.equal(claude.ok, false);
  assert.match(claude.consequence, /mock tests still pass/i);
});

test('an unresolved @apralabs symlink fails', () => {
  const checks = runChecks(healthyProbes({ exists: () => false }));
  assert.equal(byId(checks, 'apralabs').ok, false);
});

test('an empty token is treated as unset', () => {
  const checks = runChecks(healthyProbes({ env: { CLAUDE_CODE_OAUTH_TOKEN: '   ' } }));
  const token = byId(checks, 'token');
  assert.equal(token.ok, false);
  assert.match(token.fix, /claude setup-token/);
});

test('no failing check renders a bare mark — every one carries a consequence and a fix', () => {
  const checks = runChecks(healthyProbes({
    which: () => false,
    exists: () => false,
    env: {},
    nodeVersion: 'v18.0.0',
  }));
  for (const check of checks.filter((c) => !c.ok)) {
    assert.ok(check.consequence?.length > 0, `${check.id} has no consequence`);
    assert.ok(check.fix?.length > 0, `${check.id} has no fix`);
  }
});

test('formatChecks prints the fix beneath a failing check', () => {
  const output = formatChecks(runChecks(healthyProbes({ which: (bin) => bin !== 'apra-fleet' })));
  assert.match(output, /apra-fleet/);
  assert.match(output, /→ .*npm i -g @apralabs\/apra-fleet/);
  assert.match(output, /python3\s+✓/);
});

test('the token value is never printed', () => {
  const output = formatChecks(runChecks(healthyProbes()));
  assert.ok(!output.includes('sk-test'), 'doctor must not echo the token');
});

test('importing the doctor prints nothing — the run guard is entry-point only', async () => {
  // A generated project runs this file directly as scripts/doctor.mjs, so it
  // must self-execute there while staying silent on import here.
  const logged = [];
  const realLog = console.log;
  console.log = (line) => logged.push(line);
  try {
    await import('../create/doctor.mjs?probe-import');
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(logged, [], 'importing the module must not run the checks');
});
