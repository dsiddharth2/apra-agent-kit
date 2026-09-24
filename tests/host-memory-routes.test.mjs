// tests/host-memory-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryRoutes } from '../host/memory/routes.mjs';

function mockLtm() {
  const entries = new Map();
  let stored;
  let queried;
  let updated;
  let promoted;
  let removed;
  return {
    calls: () => ({ stored, queried, updated, promoted, removed }),
    store: async (body) => {
      stored = body;
      const entry = { id: 'mem-1', ...body };
      entries.set(entry.id, entry);
      return { action: 'created', entry };
    },
    query: async (opts) => {
      queried = opts;
      return [...entries.values()];
    },
    get: async (id) => entries.get(id) ?? null,
    update: async (id, patch) => {
      updated = { id, patch };
      const entry = { ...entries.get(id), ...patch };
      entries.set(id, entry);
      return entry;
    },
    promote: async (id) => {
      promoted = id;
      return { id, retrievalStrength: 1 };
    },
    remove: async (id) => {
      removed = id;
      entries.delete(id);
    },
  };
}

const req = (over = {}) => ({ params: {}, query: {}, body: null, ...over });

test('memory routes expose the six endpoints', () => {
  const routes = buildMemoryRoutes(mockLtm());
  assert.deepEqual(
    Object.entries(routes).map(([name, route]) => [name, route.method, route.path]),
    [
      ['memoryStore', 'POST', '/memory'],
      ['memoryQuery', 'GET', '/memory'],
      ['memoryGet', 'GET', '/memory/:id'],
      ['memoryUpdate', 'PATCH', '/memory/:id'],
      ['memoryPromote', 'PATCH', '/memory/:id/promote'],
      ['memoryRemove', 'DELETE', '/memory/:id'],
    ],
  );
});

test('POST /memory requires text and kind, otherwise stores and returns 201', async () => {
  const ltm = mockLtm();
  const { memoryStore } = buildMemoryRoutes(ltm);
  const missing = await memoryStore.handler(req({ body: { text: 'only text' } }));
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { ok: false, error: 'text and kind are required' });
  assert.equal(ltm.calls().stored, undefined);

  const created = await memoryStore.handler(req({ body: { text: 'Fact', kind: 'domain', tags: ['a'] } }));
  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.action, 'created');
  assert.deepEqual(ltm.calls().stored, { text: 'Fact', kind: 'domain', tags: ['a'] });
});

test('GET /memory splits list query params and passes limit as a number', async () => {
  const ltm = mockLtm();
  const { memoryQuery } = buildMemoryRoutes(ltm);
  const res = await memoryQuery.handler(req({
    query: { kinds: 'domain,preference', tags: 'a,b', states: 'active', query: 'port', limit: '5' },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(ltm.calls().queried, {
    kinds: ['domain', 'preference'],
    tags: ['a', 'b'],
    states: ['active'],
    query: 'port',
    limit: 5,
  });
  assert.deepEqual(res.body, []);
});

test('GET /memory/:id returns 404 when missing and the entry when present', async () => {
  const ltm = mockLtm();
  const routes = buildMemoryRoutes(ltm);
  const missing = await routes.memoryGet.handler(req({ params: { id: 'nope' } }));
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { ok: false, error: 'not found' });

  await routes.memoryStore.handler(req({ body: { text: 'Fact', kind: 'domain' } }));
  const found = await routes.memoryGet.handler(req({ params: { id: 'mem-1' } }));
  assert.equal(found.status, 200);
  assert.equal(found.body.id, 'mem-1');
  assert.equal(found.body.text, 'Fact');
});

test('PATCH update and promote, and DELETE remove, delegate to long-term memory', async () => {
  const ltm = mockLtm();
  const routes = buildMemoryRoutes(ltm);
  await routes.memoryStore.handler(req({ body: { text: 'Fact', kind: 'domain' } }));

  const updated = await routes.memoryUpdate.handler(req({ params: { id: 'mem-1' }, body: { text: 'Edited' } }));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.entry.text, 'Edited');
  assert.deepEqual(ltm.calls().updated, { id: 'mem-1', patch: { text: 'Edited' } });

  const promoted = await routes.memoryPromote.handler(req({ params: { id: 'mem-1' } }));
  assert.equal(promoted.status, 200);
  assert.deepEqual(promoted.body, { ok: true, entry: { id: 'mem-1', retrievalStrength: 1 } });
  assert.equal(ltm.calls().promoted, 'mem-1');

  const removed = await routes.memoryRemove.handler(req({ params: { id: 'mem-1' } }));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });
  assert.equal(ltm.calls().removed, 'mem-1');
  const gone = await routes.memoryGet.handler(req({ params: { id: 'mem-1' } }));
  assert.equal(gone.status, 404);
});
