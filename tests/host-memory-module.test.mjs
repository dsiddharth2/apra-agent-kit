// tests/host-memory-module.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createMemoryModule } = await import('../host/memory/index.mjs');

function fakeStore() {
  const data = new Map();
  const calls = [];
  return {
    calls,
    async open() { calls.push('open'); },
    async close() { calls.push('close'); },
    async store(entry) { data.set(entry.id, entry); calls.push('store'); },
    async get(id) { return data.get(id) ?? null; },
    async update(id, patch) {
      const next = { ...data.get(id), ...patch };
      data.set(id, next);
      return next;
    },
    async remove(id) { data.delete(id); },
    async query() { return [...data.values()]; },
    async purge() { return 0; },
    async count() { return data.size; },
  };
}

test('createMemoryModule wires long-term memory, routes, and events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-'));
  const published = [];
  const notifier = { publish: async (event) => { published.push(event); } };
  const mod = await createMemoryModule({
    longTerm: {
      enabled: true,
      store: 'filesystem',
      dir,
      decay: { mode: 'none' },
    },
  }, { notifier, fleetApi: {}, logger: console });
  assert.equal(mod.workingContext, null);
  assert.equal(mod.createRunWorkingContext(), null);
  assert.equal(mod.runState, null);
  assert.equal(mod.learner, null);
  assert.ok(mod.longTerm);
  assert.equal(typeof mod.routes.memoryStore.handler, 'function');
  await mod.open();
  try {
    await mod.longTerm.store({ kind: 'domain', text: 'the sky is blue', source: 'human', tags: ['sky'] });
    assert.ok(published.some(event => event.type === 'memory:store'));
  } finally {
    await mod.close();
  }
});

test('createMemoryModule enables learner and run state only when configured', async () => {
  const store = fakeStore();
  const mod = await createMemoryModule({
    workingContext: { enabled: true, maxTurns: 4 },
    runState: { enabled: true, store: () => store },
    longTerm: { enabled: true, autoLearn: true, store: () => fakeStore(), decay: { mode: 'none' } },
  }, { notifier: null, fleetApi: { executePrompt() {} }, logger: console });
  assert.ok(mod.workingContext);
  const runA = mod.createRunWorkingContext();
  const runB = mod.createRunWorkingContext();
  assert.ok(runA);
  assert.notEqual(runA, runB);
  assert.notEqual(runA, mod.workingContext);
  runA.append({ type: 'observation', tool: 'only-a' });
  assert.equal((await runB.forPrompt()).length, 0);
  assert.equal(mod.workingContext.history().length, 0);
  assert.ok(mod.runState);
  assert.ok(mod.learner);
  assert.ok(mod.longTerm);
  await mod.open();
  try {
    await mod.runState.save('task-1', { step: 1 });
    assert.ok(store.calls.includes('store'));
  } finally {
    await mod.close();
    assert.ok(store.calls.includes('close'));
  }
});

test('createMemoryModule interpolates env vars in long-term config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-env-'));
  const previous = process.env.MEM_TEST_DIR;
  process.env.MEM_TEST_DIR = dir;
  try {
    const mod = await createMemoryModule({
      longTerm: { enabled: true, store: 'filesystem', dir: '${MEM_TEST_DIR}', decay: { mode: 'none' } },
    }, { logger: console });
    await mod.open();
    try {
      const stored = await mod.longTerm.store({ kind: 'preference', text: 'prefer windows', source: 'human' });
      const id = stored.entry?.id ?? stored.id;
      const onDisk = await fs.readFile(path.join(dir, `${id}.json`), 'utf8');
      assert.match(onDisk, /prefer windows/);
    } finally {
      await mod.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MEM_TEST_DIR;
    else process.env.MEM_TEST_DIR = previous;
  }
});

test('createMemoryModule closes ltm and rsStore independently', async () => {
  const ltmStore = fakeStore();
  ltmStore.close = async () => { throw new Error('ltm close failed'); };
  const rsStore = fakeStore();
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(String(msg)) };
  const mod = await createMemoryModule({
    runState: { enabled: true, store: () => rsStore },
    longTerm: { enabled: true, store: () => ltmStore, decay: { mode: 'none' } },
  }, { logger });
  await mod.open();
  await mod.close();
  assert.ok(rsStore.calls.includes('close'), 'run-state store must close even when long-term close fails');
  assert.ok(warnings.some(w => /long-term memory/i.test(w)));
});

test('createMemoryModule open resolves when preload fails with non-ENOENT error', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-store-'));
  const preloadPath = path.join(os.tmpdir(), `mem-mod-preload-file-${process.pid}-${Date.now()}`);
  await fs.writeFile(preloadPath, 'not a directory');
  const warnings = [];
  const mod = await createMemoryModule({
    longTerm: {
      enabled: true,
      store: 'filesystem',
      dir: storeDir,
      decay: { mode: 'none' },
      preloadDir: preloadPath,
    },
  }, { logger: { info() {}, warn: (msg) => warnings.push(String(msg)) } });
  try {
    await assert.doesNotReject(() => mod.open());
    assert.ok(warnings.some(w => /preload failed/i.test(w)), 'should warn when preload throws');
  } finally {
    await mod.close();
    await fs.unlink(preloadPath).catch(() => {});
  }
});

test('createMemoryModule preloads knowledge when preloadDir is set', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-store-'));
  const preloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-preload-'));
  await fs.writeFile(path.join(preloadDir, 'rules.json'), JSON.stringify([
    { kind: 'rule', text: 'Always validate input', tags: ['safety'] },
  ]));
  const mod = await createMemoryModule({
    longTerm: {
      enabled: true,
      store: 'filesystem',
      dir: storeDir,
      decay: { mode: 'none' },
      preloadDir,
    },
  }, { logger: { info() {}, warn() {} } });
  await mod.open();
  try {
    const entries = await mod.longTerm.query({});
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /validate input/);
  } finally {
    await mod.close();
  }
});

test('memory module lazy-loads cosmos and does not import @azure/cosmos', async () => {
  const src = await fs.readFile(new URL('../host/memory/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /await import\('\.\/store\/cosmos\.mjs'\)/);
  assert.doesNotMatch(src, /@azure\/cosmos/);
  await assert.rejects(
    () => createMemoryModule({
      longTerm: { enabled: true, store: 'cosmos', cosmos: {} },
    }),
    /endpoint/,
  );
});
