// tests/acceptance/async-job.acceptance.test.mjs
// Real Fleet + real LLM. Answers: can the agent still run a task as a job?
import '../setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSse } from '../helpers/sse.mjs';

const { startHost } = await import('../../host/index.mjs');

const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

const opts = (dbPath) => ({
  port: 0,
  runLoop: { enabled: true, strategy: 'open-ended' },
  budgets: { maxIterations: 10, timeoutMs: 180_000 },
  guardrails: { defaultPolicy: 'allow', validateInputs: true },
  dispatch: { enabled: true, store: { kind: 'sqlite', dbPath }, maxQueueSize: 5, concurrency: 1 },
  notify: { sse: { enabled: true } },
});

test('submit → SSE to settled → GET matches → record survives restart', { timeout: 400_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-jobs-'));
  const dbPath = path.join(dir, 'jobs.db');
  let { host, close } = await startHost(opts(dbPath));
  let jobId;
  try {
    const res = await post(host.port(), '/task', { goal: 'What is the current weather in London?' });
    assert.equal(res.status, 202);
    ({ jobId } = await res.json());
    let settled;
    for await (const e of readSse(await fetch(`http://127.0.0.1:${host.port()}/jobs/${jobId}/events`))) { if (e.event === 'settled') { settled = e.data; break; } }
    assert.ok(['completed', 'budget_exceeded'].includes(settled.status));
    const rec = await get(host.port(), `/jobs/${jobId}`);
    assert.equal(rec.body.status, settled.status);
    assert.ok(Array.isArray(rec.body.history), 'history should be an array');
  } finally { await close(); }

  ({ host, close } = await startHost(opts(dbPath)));
  try {
    const rec = await get(host.port(), `/jobs/${jobId}`);
    assert.equal(rec.status, 200);
    assert.ok(['completed', 'budget_exceeded'].includes(rec.body.status));
  } finally { await close(); }
});

test('cancel mid-run settles cancelled', { timeout: 300_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-jobs-'));
  const { host, close } = await startHost(opts(path.join(dir, 'jobs.db')));
  try {
    const res = await post(host.port(), '/task', { goal: 'Compare the weather in London, Paris, Berlin, Madrid, Rome, Vienna and Oslo.', constraints: { maxIterations: 30 } });
    const { jobId } = await res.json();
    for (let i = 0; i < 600; i++) { if ((await get(host.port(), `/jobs/${jobId}`)).body.status === 'processing') break; await new Promise(r => setTimeout(r, 100)); }
    const del = await fetch(`http://127.0.0.1:${host.port()}/jobs/${jobId}`, { method: 'DELETE' });
    assert.ok([200, 202].includes(del.status));
    for await (const e of readSse(await fetch(`http://127.0.0.1:${host.port()}/jobs/${jobId}/events`))) { if (e.event === 'settled') { assert.equal(e.data.status, 'cancelled'); break; } }
  } finally { await close(); }
});
