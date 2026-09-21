// tests/host-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'host-config-'));
}

async function writeConfig(dir, filename, content) {
  await fs.writeFile(path.join(dir, filename), content);
}

// Dynamic import of the module under test — deferred so the file can be missing
// at parse time during TDD red phase.
let loadConfig;
test('load module', async () => {
  ({ loadConfig } = await import('../host/config.mjs'));
});

test('valid config returns frozen object', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'test-host',
    fleet: {},
    comm: { adapter: 'express', port: 4000, host: '127.0.0.1' },
  };`);
  const config = await loadConfig(dir);
  assert.equal(config.name, 'test-host');
  assert.equal(config.comm.adapter, 'express');
  assert.equal(config.comm.port, 4000);
  assert.ok(Object.isFrozen(config));
});

test('missing name throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    fleet: {},
    comm: { adapter: 'express' },
  };`);
  await assert.rejects(() => loadConfig(dir), /name/i);
});

test('missing fleet throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    comm: { adapter: 'express' },
  };`);
  await assert.rejects(() => loadConfig(dir), /fleet/i);
});

test('missing comm throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
  };`);
  await assert.rejects(() => loadConfig(dir), /comm/i);
});

test('unsupported adapter throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'fastify' },
  };`);
  await assert.rejects(() => loadConfig(dir), /fastify/i);
});

test('no config file throws', async () => {
  const dir = await tmpDir();
  await assert.rejects(() => loadConfig(dir), /not found/i);
});

test('falls back to .json when .mjs is absent', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.json', JSON.stringify({
    name: 'json-host',
    fleet: {},
    comm: { adapter: 'express' },
  }));
  const config = await loadConfig(dir);
  assert.equal(config.name, 'json-host');
});

test('env PORT is default when comm.port is absent', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
  };`);
  const config = await loadConfig(dir, { PORT: '9090' });
  assert.equal(config.comm.port, 9090);
});

test('comm.port in config wins over env', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express', port: 5000 },
  };`);
  const config = await loadConfig(dir, { PORT: '9090' });
  assert.equal(config.comm.port, 5000);
});

test('unknown module key logs warning', async (t) => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { banana: { enabled: true } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some(w => /banana/i.test(w)));
});

test('unimplemented module with enabled:true logs warning', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { memory: { enabled: true } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some(w => /memory/i.test(w) && /not implemented/i.test(w)));
});

test('runLoop module accepted when enabled', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true, strategy: 'plan-execute' } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const config = await loadConfig(dir);
    assert.equal(config.modules.runLoop.enabled, true);
    assert.ok(!warnings.some(w => /runLoop/i.test(w) && /not implemented/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('budgets module accepted when enabled', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { budgets: { enabled: true, maxIterations: 25 } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
    assert.ok(!warnings.some(w => /budgets/i.test(w) && /not implemented/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('guardrails module accepted when enabled', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { guardrails: { enabled: true, defaultPolicy: 'allow' } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
    assert.ok(!warnings.some(w => /guardrails/i.test(w) && /not implemented/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

test('budgets without runLoop logs dependency warning', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { budgets: { enabled: true } },
  };`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await loadConfig(dir);
    assert.ok(warnings.some(w => /budgets/i.test(w) && /runLoop/i.test(w)));
  } finally {
    console.warn = origWarn;
  }
});

function captureWarnings(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (m) => seen.push(String(m));
  return fn().finally(() => { console.warn = orig; }).then(r => ({ result: r, warnings: seen }));
}

test('accepts raw-http and azure-functions adapters', async () => {
  for (const adapter of ['raw-http', 'azure-functions']) {
    const dir = await tmpDir();
    await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: '${adapter}' } };`);
    assert.equal((await loadConfig(dir)).comm.adapter, adapter);
  }
});

test('dispatch without runLoop is an error', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { dispatch: { enabled: true } } };`);
  await assert.rejects(() => loadConfig(dir), /dispatch.*runLoop/);
});

test('durable backend requires the azure-functions adapter', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, dispatch: { enabled: true, backend: 'durable' } } };`);
  await assert.rejects(() => loadConfig(dir), /durable.*azure-functions/);
});

test('azure-functions with in-process backend warns; budgets timeout above maxActivityMs warns; allowHttp warns', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'azure-functions' },
    modules: {
      runLoop: { enabled: true },
      budgets: { enabled: true, timeoutMs: 7200000 },
      dispatch: { enabled: true, backend: 'in-process', durable: { maxActivityMs: 3600000 } },
      notify: { webhook: { allowHttp: true } },
    } };`);
  const { result, warnings } = await captureWarnings(() => loadConfig(dir));
  assert.equal(result.modules.dispatch.backend, 'in-process');
  assert.ok(warnings.some(w => /in-process.*azure-functions|lost when the instance recycles/i.test(w)));
  assert.ok(warnings.some(w => /timeoutMs.*maxActivityMs/i.test(w) && /does not enforce maxActivityMs/i.test(w)));
  assert.ok(warnings.some(w => /allowHttp/i.test(w)));
});

test('memory store kind warns outside tests', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, dispatch: { enabled: true, store: { kind: 'memory' } } } };`);
  const { warnings } = await captureWarnings(() => loadConfig(dir, { NODE_ENV: 'production' }));
  assert.ok(warnings.some(w => /memory.*lost on restart/i.test(w)));
});

test('resolved dispatch and notify configs are exposed on the frozen config', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, dispatch: { enabled: true, maxQueueSize: 3 }, notify: { sse: { heartbeatMs: 5 } } } };`);
  const config = await loadConfig(dir, { JOBS_CONCURRENCY: '1' });
  assert.equal(config.modules.dispatch.maxQueueSize, 3);
  assert.equal(config.modules.dispatch.store.kind, 'sqlite');
  assert.equal(config.modules.notify.sse.heartbeatMs, 5);
  assert.equal(config.modules.notify.webhook.enabled, true);
});

const chatBase = (chat, extra = '') => `export default {
  name: 'chat-host', fleet: {}, comm: { adapter: 'express' },
  modules: {
    runLoop: { enabled: true },
    dispatch: { enabled: true, store: { kind: 'memory' } },
    ${extra}
    chat: ${chat},
  } };`;
const testEnv = { NODE_ENV: 'test' };

test('chat absent resolves to disabled with title defaulting to name', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'plain-host', fleet: {}, comm: { adapter: 'express' } };`);
  const config = await loadConfig(dir, testEnv);
  assert.deepEqual(config.modules.chat, { enabled: false, title: 'plain-host', themes: ['apra'] });
});

test('chat enabled with dispatch and sse resolves; title falls back to name', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true }`));
  const config = await loadConfig(dir, testEnv);
  assert.deepEqual(config.modules.chat, { enabled: true, title: 'chat-host', themes: ['apra'] });
});

test('chat.title is kept when given', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true, title: 'Travel agent' }`));
  const config = await loadConfig(dir, testEnv);
  assert.equal(config.modules.chat.title, 'Travel agent');
});

test('chat enabled without dispatch throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, chat: { enabled: true } } };`);
  await assert.rejects(() => loadConfig(dir, testEnv), /chat enabled but dispatch disabled/);
});

test('chat enabled with notify.sse disabled throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true }`, `notify: { sse: { enabled: false } },`));
  await assert.rejects(() => loadConfig(dir, testEnv), /chat enabled but notify\.sse disabled/);
});

test('CHAT_ENABLED env overrides the file in both directions', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true }`));
  const off = await loadConfig(dir, { ...testEnv, CHAT_ENABLED: 'false' });
  assert.equal(off.modules.chat.enabled, false);
  const dir2 = await tmpDir();
  await writeConfig(dir2, 'host.config.mjs', chatBase(`{ enabled: false }`));
  const on = await loadConfig(dir2, { ...testEnv, CHAT_ENABLED: 'true' });
  assert.equal(on.modules.chat.enabled, true);
});

test('chat.title must be a non-empty string', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true, title: '' }`));
  await assert.rejects(() => loadConfig(dir, testEnv), /chat\.title must be a non-empty string/);
  const dir2 = await tmpDir();
  await writeConfig(dir2, 'host.config.mjs', chatBase(`{ enabled: true, title: 42 }`));
  await assert.rejects(() => loadConfig(dir2, testEnv), /chat\.title must be a non-empty string/);
});

test('resolveChatConfig is exported for builder overrides', async () => {
  const { resolveChatConfig } = await import('../host/config.mjs');
  assert.deepEqual(resolveChatConfig({ enabled: true }, { env: {}, name: 'n' }), { enabled: true, title: 'n', themes: ['apra'] });
  assert.deepEqual(resolveChatConfig(undefined, { env: {}, name: 'n' }), { enabled: false, title: 'n', themes: ['apra'] });
  assert.deepEqual(resolveChatConfig({ enabled: true }, { env: { CHAT_ENABLED: '0' }, name: 'n' }), { enabled: false, title: 'n', themes: ['apra'] });
});

test('router.enabled with runLoop disabled throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { router: { enabled: true }, runLoop: { enabled: false } },
  };`);
  await assert.rejects(
    () => loadConfig(dir),
    /runLoop/,
  );
});

test('router.fallbackStrategy must be open-ended or plan-execute', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { router: { enabled: true, fallbackStrategy: 'invalid' }, runLoop: { enabled: true } },
  };`);
  await assert.rejects(
    () => loadConfig(dir),
    /fallbackStrategy/,
  );
});

test('router.enabled: false is accepted without error', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { router: { enabled: false }, runLoop: { enabled: true } },
  };`);
  const config = await loadConfig(dir);
  assert.ok(config);
});

test('router config resolves from env overrides', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x',
    fleet: {},
    comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true } },
  };`);
  const config = await loadConfig(dir, { ...process.env, ROUTER_ENABLED: 'true', ROUTER_FALLBACK_STRATEGY: 'plan-execute' });
  assert.equal(config.modules.router.enabled, true);
  assert.equal(config.modules.router.fallbackStrategy, 'plan-execute');
});
