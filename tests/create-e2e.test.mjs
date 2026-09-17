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
