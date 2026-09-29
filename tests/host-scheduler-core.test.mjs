import { test } from 'node:test';
import assert from 'node:assert/strict';

const { assertSchedulerBackend } = await import('../host/scheduler/interface.mjs');
const { validateSchedules } = await import('../host/scheduler/validate.mjs');
const { shouldRun } = await import('../host/scheduler/overlap.mjs');

// --- interface ---

test('assertSchedulerBackend rejects missing methods', () => {
  assert.throws(() => assertSchedulerBackend({}), /missing/);
});

test('assertSchedulerBackend accepts valid backend', () => {
  const backend = {
    start: async () => {},
    stop: async () => {},
    getSchedules: () => [],
  };
  assert.equal(assertSchedulerBackend(backend), backend);
});

// --- validate ---

const REGISTRY = [
  { name: 'city-briefing', routing: { description: 'briefing', args: { city: 'city name' } } },
  { name: 'weather', routing: null },
];

test('validateSchedules accepts valid schedule', () => {
  assert.doesNotThrow(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY));
});

test('validateSchedules rejects unknown workflow', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'nonexistent', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY), /unknown workflow/);
});

test('validateSchedules rejects workflow without routing', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'weather', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY), /not a routable workflow/);
});

test('validateSchedules rejects invalid cron', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: 'not-a-cron', timezone: 'UTC' },
  ], REGISTRY), /invalid cron/);
});

test('validateSchedules rejects invalid timezone', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'Mars/Olympus' },
  ], REGISTRY), /invalid timezone/);
});

test('validateSchedules rejects duplicate names', () => {
  assert.throws(() => validateSchedules([
    { name: 'dup', workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'UTC' },
    { name: 'dup', workflow: 'city-briefing', cron: '0 10 * * *', timezone: 'UTC' },
  ], REGISTRY), /duplicate schedule name/);
});

test('validateSchedules rejects missing name', () => {
  assert.throws(() => validateSchedules([
    { workflow: 'city-briefing', cron: '0 9 * * *', timezone: 'UTC' },
  ], REGISTRY), /name.*required/i);
});

test('validateSchedules rejects missing cron', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', timezone: 'UTC' },
  ], REGISTRY), /cron.*required/i);
});

test('validateSchedules rejects missing timezone', () => {
  assert.throws(() => validateSchedules([
    { name: 'test', workflow: 'city-briefing', cron: '0 9 * * *' },
  ], REGISTRY), /timezone.*required/i);
});

// --- overlap ---

function mockJobs(records) {
  return {
    async get(id) { return records.find(r => r.id === id) ?? null; },
    _records: records,
  };
}

test('shouldRun returns true for queue policy regardless', async () => {
  const result = await shouldRun('test', 'queue', {
    jobs: mockJobs([{ id: 'j1', status: 'processing', metadata: { schedule: { name: 'test' } } }]),
    logger: { info() {} },
  });
  assert.equal(result, true);
});

test('shouldRun returns true for skip policy when no active jobs', async () => {
  const result = await shouldRun('test', 'skip', {
    jobs: mockJobs([{ id: 'j1', status: 'completed', metadata: { schedule: { name: 'test' } } }]),
    logger: { info() {} },
  });
  assert.equal(result, true);
});

test('shouldRun returns false for skip policy when active job exists', async () => {
  const result = await shouldRun('test', 'skip', {
    jobs: mockJobs([{ id: 'j1', status: 'processing', metadata: { schedule: { name: 'test' } } }]),
    logger: { info() {}, warn() {} },
  });
  assert.equal(result, false);
});

test('shouldRun skip queries listByStatus when the jobs backend has no _records', async () => {
  const logs = [];
  const activeJobs = {
    async listByStatus(status) {
      if (status === 'processing') {
        return [{ id: 'j-active', status: 'processing', metadata: { schedule: { name: 'morning' } } }];
      }
      return [];
    },
  };
  const skipped = await shouldRun('morning', 'skip', {
    jobs: activeJobs,
    logger: { info(msg) { logs.push(msg); } },
  });
  assert.equal(skipped, false);
  assert.equal(logs[0], '[scheduler] skipping "morning": previous run still active (job j-active)');

  const terminalJobs = {
    async listByStatus(status) {
      if (status === 'queued') {
        return [{ id: 'j-done', status: 'completed', metadata: { schedule: { name: 'morning' } } }];
      }
      return [];
    },
  };
  const ran = await shouldRun('morning', 'skip', {
    jobs: terminalJobs,
    logger: { info() {} },
  });
  assert.equal(ran, true);
});
