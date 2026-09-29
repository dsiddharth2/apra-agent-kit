import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessScheduler } = await import('../host/scheduler/in-process.mjs');

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
      const record = { id, status: 'queued', task, metadata: opts?.metadata ?? {} };
      submitted.push(record);
      this._records.push(record);
      return { jobId: id, status: 'queued', position: 1 };
    },
  };
}

test('start validates schedules', async () => {
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'bad', workflow: 'nonexistent', cron: '* * * * *', timezone: 'UTC' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await assert.rejects(scheduler.start(), /unknown workflow/);
});

test('tick submits a job with correct shape', async () => {
  const jobs = mockJobs();
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: { city: 'Tokyo' }, cron: '* * * * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  try {
    await sleep(1500);
    assert.ok(jobs.submitted.length >= 1, `expected at least 1 submission, got ${jobs.submitted.length}`);
    const task = jobs.submitted[0].task;
    assert.equal(task.workflow, 'city-briefing');
    assert.deepEqual(task.inputs, { city: 'Tokyo' });
    assert.equal(task.strategy, 'workflow');
    assert.ok(task.goal.includes('city-briefing'));
    const meta = jobs.submitted[0].metadata;
    assert.equal(meta.schedule.name, 'test');
    assert.ok(meta.schedule.tick);
  } finally {
    await scheduler.stop();
  }
});

test('overlap skip prevents submission when active job exists', async () => {
  const jobs = mockJobs();
  jobs._records.push({ id: 'existing', status: 'processing', metadata: { schedule: { name: 'test' } } });
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '* * * * * *', timezone: 'UTC', overlap: 'skip' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  try {
    await sleep(1500);
    assert.equal(jobs.submitted.length, 0, 'should not have submitted');
  } finally {
    await scheduler.stop();
  }
});

test('getSchedules returns schedule info with nextRun', async () => {
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '0 9 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' }] },
    { jobs: mockJobs(), toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  try {
    const schedules = scheduler.getSchedules();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].name, 'test');
    assert.equal(schedules[0].workflow, 'city-briefing');
    assert.ok(schedules[0].nextRun instanceof Date || typeof schedules[0].nextRun === 'string');
  } finally {
    await scheduler.stop();
  }
});

test('stop clears all timers', async () => {
  const jobs = mockJobs();
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '* * * * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn() {} } },
  );
  await scheduler.start();
  await scheduler.stop();
  const countBefore = jobs.submitted.length;
  await sleep(1500);
  assert.equal(jobs.submitted.length, countBefore, 'no new submissions after stop');
});

test('submit error does not crash scheduler', async () => {
  const jobs = mockJobs();
  jobs.submit = async () => { throw new Error('queue full'); };
  const logged = [];
  const scheduler = createInProcessScheduler(
    { enabled: true, schedules: [{ name: 'test', workflow: 'city-briefing', args: {}, cron: '* * * * * *', timezone: 'UTC', overlap: 'queue' }] },
    { jobs, toolRegistry: REGISTRY, logger: { info() {}, warn(msg) { logged.push(msg); } } },
  );
  await scheduler.start();
  try {
    await sleep(1500);
    assert.ok(logged.some(m => m.includes('queue full')), 'should have logged the error');
  } finally {
    await scheduler.stop();
  }
});
