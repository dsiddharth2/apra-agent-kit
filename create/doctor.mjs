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

function isMainModule() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  }
}

// This file is also copied into generated projects as scripts/doctor.mjs and
// run directly by `npm run doctor`, so it must execute when it is the entry
// point — and stay silent when the generator imports it.
if (isMainModule()) {
  process.exit(await main());
}
