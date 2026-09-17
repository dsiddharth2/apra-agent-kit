import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../workflows/hello/hello.js';

// A fake context standing in for the Fleet primitives. Workflow bodies take
// their primitives from the context, so testing one needs no Fleet, no
// members, and no token. Write tests like this first when adding a workflow.
function fakeContext({ name } = {}) {
  const calls = { commands: [], prompts: [] };
  const context = {
    log: () => {},
    args: { name },
    async command(cmd, options) {
      calls.commands.push({ cmd, ...options });
      return 'test-machine';
    },
    async agent(prompt, options) {
      calls.prompts.push({ prompt, ...options });
      return `Hello, ${name ?? 'world'}!`;
    },
  };
  return { context, calls };
}

test('hello greets the name it is given', async () => {
  const { context } = fakeContext({ name: 'Ada' });
  const result = await main(context);
  assert.equal(result.who, 'Ada');
  assert.match(result.greeting, /Ada/);
});

test('hello defaults to world', async () => {
  const { context } = fakeContext();
  assert.equal((await main(context)).who, 'world');
});

test('hello addresses roles, not member names', async () => {
  const { context, calls } = fakeContext({ name: 'Ada' });
  await main(context);
  assert.equal(calls.commands[0].member_name, 'doer');
  assert.equal(calls.prompts[0].member_name, 'doer');
});
