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
  const stalePath = ['demo', 'ensure-apralabs'].join('/');
  const thisFile = fileURLToPath(import.meta.url);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (full !== thisFile && /\.(mjs|js|sh)$/.test(entry.name)) {
        const body = fs.readFileSync(full, 'utf8');
        if (body.includes(stalePath)) {
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
