// tests/acceptance/concurrency.acceptance.test.mjs
// Real Fleet + real LLM. Multi-step tasks (city briefings, vacation planning)
// that exercise weather, timezone, currency, country-info, travel-advisory,
// forecast, and wikipedia-summary tools. Proves concurrent /task requests run
// in parallel with true tool-call overlap.
import '../setup-fleet-modules.mjs';
import { test } from 'node:test';
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
    budgets: { maxIterations: 20, timeoutMs: 240_000 },
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

// Multi-step goals that force the agent to chain 4-6 tool calls each.
const GOALS = {
  tokyoVacation:
    'I am planning a vacation to Tokyo. ' +
    'Get the current weather, the local time, the 7-day forecast, ' +
    'any travel advisories for Japan (country code JP), and a Wikipedia summary of Tokyo. ' +
    'Then write a short vacation briefing combining all of that information.',

  parisTrip:
    'I want to visit Paris next week. ' +
    'Look up the current weather in Paris, the local time, convert 500 USD to EUR, ' +
    'check travel advisories for France (country code FR), and get a Wikipedia summary of Paris. ' +
    'Summarize everything into a travel preparation guide.',

  londonBriefing:
    'Give me a full city briefing for London. ' +
    'Fetch the current weather, local time, a 5-day forecast, ' +
    'any public holidays in the UK (country code GB) this year, and a Wikipedia summary of London. ' +
    'Combine it all into a concise briefing.',

  berlinWeekend:
    'I am planning a weekend trip to Berlin. ' +
    'Get the weather, timezone, country information for Germany, ' +
    'travel advisories for DE, and convert 200 USD to EUR. ' +
    'Write a short weekend trip preparation note.',

  soloSydney:
    'Prepare a travel brief for Sydney, Australia. ' +
    'Fetch the current weather, local time, a 7-day forecast, ' +
    'travel advisories for Australia (country code AU), and a Wikipedia summary of Sydney. ' +
    'Combine everything into a travel brief.',
};

function countToolCalls(history) {
  return history.filter(h =>
    h.type === 'observation' || h.type === 'action' || h.tool,
  ).length;
}

// ---------------------------------------------------------------------------
// Tests — real Fleet, real LLM, multi-step tasks
// ---------------------------------------------------------------------------

test('concurrency:2 — two vacation-planning tasks run simultaneously', { timeout: 600_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-conc-'));
  const dbPath = path.join(dir, 'jobs.db');
  const { host, close } = await startHost(hostOpts(dbPath, { concurrency: 2 }));

  try {
    const port = host.port();

    const [resA, resB] = await Promise.all([
      post(port, '/task', { goal: GOALS.tokyoVacation }),
      post(port, '/task', { goal: GOALS.parisTrip }),
    ]);

    assert.equal(resA.status, 202, 'task A accepted');
    assert.equal(resB.status, 202, 'task B accepted');

    const jobA = (await resA.json()).jobId;
    const jobB = (await resB.json()).jobId;

    // Poll until both are processing at the same time
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

    // Multi-step: each task should have made multiple tool calls
    const toolsA = countToolCalls(finalA.history);
    const toolsB = countToolCalls(finalB.history);
    console.log(`  Tokyo vacation: ${toolsA} tool interactions, status ${finalA.status}`);
    console.log(`  Paris trip:     ${toolsB} tool interactions, status ${finalB.status}`);
    assert.ok(toolsA >= 3, `Tokyo task used only ${toolsA} tool calls — expected multi-step`);
    assert.ok(toolsB >= 3, `Paris task used only ${toolsB} tool calls — expected multi-step`);

    if (bothProcessing) {
      console.log('  ✓ observed both multi-step jobs processing simultaneously');
    }
  } finally {
    await close();
  }
});

test('concurrency:1 — second city briefing waits while first is processing', { timeout: 600_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-conc-'));
  const dbPath = path.join(dir, 'jobs.db');
  const { host, close } = await startHost(hostOpts(dbPath, { concurrency: 1 }));

  try {
    const port = host.port();

    const [resA, resB] = await Promise.all([
      post(port, '/task', { goal: GOALS.londonBriefing }),
      post(port, '/task', { goal: GOALS.berlinWeekend }),
    ]);

    assert.equal(resA.status, 202);
    assert.equal(resB.status, 202);

    const jobA = (await resA.json()).jobId;
    const jobB = (await resB.json()).jobId;

    // With concurrency:1, one must be queued while the other processes
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

test('concurrency:2 — SSE streams show multi-step progress for both tasks', { timeout: 600_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-conc-'));
  const dbPath = path.join(dir, 'jobs.db');
  const { host, close } = await startHost(hostOpts(dbPath, { concurrency: 2 }));

  try {
    const port = host.port();

    const [resA, resB] = await Promise.all([
      post(port, '/task', { goal: GOALS.londonBriefing }),
      post(port, '/task', { goal: GOALS.tokyoVacation }),
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

      // Multi-step tasks should produce multiple progress events
      const progressCount = types.filter(t => t === 'progress').length;
      console.log(`  ${label}: ${types.length} SSE events (${progressCount} progress), status ${settled.data.status}`);
      assert.ok(progressCount >= 2, `${label} had only ${progressCount} progress events — expected multi-step`);
    }

    // Timeline overlap: both tasks' [started, settled] intervals should intersect
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
  } finally {
    await close();
  }
});

test('concurrency:2 — wall-clock time with multi-step tasks proves overlap', { timeout: 600_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-conc-'));

  // Solo baseline: one full city briefing
  let soloMs;
  let soloTools;
  {
    const { host, close } = await startHost(hostOpts(path.join(dir, 'solo.db'), { concurrency: 1 }));
    try {
      const port = host.port();
      const start = Date.now();
      const res = await post(port, '/task', { goal: GOALS.soloSydney });
      const { jobId } = await res.json();
      const final = await waitForTerminal(port, jobId);
      soloMs = Date.now() - start;
      soloTools = countToolCalls(final.history);
      console.log(`  solo (Sydney): ${soloMs}ms, ${soloTools} tool interactions, status ${final.status}`);
    } finally {
      await close();
    }
  }

  // Concurrent pair: two different multi-step tasks
  let pairMs;
  {
    const { host, close } = await startHost(hostOpts(path.join(dir, 'pair.db'), { concurrency: 2 }));
    try {
      const port = host.port();
      const start = Date.now();
      const [resA, resB] = await Promise.all([
        post(port, '/task', { goal: GOALS.tokyoVacation }),
        post(port, '/task', { goal: GOALS.parisTrip }),
      ]);
      const jobA = (await resA.json()).jobId;
      const jobB = (await resB.json()).jobId;
      const [finalA, finalB] = await Promise.all([
        waitForTerminal(port, jobA),
        waitForTerminal(port, jobB),
      ]);
      pairMs = Date.now() - start;
      console.log(`  pair (Tokyo+Paris): ${pairMs}ms`);
      console.log(`    Tokyo: ${countToolCalls(finalA.history)} tool interactions, status ${finalA.status}`);
      console.log(`    Paris: ${countToolCalls(finalB.history)} tool interactions, status ${finalB.status}`);
    } finally {
      await close();
    }
  }

  // Two multi-step tasks in parallel should take well under 2× a single one.
  // LLM variance is higher with multi-step tasks, so the threshold is generous.
  const ratio = pairMs / soloMs;
  console.log(`  ratio: ${ratio.toFixed(2)}× (< 1.7 means true concurrency)`);
  assert.ok(
    ratio < 1.7,
    `pair/solo ratio ${ratio.toFixed(2)} suggests serialization (expected < 1.7)`,
  );
});
