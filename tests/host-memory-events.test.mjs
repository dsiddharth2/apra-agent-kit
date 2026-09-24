import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryEvents } from '../host/memory/events.mjs';

test('events: none level emits nothing', async () => {
  const published = [];
  const notifier = { publish: async (e) => published.push(e) };
  const events = createMemoryEvents({ notifier, level: 'none' });
  events.emit('memory:recall', { count: 5 });
  assert.equal(published.length, 0);
});

test('events: notifications level emits recall but strips facts', async () => {
  const published = [];
  const notifier = { publish: async (e) => published.push(e) };
  const events = createMemoryEvents({ notifier, level: 'notifications' });
  events.emit('memory:recall', { taskId: 't1', facts: [{}, {}, {}] });
  assert.equal(published.length, 1);
  assert.equal(published[0].count, 3);
  assert.equal(published[0].facts, undefined);
});

test('events: notifications level does not emit promote', async () => {
  const published = [];
  const notifier = { publish: async (e) => published.push(e) };
  const events = createMemoryEvents({ notifier, level: 'notifications' });
  events.emit('memory:promote', { id: 'mem-1' });
  assert.equal(published.length, 0);
});

test('events: full level emits everything with full payloads', async () => {
  const published = [];
  const notifier = { publish: async (e) => published.push(e) };
  const events = createMemoryEvents({ notifier, level: 'full' });
  events.emit('memory:promote', { id: 'mem-1', kind: 'domain' });
  events.emit('memory:recall', { taskId: 't1', facts: [{ id: 'f1' }] });
  assert.equal(published.length, 2);
  assert.ok(published[1].facts);
});
