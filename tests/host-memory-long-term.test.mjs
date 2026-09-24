import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLongTermMemory } from '../host/memory/long-term.mjs';
import { createFilesystemStore } from '../host/memory/store/filesystem.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

async function makeLtm(opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-ltm-'));
  const store = createFilesystemStore({ dir });
  return createLongTermMemory({ store, decayConfig: { mode: 'manual' }, ...opts });
}

test('store and recall a fact', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  await ltm.store({ kind: 'domain', text: 'Port is 5432', tags: ['db'] });
  const results = await ltm.recall({ tags: ['db'] });
  assert.ok(results.some(r => r.text === 'Port is 5432'));
  await ltm.close();
});

test('rules always come back in recall', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  await ltm.store({ kind: 'rule', text: 'Never delete without backup', tags: ['safety'] });
  await ltm.store({ kind: 'domain', text: 'DB on port 5432', tags: ['db'] });
  const results = await ltm.recall({ tags: ['db'] });
  assert.ok(results.some(r => r.kind === 'rule'));
  assert.ok(results.some(r => r.kind === 'domain'));
  await ltm.close();
});

test('recall respects recallLimit', async () => {
  const ltm = await makeLtm({ recallLimit: 3 });
  await ltm.open();
  for (let i = 0; i < 10; i++) {
    await ltm.store({ kind: 'domain', text: `Fact ${i}`, tags: ['batch'] });
  }
  const results = await ltm.recall({ tags: ['batch'] });
  assert.ok(results.length <= 3);
  await ltm.close();
});

test('promote increases retrievalStrength', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  const { entry } = await ltm.store({ kind: 'domain', text: 'Promotable fact', tags: ['a'] });
  await ltm.update(entry.id, { retrievalStrength: 0.4, state: 'dormant' });
  const promoted = await ltm.promote(entry.id);
  assert.equal(promoted.retrievalStrength, 1.0);
  assert.equal(promoted.state, 'active');
  await ltm.close();
});

test('dedup reinforces near-duplicate', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  await ltm.store({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am', tags: ['db'] });
  // "…2am" vs "…2am UTC" scores ~0.907 (merge). Trailing " x" scores ~0.951 (reinforce).
  const result = await ltm.store({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am x', tags: ['db'] });
  assert.equal(result.action, 'reinforced');
  const all = await ltm.query({});
  assert.equal(all.length, 1);
  await ltm.close();
});

test('dormant facts backfill when active count is low', async () => {
  const ltm = await makeLtm({ recallLimit: 5 });
  await ltm.open();
  await ltm.store({ kind: 'domain', text: 'Active fact', tags: ['a'] });
  const { entry } = await ltm.store({ kind: 'domain', text: 'Dormant fact', tags: ['a'] });
  await ltm.update(entry.id, { retrievalStrength: 0.5, state: 'dormant' });
  const results = await ltm.recall({ tags: ['a'] });
  assert.equal(results.length, 2);
  await ltm.close();
});
