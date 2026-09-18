// tests/comm-azure-http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAzureFunctionsAdapter, toNeutralRequest, toHttpResponse, toFunctionsRoute, getHttpDurableClient } = await import('../comm/azure-functions/http.mjs');

function fakeApp() {
  const registered = {};
  return { registered, setup(opts) { registered.__setup = opts; }, http(name, opts) { registered[name] = opts; } };
}
function fakeHttpRequest({ method = 'GET', url = 'http://f/api/jobs/j1?q=2', headers = {}, params = {}, body = null, signal } = {}) {
  let bodyUsed = false;
  const bodyAlreadyUsed = () => {
    throw new TypeError('body already used');
  };
  return {
    method, url, params, query: new URL(url).searchParams,
    headers: new Headers(headers),
    async json() {
      if (bodyUsed) bodyAlreadyUsed();
      if (body === null) throw new Error('no body');
      bodyUsed = true;
      return body;
    },
    async text() {
      if (bodyUsed) bodyAlreadyUsed();
      bodyUsed = true;
      return body == null ? '' : JSON.stringify(body);
    },
    signal: signal ?? new AbortController().signal,
  };
}
async function collect(stream) { const out = []; for await (const c of stream) out.push(c.toString()); return out; }

test('toFunctionsRoute strips the leading slash and converts :params to {params}', () => {
  assert.equal(toFunctionsRoute('/health'), 'health');
  assert.equal(toFunctionsRoute('/jobs/:id/events'), 'jobs/{id}/events');
});

test('toNeutralRequest maps method, /api-stripped path, params, query, lower-case headers, body', async () => {
  const r = await toNeutralRequest(fakeHttpRequest({ method: 'POST', url: 'http://f/api/task?wait=true', headers: { 'X-Test': 'a' }, body: { goal: 'g' } }), { id: 'j1' });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/task');
  assert.deepEqual(r.params, { id: 'j1' });
  assert.deepEqual(r.query, { wait: 'true' });
  assert.equal(r.headers['x-test'], 'a');
  assert.deepEqual(r.body, { goal: 'g' });
  assert.equal(r.user, null);
  const g = await toNeutralRequest(fakeHttpRequest({ method: 'GET', url: 'http://f/api/health' }));
  assert.equal(g.path, '/health');
  assert.equal(g.body, null);
  const d = await toNeutralRequest(fakeHttpRequest({ method: 'DELETE', url: 'http://f/api/jobs/j1' }));
  assert.equal(d.body, null);
  const bad = await toNeutralRequest(fakeHttpRequest({ method: 'POST', url: 'http://f/api/task', body: null }));
  assert.equal(bad.body, null);
});

test('toHttpResponse maps JSON and stream responses', async () => {
  const j = toHttpResponse({ status: 202, headers: { 'retry-after': '30' }, body: { a: 1 } });
  assert.equal(j.status, 202);
  assert.equal(j.headers['retry-after'], '30');
  assert.equal(j.headers['content-type'], 'application/json');
  assert.deepEqual(j.jsonBody, { a: 1 });
  async function* gen() { yield 'a'; yield 'b'; }
  const s = toHttpResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: gen() });
  assert.equal(s.status, 200);
  assert.equal(s.headers['content-type'], 'text/event-stream');
  assert.deepEqual(await collect(s.body), ['a', 'b']);
  const empty = toHttpResponse({ status: 204 });
  assert.deepEqual(empty.jsonBody, {});
});

test('adapter registers one anonymous function per non-null route, with extraInputs, and applies auth', async () => {
  const app = fakeApp();
  const clientInput = { name: 'client', type: 'durableClient' };
  const adapter = createAzureFunctionsAdapter({ app, extraInputs: [clientInput] });
  const authenticate = (r) => (r.headers['x-deny'] ? null : { id: 'u' });
  await adapter.start({
    routes: {
      health: { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
      jobGet: { method: 'GET', path: '/jobs/:id', handler: async (r) => ({ status: 200, body: { id: r.params.id, user: r.user } }) },
      task: null,
      boom: { method: 'GET', path: '/boom', handler: async () => { throw new Error('kaboom'); } },
    },
    authenticate,
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => {} }),
  });
  assert.equal(app.registered.__setup.enableHttpStream, true);
  assert.equal(app.registered.task, undefined);
  assert.deepEqual(app.registered.jobGet.methods, ['GET']);
  assert.equal(app.registered.jobGet.route, 'jobs/{id}');
  assert.equal(app.registered.jobGet.authLevel, 'anonymous');
  assert.deepEqual(app.registered.jobGet.extraInputs, [clientInput]);

  const ok = await app.registered.jobGet.handler(fakeHttpRequest({ params: { id: 'j1' } }), {});
  assert.deepEqual(ok.jsonBody, { id: 'j1', user: { id: 'u' } });
  const denied = await app.registered.jobGet.handler(fakeHttpRequest({ params: { id: 'j1' }, headers: { 'x-deny': '1' } }), {});
  assert.equal(denied.status, 401);
  const health = await app.registered.health.handler(fakeHttpRequest({ url: 'http://f/api/health', headers: { 'x-deny': '1' } }), {});
  assert.equal(health.status, 200);
  const err = await app.registered.boom.handler(fakeHttpRequest({ url: 'http://f/api/boom' }), {});
  assert.equal(err.status, 500);
  assert.equal(err.jsonBody.error, 'internal_error');
  assert.equal(adapter.port(), null);
  assert.equal(adapter.address(), null);
  await adapter.stop();
});

test('overlapping HTTP invocations keep distinct Durable clients', async () => {
  const app = fakeApp();
  const adapter = createAzureFunctionsAdapter({
    app,
    extraInputs: [{ name: 'client', type: 'durableClient' }],
    getClient: (context) => ({ id: context.invocationId }),
  });
  await adapter.start({
    routes: {
      jobGet: {
        method: 'GET', path: '/jobs/:id', auth: false,
        handler: async () => {
          await new Promise(r => setTimeout(r, 15));
          return { status: 200, body: { client: getHttpDurableClient().id } };
        },
      },
    },
    authenticate: () => ({ id: 'u' }),
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => {} }),
  });
  const [a, b] = await Promise.all([
    app.registered.jobGet.handler(fakeHttpRequest({ params: { id: '1' } }), { invocationId: 'A' }),
    app.registered.jobGet.handler(fakeHttpRequest({ params: { id: '2' } }), { invocationId: 'B' }),
  ]);
  assert.equal(a.jsonBody.client, 'A');
  assert.equal(b.jsonBody.client, 'B');
});

test('raw route: 401 when denied; delegates to route.web when present', async () => {
  const app = fakeApp();
  const adapter = createAzureFunctionsAdapter({ app });
  let webCalled = null;
  await adapter.start({
    routes: { mcp: { method: 'POST', path: '/mcp', raw: true, handler: () => {}, web: async (req, user) => { webCalled = user; return { status: 200, jsonBody: { via: 'web' } }; } } },
    authenticate: (r) => (r.headers['x-deny'] ? null : { id: 'u' }),
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => {} }),
  });
  const denied = await app.registered.mcp.handler(fakeHttpRequest({ method: 'POST', url: 'http://f/api/mcp', headers: { 'x-deny': '1' }, body: {} }), {});
  assert.equal(denied.status, 401);
  const ok = await app.registered.mcp.handler(fakeHttpRequest({ method: 'POST', url: 'http://f/api/mcp', body: {} }), {});
  assert.deepEqual(ok.jsonBody, { via: 'web' });
  assert.deepEqual(webCalled, { id: 'u' });
});

test('raw route without web falls back to the MCP web-standard transport and returns its Response', async () => {
  const app = fakeApp();
  const adapter = createAzureFunctionsAdapter({
    app,
    loadWebTransport: async () => class FakeTransport {
      constructor() { this.connected = false; }
      async handleRequest(webReq) { return new Response(JSON.stringify({ echo: await webReq.text() }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    },
  });
  let closed = 0;
  await adapter.start({
    routes: { mcp: { method: 'POST', path: '/mcp', raw: true, handler: () => {} } },
    authenticate: () => ({ id: 'u' }),
    mcpServerFactory: () => ({ connect: async () => {}, close: async () => { closed += 1; } }),
  });
  const res = await app.registered.mcp.handler(fakeHttpRequest({ method: 'POST', url: 'http://f/api/mcp', body: { jsonrpc: '2.0' } }), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse((await collect(res.body)).join('')), { echo: JSON.stringify({ jsonrpc: '2.0' }) });
  assert.equal(closed, 1);
});
