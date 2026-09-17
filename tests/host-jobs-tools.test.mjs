// tests/host-jobs-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { jobTools, withJobTools } = await import('../host/tools/registry.mjs');

const fakeJobs = {
  submit: async (task, opts) => ({ jobId: 'job-9', status: 'queued', position: 1, _task: task, _opts: opts }),
  get: async (id) => (id === 'job-9' ? { id, status: 'completed', result: 42 } : null),
};

test('withJobTools appends the two tools only when jobs is present', () => {
  const base = [{ name: 'weather', tags: [] }];
  assert.equal(withJobTools(base, null).length, 1);
  const out = withJobTools(base, fakeJobs);
  assert.deepEqual(out.map(t => t.name), ['weather', 'submit-task', 'job-status']);
  for (const t of out.slice(1)) { assert.deepEqual(t.tags, ['jobs']); assert.equal(t.reversible, true); assert.ok(t.inputSchema); }
});

test('submit-task validates input and forwards callbackUrl', async () => {
  const tool = jobTools.find(t => t.name === 'submit-task');
  assert.equal(tool.inputSchema.safeParse({}).success, false);
  const out = await tool.run({ args: { goal: 'g', inputs: { a: 1 }, callbackUrl: 'https://cb.test/h' }, jobs: fakeJobs });
  assert.equal(out.jobId, 'job-9');
  assert.deepEqual(out._task, { goal: 'g', inputs: { a: 1 } });
  assert.equal(out._opts.callbackUrl, 'https://cb.test/h');
});

test('job-status returns the record or a not_found value', async () => {
  const tool = jobTools.find(t => t.name === 'job-status');
  assert.equal((await tool.run({ args: { jobId: 'job-9' }, jobs: fakeJobs })).result, 42);
  assert.deepEqual(await tool.run({ args: { jobId: 'zzz' }, jobs: fakeJobs }), { ok: false, error: 'not_found', jobId: 'zzz' });
});
