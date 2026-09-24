// tests/host-memory-preloader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preloadKnowledge } from '../host/memory/preloader.mjs';
import { createLongTermMemory } from '../host/memory/long-term.mjs';
import { createFilesystemStore } from '../host/memory/store/filesystem.mjs';

async function makeLtm() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-store-'));
  const store = createFilesystemStore({ dir });
  const ltm = createLongTermMemory({ store, decayConfig: { mode: 'manual' } });
  await ltm.open();
  return ltm;
}

test('preload creates entries from JSON files', async () => {
  const ltm = await makeLtm();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-'));
  await fs.writeFile(path.join(dir, 'rules.json'), JSON.stringify([
    { kind: 'rule', text: 'Never delete without backup', tags: ['safety'] },
    { kind: 'rule', text: 'Always use UTC', tags: ['dates'] },
  ]));
  const result = await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  assert.equal(result.loaded, 2);
  await ltm.close();
});

test('preload reinforces duplicates on second run', async () => {
  const ltm = await makeLtm();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-'));
  const data = JSON.stringify([{ kind: 'rule', text: 'Never delete without backup', tags: ['safety'] }]);
  await fs.writeFile(path.join(dir, 'rules.json'), data);
  await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  const result = await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  assert.equal(result.reinforced, 1);
  assert.equal(result.loaded, 0);
  await ltm.close();
});

test('preload handles missing directory gracefully', async () => {
  const ltm = await makeLtm();
  const result = await preloadKnowledge(ltm, { dir: '/nonexistent/path', logger: { info() {}, warn() {} } });
  assert.equal(result.loaded, 0);
  await ltm.close();
});

test('preload recurses into subdirectories', async () => {
  const ltm = await makeLtm();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-'));
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'facts.json'), JSON.stringify([
    { kind: 'domain', text: 'DB port is 5432', tags: ['db'] },
  ]));
  const result = await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  assert.equal(result.loaded, 1);
  await ltm.close();
});

test('preload logs progress every 50 files', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-store-'));
  const store = createFilesystemStore({ dir: storeDir });
  const ltm = createLongTermMemory({
    store,
    decayConfig: { mode: 'manual' },
    dedupConfig: { enabled: false },
  });
  await ltm.open();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-progress-'));
  for (let i = 0; i < 51; i++) {
    await fs.writeFile(
      path.join(dir, `fact-${i}.json`),
      JSON.stringify([{ kind: 'domain', text: `fact number ${i}`, tags: ['bulk'] }]),
    );
  }
  const infoLogs = [];
  const result = await preloadKnowledge(ltm, {
    dir,
    logger: { info: (msg) => infoLogs.push(msg), warn() {} },
  });
  assert.equal(result.loaded, 51);
  const progressLogs = infoLogs.filter(msg => /processed \d+\/51 files/.test(msg));
  assert.equal(progressLogs.length, 1, 'should log once at file 50');
  assert.match(progressLogs[0], /processed 50\/51 files/);
  assert.ok(infoLogs.some(msg => /loaded 51 new/.test(msg)), 'should log final summary');
  await ltm.close();
});
