// tests/host-mock-fleet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

test('default executePrompt returns pong', async () => {
  const api = createMockFleetApi({ members: ['DOER', 'REVIEWER'] });
  const result = await api.executePrompt({ member_name: 'DOER', prompt: 'hello' });
  assert.equal(result.content[0].text, 'pong');
});

test('custom promptResponses returns scripted responses in order', async () => {
  const api = createMockFleetApi({
    members: ['DOER', 'REVIEWER'],
    promptResponses: [
      'first response',
      'second response',
      'third response',
    ],
  });
  const r1 = await api.executePrompt({ member_name: 'DOER', prompt: 'q1' });
  assert.equal(r1.content[0].text, 'first response');
  const r2 = await api.executePrompt({ member_name: 'DOER', prompt: 'q2' });
  assert.equal(r2.content[0].text, 'second response');
  const r3 = await api.executePrompt({ member_name: 'DOER', prompt: 'q3' });
  assert.equal(r3.content[0].text, 'third response');
});

test('promptResponses cycles after exhaustion', async () => {
  const api = createMockFleetApi({
    members: ['DOER'],
    promptResponses: ['only-one'],
  });
  const r1 = await api.executePrompt({ member_name: 'DOER', prompt: 'q1' });
  assert.equal(r1.content[0].text, 'only-one');
  const r2 = await api.executePrompt({ member_name: 'DOER', prompt: 'q2' });
  assert.equal(r2.content[0].text, 'only-one');
});

test('function promptResponses receives options', async () => {
  const api = createMockFleetApi({
    members: ['DOER'],
    promptResponses: (options) => `echo: ${options.prompt}`,
  });
  const r = await api.executePrompt({ member_name: 'DOER', prompt: 'hello' });
  assert.equal(r.content[0].text, 'echo: hello');
});

test('promptCalls records all prompt calls', async () => {
  const api = createMockFleetApi({
    members: ['DOER'],
    promptResponses: ['r1'],
  });
  await api.executePrompt({ member_name: 'DOER', prompt: 'p1' });
  await api.executePrompt({ member_name: 'DOER', prompt: 'p2' });
  assert.equal(api.promptCalls.length, 2);
  assert.equal(api.promptCalls[0].prompt, 'p1');
  assert.equal(api.promptCalls[1].prompt, 'p2');
});
