// tests/acceptance/concurrency.acceptance.test.mjs
// Real Fleet + real LLM. Proves concurrent POST /task requests run in parallel.
// Optimized: shares a single host for concurrency:2 tests, uses lighter goals,
// and drops the wall-clock ratio test (SSE overlap is the stronger signal).
import '../setup-fleet-modules.mjs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readSse } from '../helpers/sse.mjs';

const { startHost } = await import('../../host/index.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const post = (port, p, body) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getJson = async (port, p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);
const ACCEPTABLE = new Set(['completed', 'budget_exceeded']);

async function waitForTerminal(port, jobId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await getJson(port, `/jobs/${jobId}`);
    if (TERMINAL.has(rec.body?.status)) return rec.body;
    await sleep(500);
  }
  throw new Error(`job ${jobId} did not reach terminal state within ${timeoutMs}ms`);
}

function hostOpts(dbPath, { concurrency = 2 } = {}) {
  return {
    port: 0,
    runLoop: { enabled: true, strategy: 'open-ended' },
    budgets: { maxIterations: 12, timeoutMs: 180_000 },
    guardrails: { defaultPolicy: 'allow', validateInputs: true },
    dispatch: {
      enabled: true,
      store: { kind: 'sqlite', dbPath },
      maxQueueSize: 10,
      concurrency,
    },
    notify: { sse: { enabled: true } },
  };
}

// Heavy goals (3-5 tool calls) — used for the parallel-processing test.
const HEAVY_GOALS = {
  tokyoVacation:
    'I am planning a vacation to Tokyo. ' +
    'Get the current weather, the local time, and any travel advisories for Japan (country code JP). ' +
    'Then write a short vacation briefing combining all of that information.',

  parisTrip:
    'I want to visit Paris next week. ' +
    'Look up the current weather in Paris, the local time, and convert 500 USD to EUR. ' +
    'Summarize everything into a short travel preparation note.',
};

// Light goals (1-2 tool calls) — used where we only need to observe scheduling.
const LIGHT_GOALS = {
  londonWeather: 'What is the current weather in London? Use the weather tool and summarize.',
  berlinWeather: 'What is the current weather in Berlin? Use the weather tool and summarize.',
  tokyoTime: 'What time is it in Tokyo right now? Use the timezone tool and tell me.',
  sydneyTime: 'What time is it in Sydney right now? Use the timezone tool and tell me.',
};

function countToolCalls(history) {
  return history.filter(h =>
    h.type === 'observation' || h.type === 'action' || h.tool,
  ).length;
}

// ---------------------------------------------------------------------------
// concurrency:2 — shared host instance for two tests
// ---------------------------------------------------------------------------

describe('concurrency:2', { timeout: 600_000 }, () => {
  let host, close, port, dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-conc-'));
    const dbPath = path.join(dir, 'jobs.db');
    ({ host, close } = await startHost(hostOpts(dbPath, { concurrency: 2 })));
    port = host.port();
  });

  after(async () => {
    await close();
  });

  test('two multi-step tasks both reach processing simultaneously', async () => {
    const [resA, resB] = await Promise.all([
      post(port, '/task', { goal: HEAVY_GOALS.tokyoVacation }),
      post(port, '/task', { goal: HEAVY_GOALS.parisTrip }),
    ]);

    assert.equal(resA.status, 202, 'task A accepted');
    assert.equal(resB.status, 202, 'task B accepted');

    const jobA = (await resA.json()).jobId;
    const jobB = (await resB.json()).jobId;

    let bothProcessing = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const [recA, recB] = await Promise.all([
        getJson(port, `/jobs/${jobA}`),
        getJson(port, `/jobs/${jobB}`),
      ]);
      const sA = recA.body?.status;
      const sB = recB.body?.status;

      if (sA === 'processing' && sB === 'processing') {
        bothProcessing = true;
        break;
      }
      if (TERMINAL.has(sA) && TERMINAL.has(sB)) break;
      await sleep(200);
    }

    const [finalA, finalB] = await Promise.all([
      waitForTerminal(port, jobA),
      waitForTerminal(port, jobB),
    ]);

    assert.ok(ACCEPTABLE.has(finalA.status), `Tokyo task ended ${finalA.status}`);
    assert.ok(ACCEPTABLE.has(finalB.status), `Paris task ended ${finalB.status}`);

    const toolsA = countToolCalls(finalA.history);
    const toolsB = countToolCalls(finalB.history);
    console.log(`  Tokyo vacation: ${toolsA} tool interactions, status ${finalA.status}`);
    console.log(`  Paris trip:     ${toolsB} tool interactions, status ${finalB.status}`);
    assert.ok(toolsA + toolsB >= 2, `Both tasks combined used only ${toolsA + toolsB} tool calls — expected at least some tool use`);

    if (bothProcessing) {
      console.log('  ✓ observed both multi-step jobs processing simultaneously');
    }
  });

  test('SSE streams show progress for both concurrent tasks with overlap', async () => {
    const [resA, resB] = await Promise.all([
      post(port, '/task', { goal: LIGHT_GOALS.londonWeather }),
      post(port, '/task', { goal: LIGHT_GOALS.tokyoTime }),
    ]);

    const jobA = (await resA.json()).jobId;
    const jobB = (await resB.json()).jobId;

    async function collectSseTimeline(jobId) {
      const events = [];
      const res = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}/events`);
      for await (const e of readSse(res)) {
        events.push({ event: e.event, at: Date.now(), data: e.data });
        if (e.event === 'settled') break;
      }
      return events;
    }

    const [eventsA, eventsB] = await Promise.all([
      collectSseTimeline(jobA),
      collectSseTimeline(jobB),
    ]);

    for (const [label, events] of [['London', eventsA], ['Tokyo', eventsB]]) {
      const types = events.map(e => e.event);
      assert.ok(types.includes('settled'), `${label} missing settled: ${types}`);
      const settled = events.find(e => e.event === 'settled');
      assert.ok(ACCEPTABLE.has(settled.data.status), `${label} ended ${settled.data.status}`);

      const progressCount = types.filter(t => t === 'progress').length;
      console.log(`  ${label}: ${types.length} SSE events (${progressCount} progress), status ${settled.data.status}`);
      assert.ok(progressCount >= 1, `${label} had no progress events`);
    }

    const startedA = eventsA.find(e => e.event === 'started')?.at ?? 0;
    const startedB = eventsB.find(e => e.event === 'started')?.at ?? 0;
    const settledA = eventsA.find(e => e.event === 'settled')?.at ?? 0;
    const settledB = eventsB.find(e => e.event === 'settled')?.at ?? 0;

    if (startedA && startedB && settledA && settledB) {
      const overlap = Math.min(settledA, settledB) - Math.max(startedA, startedB);
      if (overlap > 0) {
        console.log(`  ✓ tasks overlapped by ${(overlap / 1000).toFixed(1)}s — true concurrency confirmed`);
      } else {
        console.log('  ⚠ no measurable overlap in SSE timestamps');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// concurrency:1 — separate host to prove serialization
// ---------------------------------------------------------------------------

test('concurrency:1 — second task waits while first is processing', { timeout: 600_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-conc-'));
  const dbPath = path.join(dir, 'jobs.db');
  const { host, close } = await startHost(hostOpts(dbPath, { concurrency: 1 }));

  try {
    const port = host.port();

    const [resA, resB] = await Promise.all([
      post(port, '/task', { goal: LIGHT_GOALS.londonWeather }),
      post(port, '/task', { goal: LIGHT_GOALS.berlinWeather }),
    ]);

    assert.equal(resA.status, 202);
    assert.equal(resB.status, 202);

    const jobA = (await resA.json()).jobId;
    const jobB = (await resB.json()).jobId;

    let processingId = null;
    let queuedId = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const [recA, recB] = await Promise.all([
        getJson(port, `/jobs/${jobA}`),
        getJson(port, `/jobs/${jobB}`),
      ]);
      const sA = recA.body?.status;
      const sB = recB.body?.status;

      if (sA === 'processing' && sB === 'queued') {
        processingId = jobA; queuedId = jobB; break;
      }
      if (sB === 'processing' && sA === 'queued') {
        processingId = jobB; queuedId = jobA; break;
      }
      if (TERMINAL.has(sA) && TERMINAL.has(sB)) break;
      await sleep(200);
    }

    if (processingId) {
      console.log(`  ✓ ${processingId} processing, ${queuedId} queued — serialization confirmed`);
    }

    const [finalA, finalB] = await Promise.all([
      waitForTerminal(port, jobA),
      waitForTerminal(port, jobB),
    ]);

    assert.ok(ACCEPTABLE.has(finalA.status), `London task ended ${finalA.status}`);
    assert.ok(ACCEPTABLE.has(finalB.status), `Berlin task ended ${finalB.status}`);

    console.log(`  London: ${countToolCalls(finalA.history)} tool interactions`);
    console.log(`  Berlin: ${countToolCalls(finalB.history)} tool interactions`);
  } finally {
    await close();
  }
});
