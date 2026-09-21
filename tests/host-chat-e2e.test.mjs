// tests/host-chat-e2e.test.mjs
// Offline proof of the chat page's contract: mock Fleet, scripted plan-execute
// run, real HTTP, real SSE, real reducer. No token, no network, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames, withRouterBypass } from './helpers/mock-fleet.mjs';
import { readSse } from './helpers/sse.mjs';

const { startHost, createHost } = await import('../host/index.mjs');
const { initialTurn, accepted, reduce } = await import('../host/chat/transcript.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-chat-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

const WEATHER = JSON.stringify({
  ok: true, location: 'London', temp_c: '15', temp_f: '59', feels_like_c: '14', humidity: '72',
  description: 'Cloudy', wind_speed_kmph: '11', wind_dir: 'WSW', visibility_km: '10', uv_index: '3',
});

// doer plans one weather step, reviewer approves, doer reports done. Same script
// as tests/host-strategy-plan-execute.test.mjs "simple plan".
const planFleet = () => createMockFleetApi({
  members: rosterNames(2),
  commandPayload: WEATHER,
  promptResponses: withRouterBypass([
    '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}\n```',
    '```review\n{"approved": true}\n```',
    '```done\n{"result": "London is 15°C and cloudy", "summary": "Done"}\n```',
  ], 'plan-execute'),
});

const chatHost = (extra = {}) => startHost({
  port: 0, env: { ...process.env, NODE_ENV: 'test' },
  runLoop: { enabled: true, strategy: 'plan-execute' },
  dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 2, concurrency: 1 },
  chat: { title: 'Chat e2e' },
  ...extra,
});

const url = (host, p) => `http://127.0.0.1:${host.port()}${p}`;

test('chat page, script, task, SSE, and reducer agree end to end', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { host, close, config } = await chatHost({ fleetApi: planFleet(), dispatcher });
  try {
    assert.deepEqual(config.modules.chat, { enabled: true, title: 'Chat e2e', themes: ['apra'] });

    const page = await fetch(url(host, '/chat'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Chat e2e<\/title>/);

    const script = await fetch(url(host, '/chat/app.mjs'));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);
    assert.match(await script.text(), /new EventSource/);

    const res = await fetch(url(host, '/task'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'Weather in London' }) });
    assert.equal(res.status, 202);
    const body = await res.json();
    let turn = accepted(initialTurn('Weather in London'), { jobId: body.jobId, position: body.position });

    const kinds = [];
    for await (const frame of readSse(await fetch(url(host, body.links.events)))) {
      if (frame.event === 'progress') kinds.push(frame.data.kind);
      turn = reduce(turn, frame.data);
      if (frame.event === 'settled') break;
    }
    assert.ok(kinds.includes('plan'), `expected a plan event, got ${kinds.join(',')}`);
    assert.ok(kinds.includes('step_completed'), `expected step_completed, got ${kinds.join(',')}`);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.answer, 'London is 15°C and cloudy');
    assert.equal(turn.plan.steps[0].tool, 'weather');
    assert.equal(turn.plan.steps[0].status, 'completed');
    assert.ok(turn.reviews.some(r => r.approved));
  } finally { await close(); }
});

test('CHAT_ENABLED=false turns chat off even though the repo config enables it', async () => {
  // No `chat` override, so the flag comes from host.config.mjs (enabled after
  // Task 5 Step 4); the env override must win and leave every other route intact.
  const dispatcher = await makeDispatcher();
  const { host, close, config } = await chatHost({ fleetApi: planFleet(), dispatcher, chat: undefined, env: { ...process.env, NODE_ENV: 'test', CHAT_ENABLED: 'false' } });
  try {
    assert.equal(config.modules.chat.enabled, false);
    assert.equal((await fetch(url(host, '/chat'))).status, 404);
    assert.equal((await fetch(url(host, '/health'))).status, 200);
  } finally { await close(); }
});

test('chat override without dispatch fails fast and unwinds', async () => {
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({ port: 0, env: { ...process.env, NODE_ENV: 'test' }, fleetApi: planFleet(), dispatcher, runLoop: { enabled: true, strategy: 'open-ended' }, dispatch: { enabled: false }, chat: { enabled: true } }),
    /chat enabled but dispatch disabled/,
  );
  await dispatcher.close();
});

test('createHost().chat() flows through the builder', async () => {
  const dispatcher = await makeDispatcher();
  const agent = createHost({ fleetApi: planFleet(), dispatcher, env: { ...process.env, NODE_ENV: 'test' } })
    .runLoop({ strategy: 'plan-execute' })
    .dispatch({ store: { kind: 'memory' } })
    .chat({ title: 'Builder chat' })
    .build();
  const { host, close, config } = await agent.start({ port: 0 });
  try {
    assert.deepEqual(config.modules.chat, { enabled: true, title: 'Builder chat', themes: ['apra'] });
    assert.equal((await fetch(url(host, '/chat'))).status, 200);
  } finally { await close(); }
});
