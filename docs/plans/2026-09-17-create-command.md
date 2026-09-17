# Create Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `npm create @dsiddharth2/fleet-agent my-agent`, replacing the clone-and-delete-`.git` onboarding with one command that emits a named, runnable project.

**Architecture:** The repository publishes itself as `@dsiddharth2/create-fleet-agent`. npm's `files` field selects which folders enter the tarball; at generate time the CLI copies those folders into the target, then overlays `template/`, which wins on conflict. Two prerequisite refactors land first, because the repo as it stands cannot emit a project that runs.

**Tech Stack:** Node ≥22.16 ESM, `node:test`, `node:util.parseArgs`, `node:readline/promises`. No new runtime dependencies.

**Spec:** `docs/specs/2026-09-17-create-command-spec.md`

## Global Constraints

- **Node floor is `>=22.16`**, matching the existing `engines` field. The doctor's minimum is the string `22.16.0`.
- **No new runtime dependencies.** Every module here uses only the Node standard library. `package.json` `dependencies` stays exactly as it is.
- **Reserved member keywords.** Workflow bodies address `'doer'` and `'reviewer'`, never a member name. This holds in the generated starter workflow.
- **Prompts explain before they ask.** Every prompt states the purpose, what breaks without the step, and whether anything outside the project directory is modified. A bare `(Y/n)` is a defect.
- **Doctor output never shows a bare ✗.** Every failing check carries a consequence line and a fix line.
- **`template/` holds exactly 8 entries — 9 files on disk**, `workflows/hello/` being two of them. An entry belongs there only if it has no counterpart in the repo, or must differ from it. Adding a ninth entry means the spec's Decision 4 needs revisiting.
- **Tests require no Fleet binary, no members, and no token**, consistent with the existing suite. Doctor probes are injected.
- **ESM only, `.mjs`**, two-space indent, single quotes, semicolons — matching the existing codebase.

---

### Task 1: Relocate `ensure-apralabs.mjs` out of the demo workflow

`ensure-apralabs.mjs` is framework code sitting inside an example directory. `mcp/main.mjs` and `host/index.mjs` both import it, so a generated project without `workflows/demo/` has a broken MCP server. It moves to `transport/`, beside the other transport-layer concern.

**Files:**
- Create: `transport/ensure-apralabs.mjs` (moved from `workflows/demo/ensure-apralabs.mjs`)
- Delete: `workflows/demo/ensure-apralabs.mjs`
- Modify: `mcp/main.mjs:4`, `host/index.mjs:135`, `tests/setup-fleet-modules.mjs:1`, `workflows/demo/main.mjs:4`, `workflows/inspect-members/main.mjs:6`, `workflows/city-briefing/main.mjs:4`, `scripts/docker-entrypoint.sh`
- Test: `tests/ensure-apralabs-location.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `transport/ensure-apralabs.mjs` exporting `ensureApralabs(): void` — unchanged signature, new path. Every later task importing it uses this path.

- [ ] **Step 1: Write the failing test**

The module resolves `node_modules` from a `repoRoot` constant computed relative to its own location. Moving it up one directory silently breaks that constant, and the breakage only shows as a symlink landing one directory too high — which no existing test would catch. This test pins the location and the resolved root.

```js
// tests/ensure-apralabs-location.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ensureApralabs lives in transport/, not inside a workflow', () => {
  assert.ok(
    fs.existsSync(path.join(repoRoot, 'transport', 'ensure-apralabs.mjs')),
    'transport/ensure-apralabs.mjs must exist',
  );
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'workflows', 'demo', 'ensure-apralabs.mjs')),
    'the old copy under workflows/demo/ must be gone',
  );
});

test('no source file imports ensure-apralabs from the old demo path', () => {
  const dirs = ['mcp', 'host', 'transport', 'pool', 'comm', 'workflows', 'tests', 'scripts'];
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|js|sh)$/.test(entry.name)) {
        const body = fs.readFileSync(full, 'utf8');
        if (body.includes('demo/ensure-apralabs')) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    }
  };

  for (const dir of dirs) walk(path.join(repoRoot, dir));
  assert.deepEqual(offenders, [], `stale imports: ${offenders.join(', ')}`);
});

test('repoRoot resolves to the repository root, not one level above', async () => {
  const mod = await import('../transport/ensure-apralabs.mjs');
  assert.equal(typeof mod.ensureApralabs, 'function');

  // The constant is module-private, so assert on observable behaviour: the
  // module's own URL is one level below the root it must compute.
  const moduleDir = path.dirname(fileURLToPath(new URL('../transport/ensure-apralabs.mjs', import.meta.url)));
  assert.equal(path.resolve(moduleDir, '..'), repoRoot);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ensure-apralabs-location.test.mjs`
Expected: FAIL — `transport/ensure-apralabs.mjs must exist`.

- [ ] **Step 3: Move the file and fix its root constant**

```bash
git mv workflows/demo/ensure-apralabs.mjs transport/ensure-apralabs.mjs
```

In `transport/ensure-apralabs.mjs`, change the root constant from two levels up to one. It currently reads:

```js
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
```

Replace with:

```js
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
```

Nothing else in the file changes.

- [ ] **Step 4: Update the six importers**

```bash
# From the repository root.
sed -i '' "s#'../workflows/demo/ensure-apralabs.mjs'#'../transport/ensure-apralabs.mjs'#" \
  mcp/main.mjs host/index.mjs tests/setup-fleet-modules.mjs
sed -i '' "s#'../demo/ensure-apralabs.mjs'#'../../transport/ensure-apralabs.mjs'#" \
  workflows/inspect-members/main.mjs workflows/city-briefing/main.mjs
sed -i '' "s#'./ensure-apralabs.mjs'#'../../transport/ensure-apralabs.mjs'#" \
  workflows/demo/main.mjs
sed -i '' "s#./workflows/demo/ensure-apralabs.mjs#./transport/ensure-apralabs.mjs#" \
  scripts/docker-entrypoint.sh
```

On GNU sed (Linux, CI) drop the `''` after `-i`.

Verify no stale references remain in shipping code:

```bash
grep -rn "demo/ensure-apralabs" --include='*.mjs' --include='*.js' --include='*.sh' \
  mcp host transport pool comm workflows tests scripts
```

Expected: no output. Matches inside `docs/superpowers/plans/` are historical records of completed work — leave them.

- [ ] **Step 5: Update the documentation references**

In `README.md:93`, change the import in the workflow example:

```js
import { ensureApralabs } from '../../transport/ensure-apralabs.mjs';
```

In `README.md:318`, the layout block lists `ensure-apralabs.mjs` under `workflows/demo/`. Remove that line and add it under the `transport/` block:

```text
transport/
  stdio-fleet.mjs       # spawn apra-fleet over stdio, wrap as fleetApi
  ensure-apralabs.mjs   # symlinks @apralabs packages from Fleet install
```

In `docs/development.md:180`, apply the same import change as `README.md:93`.

- [ ] **Step 6: Run the new test and the full suite**

Run: `node --test tests/ensure-apralabs-location.test.mjs`
Expected: PASS — 3 tests.

Run: `npm test`
Expected: PASS. This is the real gate — `tests/setup-fleet-modules.mjs` is imported by most suites, so a bad path here fails everything.

- [ ] **Step 7: Commit**

```bash
git add transport/ensure-apralabs.mjs mcp/main.mjs host/index.mjs \
  tests/setup-fleet-modules.mjs tests/ensure-apralabs-location.test.mjs \
  workflows/demo/main.mjs workflows/inspect-members/main.mjs \
  workflows/city-briefing/main.mjs scripts/docker-entrypoint.sh \
  README.md docs/development.md
git add -u workflows/demo/
git commit -m "refactor: move ensure-apralabs into transport/

It is framework code that mcp/main.mjs and host/index.mjs import, so a
project without workflows/demo/ could not start. Its repoRoot constant
moves up one level with it."
```

---

### Task 2: Extract the registry's shared helpers

`mcp/registry.mjs` imports the three demo workflows at module scope, so the starter registry cannot simply drop them — it would have to reimplement `toolsDir`, `shellEscape` and `parseToolOutput` too. Extracting those makes `template/mcp/registry.mjs` a short, obviously-correct file.

**Files:**
- Create: `mcp/registry-helpers.mjs`
- Modify: `mcp/registry.mjs:1-38`
- Test: `tests/mcp-registry-helpers.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `mcp/registry-helpers.mjs` exporting `toolsDir: string`, `shellEscape(value: string): string`, `parseToolOutput(raw: unknown): object`. Task 7's starter registry imports all three.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcp-registry-helpers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolsDir, shellEscape, parseToolOutput } from '../mcp/registry-helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('toolsDir points at the repository tools directory', () => {
  assert.equal(toolsDir, path.join(repoRoot, 'tools'));
});

test('shellEscape neutralises quotes and newlines', () => {
  assert.equal(shellEscape('say "hi"'), 'say \\"hi\\"');
  assert.equal(shellEscape('one\ntwo'), 'one two');
  assert.equal(shellEscape('plain'), 'plain');
});

test('parseToolOutput reads a plain JSON string', () => {
  assert.deepEqual(parseToolOutput('{"ok":true}'), { ok: true });
});

test('parseToolOutput prefers structuredContent.stdout', () => {
  const raw = { structuredContent: { stdout: '{"ok":true,"via":"structured"}' } };
  assert.deepEqual(parseToolOutput(raw), { ok: true, via: 'structured' });
});

test('parseToolOutput falls back to the first text content part', () => {
  const raw = { content: [{ type: 'text', text: '{"ok":true,"via":"content"}' }] };
  assert.deepEqual(parseToolOutput(raw), { ok: true, via: 'content' });
});

test('parseToolOutput reports unparseable output instead of throwing', () => {
  const result = parseToolOutput('not json');
  assert.equal(result.ok, false);
  assert.match(result.error, /failed to parse/);
  assert.equal(result.raw, 'not json');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-registry-helpers.test.mjs`
Expected: FAIL — `Cannot find module '../mcp/registry-helpers.mjs'`.

- [ ] **Step 3: Create the helpers module**

The three helpers move verbatim out of `mcp/registry.mjs:8-38`. Only the `toolsDir` relative path changes meaning — it is computed from this file's location, which is the same directory, so the `'../tools'` argument is unchanged.

```js
// mcp/registry-helpers.mjs
// Shared by the kit's registry and by the starter registry a generated
// project receives. Kept separate so the starter can be a short file that
// registers its own workflows without reimplementing these.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools',
);

export function shellEscape(value) {
  return value.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function parseToolOutput(raw) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw?.structuredContent?.stdout) {
    text = raw.structuredContent.stdout;
  } else if (raw?.content?.[0]?.text) {
    text = raw.content[0].text;
  } else {
    text = raw?.output ?? '';
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: 'failed to parse tool output', raw: text };
  }
}
```

- [ ] **Step 4: Import them in the kit registry**

In `mcp/registry.mjs`, delete the `toolsDir` constant and the `shellEscape` and `parseToolOutput` function bodies (lines 8-38), and replace the header. The file's first lines become:

```js
import * as z from 'zod/v4';
import { toolsDir, shellEscape, parseToolOutput } from './registry-helpers.mjs';
import { runDemo } from '../workflows/demo/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';
import { runCityBriefing } from '../workflows/city-briefing/main.mjs';
```

The `path` and `fileURLToPath` imports are no longer used by this file — remove both. Everything from `export const defaultRegistry = [` onward is untouched.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/mcp-registry-helpers.test.mjs`
Expected: PASS — 6 tests.

Run: `npm test`
Expected: PASS. `tests/mcp.test.mjs` exercises the registry entries that use these helpers, so a bad extraction fails there.

- [ ] **Step 6: Commit**

```bash
git add mcp/registry-helpers.mjs mcp/registry.mjs tests/mcp-registry-helpers.test.mjs
git commit -m "refactor: extract registry helpers into their own module

The starter registry a generated project receives registers different
workflows but needs the same toolsDir, shellEscape and parseToolOutput."
```

---

### Task 3: The doctor — six environment checks

One copy of the checks, two consumers: the generator runs them to decide what to prompt for, and the generated project receives this file as `scripts/doctor.mjs`. Probes are injected so tests never depend on what is installed on the machine running them.

**Files:**
- Create: `create/doctor.mjs`
- Test: `tests/create-doctor.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `NODE_MIN: string` — `'22.16.0'`
  - `createProbes({ env?, cwd? }): Probes` — real probes; `Probes` is `{ which(bin): boolean, version(bin, args): string|null, exists(p): boolean, env: object, cwd: string }`
  - `runChecks(probes): Check[]` where `Check` is `{ id, label, ok, detail, consequence, fix }`; `consequence` and `fix` are `null` when `ok` is true
  - `formatChecks(checks): string` — the printable block
  - `main(probes?): Promise<number>` — prints and returns an exit code

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-doctor.test.mjs`
Expected: FAIL — `Cannot find module '../create/doctor.mjs'`.

- [ ] **Step 3: Write the doctor**

```js
// create/doctor.mjs
// One copy of the environment checks, two consumers: the generator (which
// runs them to decide what to offer installing) and the generated project
// (which receives this file as scripts/doctor.mjs). Probes are injected so
// tests never depend on what is installed on the machine running them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_MIN = '22.16.0';

export function createProbes({ env = process.env, cwd = process.cwd() } = {}) {
  return {
    which(bin) {
      try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },
    version(bin, args = ['--version']) {
      try {
        return execFileSync(bin, args, { encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {
        return null;
      }
    },
    exists(target) {
      return fs.existsSync(target);
    },
    env,
    cwd,
    nodeVersion: process.version,
  };
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(found, floor) {
  const a = parseVersion(found);
  const b = parseVersion(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function pass(id, label, detail) {
  return { id, label, ok: true, detail, consequence: null, fix: null };
}

function fail(id, label, detail, consequence, fix) {
  return { id, label, ok: false, detail, consequence, fix };
}

export function runChecks(probes) {
  const env = probes.env ?? {};
  const checks = [];

  const nodeVersion = probes.nodeVersion ?? process.version;
  checks.push(
    atLeast(nodeVersion, NODE_MIN)
      ? pass('node', 'node', nodeVersion.replace(/^v/, ''))
      : fail(
          'node',
          'node',
          nodeVersion.replace(/^v/, ''),
          `the kit requires Node >=${NODE_MIN}; nothing here will run`,
          `install Node ${NODE_MIN} or newer (nodejs.org, nvm, or your package manager)`,
        ),
  );

  const python = probes.which('python3');
  checks.push(
    python
      ? pass('python3', 'python3', probes.version('python3') ?? 'present')
      : fail(
          'python3',
          'python3',
          'not found',
          'the Python tool scripts under tools/ cannot run',
          'install Python 3 and ensure python3 is on PATH',
        ),
  );

  const fleetOnPath = probes.which('apra-fleet');
  const fleetOverride = (env.APRA_FLEET_BIN ?? '').trim();
  checks.push(
    fleetOnPath || fleetOverride
      ? pass(
          'apra-fleet',
          'apra-fleet',
          fleetOnPath ? (probes.version('apra-fleet') ?? 'present') : `APRA_FLEET_BIN=${fleetOverride}`,
        )
      : fail(
          'apra-fleet',
          'apra-fleet',
          'not found',
          'workflows cannot spawn Fleet, so every run fails at startup',
          'npm i -g @apralabs/apra-fleet && apra-fleet install --skill none (or set APRA_FLEET_BIN)',
        ),
  );

  checks.push(
    probes.which('claude')
      ? pass('claude', 'claude', probes.version('claude') ?? 'present')
      : fail(
          'claude',
          'claude',
          'not found',
          'live agent() calls fail; mock tests still pass',
          'npm i -g @anthropic-ai/claude-code',
        ),
  );

  const linked = path.join(probes.cwd, 'node_modules', '@apralabs', 'apra-fleet-workflow');
  checks.push(
    probes.exists(linked)
      ? pass('apralabs', '@apralabs', 'linked')
      : fail(
          'apralabs',
          '@apralabs',
          'not linked',
          'workflows fail at import of @apralabs/apra-fleet-workflow',
          'install Fleet first — the link is created automatically on the next run',
        ),
  );

  const token = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  checks.push(
    token
      ? pass('token', 'token', 'set')
      : fail(
          'token',
          'token',
          'CLAUDE_CODE_OAUTH_TOKEN unset',
          'agent() calls fail; command() and transform() still work',
          'export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"',
        ),
  );

  return checks;
}

export function formatChecks(checks) {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = [];
  for (const check of checks) {
    const label = check.label.padEnd(width, ' ');
    lines.push(`  ${label}  ${check.ok ? '✓' : '✗'} ${check.detail}`);
    if (!check.ok) {
      lines.push(`  ${' '.repeat(width)}    → ${check.consequence}. ${check.fix}`);
    }
  }
  return lines.join('\n');
}

export async function main(probes = createProbes()) {
  const checks = runChecks(probes);
  console.log(formatChecks(checks));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${checks.length} checks failed.`);
    return 1;
  }
  console.log('\nAll checks passed.');
  return 0;
}

// This file is also copied into generated projects as scripts/doctor.mjs and
// run directly by `npm run doctor`, so it must execute when it is the entry
// point — and stay silent when the generator imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/create-doctor.test.mjs`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add create/doctor.mjs tests/create-doctor.test.mjs
git commit -m "feat: add the environment doctor

Six checks with injected probes. Every failure reports what breaks and
how to fix it; the token value is never echoed."
```

---

### Task 4: Copy and overlay

The generator's whole file-moving job: copy the published folders into the target, then overlay `template/` on top. `template/` wins on conflict, and `gitignore` is renamed to `.gitignore` on write because npm rewrites a packed `.gitignore` to `.npmignore`.

**Files:**
- Create: `create/copy.mjs`
- Test: `tests/create-copy.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `copyTree(src: string, dest: string, opts?: { overwrite?: boolean, rename?: Record<string,string> }): string[]` — returns relative paths written, sorted
  - `RENAME_ON_WRITE: Record<string,string>` — `{ gitignore: '.gitignore' }`
  - `PUBLISHED_DIRS: string[]` — the framework paths copied before the overlay

- [ ] **Step 1: Write the failing test**

```js
// tests/create-copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTree, RENAME_ON_WRITE, PUBLISHED_DIRS } from '../create/copy.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'create-copy-'));
}

function write(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

test('copyTree copies nested files and reports what it wrote', () => {
  const src = tmp();
  const dest = tmp();
  write(src, 'a.txt', 'A');
  write(src, 'deep/nested/b.txt', 'B');

  const written = copyTree(src, dest);

  assert.deepEqual(written, ['a.txt', path.join('deep', 'nested', 'b.txt')]);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(dest, 'deep/nested/b.txt'), 'utf8'), 'B');
});

test('copyTree refuses to clobber by default', () => {
  const src = tmp();
  const dest = tmp();
  write(src, 'shared.txt', 'from source');
  write(dest, 'shared.txt', 'already here');

  copyTree(src, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'shared.txt'), 'utf8'), 'already here');
});

test('the overlay wins when overwrite is set', () => {
  const framework = tmp();
  const template = tmp();
  const dest = tmp();
  write(framework, 'mcp/registry.mjs', 'kit registry');
  write(framework, 'pool/worker-pool.mjs', 'pool');
  write(template, 'mcp/registry.mjs', 'starter registry');

  copyTree(framework, dest);
  copyTree(template, dest, { overwrite: true });

  assert.equal(
    fs.readFileSync(path.join(dest, 'mcp/registry.mjs'), 'utf8'),
    'starter registry',
    'template must win on conflict',
  );
  assert.equal(
    fs.readFileSync(path.join(dest, 'pool/worker-pool.mjs'), 'utf8'),
    'pool',
    'framework files with no template counterpart survive',
  );
});

test('gitignore is written as .gitignore', () => {
  const src = tmp();
  const dest = tmp();
  write(src, 'gitignore', 'node_modules/\n');

  const written = copyTree(src, dest, { rename: RENAME_ON_WRITE });

  assert.deepEqual(written, ['.gitignore']);
  assert.ok(fs.existsSync(path.join(dest, '.gitignore')));
  assert.ok(!fs.existsSync(path.join(dest, 'gitignore')));
});

test('renaming applies to the basename only, not to nested lookalikes', () => {
  const src = tmp();
  const dest = tmp();
  write(src, 'docs/gitignore-notes.md', 'notes');

  copyTree(src, dest, { rename: RENAME_ON_WRITE });

  assert.ok(fs.existsSync(path.join(dest, 'docs/gitignore-notes.md')));
});

test('copyTree preserves the executable bit', () => {
  const src = tmp();
  const dest = tmp();
  write(src, 'run.sh', '#!/bin/sh\n');
  fs.chmodSync(path.join(src, 'run.sh'), 0o755);

  copyTree(src, dest);

  assert.ok(fs.statSync(path.join(dest, 'run.sh')).mode & 0o111, 'executable bit must survive');
});

test('a missing source directory is skipped, not fatal', () => {
  const dest = tmp();
  assert.deepEqual(copyTree(path.join(tmp(), 'absent'), dest), []);
});

test('PUBLISHED_DIRS names the framework paths and excludes repo-only ones', () => {
  for (const required of ['mcp', 'pool', 'host', 'transport', 'comm']) {
    assert.ok(PUBLISHED_DIRS.includes(required), `${required} must be published`);
  }
  for (const excluded of ['tests', '.github', 'workdir', 'create', 'template']) {
    assert.ok(!PUBLISHED_DIRS.includes(excluded), `${excluded} must not be copied as framework`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-copy.test.mjs`
Expected: FAIL — `Cannot find module '../create/copy.mjs'`.

- [ ] **Step 3: Write the copier**

```js
// create/copy.mjs
// The generator's file-moving half. Framework folders are copied from the
// published package as they are; template/ is then copied over the result
// with overwrite set, so it wins on conflict.
import fs from 'node:fs';
import path from 'node:path';

// npm rewrites a packed .gitignore to .npmignore, so the generated project's
// copy ships under a name npm leaves alone and is renamed on write.
export const RENAME_ON_WRITE = { gitignore: '.gitignore' };

// Framework paths copied into every generated project, before the overlay.
// Mirrors the package.json "files" field; tools and docs are narrowed to the
// subset a starter project keeps.
export const PUBLISHED_DIRS = [
  'mcp',
  'pool',
  'host',
  'transport',
  'comm',
  'workflows/standalone.mjs',
  'tools/weather',
  'tools/textstats',
  'docs/architecture.md',
  'docs/development.md',
  '.dockerignore',
];

export function copyTree(src, dest, { overwrite = false, rename = {} } = {}) {
  const written = [];
  if (!fs.existsSync(src)) return written;

  const walk = (fromDir, toDir, relBase) => {
    fs.mkdirSync(toDir, { recursive: true });
    const entries = fs.readdirSync(fromDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const from = path.join(fromDir, entry.name);
      const name = rename[entry.name] ?? entry.name;
      const to = path.join(toDir, name);
      const rel = relBase ? path.join(relBase, name) : name;

      if (entry.isDirectory()) {
        walk(from, to, rel);
      } else {
        if (fs.existsSync(to) && !overwrite) continue;
        fs.copyFileSync(from, to);
        fs.chmodSync(to, fs.statSync(from).mode & 0o777);
        written.push(rel);
      }
    }
  };

  const stat = fs.statSync(src);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest) || overwrite) {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, stat.mode & 0o777);
      written.push(path.basename(dest));
    }
    return written;
  }

  walk(src, dest, '');
  return written.sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/create-copy.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add create/copy.mjs tests/create-copy.test.mjs
git commit -m "feat: add copy and overlay for the generator

template/ overwrites the framework copy, and gitignore is renamed on
write because npm rewrites a packed .gitignore to .npmignore."
```

---

### Task 5: Name validation and substitution

The project name reaches three files. Validation runs before anything is written, so a bad name cannot produce a half-made directory with an invalid `package.json`.

**Files:**
- Create: `create/substitute.mjs`
- Test: `tests/create-substitute.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `validateProjectName(name: string): void` — throws `Error` with a readable message; returns nothing on success
  - `substitute(destDir: string, projectName: string, kitVersion: string): void` — rewrites `package.json`, `README.md`, and writes `.kit-version`

- [ ] **Step 1: Write the failing test**

```js
// tests/create-substitute.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProjectName, substitute } from '../create/substitute.mjs';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-sub-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '{{PROJECT_NAME}}', version: '0.1.0', type: 'module' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# {{PROJECT_NAME}}\n\nRun {{PROJECT_NAME}} with docker.\n');
  return dir;
}

test('valid npm names are accepted', () => {
  for (const name of ['my-agent', 'agent2', 'my.agent', '@scope/agent']) {
    assert.doesNotThrow(() => validateProjectName(name), `${name} should be valid`);
  }
});

test('invalid npm names are rejected before anything is written', () => {
  for (const name of ['My-Agent', 'my agent', '', '.hidden', 'a'.repeat(215)]) {
    assert.throws(() => validateProjectName(name), /name/i, `${name} should be rejected`);
  }
});

test('the rejection message states the rule, not just that it failed', () => {
  assert.throws(() => validateProjectName('My-Agent'), /lowercase/i);
});

test('substitute writes the name into package.json', () => {
  const dir = project();
  substitute(dir, 'my-agent', '1.0.0');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'my-agent');
  assert.equal(pkg.version, '0.1.0', 'other fields are untouched');
});

test('substitute replaces every README placeholder', () => {
  const dir = project();
  substitute(dir, 'my-agent', '1.0.0');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.equal(readme, '# my-agent\n\nRun my-agent with docker.\n');
  assert.ok(!readme.includes('{{PROJECT_NAME}}'));
});

test('substitute writes .kit-version verbatim', () => {
  const dir = project();
  substitute(dir, 'my-agent', '1.2.3');
  assert.equal(fs.readFileSync(path.join(dir, '.kit-version'), 'utf8').trim(), '1.2.3');
});

test('package.json stays valid JSON with a trailing newline', () => {
  const dir = project();
  substitute(dir, 'my-agent', '1.0.0');
  const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.doesNotThrow(() => JSON.parse(raw));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-substitute.test.mjs`
Expected: FAIL — `Cannot find module '../create/substitute.mjs'`.

- [ ] **Step 3: Write the substituter**

```js
// create/substitute.mjs
// The project name reaches exactly three files. Validation runs before any
// write, so a bad name cannot leave a half-made directory behind.
import fs from 'node:fs';
import path from 'node:path';

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PLACEHOLDER = /\{\{PROJECT_NAME\}\}/g;

export function validateProjectName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Project name is required.');
  }
  if (name.length > 214) {
    throw new Error('Project name must be 214 characters or fewer.');
  }
  if (name.startsWith('.') || name.startsWith('_')) {
    throw new Error('Project name cannot start with "." or "_".');
  }
  if (!NPM_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid npm package name. Use lowercase letters, digits, ` +
        'and - . _ ~ only, with no spaces.',
    );
  }
}

export function substitute(destDir, projectName, kitVersion) {
  const pkgPath = path.join(destDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = projectName;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const readmePath = path.join(destDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    fs.writeFileSync(readmePath, readme.replace(PLACEHOLDER, projectName));
  }

  fs.writeFileSync(path.join(destDir, '.kit-version'), `${kitVersion}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/create-substitute.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add create/substitute.mjs tests/create-substitute.test.mjs
git commit -m "feat: add project name validation and substitution

Validation runs before any write so an invalid name cannot produce a
half-made directory."
```

---

### Task 6: The explain-then-ask prompt

The global installs modify the machine outside the project directory and may require `sudo`. A user cannot consent to that from `(Y/n)` alone, so the prompt always prints purpose, consequence and scope first.

**Files:**
- Create: `create/prompt.mjs`
- Test: `tests/create-prompt.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `formatPrompt({ title, why, question }): string`
  - `confirm({ title, why, question, yes?, defaultAnswer? }, { ask?, write? }): Promise<boolean>` — `ask(question: string): Promise<string>`, `write(text: string): void`

- [ ] **Step 1: Write the failing test**

```js
// tests/create-prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrompt, confirm } from '../create/prompt.mjs';

const FLEET_PROMPT = {
  title: 'apra-fleet is not installed.',
  why:
    'Fleet is the runtime your workflows execute on. Without it, workflows ' +
    'cannot resolve @apralabs/apra-fleet-workflow and will fail on first run. ' +
    'It installs globally, outside this project, because Fleet is a machine ' +
    'install, not a dependency.',
  question: 'Install now?',
};

function recorder() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

test('the prompt states the reason before the question', () => {
  const output = formatPrompt(FLEET_PROMPT);
  assert.ok(
    output.indexOf('Fleet is the runtime') < output.indexOf('Install now?'),
    'the why must precede the question',
  );
  assert.match(output, /outside this project/, 'scope of the change must be stated');
  assert.match(output, /Install now\? \(Y\/n\)/);
});

test('confirm returns true on empty input when the default is yes', async () => {
  const out = recorder();
  const answer = await confirm(FLEET_PROMPT, { ask: async () => '', write: out.write });
  assert.equal(answer, true);
});

test('confirm accepts n, N, and no', async () => {
  for (const reply of ['n', 'N', 'no', 'NO']) {
    const answer = await confirm(FLEET_PROMPT, { ask: async () => reply, write: () => {} });
    assert.equal(answer, false, `${reply} should decline`);
  }
});

test('confirm accepts y, Y, and yes', async () => {
  for (const reply of ['y', 'Y', 'yes', 'YES']) {
    const answer = await confirm(
      { ...FLEET_PROMPT, defaultAnswer: false },
      { ask: async () => reply, write: () => {} },
    );
    assert.equal(answer, true, `${reply} should accept`);
  }
});

test('--yes skips the question but still prints the explanation', async () => {
  const out = recorder();
  let asked = false;
  const answer = await confirm(
    { ...FLEET_PROMPT, yes: true },
    { ask: async () => { asked = true; return 'n'; }, write: out.write },
  );
  assert.equal(answer, true);
  assert.equal(asked, false, 'no question is asked under --yes');
  assert.match(out.lines.join('\n'), /Fleet is the runtime/, 'the reason is still shown');
});

test('an unrecognised reply falls back to the default rather than looping', async () => {
  const answer = await confirm(FLEET_PROMPT, { ask: async () => 'maybe', write: () => {} });
  assert.equal(answer, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-prompt.test.mjs`
Expected: FAIL — `Cannot find module '../create/prompt.mjs'`.

- [ ] **Step 3: Write the prompt**

```js
// create/prompt.mjs
// Global installs modify the machine outside the project directory and may
// require sudo. A user cannot consent to that from "(Y/n)" alone, so every
// prompt prints purpose, consequence and scope before it asks.
import readline from 'node:readline/promises';

function wrap(text, width = 66, indent = '    ') {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if ((line + ' ' + word).length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines.join('\n');
}

export function formatPrompt({ title, why, question, defaultAnswer = true }) {
  const suffix = defaultAnswer ? '(Y/n)' : '(y/N)';
  return [`  ${title}`, wrap(why), `  ${question} ${suffix}`].join('\n');
}

async function defaultAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function confirm(options, { ask = defaultAsk, write = console.log } = {}) {
  const { yes = false, defaultAnswer = true } = options;
  write(formatPrompt({ ...options, defaultAnswer }));

  if (yes) return true;

  const reply = (await ask('> ')).trim().toLowerCase();
  if (reply === 'y' || reply === 'yes') return true;
  if (reply === 'n' || reply === 'no') return false;
  return defaultAnswer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/create-prompt.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add create/prompt.mjs tests/create-prompt.test.mjs
git commit -m "feat: add the explain-then-ask prompt

Purpose, consequence and scope print before the question; --yes skips
the question but not the explanation."
```

---

### Task 7: The template

The eight files a generated project needs that this repo either does not have, or has in a form that must differ. The starter workflow body is pure — it takes a context and returns a value — so it is testable in this repo without a Fleet binary.

**Files:**
- Create: `template/workflows/hello/hello.js`, `template/workflows/hello/main.mjs`, `template/mcp/registry.mjs`, `template/package.json`, `template/Dockerfile`, `template/docker-compose.yml`, `template/README.md`, `template/tests/hello.test.mjs`, `template/gitignore`
- Test: `tests/create-template.test.mjs`

**Interfaces:**
- Consumes: `mcp/registry-helpers.mjs` (Task 2) — `toolsDir`, `shellEscape`, `parseToolOutput`; `transport/ensure-apralabs.mjs` (Task 1)
- Produces: `template/workflows/hello/hello.js` exporting `meta: { name: 'hello' }` and `main(context): Promise<{ who, host, greeting }>`; `template/workflows/hello/main.mjs` exporting `runHello({ fleetApi, workspace, signal, reportPhase, name })`

Note on counting: the spec's table has 8 rows, and `workflows/hello/` is one row holding two files — so 8 entries, 9 files on disk. Task 7's test asserts the 9.

- [ ] **Step 1: Write the failing test**

```js
// tests/create-template.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as helloMain } from '../template/workflows/hello/hello.js';

const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template');

function fakeContext({ name } = {}) {
  const calls = { commands: [], prompts: [], logs: [] };
  return {
    calls,
    context: {
      log: (line) => calls.logs.push(line),
      args: { name },
      async command(cmd, options) {
        calls.commands.push({ cmd, ...options });
        return 'my-machine';
      },
      async agent(prompt, options) {
        calls.prompts.push({ prompt, ...options });
        return `Hello, ${name ?? 'world'}!`;
      },
    },
  };
}

test('hello greets the supplied name', async () => {
  const { context } = fakeContext({ name: 'Ada' });
  const result = await helloMain(context);
  assert.equal(result.who, 'Ada');
  assert.match(result.greeting, /Ada/);
});

test('hello defaults to world', async () => {
  const { context } = fakeContext();
  const result = await helloMain(context);
  assert.equal(result.who, 'world');
});

test('hello addresses the doer keyword, never a member name', async () => {
  const { context, calls } = fakeContext({ name: 'Ada' });
  await helloMain(context);
  assert.equal(calls.commands[0].member_name, 'doer');
  assert.equal(calls.prompts[0].member_name, 'doer');
});

test('the template holds exactly the agreed files', () => {
  const found = [];
  const walk = (dir, base = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? path.join(base, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else found.push(rel.split(path.sep).join('/'));
    }
  };
  walk(templateDir);

  assert.deepEqual(found.sort(), [
    'Dockerfile',
    'README.md',
    'docker-compose.yml',
    'gitignore',
    'mcp/registry.mjs',
    'package.json',
    'tests/hello.test.mjs',
    'workflows/hello/hello.js',
    'workflows/hello/main.mjs',
  ]);
});

test('the template Dockerfile does not use npm ci — a generated project has no lockfile', () => {
  const dockerfile = fs.readFileSync(path.join(templateDir, 'Dockerfile'), 'utf8');
  assert.ok(!/npm ci/.test(dockerfile), 'npm ci requires a lockfile the project does not have');
  assert.match(dockerfile, /npm install/);
});

test('the template package.json carries the name placeholder and the four scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '{{PROJECT_NAME}}');
  assert.equal(pkg.type, 'module');
  for (const script of ['test', 'doctor', 'hello', 'mcp']) {
    assert.ok(pkg.scripts[script], `missing script: ${script}`);
  }
  assert.ok(!pkg.private, 'a user project should not be marked private by default');
});

test('the starter registry registers hello and does not import the kit demos', () => {
  const registry = fs.readFileSync(path.join(templateDir, 'mcp/registry.mjs'), 'utf8');
  assert.match(registry, /runHello/);
  for (const demo of ['runDemo', 'runInspectMembers', 'runCityBriefing']) {
    assert.ok(!registry.includes(demo), `starter registry must not import ${demo}`);
  }
  assert.match(registry, /registry-helpers\.mjs/, 'it must reuse the shared helpers');
});

test('the starter test is self-contained so npm test runs before npm install', () => {
  const body = fs.readFileSync(path.join(templateDir, 'tests/hello.test.mjs'), 'utf8');
  assert.ok(!body.includes('helpers/mock-fleet'), 'the kit test helper is not shipped');
  assert.ok(!body.includes('setup-fleet-modules'), 'no Fleet packages may be required');
});

test('the README uses the project name placeholder', () => {
  const readme = fs.readFileSync(path.join(templateDir, 'README.md'), 'utf8');
  assert.match(readme, /\{\{PROJECT_NAME\}\}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-template.test.mjs`
Expected: FAIL — `Cannot find module '../template/workflows/hello/hello.js'`.

- [ ] **Step 3: Write the starter workflow body**

```js
// template/workflows/hello/hello.js
// Your workflow body. It receives a context with Fleet primitives and returns
// a value. Nothing here spawns Fleet or manages members — main.mjs does that.
export const meta = { name: 'hello' };

export async function main(context) {
  const { command, agent, log, args } = context;
  const who = args?.name ?? 'world';

  log(`greeting ${who}`);

  // 'doer' and 'reviewer' are reserved keywords. The kit resolves them to the
  // worker pair this run leased. Never name a member directly — doing so
  // collides with other runs.
  const host = await command('hostname', { member_name: 'doer' });

  const greeting = await agent(
    `Say hello to ${who} in one short, friendly sentence.`,
    { member_name: 'doer' },
  );

  return { who, host, greeting };
}
```

- [ ] **Step 4: Write the starter launcher**

```js
// template/workflows/hello/main.mjs
// The launcher owns spawning Fleet, leasing a worker pair, and cleanup. The
// body in hello.js owns the work. That split is what keeps the body testable
// with no binary and no token.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../../transport/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'hello.js');

export const selfExecuting = true;

export async function runHello({ fleetApi, workspace, signal, reportPhase, name } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    // CLI run: spawn Fleet, take one lease, run, release.
    return withStandaloneLease((ctx) => runHello({ ...ctx, reportPhase, name }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, { fleetApi, workspace, signal, reportPhase, name });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runHello({ name: process.argv[2] }), null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Write the starter registry**

```js
// template/mcp/registry.mjs
// Your tool catalog. To expose a new workflow, append an entry here — no
// changes to server.mjs or http.mjs are needed. `description` is read by the
// connected model when it decides which tool to call, so write it for that
// reader.
import path from 'node:path';
import * as z from 'zod/v4';
import { toolsDir, shellEscape, parseToolOutput } from './registry-helpers.mjs';
import { runHello } from '../workflows/hello/main.mjs';

export const defaultRegistry = [
  {
    name: 'hello',
    description:
      'Greets someone by name using an agent. A starting point to copy — replace ' +
      'the body in workflows/hello/hello.js with your own work. Spends LLM tokens.',
    inputSchema: z.object({
      name: z.string().optional().describe('Who to greet. Defaults to "world".'),
    }),
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      return await runHello({ fleetApi, workspace, name: args.name, signal, reportPhase });
    },
  },
  {
    name: 'weather',
    description:
      'Fetches current weather for a city using the wttr.in API. Returns temperature, ' +
      'humidity, wind, UV index, and a text description. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z.string().optional().describe('City name to look up. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = shellEscape(args.city || 'London');
      const script = path.join(toolsDir, 'weather', 'weather.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${city}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'textstats',
    description:
      'Analyzes a text string and returns character count, word count, sentence count, ' +
      'unique words, and average word length. Read-only, no LLM tokens.',
    inputSchema: z.object({
      text: z.string().describe('The text to analyze.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const escaped = shellEscape(args.text);
      const script = path.join(toolsDir, 'textstats', 'textstats.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${escaped}"`,
      });
      return parseToolOutput(raw);
    },
  },
];
```

- [ ] **Step 6: Write the starter test**

Self-contained by design: it imports only the body, so `npm test` works in a freshly generated project before `npm install` has run and with no Fleet binary present.

```js
// template/tests/hello.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../workflows/hello/hello.js';

// A fake context standing in for the Fleet primitives. Workflow bodies take
// their primitives from the context, so testing one needs no Fleet, no
// members, and no token. Write tests like this first when adding a workflow.
function fakeContext({ name } = {}) {
  const calls = { commands: [], prompts: [] };
  const context = {
    log: () => {},
    args: { name },
    async command(cmd, options) {
      calls.commands.push({ cmd, ...options });
      return 'test-machine';
    },
    async agent(prompt, options) {
      calls.prompts.push({ prompt, ...options });
      return `Hello, ${name ?? 'world'}!`;
    },
  };
  return { context, calls };
}

test('hello greets the name it is given', async () => {
  const { context } = fakeContext({ name: 'Ada' });
  const result = await main(context);
  assert.equal(result.who, 'Ada');
  assert.match(result.greeting, /Ada/);
});

test('hello defaults to world', async () => {
  const { context } = fakeContext();
  assert.equal((await main(context)).who, 'world');
});

test('hello addresses roles, not member names', async () => {
  const { context, calls } = fakeContext({ name: 'Ada' });
  await main(context);
  assert.equal(calls.commands[0].member_name, 'doer');
  assert.equal(calls.prompts[0].member_name, 'doer');
});
```

- [ ] **Step 7: Write the remaining four template files**

```json
// template/package.json
{
  "name": "{{PROJECT_NAME}}",
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22.16"
  },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "doctor": "node scripts/doctor.mjs",
    "hello": "node workflows/hello/main.mjs",
    "mcp": "node mcp/main.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@modelcontextprotocol/express": "^2.0.0",
    "@modelcontextprotocol/node": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "express": "^5.1.0",
    "proper-lockfile": "^4.1.2",
    "zod": "^4.4.3"
  }
}
```

```dockerfile
# template/Dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 python3-pip ca-certificates git make g++ \
  && update-ca-certificates \
  && pip install --no-cache-dir --break-system-packages certifi \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && apt-get purge -y --auto-remove make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# npm install, not npm ci: a generated project ships without a lockfile.
# Commit the lockfile npm writes here and this can become npm ci.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "mcp/main.mjs"]
```

```yaml
# template/docker-compose.yml
services:
  fleet:
    build: .
    ports:
      - "${MCP_PORT:-3000}:3000"
    volumes:
      - .:/workspace
      - node_modules:/workspace/node_modules
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      MCP_BIND_HOST: "0.0.0.0"
      WORKER_POOL_SIZE: ${WORKER_POOL_SIZE:-4}
      WORKER_EPHEMERAL_MAX: ${WORKER_EPHEMERAL_MAX:-10}
    # Default: MCP server. Fleet is spawned over stdio on demand.
    # Override for anything else:
    #   docker compose run --rm fleet node workflows/hello/main.mjs
    #   docker compose run --rm fleet npm test

volumes:
  node_modules:
```

```text
# template/gitignore
# Written as .gitignore by the generator — npm rewrites a packed .gitignore
# to .npmignore, so it cannot ship under its real name.
.DS_Store
.fleet-workflow/
.fleet/
.fleet-src/
node_modules/
.env
.claude/
.cursor/
workdir/*
!workdir/.gitkeep
```

```markdown
<!-- template/README.md -->
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
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/create-template.test.mjs`
Expected: PASS — 9 tests.

Run: `npm test`
Expected: PASS — the template is not imported by the kit's own suites, so nothing else moves.

- [ ] **Step 9: Commit**

```bash
git add template tests/create-template.test.mjs
git commit -m "feat: add the starter template

Nine files: the hello workflow, a starter registry that reuses the
shared helpers, and the five files that must differ from the repo's."
```

---

### Task 8: The CLI

Argument parsing, orchestration, and the failure modes. Nothing except a bad target or a bad name aborts generation — once files are written they are correct, and every later step is an optimisation the doctor can re-report.

**Files:**
- Create: `bin/create.mjs`
- Test: `tests/create-cli.test.mjs`

**Interfaces:**
- Consumes: `create/copy.mjs` (`copyTree`, `PUBLISHED_DIRS`, `RENAME_ON_WRITE`), `create/substitute.mjs` (`validateProjectName`, `substitute`), `create/doctor.mjs` (`createProbes`, `runChecks`, `formatChecks`), `create/prompt.mjs` (`confirm`)
- Produces: `generate({ target, name, packageRoot, noInstall, yes, force }, io?): Promise<{ dir, written, checks }>` — the orchestration, exported for testing; and a CLI entry that calls it

- [ ] **Step 1: Write the failing test**

```js
// tests/create-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, parseCliArgs } from '../bin/create.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function target(name = 'my-agent') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'create-cli-')), name);
}

const silent = { write: () => {} };

test('parseCliArgs reads the directory and the flags', () => {
  const parsed = parseCliArgs(['my-agent', '--no-install', '--yes', '--force']);
  assert.equal(parsed.target, 'my-agent');
  assert.equal(parsed.noInstall, true);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.force, true);
});

test('parseCliArgs defaults the flags to false', () => {
  const parsed = parseCliArgs(['my-agent']);
  assert.deepEqual(
    { noInstall: parsed.noInstall, yes: parsed.yes, force: parsed.force },
    { noInstall: false, yes: false, force: false },
  );
});

test('generate emits the framework, the overlay, and the doctor', async () => {
  const dir = target();
  await generate({ target: dir, name: 'my-agent', packageRoot, noInstall: true, yes: true }, silent);

  for (const expected of [
    'pool/worker-pool.mjs',
    'host/index.mjs',
    'transport/stdio-fleet.mjs',
    'transport/ensure-apralabs.mjs',
    'comm/express.mjs',
    'mcp/server.mjs',
    'mcp/registry-helpers.mjs',
    'workflows/standalone.mjs',
    'workflows/hello/hello.js',
    'tools/weather/weather.py',
    'tools/textstats/textstats.py',
    'tests/hello.test.mjs',
    'scripts/doctor.mjs',
    'docs/architecture.md',
    'Dockerfile',
    'docker-compose.yml',
    '.gitignore',
    '.kit-version',
    'package.json',
    'README.md',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, expected)), `missing: ${expected}`);
  }
});

test('generate excludes everything that belongs only to the kit', async () => {
  const dir = target();
  await generate({ target: dir, name: 'my-agent', packageRoot, noInstall: true, yes: true }, silent);

  for (const excluded of [
    'workflows/demo',
    'workflows/city-briefing',
    'workflows/inspect-members',
    'tools/geocode',
    'tools/forecast',
    'docs/specs',
    'docs/superpowers',
    '.github',
    'template',
    'create',
    'bin',
    'tests/demo.test.mjs',
  ]) {
    assert.ok(!fs.existsSync(path.join(dir, excluded)), `should not be generated: ${excluded}`);
  }
});

test('the overlay wins — the generated registry is the starter, not the kit one', async () => {
  const dir = target();
  await generate({ target: dir, name: 'my-agent', packageRoot, noInstall: true, yes: true }, silent);

  const registry = fs.readFileSync(path.join(dir, 'mcp/registry.mjs'), 'utf8');
  assert.match(registry, /runHello/);
  assert.ok(!registry.includes('runDemo'), 'the kit registry must have been overwritten');
});

test('the project name reaches package.json and README', async () => {
  const dir = target();
  await generate({ target: dir, name: 'weather-bot', packageRoot, noInstall: true, yes: true }, silent);

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name, 'weather-bot');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /# weather-bot/);
  assert.ok(!readme.includes('{{PROJECT_NAME}}'));
});

test('a non-empty target aborts before writing anything', async () => {
  const dir = target();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'do not touch');

  await assert.rejects(
    generate({ target: dir, name: 'my-agent', packageRoot, noInstall: true, yes: true }, silent),
    /not empty|--force/i,
  );

  assert.deepEqual(fs.readdirSync(dir), ['mine.txt'], 'nothing may be written');
});

test('--force permits a non-empty target', async () => {
  const dir = target();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep');

  await generate(
    { target: dir, name: 'my-agent', packageRoot, noInstall: true, yes: true, force: true },
    silent,
  );

  assert.ok(fs.existsSync(path.join(dir, 'package.json')));
  assert.ok(fs.existsSync(path.join(dir, 'mine.txt')), 'existing files are left alone');
});

test('an invalid name aborts before the directory is created', async () => {
  const dir = target('My-Agent');
  await assert.rejects(
    generate({ target: dir, name: 'My-Agent', packageRoot, noInstall: true, yes: true }, silent),
    /lowercase/i,
  );
  assert.ok(!fs.existsSync(dir), 'no directory may be left behind');
});

test('--no-install runs no npm and no git', async () => {
  const dir = target();
  const result = await generate(
    { target: dir, name: 'my-agent', packageRoot, noInstall: true, yes: true },
    silent,
  );
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'git init must not run under --no-install');
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), 'npm install must not run');
  assert.ok(Array.isArray(result.checks), 'checks are still reported');
});

test('a failed copy leaves no partial directory behind', async () => {
  const dir = target();
  await assert.rejects(
    generate(
      { target: dir, name: 'my-agent', packageRoot: '/nonexistent/package/root', noInstall: true, yes: true },
      silent,
    ),
  );
  assert.ok(!fs.existsSync(dir), 'the partial directory must be removed');
});
```

The spec's testing table lists a separate `tests/create-failures.test.mjs`. Those cases live here instead: they exercise `generate()`, so splitting them into a second file would duplicate the fixtures without giving a reviewer anything extra to reject.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-cli.test.mjs`
Expected: FAIL — `Cannot find module '../bin/create.mjs'`.

- [ ] **Step 3: Write the CLI**

```js
#!/usr/bin/env node
// bin/create.mjs
// npm create @dsiddharth2/fleet-agent <dir>
//
// Copies the published framework folders into the target, overlays template/,
// substitutes the project name, then offers to install what is missing. Only a
// bad target or a bad name aborts: once files are written they are correct,
// and every later step is an optimisation the doctor can re-report.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { copyTree, PUBLISHED_DIRS, RENAME_ON_WRITE } from '../create/copy.mjs';
import { validateProjectName, substitute } from '../create/substitute.mjs';
import { createProbes, runChecks, formatChecks } from '../create/doctor.mjs';
import { confirm } from '../create/prompt.mjs';

const thisPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'no-install': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return {
    target: positionals[0] ?? null,
    noInstall: values['no-install'],
    yes: values.yes,
    force: values.force,
    help: values.help,
  };
}

function isEmptyDir(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

function run(command, args, { cwd }) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

export async function generate(options, io = { write: console.log }) {
  const {
    target,
    name,
    packageRoot = thisPackageRoot,
    noInstall = false,
    yes = false,
    force = false,
  } = options;
  const write = io.write;

  // Both validations run before a single byte is written.
  validateProjectName(name);
  if (!force && !isEmptyDir(target)) {
    throw new Error(
      `${target} is not empty. Choose another directory, or pass --force to generate into it anyway.`,
    );
  }

  const createdRoot = !fs.existsSync(target);
  let written = [];

  try {
    write(`\n  Creating ${name}…`);
    fs.mkdirSync(target, { recursive: true });

    for (const rel of PUBLISHED_DIRS) {
      const src = path.join(packageRoot, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`the package is incomplete: ${rel} is missing from ${packageRoot}`);
      }
      written = written.concat(copyTree(src, path.join(target, rel)));
    }
    write('  ✓ copied kit (mcp, pool, host, transport, comm)');

    copyTree(path.join(packageRoot, 'template'), target, {
      overwrite: true,
      rename: RENAME_ON_WRITE,
    });
    write('  ✓ starter workflow: workflows/hello');

    // The doctor is the one file written to a path other than its source: a
    // generated project depends on nothing, so it cannot import it.
    copyTree(
      path.join(packageRoot, 'create', 'doctor.mjs'),
      path.join(target, 'scripts', 'doctor.mjs'),
      { overwrite: true },
    );

    const kitVersion = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ).version;
    substitute(target, name, kitVersion);
  } catch (err) {
    if (createdRoot) fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }

  const probes = createProbes({ cwd: target });
  let checks = runChecks(probes);

  if (!noInstall) {
    try {
      run('npm', ['install'], { cwd: target });
      write('  ✓ npm install');
    } catch {
      write('  ! npm install failed — your files are fine. Run it yourself when ready.');
    }

    const missing = checks.filter((c) => !c.ok).map((c) => c.id);

    if (missing.includes('apra-fleet') || missing.includes('claude')) {
      const accepted = await confirm(
        {
          title: 'apra-fleet is not installed.',
          why:
            'Fleet is the runtime your workflows execute on. Without it, workflows ' +
            'cannot resolve @apralabs/apra-fleet-workflow and will fail on first run. ' +
            'It installs globally, outside this project, because Fleet is a machine ' +
            'install, not a dependency.',
          question: 'Install now?',
          yes,
        },
        { write },
      );

      if (accepted) {
        try {
          run('npm', ['i', '-g', '@apralabs/apra-fleet', '@anthropic-ai/claude-code'], { cwd: target });
          write('  ✓ npm i -g @apralabs/apra-fleet @anthropic-ai/claude-code');
          run('apra-fleet', ['install', '--skill', 'none'], { cwd: target });
          write('  ✓ apra-fleet install --skill none');
        } catch {
          write('  ! the global install failed. Run it yourself:');
          write('      npm i -g @apralabs/apra-fleet @anthropic-ai/claude-code');
          write('      apra-fleet install --skill none');
        }
      }
    }

    try {
      run('git', ['init', '--quiet'], { cwd: target });
      write('  ✓ git init');
    } catch {
      write('  ! git init failed — the project does not require git.');
    }

    checks = runChecks(createProbes({ cwd: target }));
  }

  const remaining = checks.filter((c) => !c.ok);
  if (remaining.length > 0) {
    write('\n  Still to do:');
    write(formatChecks(remaining));
  }

  write(`\n  cd ${path.relative(process.cwd(), target) || '.'}`);
  write('  npm test           # mock tests, no token needed');
  write('  npm run hello      # the starter workflow, for real');
  write('  npm run doctor     # re-check this environment at any time\n');

  return { dir: target, written, checks };
}

const HELP = `
  npm create @dsiddharth2/fleet-agent <directory> [options]

  --no-install   copy and substitute only; run no npm, no git, no prompts
  --yes, -y      accept every prompt without asking
  --force        generate into a non-empty directory
  --help, -h     show this message
`;

async function cli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  let target = args.target;
  if (!target) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      target = (await rl.question('  Project name: ')).trim();
    } finally {
      rl.close();
    }
  }

  const name = path.basename(path.resolve(target));
  try {
    await generate({ ...args, target: path.resolve(target), name });
    return 0;
  } catch (err) {
    console.error(`\n  ${err?.message ?? err}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await cli());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/create-cli.test.mjs`
Expected: PASS — 11 tests.

- [ ] **Step 5: Check the CLI by hand**

```bash
node bin/create.mjs /tmp/hand-check --no-install --yes
ls /tmp/hand-check
cat /tmp/hand-check/.kit-version
rm -rf /tmp/hand-check
```

Expected: the tree from the spec, and `.kit-version` holding the package version. `.kit-version` is empty or `undefined` until Task 9 adds a `version` field — note it and continue.

- [ ] **Step 6: Commit**

```bash
git add bin/create.mjs tests/create-cli.test.mjs
git commit -m "feat: add the create CLI

Copy, overlay, substitute, then offer installs. Only a bad target or a
bad name aborts; a failed copy removes the partial directory."
```

---

### Task 9: Packaging

Make the repository publishable as `@dsiddharth2/create-fleet-agent`. The `files` field is the manifest — there is no build step.

**Files:**
- Modify: `package.json`
- Test: `tests/create-packaging.test.mjs`

**Interfaces:**
- Consumes: `create/copy.mjs` (`PUBLISHED_DIRS`) — the packaged paths must be a superset
- Produces: a publishable `package.json` with `name`, `version`, `bin`, `files`, and no `private` flag

- [ ] **Step 1: Write the failing test**

`npm pack --dry-run --json` reports exactly what would ship, so the test asserts against npm itself rather than against a re-implementation of its rules.

```js
// tests/create-packaging.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_DIRS } from '../create/copy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function packedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(raw)[0].files.map((f) => f.path);
}

test('the package is named so that npm create resolves it', () => {
  assert.equal(pkg.name, '@dsiddharth2/create-fleet-agent');
});

test('the package is publishable', () => {
  assert.ok(!pkg.private, 'private:true blocks npm publish');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'a version is required to publish');
});

test('the bin points at the CLI', () => {
  assert.equal(pkg.bin['create-fleet-agent'], 'bin/create.mjs');
  assert.ok(fs.existsSync(path.join(repoRoot, 'bin/create.mjs')));
});

test('no runtime dependency was added', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/express',
    '@modelcontextprotocol/node',
    '@modelcontextprotocol/server',
    'express',
    'proper-lockfile',
    'zod',
  ]);
});

test('every path the generator copies is present in the tarball', () => {
  const files = packedFiles();
  for (const rel of [...PUBLISHED_DIRS, 'template', 'create/doctor.mjs', 'bin/create.mjs']) {
    assert.ok(
      files.some((f) => f === rel || f.startsWith(`${rel}/`)),
      `the generator copies ${rel} but it is not packed`,
    );
  }
});

test('repo-only material stays out of the tarball', () => {
  const files = packedFiles();
  for (const excluded of [
    'tests/',
    'docs/specs/',
    'docs/superpowers/',
    '.github/',
    'workdir/',
    'workflows/demo/',
    'workflows/city-briefing/',
    'tools/geocode/',
  ]) {
    const leaked = files.filter((f) => f.startsWith(excluded));
    assert.deepEqual(leaked, [], `${excluded} must not ship`);
  }
});

test('the template is packed under a name npm will not rewrite', () => {
  const files = packedFiles();
  assert.ok(files.includes('template/gitignore'), 'the gitignore must ship as template/gitignore');
  assert.ok(
    !files.includes('template/.gitignore'),
    'npm rewrites a packed .gitignore to .npmignore — it cannot ship under that name',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-packaging.test.mjs`
Expected: FAIL — the name is `workflow-kit` and there is no `version`, `bin` or `files`.

- [ ] **Step 3: Update package.json**

Replace the first block of `package.json` — everything above `"scripts"` — with:

```json
{
  "name": "@dsiddharth2/create-fleet-agent",
  "version": "0.1.0",
  "description": "Create a Fleet agent project: npm create @dsiddharth2/fleet-agent my-agent",
  "type": "module",
  "bin": {
    "create-fleet-agent": "bin/create.mjs"
  },
  "files": [
    "mcp",
    "pool",
    "host",
    "transport",
    "comm",
    "workflows/standalone.mjs",
    "tools/weather",
    "tools/textstats",
    "docs/architecture.md",
    "docs/development.md",
    "template",
    "bin",
    "create",
    ".dockerignore"
  ],
  "engines": {
    "node": ">=22.16"
  },
```

The repository's package name changes from `workflow-kit` to the publishable name — this is the package that `npm create @dsiddharth2/fleet-agent` resolves. Nothing depends on the old name; it was never published. `"private": true` is removed, and `dependencies` is untouched.

Add the new suites to the `test` script. It currently ends `tests/mcp.test.mjs`; append:

```text
tests/ensure-apralabs-location.test.mjs tests/mcp-registry-helpers.test.mjs tests/create-doctor.test.mjs tests/create-copy.test.mjs tests/create-substitute.test.mjs tests/create-prompt.test.mjs tests/create-template.test.mjs tests/create-cli.test.mjs tests/create-packaging.test.mjs tests/create-e2e.test.mjs
```

`tests/create-e2e.test.mjs` arrives in Task 10; until then `npm test` reports it as missing. Add the whole list now so the script is not edited twice, and run the suites individually until Task 10 lands.

Make the bin executable:

```bash
chmod +x bin/create.mjs
git update-index --chmod=+x bin/create.mjs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/create-packaging.test.mjs`
Expected: PASS — 7 tests.

Run: `npm pack --dry-run`
Expected: a file list with no `tests/`, `docs/specs/`, `.github/` or demo workflow entries.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/create-packaging.test.mjs bin/create.mjs
git commit -m "feat: make the repo publishable as @dsiddharth2/create-fleet-agent

The files field is the manifest — no build step. Tests assert against
npm pack --dry-run rather than re-implementing npm's rules."
```

---

### Task 10: End-to-end generation

The test that makes the single-copy packaging mean something: generate a project, then run its own test suite. A framework change that breaks generated projects fails CI before publish.

**Files:**
- Create: `tests/create-e2e.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `bin/create.mjs` (`generate`)
- Produces: nothing — this is the gate

- [ ] **Step 1: Write the failing test**

The generated suite runs with no `npm install` and no Fleet binary, because `template/tests/hello.test.mjs` imports only the workflow body.

```js
// tests/create-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate } from '../bin/create.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silent = { write: () => {} };

async function generated(name = 'my-agent') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'create-e2e-')), name);
  await generate({ target: dir, name, packageRoot, noInstall: true, yes: true }, silent);
  return dir;
}

test('a generated project passes its own test suite', async () => {
  const dir = await generated();

  const output = execFileSync('npm', ['test'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(output, /pass 3/, `generated suite did not pass:\n${output}`);
  assert.match(output, /fail 0/);
});

test('the generated doctor runs and reports on the generated project', async () => {
  const dir = await generated();

  let output;
  let code = 0;
  try {
    output = execFileSync('node', ['scripts/doctor.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    output = err.stdout ?? '';
    code = err.status;
  }

  assert.match(output, /node\s+✓/, `doctor output was:\n${output}`);
  assert.match(output, /apralabs/);
  assert.ok(code === 0 || code === 1, 'the doctor exits 0 or 1, never crashes');
});

test('every generated module parses — no stale import survives the copy', async () => {
  const dir = await generated();
  const files = [];

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);

  assert.ok(files.length > 30, `expected a full kit, found ${files.length} modules`);
  for (const file of files) {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  }
});

test('no generated file still references a path that was not shipped', async () => {
  const dir = await generated();
  const offenders = [];

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        const body = fs.readFileSync(full, 'utf8');
        for (const gone of ['workflows/demo', 'workflows/city-briefing', 'workflows/inspect-members']) {
          if (body.includes(`'../${gone}`) || body.includes(`'./${gone}`)) {
            offenders.push(`${path.relative(dir, full)} → ${gone}`);
          }
        }
      }
    }
  };
  walk(dir);

  assert.deepEqual(offenders, [], `generated project imports paths that were not shipped`);
});

test('generating twice into different directories produces identical trees', async () => {
  const listing = async () => {
    const dir = await generated();
    const files = [];
    const walk = (current, base = '') => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
        else files.push(rel);
      }
    };
    walk(dir);
    return files;
  };

  assert.deepEqual(await listing(), await listing());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/create-e2e.test.mjs`
Expected: PASS if Tasks 1-9 are complete and correct. If anything is wrong, this is where it shows — most likely as a stale import in the fourth test or a `--check` failure in the third. Fix the offending task's output, not this test.

- [ ] **Step 3: Add the gate to CI**

In `.github/workflows/ci.yml`, add a job that runs the generator suites and the end-to-end gate. Match the existing jobs' `runs-on`, checkout and Node setup steps; only the final step differs:

```yaml
  create-command:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - name: Generator unit tests
        run: |
          node --test \
            tests/create-doctor.test.mjs \
            tests/create-copy.test.mjs \
            tests/create-substitute.test.mjs \
            tests/create-prompt.test.mjs \
            tests/create-template.test.mjs \
            tests/create-cli.test.mjs \
            tests/create-packaging.test.mjs
      - name: Generate a project and run its suite
        run: node --test tests/create-e2e.test.mjs
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, now including all ten new suites.

- [ ] **Step 5: Commit**

```bash
git add tests/create-e2e.test.mjs .github/workflows/ci.yml
git commit -m "test: generate a project and run its suite in CI

The gate the single-copy packaging exists to provide: a framework change
that breaks generated projects fails the build before publish."
```

---

### Task 11: Documentation and the two open questions

The spec's open items are verification, not design. Both are settled here, and the README's opening stops telling people to clone.

**Files:**
- Modify: `README.md:1-30`, `docs/development.md`, `docs/specs/2026-09-17-create-command-spec.md`
- Test: manual verification, recorded in the spec

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Verify that `npm create` forwards flags**

The spec flags this because npm has historically consumed some flags before the bin sees them. Pack and install the tarball locally rather than publishing:

```bash
npm pack
npm i -g ./dsiddharth2-create-fleet-agent-0.1.0.tgz
cd /tmp && create-fleet-agent flag-check --no-install --yes
ls /tmp/flag-check && rm -rf /tmp/flag-check
```

Expected: the project is generated, with no `node_modules` and no `.git` — proving `--no-install` arrived. If it did not, the separator form is required:

```bash
npm create @dsiddharth2/fleet-agent my-agent -- --no-install
```

Record which form works in the spec's open-questions section, and use that form in the README and in CI.

- [ ] **Step 2: Verify the generated Docker image builds**

```bash
node bin/create.mjs /tmp/docker-check --no-install --yes
cd /tmp/docker-check && docker build -t fleet-agent-docker-check .
```

Expected: the build completes. `npm install --omit=dev` must succeed without a lockfile — the reason the template's Dockerfile differs from the repo's. If it fails, fix `template/Dockerfile` and re-run Task 7's suite.

```bash
docker image rm fleet-agent-docker-check && rm -rf /tmp/docker-check
```

- [ ] **Step 3: Record both results in the spec**

Replace the spec's `## Open questions` section with `## Verified`, stating what was run and what happened — the exact invocation form for flags, and the Docker result. An open question that was answered should read as an answer, not as a question someone must re-ask.

- [ ] **Step 4: Rewrite the README's opening**

Replace the `## Quick start` block at `README.md:5-30`. The clone instructions become the contributor path, not the user path:

```markdown
## Quick start

```bash
npm create @dsiddharth2/fleet-agent my-agent
cd my-agent
```

The command copies the kit, writes a starter workflow, and offers to install
Fleet and the Claude CLI. It explains each step before it asks.

Then set the token and start the server:

**Bash / macOS / Linux:**
```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
docker compose up -d
```

**PowerShell (Windows):**
```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"
docker compose up -d
```

The MCP server listens on `http://localhost:3000/mcp`. Register it with Claude Code:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Run `npm run doctor` in your project at any time to see what is missing.

### Working on the kit itself

Clone this repository instead:

```bash
git clone https://github.com/dsiddharth2/workflow-kit.git
cd workflow-kit && npm install
```
```

- [ ] **Step 5: Document the generator in the development guide**

Append to `docs/development.md`:

```markdown
## The create command

`npm create @dsiddharth2/fleet-agent my-agent` generates a project from this
repository. Two rules govern what it emits:

1. **`files` in `package.json` decides what ships.** Anything not listed is
   absent from the tarball and so cannot reach a generated project.
2. **`template/` overlays the framework copy and wins on conflict.** A file
   belongs in `template/` only if it has no counterpart here, or must differ
   from the one here. There are eight such entries, nine files.

`create/doctor.mjs` has one copy and two consumers — the generator, and the
generated project, which receives it as `scripts/doctor.mjs`.

When you add a framework file that generated projects need, add its path to
`files` and to `PUBLISHED_DIRS` in `create/copy.mjs`. `tests/create-e2e.test.mjs`
generates a project and runs its suite, so a missed path fails CI.
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/development.md docs/specs/2026-09-17-create-command-spec.md
git commit -m "docs: lead with the create command

Quick start is now one command; cloning is documented as the
contributor path. Both spec open questions are verified and recorded."
```

---

## Publishing

Not a task — the release step, run once the plan is complete and reviewed.

```bash
npm test
npm pack --dry-run          # confirm the file list one last time
npm publish --access public # scoped packages are restricted without it
```

`--access public` is required: `@dsiddharth2/create-fleet-agent` is a scoped
package and scoped packages default to restricted, which would make
`npm create @dsiddharth2/fleet-agent` fail for everyone but the owner.

Verify from a clean directory:

```bash
cd $(mktemp -d) && npm create @dsiddharth2/fleet-agent smoke-test
```
