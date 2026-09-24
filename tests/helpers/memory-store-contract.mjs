// tests/helpers/memory-store-contract.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryEntry } from '../../host/memory/store/interface.mjs';

export function runMemoryStoreContract(label, createStore) {
  test(`${label}: open and close`, async () => {
    const store = await createStore();
    await store.open();
    await store.close();
  });

  test(`${label}: store and get`, async () => {
    const store = await createStore();
    await store.open();
    try {
      const entry = createMemoryEntry({ kind: 'domain', text: 'Test fact', tags: ['test'] });
      await store.store(entry);
      const got = await store.get(entry.id);
      assert.equal(got.id, entry.id);
      assert.equal(got.text, 'Test fact');
      assert.equal(got.kind, 'domain');
    } finally { await store.close(); }
  });

  test(`${label}: get returns null for missing id`, async () => {
    const store = await createStore();
    await store.open();
    try {
      assert.equal(await store.get('nonexistent'), null);
    } finally { await store.close(); }
  });

  test(`${label}: update merges patch`, async () => {
    const store = await createStore();
    await store.open();
    try {
      const entry = createMemoryEntry({ kind: 'domain', text: 'Original', tags: ['a'] });
      await store.store(entry);
      const updated = await store.update(entry.id, { text: 'Updated', retrievalStrength: 0.5 });
      assert.equal(updated.text, 'Updated');
      assert.equal(updated.retrievalStrength, 0.5);
      assert.equal(updated.kind, 'domain');
    } finally { await store.close(); }
  });

  test(`${label}: remove deletes entry`, async () => {
    const store = await createStore();
    await store.open();
    try {
      const entry = createMemoryEntry({ kind: 'domain', text: 'To delete', tags: ['x'] });
      await store.store(entry);
      await store.remove(entry.id);
      assert.equal(await store.get(entry.id), null);
    } finally { await store.close(); }
  });

  test(`${label}: query filters by kinds`, async () => {
    const store = await createStore();
    await store.open();
    try {
      await store.store(createMemoryEntry({ kind: 'rule', text: 'A rule', tags: ['safety'] }));
      await store.store(createMemoryEntry({ kind: 'domain', text: 'A fact', tags: ['safety'] }));
      const rules = await store.query({ kinds: ['rule'] });
      assert.equal(rules.length, 1);
      assert.equal(rules[0].kind, 'rule');
    } finally { await store.close(); }
  });

  test(`${label}: query filters by tags`, async () => {
    const store = await createStore();
    await store.open();
    try {
      await store.store(createMemoryEntry({ kind: 'domain', text: 'DB fact', tags: ['database'] }));
      await store.store(createMemoryEntry({ kind: 'domain', text: 'UI fact', tags: ['frontend'] }));
      const results = await store.query({ tags: ['database'] });
      assert.equal(results.length, 1);
      assert.equal(results[0].tags[0], 'database');
    } finally { await store.close(); }
  });

  test(`${label}: query filters by states`, async () => {
    const store = await createStore();
    await store.open();
    try {
      const active = createMemoryEntry({ kind: 'domain', text: 'Active', tags: ['a'] });
      await store.store(active);
      const dormant = createMemoryEntry({ kind: 'domain', text: 'Dormant', tags: ['a'] });
      dormant.state = 'dormant';
      dormant.retrievalStrength = 0.5;
      await store.store(dormant);
      const results = await store.query({ states: ['active'] });
      assert.equal(results.length, 1);
      assert.equal(results[0].state, 'active');
    } finally { await store.close(); }
  });

  test(`${label}: tag filter is applied before limit`, async () => {
    const store = await createStore();
    await store.open();
    try {
      const other = createMemoryEntry({ kind: 'domain', text: 'High strength other', tags: ['other'] });
      other.retrievalStrength = 1;
      const wanted = createMemoryEntry({ kind: 'domain', text: 'Lower strength wanted', tags: ['wanted'] });
      wanted.retrievalStrength = 0.2;
      await store.store(other);
      await store.store(wanted);
      const results = await store.query({ tags: ['wanted'], limit: 1 });
      assert.equal(results.length, 1);
      assert.equal(results[0].text, 'Lower strength wanted');
      assert.ok(results[0].tags.includes('wanted'));
    } finally { await store.close(); }
  });

  test(`${label}: query respects limit`, async () => {
    const store = await createStore();
    await store.open();
    try {
      for (let i = 0; i < 5; i++) {
        await store.store(createMemoryEntry({ kind: 'domain', text: `Fact ${i}`, tags: ['batch'] }));
      }
      const results = await store.query({ tags: ['batch'], limit: 3 });
      assert.equal(results.length, 3);
    } finally { await store.close(); }
  });

  test(`${label}: purge removes by states`, async () => {
    const store = await createStore();
    await store.open();
    try {
      const e = createMemoryEntry({ kind: 'domain', text: 'Unavailable', tags: ['x'] });
      e.state = 'unavailable';
      e.retrievalStrength = 0.01;
      await store.store(e);
      await store.store(createMemoryEntry({ kind: 'domain', text: 'Active', tags: ['x'] }));
      const purged = await store.purge({ states: ['unavailable'] });
      assert.equal(purged, 1);
      assert.equal(await store.get(e.id), null);
    } finally { await store.close(); }
  });

  test(`${label}: count returns counts by filter`, async () => {
    const store = await createStore();
    await store.open();
    try {
      await store.store(createMemoryEntry({ kind: 'rule', text: 'Rule 1', tags: ['a'] }));
      await store.store(createMemoryEntry({ kind: 'domain', text: 'Fact 1', tags: ['a'] }));
      await store.store(createMemoryEntry({ kind: 'domain', text: 'Fact 2', tags: ['a'] }));
      assert.equal(await store.count({ kinds: ['rule'] }), 1);
      assert.equal(await store.count({ kinds: ['domain'] }), 2);
      assert.equal(await store.count({}), 3);
    } finally { await store.close(); }
  });
}
