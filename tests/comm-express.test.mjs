import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createExpressAdapter } = await import('../comm/express.mjs');

test('express adapter mounts a health route without auth', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({
    routes: { health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) } },
    port: 0, host: '127.0.0.1', authenticate: () => null,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${adapter.port()}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await adapter.stop(); }
});
