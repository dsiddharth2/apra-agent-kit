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
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs');
  assert.ok(!pkg.scripts.test.includes('env -u'), 'do not leak the kit NODE_TEST_CONTEXT workaround');
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
