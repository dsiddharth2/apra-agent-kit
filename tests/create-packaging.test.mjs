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
