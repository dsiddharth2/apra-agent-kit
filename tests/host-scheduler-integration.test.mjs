import { test } from 'node:test';
import assert from 'node:assert/strict';

const { executeHostedTask } = await import('../host/tasks.mjs');
const { executeWorkflow } = await import('../host/router.mjs');

test('executeHostedTask with strategy=workflow bypasses router', async () => {
  let routerCalled = false;
  let workflowCalled = false;
  const task = {
    id: 'test-1',
    goal: 'Scheduled workflow: city-briefing',
    strategy: 'workflow',
    workflow: 'city-briefing',
    inputs: { city: 'Tokyo' },
  };

  const mockDispatcher = {
    dispatch: async () => ({
      workerId: 'w1', doer: 'doer', reviewer: null,
      signal: new AbortController().signal,
      release: async () => {},
    }),
  };

  const toolRegistry = [
    {
      name: 'city-briefing',
      routing: { description: 'briefing', args: { city: 'city name' } },
      async run() { workflowCalled = true; return 'done'; },
    },
  ];

  const result = await executeHostedTask(task, {
    api: {},
    activeDispatcher: mockDispatcher,
    toolRegistry,
    runLoopConfig: { strategy: 'open-ended' },
    routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
    budgetsConfig: null,
    guardrailsMod: null,
    jobs: null,
    signal: null,
    onProgress: null,
    memory: null,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.routedTo, 'workflow:city-briefing');
});
