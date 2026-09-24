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

// Full contract tests require a real Cosmos instance — run via:
// COSMOS_ENDPOINT=... COSMOS_KEY=... node --test tests/host-memory-store-cosmos.live.test.mjs
