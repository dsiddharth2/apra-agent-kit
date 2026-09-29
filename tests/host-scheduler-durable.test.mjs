import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createDurableScheduler } = await import('../host/scheduler/durable.mjs');

const REGISTRY = [
  { name: 'city-briefing', routing: { description: 'briefing', args: { city: 'city name' } } },
];

function mockJobs() {
  const submitted = [];
  return {
    submitted,
    _records: [],
    async submit(task, opts) {
      const id = `job-${submitted.length + 1}`;
      submitted.push({ id, task, metadata: opts?.metadata ?? {} });
      return { jobId: id, status: 'queued', position: 1 };
    },
  };
}

test('registerTimerFunctions registers one timer per schedule', () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const scheduler = createDurableScheduler(
    {
      enabled: true,
      schedules: [
        { name: 'morning', workflow: 'city-briefing', args: { city: 'Tokyo' }, cron: '0 9 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' },
        { name: 'evening', workflow: 'city-briefing', args: { city: 'London' }, cron: '0 18 * * *', timezone: 'Europe/London', overlap: 'skip' },
      ],
    },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, 'schedule-morning');
  assert.equal(registered[0].schedule, '0 0 9 * * *');
  assert.equal(registered[1].name, 'schedule-evening');
  assert.equal(registered[1].schedule, '0 0 18 * * *');
  assert.equal(registered[0].runOnStartup, false);
  assert.equal(registered[0].scheduleMonitor, undefined);
});

test('registerTimerFunctions leaves a 6-field NCRONTAB unchanged', () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const scheduler = createDurableScheduler(
    {
      enabled: true,
      schedules: [
        { name: 'hourly', workflow: 'city-briefing', args: {}, cron: '0 0 * * * *', timezone: 'UTC', overlap: 'queue' },
      ],
    },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  assert.equal(registered[0].schedule, '0 0 * * * *');
});

test('registerTimerFunctions rejects unknown workflow', () => {
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'bad', workflow: 'nonexistent', cron: '* * * * *', timezone: 'UTC' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  assert.throws(() => scheduler.registerTimerFunctions({ timer() {} }), /unknown workflow/);
});

test('timer handler submits job on fire', async () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const jobs = mockJobs();
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: { city: 'Tokyo' }, cron: '0 9 * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  await registered[0].handler({ scheduleStatus: { last: '2026-09-29T09:00:00Z' } }, {});
  assert.equal(jobs.submitted.length, 1);
  assert.equal(jobs.submitted[0].task.workflow, 'city-briefing');
  assert.equal(jobs.submitted[0].metadata.schedule.name, 'test');
});

test('getSchedules returns schedule info', () => {
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  const list = scheduler.getSchedules();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'test');
  assert.ok(list[0].nextRun);
});

test('timer handler skips submit when an active job exists', async () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const jobs = mockJobs();
  jobs._records.push({ id: 'existing', status: 'processing', metadata: { schedule: { name: 'test' } } });
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'UTC', overlap: 'skip' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  await registered[0].handler({ scheduleStatus: { last: '2026-09-29T09:00:00Z' } }, {});
  assert.equal(jobs.submitted.length, 0);
});

test('timer handler skips submit when listByStatus reports an active job', async () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const jobs = {
    submitted: [],
    async listByStatus(status) {
      if (status === 'processing') {
        return [{ id: 'existing', status: 'processing', metadata: { schedule: { name: 'test' } } }];
      }
      return [];
    },
    async submit() {
      jobs.submitted.push({});
      return { jobId: 'should-not-happen', status: 'queued', position: 1 };
    },
  };
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'UTC', overlap: 'skip' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  scheduler.registerTimerFunctions(mockApp);
  await registered[0].handler({ scheduleStatus: { last: '2026-09-29T09:00:00Z' } }, {});
  assert.equal(jobs.submitted.length, 0);
});

test('timer handler resolves when jobs.submit throws and logs the error', async () => {
  const registered = [];
  const mockApp = { timer: (name, opts) => registered.push({ name, ...opts }) };
  const jobs = mockJobs();
  jobs.submit = async () => { throw new Error('queue full'); };
  const warnings = [];
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn(msg) { warnings.push(msg); } } },
  );
  scheduler.registerTimerFunctions(mockApp);
  await assert.doesNotReject(registered[0].handler({ scheduleStatus: { last: '2026-09-29T09:00:00Z' } }, {}));
  assert.equal(jobs.submitted.length, 0);
  assert.ok(warnings.some(msg => String(msg).includes('queue full')));
});

test('start validates schedules', async () => {
  const scheduler = createDurableScheduler(
    { enabled: true, schedules: [{ name: 'bad', workflow: 'nonexistent', cron: '* * * * *', timezone: 'UTC' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await assert.rejects(scheduler.start(), /unknown workflow/);
});
