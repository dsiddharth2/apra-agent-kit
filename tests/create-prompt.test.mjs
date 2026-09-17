// tests/create-prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrompt, confirm, installPromptTitle } from '../create/prompt.mjs';

const FLEET_PROMPT = {
  title: 'apra-fleet is not installed.',
  why:
    'Fleet is the runtime your workflows execute on. Without it, workflows ' +
    'cannot resolve @apralabs/apra-fleet-workflow and will fail on first run. ' +
    'It installs globally, outside this project, because Fleet is a machine ' +
    'install, not a dependency.',
  question: 'Install now?',
};

function recorder() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

test('the prompt states the reason before the question', () => {
  const output = formatPrompt(FLEET_PROMPT);
  assert.ok(
    output.indexOf('Fleet is the runtime') < output.indexOf('Install now?'),
    'the why must precede the question',
  );
  assert.match(output, /outside this project/, 'scope of the change must be stated');
  assert.match(output, /Install now\? \(Y\/n\)/);
});

test('confirm returns true on empty input when the default is yes', async () => {
  const out = recorder();
  const answer = await confirm(FLEET_PROMPT, { ask: async () => '', write: out.write });
  assert.equal(answer, true);
});

test('confirm accepts n, N, and no', async () => {
  for (const reply of ['n', 'N', 'no', 'NO']) {
    const answer = await confirm(FLEET_PROMPT, { ask: async () => reply, write: () => {} });
    assert.equal(answer, false, `${reply} should decline`);
  }
});

test('confirm accepts y, Y, and yes', async () => {
  for (const reply of ['y', 'Y', 'yes', 'YES']) {
    const answer = await confirm(
      { ...FLEET_PROMPT, defaultAnswer: false },
      { ask: async () => reply, write: () => {} },
    );
    assert.equal(answer, true, `${reply} should accept`);
  }
});

test('--yes skips the question but still prints the explanation', async () => {
  const out = recorder();
  let asked = false;
  const answer = await confirm(
    { ...FLEET_PROMPT, yes: true },
    { ask: async () => { asked = true; return 'n'; }, write: out.write },
  );
  assert.equal(answer, true);
  assert.equal(asked, false, 'no question is asked under --yes');
  assert.match(out.lines.join('\n'), /Fleet is the runtime/, 'the reason is still shown');
});

test('an unrecognised reply falls back to the default rather than looping', async () => {
  const answer = await confirm(FLEET_PROMPT, { ask: async () => 'maybe', write: () => {} });
  assert.equal(answer, true);
});

test('installPromptTitle names only what is missing', () => {
  assert.equal(installPromptTitle(['claude']), 'claude is not installed.');
  assert.equal(installPromptTitle(['apra-fleet']), 'apra-fleet is not installed.');
  assert.match(installPromptTitle(['apra-fleet', 'claude']), /apra-fleet/);
  assert.match(installPromptTitle(['apra-fleet', 'claude']), /claude/);
});
