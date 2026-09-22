// tests/host-scripted-fleet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createScriptedFleetApi, loadScript } = await import('./helpers/scripted-fleet.mjs');
const { startHost } = await import('../host/index.mjs');

const script = {
  tools: { weather: { ok: true, location: 'Tokyo', temp_c: '22' } },
  goals: { 'weather in Tokyo': ['```tool_call\n{"tool":"weather","args":{"city":"Tokyo"}}\n```', '```done\n{"result":"22C","summary":"s"}\n```'] },
  default: ['```done\n{"result":"default","summary":"s"}\n```'],
  delays: { 'weather in Tokyo': 20 },
};

test('executeCommand returns the payload for the tool named in the command', async () => {
  const api = createScriptedFleetApi(script);
  const out = await api.executeCommand({ member_name: 'doer', command: 'python3 "/x/tools/weather/weather.py" "Tokyo"' });
  assert.equal(JSON.parse(out.structuredContent.stdout).location, 'Tokyo');
  const miss = await api.executeCommand({ member_name: 'doer', command: 'python3 nothing.py' });
  assert.equal(JSON.parse(miss.structuredContent.stdout).ok, false);
});

test('executePrompt walks the goal script, repeats the last response, falls back to default, honours delays', async () => {
  const api = createScriptedFleetApi(script);
  const p = (text) => api.executePrompt({ member_name: 'doer', prompt: `Task: What is the weather in Tokyo?\n${text}` });
  const t0 = Date.now();
  assert.match((await p('')).structuredContent.response, /tool_call/);
  assert.ok(Date.now() - t0 >= 15, 'delay applied');
  assert.match((await p('')).structuredContent.response, /done/);
  assert.match((await p('')).structuredContent.response, /done/);
  assert.match((await api.executePrompt({ member_name: 'doer', prompt: 'Task: something else' })).structuredContent.response, /default/);
});

test('classifier derives plan-execute from plan fence without consuming goal cursor', async () => {
  const planScript = {
    goals: {
      'plan a trip': [
        '```plan\n{"steps":[]}\n```',
        '```done\n{"result":"done","summary":"s"}\n```',
      ],
    },
    default: ['```done\n{"result":"default","summary":"s"}\n```'],
  };
  const api = createScriptedFleetApi(planScript);
  const routerPrompt = `You are a task router for a travel assistant.\n\nUser's goal: "plan a trip to Japan"\n\nRespond with ONLY a JSON object`;
  const classified = JSON.parse((await api.executePrompt({ member_name: 'doer', prompt: routerPrompt })).structuredContent.response);
  assert.equal(classified.path, 'plan-execute');
  const runLoop = await api.executePrompt({ member_name: 'doer', prompt: 'Task: plan a trip to Japan\ncontext' });
  assert.match(runLoop.structuredContent.response, /```plan/);
});

test('loadScript reads JSON from disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scripted-'));
  const file = path.join(dir, 's.json');
  await fs.writeFile(file, JSON.stringify(script));
  assert.deepEqual((await loadScript(file)).tools.weather.location, 'Tokyo');
});

test('startHost uses the scripted fleet under NODE_ENV=test and refuses it otherwise', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scripted-host-'));
  const file = path.join(dir, 's.json');
  await fs.writeFile(file, JSON.stringify(script));
  const base = { ...process.env, FLEET_MOCK_SCRIPT: file, WORKER_POOL_SIZE: '1', WORKER_EPHEMERAL_MAX: '0', WORKER_POOL_ROOT: path.join(dir, 'pool') };

  await assert.rejects(
    () => startHost({ port: 0, env: { ...base, NODE_ENV: 'production' }, dispatch: { enabled: false } }),
    /NODE_ENV=test/,
  );

  const { host, close } = await startHost({ port: 0, env: { ...base, NODE_ENV: 'test' }, runLoop: { enabled: true, strategy: 'open-ended' }, dispatch: { enabled: false }, chat: { enabled: false } });
  try {
    const res = await fetch(`http://127.0.0.1:${host.port()}/task?wait=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'What is the weather in Tokyo?' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.result, '22C');
    assert.ok(body.history.some((h) => h.tool === 'weather'), 'run loop should call weather');
  } finally { await close(); }
});
