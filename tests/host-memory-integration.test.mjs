// tests/host-memory-integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';
import { buildSystemPrompt } from '../host/prompts/system.mjs';

const { createOpenEndedStrategy } = await import('../host/strategies/open-ended.mjs');
const { createPlanExecuteStrategy } = await import('../host/strategies/plan-execute.mjs');
const { runTask } = await import('../host/run-loop.mjs');
const { executeHostedTask } = await import('../host/tasks.mjs');
const { startHost, createHost } = await import('../host/index.mjs');
const { createMemoryModule } = await import('../host/memory/index.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15', city: 'London' }) },
  ];
}

function doneFleet(extra = []) {
  return createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      ...extra,
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-int-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

function httpCall(port, method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('system prompt includes memory section when memories provided', () => {
  const prompt = buildSystemPrompt({
    agentName: 'test-agent',
    agentDescription: '',
    memories: [
      { kind: 'rule', text: 'Never delete without backup' },
      { kind: 'domain', text: 'DB on port 5432' },
    ],
  });
  assert.ok(prompt.includes('## Your Memory'));
  assert.ok(prompt.includes('Never delete without backup'));
  assert.ok(prompt.includes('DB on port 5432'));
  assert.ok(prompt.includes('recall'));
  assert.ok(prompt.includes('Rules (always follow these):'));
  assert.ok(prompt.includes('Relevant knowledge:'));
  assert.ok(prompt.indexOf('Never delete without backup') < prompt.indexOf('DB on port 5432'));
  assert.ok(prompt.includes('## Response format'));
  assert.ok(prompt.includes('```tool_call'));
});

test('system prompt omits memory section when no memories', () => {
  const prompt = buildSystemPrompt({ agentName: 'test-agent', agentDescription: '' });
  assert.ok(!prompt.includes('## Your Memory'));
  const bare = buildSystemPrompt({ agentName: 'test-agent', agentDescription: '', memories: [] });
  assert.equal(bare, prompt);
  assert.ok(prompt.includes('## Response format'));
  assert.ok(prompt.includes('One tool call per turn'));
});

test('open-ended strategy feeds working context into the next prompt', async () => {
  const appended = [];
  const api = doneFleet();
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    memory: {
      workingContext: {
        append(observation) { appended.push(observation); },
        async forPrompt() {
          return appended.map(obs => ({ ...obs, via: 'working-context' }));
        },
      },
    },
    memories: [{ kind: 'rule', text: 'Never delete without backup' }],
  });
  const events = [];
  for await (const event of strategy.iterate()) events.push(event);
  assert.ok(events.some(e => e.type === 'done'));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].tool, 'weather');
  const second = api.promptCalls[1].prompt;
  assert.ok(second.includes('working-context'));
  assert.ok(api.promptCalls[0].prompt.includes('## Your Memory'));
  assert.ok(api.promptCalls[0].prompt.includes('Never delete without backup'));
});

test('open-ended strategy continues when working context fails', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const api = doneFleet();
    const strategy = createOpenEndedStrategy({
      task: { id: 't-1', goal: 'Weather in London' },
      tools: makeTools(),
      fleetApi: api,
      memory: {
        workingContext: {
          append() { throw new Error('append boom'); },
          async forPrompt() { throw new Error('prompt boom'); },
        },
      },
    });
    const events = [];
    for await (const event of strategy.iterate()) events.push(event);
    assert.ok(events.some(e => e.type === 'done'));
    assert.ok(warnings.some(w => /prompt boom/.test(w)));
    assert.ok(api.promptCalls[1].prompt.includes('weather'));
  } finally {
    console.warn = orig;
  }
});

test('plan-execute checkpoints after each step and skips idempotent steps on resume', async () => {
  const plan = '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}\n```';
  const review = '```review\n{"approved": true}\n```';
  const done = '```done\n{"result": "15°C", "summary": "ok"}\n```';
  let calls = 0;
  const tools = [{
    name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
    run: async () => { calls += 1; return { temp_c: '15' }; },
  }];
  const key = `weather-${JSON.stringify({ city: 'London' })}-0`;
  let snapshot = null;
  const runState = {
    async save(_id, snap) { snapshot = snap; },
    async load() { return snapshot; },
    async hasIdempotencyKey(_id, k) { return (snapshot?.idempotencyKeys ?? []).includes(k); },
    async addIdempotencyKey(_id, k) {
      if (!snapshot) return;
      const keys = snapshot.idempotencyKeys ?? [];
      if (!keys.includes(k)) snapshot = { ...snapshot, idempotencyKeys: [...keys, k] };
    },
  };
  const first = createPlanExecuteStrategy({
    task: { id: 'task-9', goal: 'Weather in London' },
    tools,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, review, done] }),
    memory: { runState, workingContext: { append() {}, async forPrompt() { return []; } } },
  });
  for await (const _event of first.iterate()) { /* drain */ }
  assert.equal(calls, 1);
  assert.equal(snapshot.strategy, 'plan-execute');
  assert.equal(snapshot.stepIndex, 0);
  assert.ok(snapshot.plan.steps.length === 1);
  assert.ok(snapshot.observations.length >= 1);
  assert.ok(snapshot.idempotencyKeys.includes(key));

  calls = 0;
  const resumed = createPlanExecuteStrategy({
    task: { id: 'task-9', goal: 'Weather in London' },
    tools,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [done] }),
    memory: { runState },
  });
  const events = [];
  for await (const event of resumed.iterate()) events.push(event);
  assert.equal(calls, 0);
  assert.ok(events.some(e => e.type === 'done'));
  assert.ok(!events.some(e => e.type === 'plan'));
});

test('plan-execute continues when run state save throws', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const api = createMockFleetApi({
      members: rosterNames(1),
      promptResponses: [
        '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "x", "review": false}]}\n```',
        '```review\n{"approved": true}\n```',
        '```done\n{"result": "ok", "summary": "ok"}\n```',
      ],
    });
    const strategy = createPlanExecuteStrategy({
      task: { id: 't-1', goal: 'Weather' },
      tools: makeTools(),
      fleetApi: api,
      memory: {
        runState: {
          async load() { return null; },
          async hasIdempotencyKey() { return false; },
          async save() { throw new Error('save boom'); },
          async addIdempotencyKey() { throw new Error('key boom'); },
        },
      },
    });
    const events = [];
    for await (const event of strategy.iterate()) events.push(event);
    assert.ok(events.some(e => e.type === 'done'));
    assert.ok(warnings.some(w => /save boom/.test(w)));
  } finally {
    console.warn = orig;
  }
});

test('runTask passes memory and memories through to the strategy', async () => {
  const api = doneFleet();
  const appended = [];
  const result = await runTask(
    { id: 't-1', goal: 'Weather in London' },
    {
      strategy: 'open-ended',
      tools: makeTools(),
      fleetApi: api,
      memories: [{ kind: 'domain', text: 'DB on port 5432' }],
      memory: {
        createRunWorkingContext() {
          return {
            append(obs) { appended.push(obs); },
            async forPrompt() { return appended; },
          };
        },
      },
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(appended.length, 1);
  assert.ok(api.promptCalls[0].prompt.includes('DB on port 5432'));
  assert.ok(api.promptCalls[0].prompt.includes('## Your Memory'));
});

test('sequential runs do not leak working-context observations', async () => {
  const mod = await createMemoryModule({
    workingContext: { enabled: true, maxTurns: 20 },
  }, { fleetApi: {}, logger: console });
  const contexts = [];
  const create = mod.createRunWorkingContext.bind(mod);
  mod.createRunWorkingContext = () => {
    const ctx = create();
    contexts.push(ctx);
    return ctx;
  };

  const run = (city) => runTask(
    { id: `t-${city}`, goal: `Weather in ${city}` },
    {
      strategy: 'open-ended',
      tools: makeTools(),
      fleetApi: createMockFleetApi({
        members: rosterNames(1),
        promptResponses: [
          `\`\`\`tool_call\n{"tool": "weather", "args": {"city": "${city}"}}\n\`\`\``,
          '```done\n{"result": "ok", "summary": "ok"}\n```',
        ],
      }),
      memory: mod,
    },
  );

  const first = await run('London');
  const second = await run('Paris');
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(contexts.length, 2);

  const promptB = await contexts[1].forPrompt();
  assert.equal(promptB.length, 1);
  assert.equal(promptB[0].args.city, 'Paris');
  assert.ok(!promptB.some(obs => obs.args?.city === 'London'));
  assert.equal((await contexts[0].forPrompt())[0].args.city, 'London');
  assert.equal(mod.workingContext.history().length, 0);
});

test('plan-execute resume replays checkpoint observations into that run only', async () => {
  const mod = await createMemoryModule({
    workingContext: { enabled: true, maxTurns: 20 },
  }, { fleetApi: {}, logger: console });
  const prior = { type: 'observation', tool: 'archive', args: { id: 'prior-only' }, result: { ok: true } };
  mod.runState = {
    async load() {
      return {
        stepIndex: 1,
        plan: { steps: [{ type: 'tool', tool: 'weather', args: { city: 'London' }, review: false }] },
        observations: [prior],
        idempotencyKeys: [],
        strategy: 'plan-execute',
      };
    },
    async hasIdempotencyKey() { return false; },
    async save() {},
    async addIdempotencyKey() {},
  };
  const contexts = [];
  const create = mod.createRunWorkingContext.bind(mod);
  mod.createRunWorkingContext = () => {
    const ctx = create();
    contexts.push(ctx);
    return ctx;
  };
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```done\n{"result": "ok", "summary": "ok"}\n```'],
  });
  const result = await runTask(
    { id: 'resume-1', goal: 'Weather' },
    { strategy: 'plan-execute', tools: makeTools(), fleetApi: api, memory: mod },
  );
  assert.equal(result.status, 'completed');
  const replayed = await contexts[0].forPrompt();
  assert.ok(replayed.some(obs => obs.tool === 'archive' && obs.args?.id === 'prior-only'));
  assert.equal(mod.workingContext.history().length, 0);
});

test('executeHostedTask recalls before the run and learns after', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const seen = { tags: null, learned: null, cleared: null };
  try {
    const out = await executeHostedTask({ id: 'task-15', goal: 'Inspect the weather in London' }, {
      api,
      activeDispatcher: dispatcher,
      toolRegistry: [{ name: 'inspect-members', description: 'Inspect', reversible: true, timeout: 5000, run: async () => ({ ok: true }) }],
      runLoopConfig: { strategy: 'open-ended', agentName: 'test-agent', agentDescription: '' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: {
        longTerm: {
          async recall({ tags }) {
            seen.tags = tags;
            return [
              { kind: 'rule', text: 'Never delete without backup' },
              { kind: 'domain', text: 'DB on port 5432' },
            ];
          },
        },
        learner: {
          async extract(args) { seen.learned = args; return { newFacts: [], promotedIds: [] }; },
        },
        runState: {
          async clear(id) { seen.cleared = id; },
        },
        workingContext: {
          append() {},
          async forPrompt() { return []; },
        },
      },
    });
    assert.equal(out.status, 'completed');
    assert.deepEqual(seen.tags, ['inspect', 'weather', 'london']);
    assert.ok(api.promptCalls[0].prompt.includes('## Your Memory'));
    assert.ok(api.promptCalls[0].prompt.includes('Never delete without backup'));
    assert.equal(seen.learned.task.id, 'task-15');
    assert.ok(seen.learned.history.some(h => h.tool === 'inspect-members' || h.type === 'observation'));
    assert.equal(seen.learned.recalledFacts.length, 2);
    assert.equal(seen.cleared, 'task-15');
  } finally {
    await dispatcher.close();
  }
});

test('executeHostedTask continues when recall, learn, and clear fail', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  try {
    const out = await executeHostedTask({ goal: 'Inspect weather' }, {
      api,
      activeDispatcher: dispatcher,
      toolRegistry: [],
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: {
        longTerm: { async recall() { throw new Error('recall boom'); } },
        learner: { async extract() { throw new Error('learn boom'); } },
        runState: { async clear() { throw new Error('clear boom'); } },
      },
    });
    assert.equal(out.status, 'completed');
    assert.ok(!api.promptCalls[0].prompt.includes('## Your Memory'));
    assert.ok(warnings.some(w => /recall boom/.test(w)));
    assert.ok(warnings.some(w => /learn boom/.test(w)));
    assert.ok(warnings.some(w => /clear boom/.test(w)));
  } finally {
    console.warn = orig;
    await dispatcher.close();
  }
});

test('startHost runSync threads memory into the task prompt', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-wire-'));
  const memDir = path.join(dir, 'memory');
  await fs.writeFile(path.join(dir, 'host.config.mjs'), `export default {
    name: 'mem-wire',
    fleet: {},
    comm: { adapter: 'express', host: '127.0.0.1' },
    modules: {
      runLoop: { enabled: true, strategy: 'open-ended' },
      router: { enabled: false },
      guardrails: { enabled: false },
      budgets: { enabled: false },
      dispatch: { enabled: false },
      chat: { enabled: false },
      memory: { longTerm: { enabled: true, store: 'filesystem', dir: ${JSON.stringify(memDir)}, decay: { mode: 'none' } } },
    },
  };`);
  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const started = await startHost({ fleetApi, dispatcher, port: 0, configDir: dir });
  try {
    await started.memory.longTerm.store({ kind: 'rule', text: 'Never delete without backup', tags: ['safety'], source: 'human' });
    const res = await httpCall(started.host.port(), 'POST', '/task?wait=true', {
      goal: 'Inspect the weather in London',
      strategy: 'open-ended',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'completed');
    assert.ok(fleetApi.promptCalls.some(c => c.prompt.includes('## Your Memory')));
    assert.ok(fleetApi.promptCalls.some(c => c.prompt.includes('Never delete without backup')));
  } finally {
    await started.close();
  }
});

test('createHost().run() threads a supplied memory module', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  let recalled = false;
  const agent = createHost({
    fleetApi: api,
    dispatcher,
    env: { ...process.env, NODE_ENV: 'test' },
    runLoop: { enabled: true, strategy: 'open-ended' },
    memory: {
      longTerm: {
        async recall() {
          recalled = true;
          return [{ kind: 'rule', text: 'Never delete without backup' }];
        },
      },
    },
  }).build();
  try {
    const out = await agent.run({ id: 'run-1', goal: 'Inspect weather today', strategy: 'open-ended' });
    assert.equal(out.status, 'completed');
    assert.equal(recalled, true);
    assert.ok(api.promptCalls[0].prompt.includes('Never delete without backup'));
  } finally {
    await dispatcher.close();
  }
});
