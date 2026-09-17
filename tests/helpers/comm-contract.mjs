import { test } from 'node:test';
import assert from 'node:assert/strict';

async function readAll(res) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

export function runCommContract(name, createAdapter) {
  const authenticate = (request) => (request.headers['x-deny'] ? null : { id: 'u1' });

  async function withAdapter(routes, fn) {
    const adapter = createAdapter();
    await adapter.start({ routes, port: 0, host: '127.0.0.1', authenticate });
    const base = `http://127.0.0.1:${adapter.port()}`;
    try { await fn(base, adapter); } finally { await adapter.stop(); }
  }

  test(`${name}: routes JSON with params, query, body and user`, async () => {
    let seen;
    await withAdapter({
      jobGet: { method: 'GET', path: '/jobs/:id', handler: async (r) => { seen = r; return { status: 200, body: { id: r.params.id, q: r.query.q, user: r.user } }; } },
      task: { method: 'POST', path: '/task', handler: async (r) => ({ status: 202, headers: { 'retry-after': '30' }, body: { got: r.body } }) },
    }, async (base) => {
      const g = await readAll(await fetch(`${base}/jobs/abc?q=1`));
      assert.equal(g.status, 200);
      assert.deepEqual(g.json(), { id: 'abc', q: '1', user: { id: 'u1' } });
      assert.equal(seen.method, 'GET'); assert.equal(seen.path, '/jobs/abc');
      const p = await readAll(await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x' }) }));
      assert.equal(p.status, 202);
      assert.equal(p.headers.get('retry-after'), '30');
      assert.deepEqual(p.json(), { got: { goal: 'x' } });
    });
  });

  test(`${name}: authenticate returning null yields 401; auth:false skips it`, async () => {
    await withAdapter({
      task: { method: 'POST', path: '/task', handler: async () => ({ status: 200, body: { ok: true } }) },
      health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
    }, async (base) => {
      const denied = await fetch(`${base}/task`, { method: 'POST', headers: { 'x-deny': '1', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 401);
      const health = await fetch(`${base}/health`, { headers: { 'x-deny': '1' } });
      assert.equal(health.status, 200);
    });
  });

  test(`${name}: unknown path is 404 JSON; handler throw is 500 JSON`, async () => {
    await withAdapter({
      boom: { method: 'GET', path: '/boom', handler: async () => { throw new Error('kaboom'); } },
    }, async (base) => {
      const nf = await readAll(await fetch(`${base}/nope`));
      assert.equal(nf.status, 404);
      const err = await readAll(await fetch(`${base}/boom`));
      assert.equal(err.status, 500);
      assert.equal(err.json().error, 'internal_error');
    });
  });

  test(`${name}: null routes are not mounted`, async () => {
    await withAdapter({ task: null, health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: {} }) } },
      async (base) => { assert.equal((await fetch(`${base}/task`, { method: 'POST' })).status, 404); });
  });

  test(`${name}: streaming response arrives chunk by chunk with event-stream headers`, async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    async function* gen() { yield 'id: 1\nevent: a\ndata: {}\n\n'; await gate; yield 'id: 2\nevent: b\ndata: {}\n\n'; }
    await withAdapter({
      events: { method: 'GET', path: '/jobs/:id/events', handler: async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen() }) },
    }, async (base) => {
      const res = await fetch(`${base}/jobs/j/events`);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const first = await reader.read();
      assert.match(first.value, /^id: 1/);
      release();
      const second = await reader.read();
      assert.match(second.value, /^id: 2/);
      assert.equal((await reader.read()).done, true);
    });
  });

  test(`${name}: stream is closed when the client disconnects`, async () => {
    let finished = false;
    async function* gen(signal) {
      try { yield 'id: 1\nevent: a\ndata: {}\n\n'; await new Promise(r => signal.addEventListener('abort', r, { once: true })); }
      finally { finished = true; }
    }
    await withAdapter({
      events: { method: 'GET', path: '/e', handler: async (r) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen(r.signal) }) },
    }, async (base) => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/e`, { signal: ctrl.signal });
      await res.body.getReader().read();
      ctrl.abort();
      for (let i = 0; i < 50 && !finished; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(finished, true);
    });
  });

  test(`${name}: raw route receives Node req/res and the user`, async () => {
    await withAdapter({
      mcp: { method: 'POST', path: '/mcp', raw: true, handler: (req, res, user) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ raw: true, user })); } },
    }, async (base) => {
      const r = await readAll(await fetch(`${base}/mcp`, { method: 'POST', body: '{}' }));
      assert.deepEqual(r.json(), { raw: true, user: { id: 'u1' } });
    });
  });

  test(`${name}: stop() closes the listener`, async () => {
    const adapter = createAdapter();
    await adapter.start({ routes: { health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: {} }) } }, port: 0, host: '127.0.0.1', authenticate });
    const port = adapter.port();
    await adapter.stop();
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
  });
}
