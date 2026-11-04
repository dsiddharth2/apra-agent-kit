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

// #89: requests addressed by hostname or IP must not be refused when the
// adapter is bound to all interfaces. fetch() cannot set Host, so use node:http.
import http from 'node:http';

function getWithHost(port, hostHeader, path = '/health') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: hostHeader } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const healthRoutes = { health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) } };

test('express adapter bound to 0.0.0.0 accepts a non-localhost Host header', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({ routes: healthRoutes, port: 0, host: '0.0.0.0', authenticate: () => null });
  try {
    const res = await getWithHost(adapter.port(), 'agent-vm:3000');
    assert.equal(res.status, 200, res.body);
  } finally { await adapter.stop(); }
});

test('express adapter bound to 127.0.0.1 still refuses a foreign Host header', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({ routes: healthRoutes, port: 0, host: '127.0.0.1', authenticate: () => null });
  try {
    const res = await getWithHost(adapter.port(), 'evil.example');
    assert.equal(res.status, 403);
  } finally { await adapter.stop(); }
});

test('express adapter enforces allowedHosts when set', async () => {
  const adapter = createExpressAdapter();
  await adapter.start({ routes: healthRoutes, port: 0, host: '0.0.0.0', allowedHosts: ['agent-vm'], authenticate: () => null });
  try {
    assert.equal((await getWithHost(adapter.port(), 'agent-vm:3000')).status, 200);
    assert.equal((await getWithHost(adapter.port(), 'evil.example')).status, 403);
  } finally { await adapter.stop(); }
});
