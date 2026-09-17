import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolsDir, shellEscape, parseToolOutput } from '../mcp/registry-helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('toolsDir points at the repository tools directory', () => {
  assert.equal(toolsDir, path.join(repoRoot, 'tools'));
});

test('shellEscape neutralises quotes and newlines', () => {
  assert.equal(shellEscape('say "hi"'), 'say \\"hi\\"');
  assert.equal(shellEscape('one\ntwo'), 'one two');
  assert.equal(shellEscape('plain'), 'plain');
});

test('parseToolOutput reads a plain JSON string', () => {
  assert.deepEqual(parseToolOutput('{"ok":true}'), { ok: true });
});

test('parseToolOutput prefers structuredContent.stdout', () => {
  const raw = { structuredContent: { stdout: '{"ok":true,"via":"structured"}' } };
  assert.deepEqual(parseToolOutput(raw), { ok: true, via: 'structured' });
});

test('parseToolOutput falls back to the first text content part', () => {
  const raw = { content: [{ type: 'text', text: '{"ok":true,"via":"content"}' }] };
  assert.deepEqual(parseToolOutput(raw), { ok: true, via: 'content' });
});

test('parseToolOutput reports unparseable output instead of throwing', () => {
  const result = parseToolOutput('not json');
  assert.equal(result.ok, false);
  assert.match(result.error, /failed to parse/);
  assert.equal(result.raw, 'not json');
});
