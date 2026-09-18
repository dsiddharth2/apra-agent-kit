// tests/host-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';
import { readSse } from './helpers/sse.mjs';

const { startHost, createHost } = await import('../host/index.mjs');

function mockPayloadForCommand(command) {
  if (command.includes('weather.py')) {
    return JSON.stringify({
      ok: true, location: 'London', temp_c: '15', temp_f: '59',
      feels_like_c: '14', humidity: '72', description: 'Cloudy',
      wind_speed_kmph: '11', wind_dir: 'WSW', visibility_km: '10', uv_index: '3',
    });
  }
  if (command.includes('timezone.py')) {
    return JSON.stringify({
      ok: true, timezone: 'Europe/London', datetime: '2025-06-15T14:30:00+01:00',
      utc_offset: '+01:00', day_of_week: 0, abbreviation: 'BST',
    });
  }
  if (command.includes('textstats.py')) {
    return JSON.stringify({
      ok: true, char_count: 26, word_count: 5,
      sentence_count: 1, unique_words: 5, avg_word_length: 4.2,
    });
  }
  return JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
}

function makeMockFleetApi() {
  return createMockFleetApi({
    members: rosterNames(2),
    commandPayload: (options) => mockPayloadForCommand(options.command ?? ''),
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

function httpPost(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('startHost boots and serves tools via MCP', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'inspect-members'));
    assert.ok(tools.some(t => t.name === 'demo'));
    assert.ok(tools.some(t => t.name === 'weather'));
    assert.ok(tools.some(t => t.name === 'city-briefing'));

    const result = await client.callTool({ name: 'weather', arguments: { city: 'London' } });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);
  } finally {
    try { await client.close(); } finally { await close(); }
  }
});

test('startHost health endpoint returns ok', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: host.port(), path: '/health', method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await close();
  }
});

test('callTool returns result through executor path', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const out = await callTool('weather', { city: 'London' });
    assert.equal(out.ok, true);
    assert.ok(out.result);
  } finally {
    await close();
  }
});

test('callTool returns error for unknown tool', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });

  try {
    const out = await callTool('nonexistent-tool', {});
    assert.equal(out.ok, false);
    assert.match(out.error, /not_found|unknown/i);
  } finally {
    await close();
  }
});

test('close shuts down cleanly', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0 });
  const port = host.port();
  await close();
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
        resolve);
      req.on('error', reject);
      req.end();
    }),
    /ECONNREFUSED/,
  );
});

test('startHost rethrows loadConfig failures', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-bad-config-'));
  await fs.writeFile(path.join(dir, 'host.config.mjs'), `export default {
    fleet: {},
    comm: { adapter: 'express' },
  };`);
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({ fleetApi, dispatcher, port: 0, configDir: dir }),
    /name/i,
  );
});

test('createHost.comm applies bind host and stop aliases close', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { start } = createHost({ fleetApi, dispatcher })
    .comm({ port: 0, host: '127.0.0.1' })
    .tools(undefined)
    .build();
  const started = await start();
  const port = started.host.port();
  try {
    assert.equal(started.stop, started.close);
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/health', method: 'GET', agent: false,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await started.stop();
  }
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path: '/health', method: 'GET',
      }, resolve);
      req.on('error', reject);
      req.end();
    }),
    /ECONNREFUSED/,
  );
});

test('callTool maps dispatch failures to error-as-value', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => {
    throw new Error('queue overflow');
  };
  const { callTool, close } = await startHost({ fleetApi, dispatcher, port: 0 });
  try {
    const out = await callTool('inspect-members', {});
    assert.equal(out.ok, false);
    assert.ok(out.error);
    assert.ok(out.message);
  } finally {
    await close();
  }
});

test('startHost stops the dispatcher if jobs.start fails', async () => {
  const fleetApi = makeMockFleetApi();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-jobs-fail-'));
  const dbPath = path.join(root, 'jobs.db');
  await fs.mkdir(dbPath);
  let closed = 0;
  const origClose = WorkerDispatcher.prototype.close;
  WorkerDispatcher.prototype.close = async function (...args) {
    closed += 1;
    return origClose.apply(this, args);
  };
  try {
    await assert.rejects(
      () => startHost({
        fleetApi,
        port: 0,
        env: {
          ...process.env,
          WORKER_POOL_SIZE: '1',
          WORKER_EPHEMERAL_MAX: '0',
          WORKER_POOL_ROOT: root,
          NODE_ENV: 'test',
        },
        runLoop: { enabled: true, strategy: 'open-ended' },
        dispatch: { enabled: true, store: { kind: 'sqlite', dbPath } },
      }),
      /unable to open|SQLITE|not a database/i,
    );
    assert.equal(closed, 1, 'owned dispatcher must be closed when jobs fail to start');
  } finally {
    WorkerDispatcher.prototype.close = origClose;
  }
});

test('startHost rejects Express-style authenticate middleware', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  let started;
  try {
    started = await startHost({
      fleetApi, dispatcher, port: 0,
      authenticate(req, res, next) { next(); },
    });
  } catch (err) {
    assert.match(String(err?.message ?? err), /authenticateRequest/);
    return;
  }
  await started.close();
  assert.fail('expected startHost to reject a 3-arg authenticate function');
});

test('startHost with azure-functions adapter succeeds without a listen port', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi, dispatcher, port: 0, adapter: 'azure-functions' });
  try {
    assert.equal(host.port(), null);
  } finally {
    await close();
  }
});

test('startHost with durable backend rejects without a Durable client', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({
      fleetApi, dispatcher, port: 0,
      runLoop: { enabled: true, strategy: 'open-ended' },
      dispatch: { enabled: true, backend: 'durable', store: { kind: 'memory' } },
    }),
    /createDurableJobs requires a Durable client/,
  );
});

test('listen failure stops the adapter', async () => {
  let stopped = false;
  const fakeAdapter = {
    async start() { throw new Error('listen failed'); },
    async stop() { stopped = true; },
    port() { return undefined; },
  };
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({
      fleetApi,
      dispatcher,
      createAdapter: () => fakeAdapter,
    }),
    /listen failed/,
  );
  assert.equal(stopped, true);
});

test('POST /task executes a task through the run loop', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "inspected", "summary": "ok"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({
    fleetApi, dispatcher, port: 0,
    runLoop: { enabled: true, strategy: 'open-ended' },
  });

  try {
    const res = await httpPost(host.port(), '/task?wait=true', { goal: 'Inspect members' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'completed');
    assert.ok(body.result);
  } finally {
    await close();
  }
});

test('POST /task returns 404 when run loop is disabled', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(2) });
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({
    fleetApi, dispatcher, port: 0,
    runLoop: { enabled: false },
  });

  try {
    const res = await httpPost(host.port(), '/task', { goal: 'test' });
    assert.notEqual(res.status, 200);
  } finally {
    await close();
  }
});

test('MCP callTool is denied when guardrails policy denies weather', async () => {
  const fleetApi = makeMockFleetApi();
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({
    fleetApi,
    dispatcher,
    port: 0,
    guardrails: { enabled: true, defaultPolicy: 'deny', policies: { weather: 'deny' } },
  });

  const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const result = await client.callTool({ name: 'weather', arguments: { city: 'London' } });
    const text = result.content?.map(p => p.text ?? '').join('\n') ?? '';
    assert.ok(result.isError === true || text.includes('guardrail_denied'));
  } finally {
    try { await client.close(); } finally { await close(); }
  }
});

test('POST /task merges caller constraints and returns budget_exceeded', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "done", "summary": "ok"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({
    fleetApi,
    dispatcher,
    port: 0,
    runLoop: { enabled: true, strategy: 'open-ended' },
    budgets: { enabled: true, maxIterations: 25 },
  });

  try {
    const res = await httpPost(host.port(), '/task?wait=true', {
      goal: 'Inspect twice',
      constraints: { maxIterations: 1 },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'budget_exceeded');
    assert.equal(body.budget.iterations, 1);
  } finally {
    await close();
  }
});

test('registry tool run() shell-escapes user strings in commands', async () => {
  const { defaultRegistry } = await import('../mcp/registry.mjs');
  const countryInfo = defaultRegistry.find(t => t.name === 'country-info');
  assert.ok(countryInfo);

  const commands = [];
  const fleetApi = {
    executeCommand: async ({ command }) => {
      commands.push(command);
      return { structuredContent: { stdout: '{"ok":true}' } };
    },
  };

  await countryInfo.run({
    fleetApi,
    args: { country: 'Japan";\nrm -rf /' },
  });

  assert.equal(commands.length, 1);
  assert.match(commands[0], /Japan\\"; rm -rf \//);
  assert.doesNotMatch(commands[0], /Japan";/);
});

test('builder .runLoop().budget().guardrails() builds and starts', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(2) });
  const dispatcher = await makeDispatcher();
  const agent = createHost({ fleetApi, dispatcher })
    .runLoop({ strategy: 'open-ended' })
    .budget({ maxIterations: 10 })
    .guardrails({ defaultPolicy: 'allow' })
    .build();

  const { host, close } = await agent.start({ port: 0 });
  try {
    assert.ok(host.port() > 0);
  } finally {
    await close();
  }
});

const scripted = () => createMockFleetApi({
  members: rosterNames(2),
  promptResponses: [
    '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
    '```done\n{"result": "inspected", "summary": "ok"}\n```',
  ],
});
const asyncHost = (extra = {}) => startHost({
  port: 0, dispatcher: undefined, env: { ...process.env, NODE_ENV: 'test' },
  runLoop: { enabled: true, strategy: 'open-ended' },
  dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 1, concurrency: 1 },
  notify: { webhook: { allowHttp: true, retries: 1 } },
  ...extra,
});
async function getJson(port, path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('POST /task returns 202 and the job completes; GET /jobs/:id matches SSE settled', async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  try {
    const res = await httpPost(host.port(), '/task', { goal: 'Inspect members' });
    assert.equal(res.status, 202);
    const { jobId, links } = JSON.parse(res.body);
    assert.equal(links.events, `/jobs/${jobId}/events`);
    const types = []; let settled;
    for await (const e of readSse(await fetch(`http://127.0.0.1:${host.port()}${links.events}`))) {
      types.push(e.event); if (e.event === 'settled') settled = e;
    }
    assert.equal(types[0], 'queued'); assert.equal(types.at(-1), 'settled');
    assert.ok(types.includes('started') && types.includes('progress'));
    const rec = await getJson(host.port(), `/jobs/${jobId}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.status, settled.data.status);
    assert.equal(rec.body.status, 'completed');
    assert.ok(rec.body.history.length > 0);
  } finally { await close(); }
});

test('POST /task?wait=true keeps the Phase 2 synchronous shape', async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  try {
    const res = await httpPost(host.port(), '/task?wait=true', { goal: 'Inspect members' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['budget', 'history', 'result', 'status', 'taskId']);
    assert.equal(body.status, 'completed');
  } finally { await close(); }
});

test('429 when the job queue is full; 404 unknown job; DELETE cancels', async () => {
  // A fleet whose prompts never resolve until released, so jobs stay processing.
  let release; const gate = new Promise(r => { release = r; });
  const fleetApi = createMockFleetApi({ members: rosterNames(2), promptResponses: () => '```done\n{"result": 1}\n```' });
  const origPrompt = fleetApi.executePrompt.bind(fleetApi);
  fleetApi.executePrompt = async (o) => { await gate; return origPrompt(o); };
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi, dispatcher });
  try {
    const a = JSON.parse((await httpPost(host.port(), '/task', { goal: 'a' })).body);
    await sleep(30);                                        // a is processing
    const b = await httpPost(host.port(), '/task', { goal: 'b' });   // queued (1/1)
    assert.equal(b.status, 202);
    const c = await httpPost(host.port(), '/task', { goal: 'c' });
    assert.equal(c.status, 429);
    assert.equal(JSON.parse(c.body).error, 'queue_full');
    assert.equal((await getJson(host.port(), '/jobs/does-not-exist')).status, 404);
    const del = await getJson(host.port(), `/jobs/${a.jobId}`, 'DELETE');
    assert.equal(del.status, 202);
    await sleep(30);
    assert.equal((await getJson(host.port(), `/jobs/${a.jobId}`)).body.status, 'cancelled');
    release();
  } finally { release?.(); await close(); }
});

test('webhook receives the settled event', async () => {
  const received = [];
  const receiver = (await import('node:http')).createServer((req, res) => {
    let data = ''; req.on('data', c => { data += c; }); req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(data) }); res.end(); });
  });
  await new Promise(r => receiver.listen(0, '127.0.0.1', r));
  const dispatcher = await makeDispatcher();
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  try {
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const { jobId } = JSON.parse((await httpPost(host.port(), '/task', { goal: 'x', callbackUrl: url })).body);
    for (let i = 0; i < 100 && received.length === 0; i++) await sleep(20);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-fleet-job-id'], jobId);
    assert.equal(received[0].body.type, 'settled');
  } finally { await close(); receiver.close(); }
});

test('builder .dispatch().notify() start returns jobs and submit works programmatically', async () => {
  const dispatcher = await makeDispatcher();
  const agent = createHost({ fleetApi: scripted(), dispatcher, env: { ...process.env, NODE_ENV: 'test' } })
    .runLoop({ strategy: 'open-ended' })
    .dispatch({ store: { kind: 'memory' } })
    .notify({ sse: { enabled: false } })
    .build();
  const { jobs, close } = await agent.start({ port: 0 });
  try {
    const { jobId } = await jobs.submit({ goal: 'x' });
    for (let i = 0; i < 100 && (await jobs.get(jobId)).status !== 'completed'; i++) await sleep(10);
    assert.equal((await jobs.get(jobId)).status, 'completed');
  } finally { await close(); }
});

test('raw-http adapter serves the same host', async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await startHost({ fleetApi: makeMockFleetApi(), dispatcher, port: 0, adapter: 'raw-http' });
  try {
    assert.deepEqual((await getJson(host.port(), '/health')).body, { ok: true });
    const url = new URL(`http://127.0.0.1:${host.port()}/mcp`);
    const client = new Client({ name: 't', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.ok((await client.listTools()).tools.some(t => t.name === 'weather'));
    await client.close();
  } finally { await close(); }
});

test('hosted run loop submit-task receives jobs and does not tool_error', async () => {
  const dispatcher = await makeDispatcher();
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: [
      '```tool_call\n{"tool": "submit-task", "args": {"goal": "Inspect members"}}\n```',
      '```done\n{"result": "delegated", "summary": "ok"}\n```',
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "inspected", "summary": "ok"}\n```',
    ],
  });
  const { host, close } = await asyncHost({
    fleetApi,
    dispatcher,
    dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 4, concurrency: 1 },
  });
  try {
    const res = await httpPost(host.port(), '/task', { goal: 'delegate' });
    assert.equal(res.status, 202);
    const { jobId } = JSON.parse(res.body);
    let record;
    for (let i = 0; i < 100; i++) {
      record = (await getJson(host.port(), `/jobs/${jobId}`)).body;
      if (record?.status === 'completed' || record?.status === 'failed') break;
      await sleep(10);
    }
    assert.equal(record.status, 'completed');
    const submitObs = record.history.find(o => o.tool === 'submit-task');
    assert.ok(submitObs, 'expected submit-task observation');
    assert.notEqual(submitObs.error, 'tool_error', submitObs.message);
    assert.equal(submitObs.result.ok, true);
    assert.ok(submitObs.result.result.jobId);
  } finally { await close(); }
});

test('MCP submit-task and job-status work without taking a worker lease', async () => {
  const dispatcher = await makeDispatcher();
  let dispatches = 0;
  const origDispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = async (o) => { dispatches += 1; return origDispatch(o); };
  const { host, close } = await asyncHost({ fleetApi: scripted(), dispatcher });
  const client = new Client({ name: 't', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port()}/mcp`)));
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'submit-task') && tools.some(t => t.name === 'job-status'));
    const submitted = await client.callTool({ name: 'submit-task', arguments: { goal: 'Inspect members' } });
    const { jobId } = JSON.parse(submitted.content[0].text);
    assert.ok(jobId);
    let record;
    for (let i = 0; i < 100; i++) {
      record = JSON.parse((await client.callTool({ name: 'job-status', arguments: { jobId } })).content[0].text);
      if (record.status === 'completed') break;
      await sleep(10);
    }
    assert.equal(record.status, 'completed');
    assert.equal(dispatches, 1, 'only the job itself takes a lease');
  } finally { try { await client.close(); } finally { await close(); } }
});

