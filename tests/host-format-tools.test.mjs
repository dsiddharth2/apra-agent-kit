// tests/host-format-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';

const { formatTools } = await import('../host/prompts/format-tools.mjs');

const sampleTools = [
  {
    name: 'weather',
    description: 'Fetches current weather for a city.',
    inputSchema: z.object({ city: z.string().optional() }),
    reversible: true,
    tags: [],
  },
  {
    name: 'timezone',
    description: 'Fetches current local time and timezone.',
    inputSchema: z.object({ city: z.string().optional() }),
    reversible: true,
    tags: [],
  },
  {
    name: 'demo',
    description: 'Runs the demo workflow.',
    reversible: false,
    tags: [],
  },
];

test('includes all tool names', () => {
  const text = formatTools(sampleTools);
  assert.ok(text.includes('weather'));
  assert.ok(text.includes('timezone'));
  assert.ok(text.includes('demo'));
});

test('includes tool descriptions', () => {
  const text = formatTools(sampleTools);
  assert.ok(text.includes('Fetches current weather'));
  assert.ok(text.includes('Fetches current local time'));
  assert.ok(text.includes('Runs the demo workflow'));
});

test('marks irreversible tools', () => {
  const text = formatTools(sampleTools);
  assert.ok(/demo.*\[irreversible\]/i.test(text));
});

test('marks reversible tools', () => {
  const text = formatTools(sampleTools);
  assert.ok(/weather.*\[reversible\]/i.test(text));
});

test('renders parameter names from inputSchema', () => {
  const text = formatTools(sampleTools);
  assert.ok(/weather\(.*city/i.test(text));
});

test('renders no params for tools without inputSchema', () => {
  const text = formatTools(sampleTools);
  assert.ok(/demo\(\)/.test(text));
});

test('empty registry returns header only', () => {
  const text = formatTools([]);
  assert.ok(text.includes('Available tools'));
  assert.ok(!text.includes('- '));
});
