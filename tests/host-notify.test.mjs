// tests/host-notify.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { createSseHandler, formatSse } = await import('../host/notify/sse.mjs');
const { createWebhookChannel } = await import('../host/notify/webhook.mjs');
const { createNotifier } = await import('../host/notify/index.mjs');

const ev = (seq, type, extra = {}) => ({ seq, type, jobId: 'j', at: '2026-09-17T10:00:00.000Z', ...extra });

// Fake jobs backend with controllable stored events + live subscribers.
function fakeJobs({ status = 'processing', events = [] } = {}) {
  const subs = new Set();
  return {
    status, stored: events, subs,
    async get(id) { return id === 'j' ? { id, status: this.status } : null; },
    async events(id, { afterSeq = 0 } = {}) { return this.stored.filter(e => e.seq > afterSeq); },
    subscribe(id, fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(e) { this.stored.push(e); for (const fn of subs) fn(e); },
  };
}

async function collect(stream, { max = Infinity } = {}) {
  const out = [];
  for await (const chunk of stream) { out.push(chunk); if (out.length >= max) break; }
  return out;
}

test('formatSse renders id/event/data lines', () => {
  const s = formatSse(ev(3, 'progress', { iteration: 3, message: 'm' }));
  assert.equal(s, 'id: 3\nevent: progress\ndata: {"type":"progress","jobId":"j","at":"2026-09-17T10:00:00.000Z","iteration":3,"message":"m"}\n\n');
});

test('sse: 404 for unknown job', async () => {
  const handler = createSseHandler({ jobs: fakeJobs() });
  const res = await handler({ params: { id: 'nope' }, headers: {}, signal: new AbortController().signal });
  assert.equal(res.status, 404);
});

test('sse: terminal job replays stored events and closes without subscribing', async () => {
  const jobs = fakeJobs({ status: 'completed', events: [ev(1, 'queued'), ev(2, 'started'), ev(3, 'settled', { status: 'completed' })] });
  const handler = createSseHandler({ jobs });
  const res = await handler({ params: { id: 'j' }, headers: { 'last-event-id': '1' }, signal: new AbortController().signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const chunks = await collect(res.stream);
  assert.deepEqual(chunks.map(c => c.match(/^id: (\d+)/)[1]), ['2', '3']);
  assert.equal(jobs.subs.size, 0);
});

test('sse: live job replays then follows subscription until settled', async () => {
  const jobs = fakeJobs({ events: [ev(1, 'queued'), ev(2, 'started')] });
  const handler = createSseHandler({ jobs, heartbeatMs: 60_000 });
  const res = await handler({ params: { id: 'j' }, headers: {}, signal: new AbortController().signal });
  const it = res.stream[Symbol.asyncIterator]();
  assert.match((await it.next()).value, /^id: 1/);
  assert.match((await it.next()).value, /^id: 2/);
  jobs.emit(ev(3, 'progress', { iteration: 1, message: 'x' }));
  assert.match((await it.next()).value, /^id: 3\nevent: progress/);
  jobs.emit(ev(4, 'settled', { status: 'completed' }));
  assert.match((await it.next()).value, /^id: 4\nevent: settled/);
  assert.equal((await it.next()).done, true);
  assert.equal(jobs.subs.size, 0);
});

test('sse: events that arrive between replay and subscribe are not lost or duplicated', async () => {
  const jobs = fakeJobs({ events: [ev(1, 'queued')] });
  const originalEvents = jobs.events.bind(jobs);
  jobs.events = async (id, opts) => { const r = await originalEvents(id, opts); jobs.emit(ev(2, 'started')); return r; };
  const handler = createSseHandler({ jobs, heartbeatMs: 60_000 });
  const res = await handler({ params: { id: 'j' }, headers: {}, signal: new AbortController().signal });
  const it = res.stream[Symbol.asyncIterator]();
  assert.match((await it.next()).value, /^id: 1/);
  assert.match((await it.next()).value, /^id: 2/);
  jobs.emit(ev(3, 'settled', { status: 'completed' }));
  assert.match((await it.next()).value, /^id: 3/);
});

test('sse: heartbeat comment is emitted while idle', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const jobs = fakeJobs({ events: [] });
    const handler = createSseHandler({ jobs, heartbeatMs: 1000 });
    const res = await handler({ params: { id: 'j' }, headers: {}, signal: new AbortController().signal });
    const it = res.stream[Symbol.asyncIterator]();
    const next = it.next();
    mock.timers.tick(1000);
    assert.equal((await next).value, ': ping\n\n');
  } finally { mock.timers.reset(); }
});

test('sse: request abort unsubscribes and ends the stream', async () => {
  const jobs = fakeJobs({ events: [] });
  const ctrl = new AbortController();
  const handler = createSseHandler({ jobs, heartbeatMs: 60_000 });
  const res = await handler({ params: { id: 'j' }, headers: {}, signal: ctrl.signal });
  const it = res.stream[Symbol.asyncIterator]();
  const next = it.next();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(jobs.subs.size, 1);
  ctrl.abort();
  assert.equal((await next).done, true);
  assert.equal(jobs.subs.size, 0);
});

test('webhook: posts settled event with job header, retries with backoff, then gives up', async () => {
  const calls = [];
  let failures = 2;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (failures-- > 0) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  const ch = createWebhookChannel({ retries: 3, fetchImpl, baseDelayMs: 1, logger: { warn() {} } });
  await ch.publish(ev(4, 'settled', { status: 'completed', result: 1, error: null }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://cb.test/h');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-fleet-job-id'], 'j');
  assert.equal(JSON.parse(calls[0].init.body).type, 'settled');

  const warnings = [];
  const always500 = async () => ({ ok: false, status: 500 });
  const ch2 = createWebhookChannel({ retries: 2, fetchImpl: always500, baseDelayMs: 1, logger: { warn: (m) => warnings.push(m) } });
  await ch2.publish(ev(4, 'settled', { status: 'completed' }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gave up/);
});

test('webhook: skips non-settled events unless sendProgress, and skips jobs without callbackUrl', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true }; };
  const quiet = createWebhookChannel({ fetchImpl, logger: { warn() {} } });
  await quiet.publish(ev(3, 'progress'), { callbackUrl: 'https://cb.test/h' });
  await quiet.publish(ev(4, 'settled', { status: 'completed' }), { callbackUrl: null });
  assert.equal(calls.length, 0);
  const chatty = createWebhookChannel({ fetchImpl, sendProgress: true, logger: { warn() {} } });
  await chatty.publish(ev(3, 'progress'), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 1);
});

test('createNotifier fans out to enabled channels and exposes sseHandler', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true }; };
  const jobs = fakeJobs({ status: 'completed', events: [ev(1, 'settled', { status: 'completed' })] });
  const n = createNotifier(
    { sse: { enabled: true, heartbeatMs: 1000 }, webhook: { enabled: true, retries: 1 } },
    { jobs, fetchImpl, logger: { warn() {} } },
  );
  await n.publish(ev(1, 'settled', { status: 'completed' }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 1);
  assert.equal(typeof n.sseHandler, 'function');
  const off = createNotifier({ sse: { enabled: false }, webhook: { enabled: false } }, { jobs, fetchImpl });
  assert.equal(off.sseHandler, null);
  await off.publish(ev(1, 'settled', { status: 'completed' }), { callbackUrl: 'https://cb.test/h' });
  assert.equal(calls.length, 1);
  await n.stop(); await off.stop();
});
