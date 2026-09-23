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
  fs.writeFileSync(path.join(dir, 'host.config.mjs'), "export default { name: '{{PROJECT_NAME}}' };\n");
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

test('substitute replaces the host config placeholder', () => {
  const dir = project();
  substitute(dir, 'my-agent', '1.0.0');
  const config = fs.readFileSync(path.join(dir, 'host.config.mjs'), 'utf8');
  assert.match(config, /name: 'my-agent'/);
  assert.ok(!config.includes('{{PROJECT_NAME}}'));
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
