import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveSchedulerConfig } = await import('../host/scheduler/config.mjs');

const VALID_SCHEDULE = {
  name: 'test-schedule',
  workflow: 'city-briefing',
  args: { city: 'Tokyo' },
  cron: '0 9 * * *',
  timezone: 'UTC',
  overlap: 'queue',
};

test('resolveSchedulerConfig returns defaults when raw is empty', () => {
  const config = resolveSchedulerConfig({}, { env: {}, dispatchConfig: { backend: 'in-process' } });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.schedules, []);
  assert.equal(config.backend, 'in-process');
});

test('resolveSchedulerConfig merges raw config', () => {
  const config = resolveSchedulerConfig(
    { enabled: true, schedules: [VALID_SCHEDULE] },
    { env: {}, dispatchConfig: { backend: 'in-process' } },
  );
  assert.equal(config.enabled, true);
  assert.equal(config.schedules.length, 1);
  assert.equal(config.schedules[0].name, 'test-schedule');
});

test('SCHEDULER_ENABLED env override', () => {
  const config = resolveSchedulerConfig(
    { enabled: false },
    { env: { SCHEDULER_ENABLED: 'true' }, dispatchConfig: { backend: 'in-process' } },
  );
  assert.equal(config.enabled, true);
});

test('backend follows JOBS_BACKEND', () => {
  const config = resolveSchedulerConfig(
    { enabled: true },
    { env: { JOBS_BACKEND: 'durable' }, dispatchConfig: { backend: 'durable' } },
  );
  assert.equal(config.backend, 'durable');
});

test('overlap defaults to queue', () => {
  const schedule = { ...VALID_SCHEDULE };
  delete schedule.overlap;
  const config = resolveSchedulerConfig(
    { enabled: true, schedules: [schedule] },
    { env: {}, dispatchConfig: { backend: 'in-process' } },
  );
  assert.equal(config.schedules[0].overlap, 'queue');
});

test('args defaults to empty object', () => {
  const schedule = { ...VALID_SCHEDULE };
  delete schedule.args;
  const config = resolveSchedulerConfig(
    { enabled: true, schedules: [schedule] },
    { env: {}, dispatchConfig: { backend: 'in-process' } },
  );
  assert.deepEqual(config.schedules[0].args, {});
});

const { loadConfig } = await import('../host/config.mjs');
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function configInTmpDir(config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-test-'));
  await fs.writeFile(
    path.join(dir, 'host.config.mjs'),
    `export default ${JSON.stringify(config)};`,
  );
  return dir;
}

const BASE_CONFIG = {
  name: 'test', fleet: {}, comm: { adapter: 'express' },
  modules: {
    runLoop: { enabled: true, strategy: 'open-ended' },
    dispatch: { enabled: true, store: { kind: 'memory' } },
    notify: { sse: { enabled: true } },
    chat: { enabled: false, title: 'test' },
  },
};

test('loadConfig rejects scheduler without dispatch', async () => {
  const dir = await configInTmpDir({
    ...BASE_CONFIG,
    modules: { ...BASE_CONFIG.modules, dispatch: { enabled: false }, scheduler: { enabled: true, schedules: [] } },
  });
  await assert.rejects(loadConfig(dir, { NODE_ENV: 'test' }), /scheduler enabled but dispatch disabled/);
});
