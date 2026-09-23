// tests/create-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
    'host.config.mjs',
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
  const config = fs.readFileSync(path.join(dir, 'host.config.mjs'), 'utf8');
  assert.match(config, /name: 'weather-bot'/);
  assert.ok(!config.includes('{{PROJECT_NAME}}'));
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

test('an unknown option prints a readable message and help, then exits 1', () => {
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/create.mjs'), '--bogus'], {
    encoding: 'utf8',
    cwd: packageRoot,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 1);
  assert.match(output, /Unknown option '--bogus'/);
  assert.match(output, /--no-install/);
  assert.ok(!/^\s+at /m.test(output), `must not dump a stack:\n${output}`);
});

test('no directory argument and closed stdin errors clearly instead of hanging', () => {
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/create.mjs')], {
    encoding: 'utf8',
    cwd: packageRoot,
    input: '',
    timeout: 5000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 1);
  assert.match(output, /directory name is required/i);
  assert.ok(!output.includes('unsettled top-level await'), output);
  assert.ok(!/not empty/i.test(output), 'must not fall through to generating into cwd');
});

test('an empty name after the prompt errors instead of resolving to cwd', () => {
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/create.mjs')], {
    encoding: 'utf8',
    cwd: packageRoot,
    input: '   \n',
    timeout: 5000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 1);
  assert.match(output, /directory name is required/i);
  assert.ok(!/not empty/i.test(output), 'empty input must not resolve to the current directory');
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
