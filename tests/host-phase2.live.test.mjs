// tests/host-phase2.live.test.mjs
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const { startHost } = await import('../host/index.mjs');

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

test('POST /task executes a simple open-ended weather task', { timeout: 300000 }, async () => {
  const { host, close } = await startHost({
    port: 0,
    runLoop: { enabled: true, strategy: 'open-ended' },
    budgets: { maxIterations: 10, timeoutMs: 120_000 },
    guardrails: { defaultPolicy: 'allow', validateInputs: true },
  });

  try {
    const res = await httpPost(host.port(), '/task', {
      goal: 'What is the current weather in London?',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(['completed', 'budget_exceeded'].includes(body.status));
    assert.ok(body.taskId);
    assert.ok(body.history.length > 0);
  } finally {
    await close();
  }
});

test('POST /task executes a plan-execute task with review', { timeout: 300000 }, async () => {
  const { host, close } = await startHost({
    port: 0,
    runLoop: { enabled: true, strategy: 'plan-execute', maxReplanAttempts: 2 },
    budgets: { maxIterations: 15, timeoutMs: 180_000 },
    guardrails: { defaultPolicy: 'allow', validateInputs: true },
  });

  try {
    const res = await httpPost(host.port(), '/task', {
      goal: 'What time is it in New York and what is the weather?',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(['completed', 'budget_exceeded'].includes(body.status));
    assert.ok(body.history.length >= 2);
  } finally {
    await close();
  }
});
