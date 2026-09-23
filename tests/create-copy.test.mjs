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
  for (const required of ['mcp', 'pool', 'host', 'transport', 'comm', '.claude/skills/agent-builder']) {
    assert.ok(PUBLISHED_DIRS.includes(required), `${required} must be published`);
  }
  for (const excluded of ['tests', '.github', 'workdir', 'create', 'template']) {
    assert.ok(!PUBLISHED_DIRS.includes(excluded), `${excluded} must not be copied as framework`);
  }
});
