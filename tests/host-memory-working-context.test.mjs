import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkingContext } from '../host/memory/working-context.mjs';

test('returns all observations when under maxTurns', async () => {
  const ctx = createWorkingContext({ maxTurns: 10 });
  for (let i = 0; i < 5; i++) ctx.append({ type: 'observation', text: `Step ${i}` });
  const result = await ctx.forPrompt();
  assert.equal(result.length, 5);
});

test('sliding-window drops oldest when over maxTurns', async () => {
  const ctx = createWorkingContext({ maxTurns: 5, compactionStrategy: 'sliding-window', keepRecent: 3 });
  for (let i = 0; i < 10; i++) ctx.append({ type: 'observation', text: `Step ${i}` });
  const result = await ctx.forPrompt();
  assert.equal(result.length, 3);
  assert.equal(result[0].text, 'Step 7');
});

test('summarise compacts older entries', async () => {
  const fakeApi = { executePrompt: async () => 'Summary of older steps.' };
  const ctx = createWorkingContext({ fleetApi: fakeApi, maxTurns: 5, keepRecent: 3 });
  for (let i = 0; i < 10; i++) ctx.append({ type: 'observation', text: `Step ${i}` });
  const result = await ctx.forPrompt();
  assert.equal(result[0].type, 'summary');
  assert.equal(result[0].text, 'Summary of older steps.');
  assert.equal(result.length, 4);
});

test('fallback to sliding-window when summarise fails', async () => {
  const fakeApi = { executePrompt: async () => { throw new Error('LLM down'); } };
  const ctx = createWorkingContext({ fleetApi: fakeApi, maxTurns: 5, keepRecent: 3, logger: { warn() {} } });
  for (let i = 0; i < 10; i++) ctx.append({ type: 'observation', text: `Step ${i}` });
  const result = await ctx.forPrompt();
  assert.equal(result.length, 3);
  assert.equal(result[0].text, 'Step 7');
});

test('history() returns full raw history', async () => {
  const ctx = createWorkingContext({ maxTurns: 3, compactionStrategy: 'sliding-window', keepRecent: 2 });
  for (let i = 0; i < 5; i++) ctx.append({ type: 'observation', text: `Step ${i}` });
  assert.equal(ctx.history().length, 5);
});
