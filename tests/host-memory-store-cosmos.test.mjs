// tests/host-memory-store-cosmos.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('cosmos: createCosmosStore throws without endpoint', async () => {
  const { createCosmosStore } = await import('../host/memory/store/cosmos.mjs');
  assert.throws(() => createCosmosStore({}), /endpoint/);
});

test('cosmos: createCosmosStore throws without key', async () => {
  const { createCosmosStore } = await import('../host/memory/store/cosmos.mjs');
  assert.throws(() => createCosmosStore({ endpoint: 'https://test' }), /key/);
});

// Shared contract coverage (store/get/update/remove/query/purge/count/open/close)
// uses the mock client in tests/host-memory-store.test.mjs.
