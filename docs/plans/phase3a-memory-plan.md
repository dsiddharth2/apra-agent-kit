# Phase 3a: Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-tier memory system (working context, run state, long-term) with FSRS-6 decay, prediction-error gating, pluggable store backends, and SSE-based memory events to the Fleet Agent Kit.

**Architecture:** A new `host/memory/` module tree with three sub-layers: stores (persistence adapters), decay (FSRS-6 engine + timer), and dedup (similarity gating). The memory module wires into the existing strategies, prompt builders, routes, tool registry, and notification system. Each tier operates independently with its own store instance and failure policy.

**Tech Stack:** Node 22, ESM, `node:test` runner, `node:sqlite` (DatabaseSync), existing `host/notify/` SSE system, existing `host/jobs/store/` patterns.

**Spec:** `docs/specs/phase3a-memory-spec.md`

## Global Constraints

- Node >= 22.16 (engine floor from package.json)
- ESM only — no CommonJS
- Zero new production dependencies (node:sqlite, node:fs, node:crypto are built-in)
- All store backends must pass the shared contract test suite
- `node:test` runner for all tests — no Jest, no Mocha
- Memory disabled = zero behavior change from current code
- Memory failures never halt a running task

## Review Focus

1. **Concurrent decay + write:** A decay timer pass runs while a store/promote call is in-flight — SQLite WAL handles this, but the filesystem backend could corrupt a JSON file mid-read/write. Each filesystem operation should be atomic (write-to-temp + rename).
2. **Dedup false positive on short text:** A 5-word fact like "use UTC always" will trigram-match many unrelated facts. The dedup gate should require same `kind` + overlapping `tags` before comparing text.
3. **FSRS-6 numeric stability:** The power-law formula `(1 + factor * t / S) ^ -w20` can produce NaN/Infinity when `S` is 0 or `t` is enormous. Clamp inputs and outputs.
4. **Cosmos eventual consistency:** Cosmos DB reads may lag writes. A store-then-query within the same request could miss the just-stored entry. Accept this for V1 — document it.
5. **Large preload directory:** Loading 500 knowledge files on startup, each running dedup against the full store, could take minutes. Preload should batch and log progress.

---

## Task dependency graph

```
Task 1  (store interface + contract tests)  — independent
Task 2  (filesystem backend)                — depends on Task 1
Task 3  (sqlite backend)                    — depends on Task 1
Task 4  (cosmos backend)                    — depends on Task 1
Task 5  (FSRS-6 decay engine)              — independent
Task 6  (decay timer)                       — depends on Tasks 1, 5
Task 7  (dedup / prediction-error gating)   — depends on Task 1
Task 8  (working context)                   — independent
Task 9  (run state)                         — depends on Task 1
Task 10 (long-term memory module)           — depends on Tasks 1, 5, 6, 7
Task 11 (auto-learner)                      — depends on Task 10
Task 12 (memory events)                     — depends on Task 10
Task 13 (HTTP routes + MCP tools)           — depends on Task 10
Task 14 (config + host wiring)              — depends on all above
Task 15 (strategy integration)              — depends on Tasks 8, 9, 14
Task 16 (preloader)                         — depends on Tasks 7, 10
```

---

### Task 1: Memory store interface + contract test suite

The pluggable persistence contract and a shared test harness that every backend must pass. Same pattern as `host/jobs/store/interface.mjs` + `tests/helpers/store-contract.mjs`.

**Files:**
- Create: `host/memory/store/interface.mjs`
- Create: `tests/helpers/memory-store-contract.mjs`
- Test: `tests/host-memory-store.test.mjs`

**Interfaces:**
- Consumes: nothing — this is the foundation
- Produces: `MEMORY_STORE_METHODS`, `assertMemoryStore(store)`, `createMemoryEntry({ kind, text, tags, source, ... })`, `runMemoryStoreContract(label, factoryFn)` (shared test harness)

- [ ] **Step 1: Write the store interface**

```js
// host/memory/store/interface.mjs
import { randomUUID } from 'node:crypto';

export const MEMORY_STORE_METHODS = [
  'open', 'close', 'store', 'get', 'update', 'remove', 'query', 'purge', 'count',
];

export const VALID_KINDS = new Set(['rule', 'domain', 'preference', 'pattern', 'procedure']);
export const VALID_SOURCES = new Set(['human', 'agent', 'system']);
export const VALID_STATES = new Set(['active', 'dormant', 'silent', 'unavailable']);

export function assertMemoryStore(store) {
  const missing = MEMORY_STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`memory store missing: ${missing.join(', ')}`);
  return store;
}

export function createMemoryEntry({
  id, kind, text, tags = [], source = 'human', confidence,
  metadata = {},
} = {}) {
  if (!VALID_KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`);
  if (!VALID_SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
  const now = new Date().toISOString();
  return {
    id: id ?? `mem-${randomUUID().slice(0, 12)}`,
    kind,
    text: text.trim(),
    tags: [...tags],
    source,
    confidence: confidence ?? (source === 'human' ? 1.0 : 0.8),
    storageStrength: source === 'human' ? 1.0 : 0.6,
    retrievalStrength: 1.0,
    state: 'active',
    stability: 1.0,
    difficulty: 0.3,
    reps: 0,
    lapses: 0,
    lastPromotedAt: now,
    lastReviewRating: null,
    createdAt: now,
    lastUsedAt: null,
    useCount: 0,
    metadata,
  };
}
```

- [ ] **Step 2: Write the shared contract test harness**

```js
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
```

- [ ] **Step 3: Create the test file that will run contract tests for each backend**

```js
// tests/host-memory-store.test.mjs
// Backends are added here as they're implemented in later tasks.
// For now, this file exists to hold the contract-test wiring.
```

- [ ] **Step 4: Run tests to verify the contract test harness compiles**

Run: `node --test tests/host-memory-store.test.mjs`
Expected: 0 tests (file imports cleanly but no backends registered yet)

- [ ] **Step 5: Commit**

```bash
git add host/memory/store/interface.mjs tests/helpers/memory-store-contract.mjs tests/host-memory-store.test.mjs
git commit -m "feat(memory): add store interface and shared contract test harness"
```

---

### Task 2: Filesystem store backend

JSON-file-per-entry storage. Human-readable, easy to inspect. Atomic writes (write-to-temp + rename) to prevent corruption from concurrent access.

**Files:**
- Create: `host/memory/store/filesystem.mjs`
- Modify: `tests/host-memory-store.test.mjs`

**Interfaces:**
- Consumes: `assertMemoryStore()`, `createMemoryEntry()` from Task 1
- Produces: `createFilesystemStore({ dir })` returning a store contract object

- [ ] **Step 1: Write the filesystem store**

```js
// host/memory/store/filesystem.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createFilesystemStore({ dir }) {
  if (!dir) throw new Error('createFilesystemStore requires dir');

  const filePath = (id) => path.join(dir, `${id}.json`);

  async function readEntry(id) {
    try {
      const text = await fs.readFile(filePath(id), 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeEntry(entry) {
    const tmp = path.join(dir, `.tmp-${randomUUID().slice(0, 8)}.json`);
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
    await fs.rename(tmp, filePath(entry.id));
  }

  async function allEntries() {
    let files;
    try { files = await fs.readdir(dir); } catch { return []; }
    const entries = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        entries.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
      } catch { /* skip corrupt */ }
    }
    return entries;
  }

  return {
    async open() { await fs.mkdir(dir, { recursive: true }); },
    async close() {},

    async store(entry) { await writeEntry(entry); },

    async get(id) { return readEntry(id); },

    async update(id, patch) {
      const existing = await readEntry(id);
      if (!existing) throw new Error(`memory ${id} not found`);
      const next = { ...existing, ...patch };
      await writeEntry(next);
      return next;
    },

    async remove(id) {
      try { await fs.unlink(filePath(id)); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },

    async query({ kinds, tags, states, query: textQuery, limit } = {}) {
      let results = await allEntries();
      if (kinds?.length) results = results.filter(e => kinds.includes(e.kind));
      if (tags?.length) results = results.filter(e => e.tags.some(t => tags.includes(t)));
      if (states?.length) results = results.filter(e => states.includes(e.state));
      if (textQuery) {
        const q = textQuery.toLowerCase();
        results = results.filter(e => e.text.toLowerCase().includes(q));
      }
      results.sort((a, b) => b.retrievalStrength - a.retrievalStrength);
      if (limit) results = results.slice(0, limit);
      return results;
    },

    async purge({ states, olderThan } = {}) {
      const all = await allEntries();
      let count = 0;
      for (const e of all) {
        const matchState = states?.length ? states.includes(e.state) : true;
        const matchAge = olderThan ? e.createdAt < olderThan : true;
        if (matchState && matchAge) {
          try { await fs.unlink(filePath(e.id)); count++; } catch { /* skip */ }
        }
      }
      return count;
    },

    async count({ kinds, states } = {}) {
      let results = await allEntries();
      if (kinds?.length) results = results.filter(e => kinds.includes(e.kind));
      if (states?.length) results = results.filter(e => states.includes(e.state));
      return results.length;
    },
  };
}
```

- [ ] **Step 2: Register in contract tests**

Add to `tests/host-memory-store.test.mjs`:

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMemoryStoreContract } from './helpers/memory-store-contract.mjs';

const { createFilesystemStore } = await import('../host/memory/store/filesystem.mjs');
runMemoryStoreContract('filesystem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-fs-'));
  return createFilesystemStore({ dir });
});
```

- [ ] **Step 3: Run contract tests**

Run: `node --test tests/host-memory-store.test.mjs`
Expected: all contract tests PASS for filesystem

- [ ] **Step 4: Commit**

```bash
git add host/memory/store/filesystem.mjs tests/host-memory-store.test.mjs
git commit -m "feat(memory): add filesystem store backend"
```

---

### Task 3: SQLite store backend

SQLite with WAL mode, FTS5 for text search, and trigram support for dedup similarity queries.

**Files:**
- Create: `host/memory/store/sqlite.mjs`
- Modify: `tests/host-memory-store.test.mjs`

**Interfaces:**
- Consumes: `assertMemoryStore()` from Task 1
- Produces: `createSqliteStore({ dbPath })` returning a store contract object

- [ ] **Step 1: Write the SQLite store**

```js
// host/memory/store/sqlite.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  text                TEXT NOT NULL,
  tags                TEXT NOT NULL DEFAULT '[]',
  source              TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 1.0,
  storage_strength    REAL NOT NULL DEFAULT 1.0,
  retrieval_strength  REAL NOT NULL DEFAULT 1.0,
  state               TEXT NOT NULL DEFAULT 'active',
  stability           REAL NOT NULL DEFAULT 1.0,
  difficulty          REAL NOT NULL DEFAULT 0.3,
  reps                INTEGER NOT NULL DEFAULT 0,
  lapses              INTEGER NOT NULL DEFAULT 0,
  last_promoted_at    TEXT,
  last_review_rating  INTEGER,
  created_at          TEXT NOT NULL,
  last_used_at        TEXT,
  use_count           INTEGER NOT NULL DEFAULT 0,
  metadata            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_memories_kind  ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
`;

function toRow(entry) {
  return {
    id: entry.id, kind: entry.kind, text: entry.text,
    tags: JSON.stringify(entry.tags), source: entry.source,
    confidence: entry.confidence, storage_strength: entry.storageStrength,
    retrieval_strength: entry.retrievalStrength, state: entry.state,
    stability: entry.stability, difficulty: entry.difficulty,
    reps: entry.reps, lapses: entry.lapses,
    last_promoted_at: entry.lastPromotedAt, last_review_rating: entry.lastReviewRating,
    created_at: entry.createdAt, last_used_at: entry.lastUsedAt,
    use_count: entry.useCount, metadata: JSON.stringify(entry.metadata),
  };
}

function fromRow(row) {
  return {
    id: row.id, kind: row.kind, text: row.text,
    tags: JSON.parse(row.tags), source: row.source,
    confidence: row.confidence, storageStrength: row.storage_strength,
    retrievalStrength: row.retrieval_strength, state: row.state,
    stability: row.stability, difficulty: row.difficulty,
    reps: row.reps, lapses: row.lapses,
    lastPromotedAt: row.last_promoted_at, lastReviewRating: row.last_review_rating,
    createdAt: row.created_at, lastUsedAt: row.last_used_at,
    useCount: row.use_count, metadata: JSON.parse(row.metadata),
  };
}

export function createSqliteStore({ dbPath }) {
  if (!dbPath) throw new Error('createSqliteStore requires dbPath');
  let db = null;
  let stmts = null;

  const ensureOpen = () => { if (!db) throw new Error('memory sqlite store is not open'); };

  return {
    async open() {
      if (db) return;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec(SCHEMA);
        stmts = {
          insert: db.prepare(`INSERT INTO memories (id, kind, text, tags, source, confidence, storage_strength, retrieval_strength, state, stability, difficulty, reps, lapses, last_promoted_at, last_review_rating, created_at, last_used_at, use_count, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
          get: db.prepare('SELECT * FROM memories WHERE id = ?'),
          update: db.prepare(`UPDATE memories SET kind=?, text=?, tags=?, source=?, confidence=?, storage_strength=?, retrieval_strength=?, state=?, stability=?, difficulty=?, reps=?, lapses=?, last_promoted_at=?, last_review_rating=?, last_used_at=?, use_count=?, metadata=? WHERE id=?`),
          remove: db.prepare('DELETE FROM memories WHERE id = ?'),
          count: db.prepare('SELECT COUNT(*) as n FROM memories'),
        };
      } catch (err) {
        try { db.close(); } catch { /* preserve original */ }
        db = null; stmts = null;
        throw err;
      }
    },

    async close() {
      if (!db) return;
      db.close(); db = null; stmts = null;
    },

    async store(entry) {
      ensureOpen();
      const r = toRow(entry);
      stmts.insert.run(r.id, r.kind, r.text, r.tags, r.source, r.confidence, r.storage_strength, r.retrieval_strength, r.state, r.stability, r.difficulty, r.reps, r.lapses, r.last_promoted_at, r.last_review_rating, r.created_at, r.last_used_at, r.use_count, r.metadata);
    },

    async get(id) {
      ensureOpen();
      const row = stmts.get.get(id);
      return row ? fromRow(row) : null;
    },

    async update(id, patch) {
      ensureOpen();
      const row = stmts.get.get(id);
      if (!row) throw new Error(`memory ${id} not found`);
      const existing = fromRow(row);
      const next = { ...existing, ...patch };
      const nr = toRow(next);
      stmts.update.run(nr.kind, nr.text, nr.tags, nr.source, nr.confidence, nr.storage_strength, nr.retrieval_strength, nr.state, nr.stability, nr.difficulty, nr.reps, nr.lapses, nr.last_promoted_at, nr.last_review_rating, nr.last_used_at, nr.use_count, nr.metadata, id);
      return next;
    },

    async remove(id) {
      ensureOpen();
      stmts.remove.run(id);
    },

    async query({ kinds, tags, states, query: textQuery, limit } = {}) {
      ensureOpen();
      const clauses = [];
      const params = [];
      if (kinds?.length) { clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
      if (states?.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
      if (textQuery) { clauses.push('text LIKE ?'); params.push(`%${textQuery}%`); }
      let sql = 'SELECT * FROM memories';
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      sql += ' ORDER BY retrieval_strength DESC';
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }
      const rows = db.prepare(sql).all(...params);
      let results = rows.map(fromRow);
      if (tags?.length) results = results.filter(e => e.tags.some(t => tags.includes(t)));
      return results;
    },

    async purge({ states, olderThan } = {}) {
      ensureOpen();
      const clauses = [];
      const params = [];
      if (states?.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
      if (olderThan) { clauses.push('created_at < ?'); params.push(olderThan); }
      if (!clauses.length) return 0;
      const sql = `DELETE FROM memories WHERE ${clauses.join(' AND ')}`;
      const { changes } = db.prepare(sql).run(...params);
      return Number(changes);
    },

    async count({ kinds, states } = {}) {
      ensureOpen();
      const clauses = [];
      const params = [];
      if (kinds?.length) { clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
      if (states?.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
      let sql = 'SELECT COUNT(*) as n FROM memories';
      if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
      return Number(db.prepare(sql).get(...params).n);
    },
  };
}
```

- [ ] **Step 2: Register in contract tests**

Append to `tests/host-memory-store.test.mjs`:

```js
const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
runMemoryStoreContract('sqlite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-sqlite-'));
  return createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
});
```

- [ ] **Step 3: Run contract tests**

Run: `node --test tests/host-memory-store.test.mjs`
Expected: all contract tests PASS for both filesystem and sqlite

- [ ] **Step 4: Add SQLite-specific persistence test**

Append to `tests/host-memory-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

test('sqlite: entries survive close and reopen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-sqlite-persist-'));
  const dbPath = path.join(dir, 'memory.db');
  const a = createSqliteStore({ dbPath }); await a.open();
  await a.store(createMemoryEntry({ kind: 'rule', text: 'Persist me', tags: ['test'] }));
  await a.close();
  const b = createSqliteStore({ dbPath }); await b.open();
  try {
    const results = await b.query({ kinds: ['rule'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].text, 'Persist me');
  } finally { await b.close(); }
});
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/host-memory-store.test.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add host/memory/store/sqlite.mjs tests/host-memory-store.test.mjs
git commit -m "feat(memory): add sqlite store backend"
```

---

### Task 4: Cosmos DB store backend

Azure Cosmos DB backend for production/serverless use. Uses the `@azure/cosmos` SDK.

**Files:**
- Create: `host/memory/store/cosmos.mjs`
- Modify: `tests/host-memory-store.test.mjs` (contract test with mock — real Cosmos tests are live-only)
- Test: `tests/host-memory-store-cosmos.test.mjs`

**Interfaces:**
- Consumes: `assertMemoryStore()` from Task 1
- Produces: `createCosmosStore({ endpoint, key, database, container })` returning a store contract object

- [ ] **Step 1: Write the Cosmos store**

```js
// host/memory/store/cosmos.mjs
export function createCosmosStore({ endpoint, key, database, container: containerName, timeoutMs = 5000 }) {
  if (!endpoint || !key) throw new Error('createCosmosStore requires endpoint and key');
  let client = null;
  let container = null;

  function toDoc(entry) {
    return { id: entry.id, partitionKey: entry.kind, ...entry };
  }

  function fromDoc(doc) {
    const { _rid, _self, _etag, _attachments, _ts, partitionKey, ...entry } = doc;
    return entry;
  }

  return {
    async open() {
      const { CosmosClient } = await import('@azure/cosmos');
      client = new CosmosClient({ endpoint, key });
      const { database: db } = await client.databases.createIfNotExists({ id: database });
      const { container: cont } = await db.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ['/partitionKey'] },
      });
      container = cont;
    },

    async close() { client = null; container = null; },

    async store(entry) {
      await container.items.create(toDoc(entry));
    },

    async get(id) {
      try {
        const kinds = ['rule', 'domain', 'preference', 'pattern', 'procedure'];
        for (const kind of kinds) {
          try {
            const { resource } = await container.item(id, kind).read();
            if (resource) return fromDoc(resource);
          } catch (err) {
            if (err.code !== 404) throw err;
          }
        }
        return null;
      } catch (err) {
        if (err.code === 404) return null;
        throw err;
      }
    },

    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new Error(`memory ${id} not found`);
      const next = { ...existing, ...patch };
      await container.item(id, next.kind).replace(toDoc(next));
      return next;
    },

    async remove(id) {
      const existing = await this.get(id);
      if (!existing) return;
      await container.item(id, existing.kind).delete();
    },

    async query({ kinds, tags, states, query: textQuery, limit = 100 } = {}) {
      const conditions = ['1=1'];
      const params = [];
      let paramIdx = 0;
      if (kinds?.length) {
        conditions.push(`c.kind IN (${kinds.map(() => `@p${paramIdx++}`).join(',')})`);
        params.push(...kinds.map((k, i) => ({ name: `@p${paramIdx - kinds.length + i}`, value: k })));
      }
      if (states?.length) {
        conditions.push(`c.state IN (${states.map(() => `@p${paramIdx++}`).join(',')})`);
        params.push(...states.map((s, i) => ({ name: `@p${paramIdx - states.length + i}`, value: s })));
      }
      if (textQuery) {
        conditions.push(`CONTAINS(c.text, @pq, true)`);
        params.push({ name: '@pq', value: textQuery });
      }
      const sql = `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.retrievalStrength DESC OFFSET 0 LIMIT ${limit}`;
      const { resources } = await container.items.query({ query: sql, parameters: params }).fetchAll();
      let results = resources.map(fromDoc);
      if (tags?.length) results = results.filter(e => e.tags.some(t => tags.includes(t)));
      return results;
    },

    async purge({ states, olderThan } = {}) {
      const toDelete = await this.query({ states, limit: 1000 });
      const filtered = olderThan ? toDelete.filter(e => e.createdAt < olderThan) : toDelete;
      for (const entry of filtered) {
        await container.item(entry.id, entry.kind).delete();
      }
      return filtered.length;
    },

    async count({ kinds, states } = {}) {
      const conditions = ['1=1'];
      const params = [];
      let paramIdx = 0;
      if (kinds?.length) {
        conditions.push(`c.kind IN (${kinds.map(() => `@p${paramIdx++}`).join(',')})`);
        params.push(...kinds.map((k, i) => ({ name: `@p${paramIdx - kinds.length + i}`, value: k })));
      }
      if (states?.length) {
        conditions.push(`c.state IN (${states.map(() => `@p${paramIdx++}`).join(',')})`);
        params.push(...states.map((s, i) => ({ name: `@p${paramIdx - states.length + i}`, value: s })));
      }
      const sql = `SELECT VALUE COUNT(1) FROM c WHERE ${conditions.join(' AND ')}`;
      const { resources } = await container.items.query({ query: sql, parameters: params }).fetchAll();
      return resources[0] ?? 0;
    },
  };
}
```

- [ ] **Step 2: Write unit test with mock**

```js
// tests/host-memory-store-cosmos.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('cosmos: createCosmosStore throws without endpoint', async () => {
  const { createCosmosStore } = await import('../host/memory/store/cosmos.mjs');
  assert.throws(() => createCosmosStore({}), /endpoint/);
});

test('cosmos: createCosmosStore throws without key', async () => {
  const { createCosmosStore } = await import('../host/memory/store/cosmos.mjs');
  assert.throws(() => createCosmosStore({ endpoint: 'https://test' }), /key/);
});

// Full contract tests require a real Cosmos instance — run via:
// COSMOS_ENDPOINT=... COSMOS_KEY=... node --test tests/host-memory-store-cosmos.live.test.mjs
```

- [ ] **Step 3: Run test**

Run: `node --test tests/host-memory-store-cosmos.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/store/cosmos.mjs tests/host-memory-store-cosmos.test.mjs
git commit -m "feat(memory): add cosmos db store backend"
```

---

### Task 5: FSRS-6 decay engine

The core decay math. Pure functions — no I/O, no store dependency. Implements the FSRS-6 forgetting curve, state computation, and review processing.

**Files:**
- Create: `host/memory/decay/fsrs6.mjs`
- Create: `host/memory/decay/interface.mjs`
- Test: `tests/host-memory-decay.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `createFsrs6Engine(params?)` returning `{ computeRetrievability(entry, now), computeState(retrievability, thresholds), processReview(entry, rating), shouldProcess(entry) }`

- [ ] **Step 1: Write the decay engine interface**

```js
// host/memory/decay/interface.mjs
export const DECAY_ENGINE_METHODS = [
  'computeRetrievability',
  'computeState',
  'processReview',
  'shouldProcess',
];

export const DEFAULT_THRESHOLDS = {
  active: 0.7,
  dormant: 0.4,
  silent: 0.1,
};

export function assertDecayEngine(engine) {
  const missing = DECAY_ENGINE_METHODS.filter(m => typeof engine?.[m] !== 'function');
  if (missing.length) throw new Error(`decay engine missing: ${missing.join(', ')}`);
  return engine;
}
```

- [ ] **Step 2: Write the FSRS-6 engine**

```js
// host/memory/decay/fsrs6.mjs
import { DEFAULT_THRESHOLDS } from './interface.mjs';

// FSRS-6 pre-trained parameters (from the public Anki dataset, 700M+ reviews).
// These are the default w0–w20 values. Individual tuning is not needed for V1.
const DEFAULT_W = [
  0.4197, 1.1869, 3.0412, 15.2441,   // w0-w3: initial stability
  7.1434, 0.6477, 1.0007, 0.0674,     // w4-w7: difficulty
  1.6597, 0.1712, 1.0005,             // w8-w10: recall success
  2.0325, 0.0613,                     // w11-w12: recall failure
  0.3013, 0.7975,                     // w13-w14: short-term
  0.0000, 2.0902,                     // w15-w16: unused in V1
  0.5002, 0.2656,                     // w17-w18: unused in V1
  0.2485,                             // w19: unused in V1
  0.5,                                // w20: decay exponent
];

export function createFsrs6Engine({ w = DEFAULT_W, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const w20 = Math.max(0.01, Math.min(w[20] ?? 0.5, 2.0));
  const factor = Math.pow(0.9, -1.0 / w20) - 1;

  function computeRetrievability(entry, now = new Date()) {
    const lastPromoted = entry.lastPromotedAt ? new Date(entry.lastPromotedAt) : new Date(entry.createdAt);
    const elapsedDays = Math.max(0, (now.getTime() - lastPromoted.getTime()) / (1000 * 60 * 60 * 24));
    const stability = Math.max(0.01, entry.stability ?? 1.0);
    const r = Math.pow(1 + factor * elapsedDays / stability, -w20);
    return Math.max(0, Math.min(1, r));
  }

  function computeState(retrievability, thresholdsOverride) {
    const t = thresholdsOverride ?? thresholds;
    if (retrievability >= t.active) return 'active';
    if (retrievability >= t.dormant) return 'dormant';
    if (retrievability >= t.silent) return 'silent';
    return 'unavailable';
  }

  function processReview(entry, rating = 3) {
    const clampedRating = Math.max(1, Math.min(4, rating));
    const now = new Date();
    const lastPromoted = entry.lastPromotedAt ? new Date(entry.lastPromotedAt) : new Date(entry.createdAt);
    const elapsedDays = Math.max(0.01, (now.getTime() - lastPromoted.getTime()) / (1000 * 60 * 60 * 24));
    const oldStability = Math.max(0.01, entry.stability ?? 1.0);
    const oldDifficulty = Math.max(0, Math.min(1, entry.difficulty ?? 0.3));
    const r = computeRetrievability(entry, now);

    let newStability;
    let newDifficulty = oldDifficulty;
    const reps = (entry.reps ?? 0) + 1;
    let lapses = entry.lapses ?? 0;

    if (clampedRating === 1) {
      // Again — memory lapsed
      lapses += 1;
      newDifficulty = Math.min(1, oldDifficulty + 0.1);
      newStability = Math.max(0.01, oldStability * 0.5);
    } else {
      // Hard(2), Good(3), Easy(4)
      const difficultyDelta = clampedRating === 2 ? 0.05 : clampedRating === 4 ? -0.1 : 0;
      newDifficulty = Math.max(0, Math.min(1, oldDifficulty + difficultyDelta));
      const stabilityMultiplier = 1 + Math.exp(w[8] ?? 1.6) *
        (11 - oldDifficulty * 10) *
        Math.pow(oldStability, -(w[9] ?? 0.17)) *
        (Math.exp((1 - r) * (w[10] ?? 1.0)) - 1) *
        (clampedRating === 2 ? (w[13] ?? 0.3) : clampedRating === 4 ? (w[14] ?? 0.8) : 1);
      newStability = Math.max(0.01, oldStability * Math.max(1.01, stabilityMultiplier));
    }

    return {
      retrievalStrength: 1.0,
      storageStrength: Math.min(1, (entry.storageStrength ?? 0.6) + 0.05),
      state: 'active',
      stability: newStability,
      difficulty: newDifficulty,
      reps,
      lapses,
      lastPromotedAt: now.toISOString(),
      lastReviewRating: clampedRating,
    };
  }

  function shouldProcess(entry) {
    return entry.kind !== 'rule';
  }

  return { computeRetrievability, computeState, processReview, shouldProcess };
}
```

- [ ] **Step 3: Write tests**

```js
// tests/host-memory-decay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';
import { assertDecayEngine } from '../host/memory/decay/interface.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

const engine = createFsrs6Engine();

test('createFsrs6Engine passes assertDecayEngine', () => {
  assertDecayEngine(engine);
});

test('retrievability is 1.0 at time of promote', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const r = engine.computeRetrievability(entry, new Date(entry.lastPromotedAt));
  assert.ok(Math.abs(r - 1.0) < 0.01);
});

test('retrievability decays over 7 days', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const sevenDaysLater = new Date(new Date(entry.createdAt).getTime() + 7 * 86400000);
  const r = engine.computeRetrievability(entry, sevenDaysLater);
  assert.ok(r < 0.8, `expected < 0.8, got ${r}`);
  assert.ok(r > 0.3, `expected > 0.3, got ${r}`);
});

test('retrievability is near zero at 90 days', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const ninetyDaysLater = new Date(new Date(entry.createdAt).getTime() + 90 * 86400000);
  const r = engine.computeRetrievability(entry, ninetyDaysLater);
  assert.ok(r < 0.15, `expected < 0.15, got ${r}`);
});

test('computeState maps thresholds correctly', () => {
  assert.equal(engine.computeState(0.9), 'active');
  assert.equal(engine.computeState(0.7), 'active');
  assert.equal(engine.computeState(0.5), 'dormant');
  assert.equal(engine.computeState(0.3), 'silent');
  assert.equal(engine.computeState(0.05), 'unavailable');
});

test('processReview restores retrievalStrength to 1.0', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  entry.retrievalStrength = 0.4;
  const updated = engine.processReview(entry, 3);
  assert.equal(updated.retrievalStrength, 1.0);
  assert.equal(updated.state, 'active');
});

test('processReview increases stability', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const original = entry.stability;
  const updated = engine.processReview(entry, 3);
  assert.ok(updated.stability > original, `stability should increase: ${updated.stability} > ${original}`);
});

test('processReview with rating 1 (Again) reduces stability', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  entry.stability = 5.0;
  const updated = engine.processReview(entry, 1);
  assert.ok(updated.stability < 5.0);
  assert.equal(updated.lapses, 1);
});

test('shouldProcess returns false for rules', () => {
  const rule = createMemoryEntry({ kind: 'rule', text: 'Never delete', tags: ['safety'] });
  assert.equal(engine.shouldProcess(rule), false);
});

test('shouldProcess returns true for domain facts', () => {
  const fact = createMemoryEntry({ kind: 'domain', text: 'DB on port 5432', tags: ['db'] });
  assert.equal(engine.shouldProcess(fact), true);
});

test('numeric stability: zero elapsed time', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const r = engine.computeRetrievability(entry, new Date(entry.createdAt));
  assert.ok(Number.isFinite(r));
});

test('numeric stability: very large elapsed time', () => {
  const entry = createMemoryEntry({ kind: 'domain', text: 'Test', tags: ['a'] });
  const farFuture = new Date(new Date(entry.createdAt).getTime() + 365 * 10 * 86400000);
  const r = engine.computeRetrievability(entry, farFuture);
  assert.ok(Number.isFinite(r));
  assert.ok(r >= 0 && r <= 1);
});
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/host-memory-decay.test.mjs`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add host/memory/decay/interface.mjs host/memory/decay/fsrs6.mjs tests/host-memory-decay.test.mjs
git commit -m "feat(memory): add FSRS-6 decay engine"
```

---

### Task 6: Decay timer

Runs decay passes periodically or on-demand. Queries all non-rule entries, recomputes retrieval strength via FSRS-6, updates state, optionally purges unavailable facts. Exports `runDecayPass()` for external callers (Azure timer trigger).

**Files:**
- Create: `host/memory/decay/timer.mjs`
- Test: `tests/host-memory-decay-timer.test.mjs`

**Interfaces:**
- Consumes: `createFsrs6Engine()` from Task 5, any store from Tasks 2-4
- Produces: `runDecayPass(store, { engine, thresholds, purgeOnDecay, purgeAfterDays })`, `createDecayTimer(store, { engine, intervalMs, ... })` returning `{ start(), stop() }`

- [ ] **Step 1: Write the decay timer**

```js
// host/memory/decay/timer.mjs
import { createFsrs6Engine } from './fsrs6.mjs';
import { DEFAULT_THRESHOLDS } from './interface.mjs';

export async function runDecayPass(store, {
  engine = createFsrs6Engine(),
  thresholds = DEFAULT_THRESHOLDS,
  purgeOnDecay = false,
  purgeAfterDays = 90,
} = {}) {
  const now = new Date();
  const candidates = await store.query({ states: ['active', 'dormant', 'silent'] });
  let updated = 0;
  const stateChanges = [];

  for (const entry of candidates) {
    if (!engine.shouldProcess(entry)) continue;
    const r = engine.computeRetrievability(entry, now);
    const newState = engine.computeState(r, thresholds);
    if (Math.abs(r - entry.retrievalStrength) > 0.001 || newState !== entry.state) {
      const oldState = entry.state;
      await store.update(entry.id, { retrievalStrength: r, state: newState });
      updated++;
      if (oldState !== newState) stateChanges.push({ id: entry.id, from: oldState, to: newState });
    }
  }

  let purged = 0;
  if (purgeOnDecay) {
    const cutoff = new Date(now.getTime() - purgeAfterDays * 86400000).toISOString();
    purged = await store.purge({ states: ['unavailable'], olderThan: cutoff });
  }

  return { processed: candidates.length, updated, stateChanges, purged };
}

export function createDecayTimer(store, {
  engine,
  intervalMs = 3600000,
  thresholds,
  purgeOnDecay = false,
  purgeAfterDays = 90,
  logger = console,
} = {}) {
  let handle = null;

  const opts = { engine, thresholds, purgeOnDecay, purgeAfterDays };

  async function tick() {
    try {
      const result = await runDecayPass(store, opts);
      if (result.updated > 0) {
        logger.info?.(`[memory/decay] updated ${result.updated}/${result.processed} entries, ${result.stateChanges.length} state changes`);
      }
      if (result.purged > 0) {
        logger.info?.(`[memory/decay] purged ${result.purged} unavailable entries`);
      }
      return result;
    } catch (err) {
      logger.warn?.(`[memory/decay] pass failed: ${err?.message ?? err}`);
      return null;
    }
  }

  return {
    start() {
      if (handle) return;
      handle = setInterval(tick, intervalMs);
      if (handle.unref) handle.unref();
    },
    stop() {
      if (handle) { clearInterval(handle); handle = null; }
    },
    tick,
  };
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-decay-timer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDecayPass, createDecayTimer } from '../host/memory/decay/timer.mjs';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

async function inMemoryStore() {
  const entries = new Map();
  return {
    async open() {},
    async close() {},
    async store(e) { entries.set(e.id, { ...e }); },
    async get(id) { const e = entries.get(id); return e ? { ...e } : null; },
    async update(id, patch) { const e = entries.get(id); const n = { ...e, ...patch }; entries.set(id, n); return n; },
    async remove(id) { entries.delete(id); },
    async query({ kinds, tags, states } = {}) {
      let r = [...entries.values()];
      if (kinds?.length) r = r.filter(e => kinds.includes(e.kind));
      if (states?.length) r = r.filter(e => states.includes(e.state));
      return r;
    },
    async purge({ states, olderThan } = {}) {
      let n = 0;
      for (const [id, e] of entries) {
        if (states?.includes(e.state) && (!olderThan || e.createdAt < olderThan)) { entries.delete(id); n++; }
      }
      return n;
    },
    async count() { return entries.size; },
  };
}

test('runDecayPass updates retrievalStrength for stale entries', async () => {
  const store = await inMemoryStore();
  await store.open();
  const entry = createMemoryEntry({ kind: 'domain', text: 'Stale fact', tags: ['a'] });
  entry.lastPromotedAt = new Date(Date.now() - 30 * 86400000).toISOString();
  await store.store(entry);
  const result = await runDecayPass(store);
  assert.equal(result.updated, 1);
  const updated = await store.get(entry.id);
  assert.ok(updated.retrievalStrength < 0.5);
});

test('runDecayPass skips rules', async () => {
  const store = await inMemoryStore();
  await store.open();
  const rule = createMemoryEntry({ kind: 'rule', text: 'Never delete', tags: ['safety'] });
  rule.lastPromotedAt = new Date(Date.now() - 90 * 86400000).toISOString();
  await store.store(rule);
  const result = await runDecayPass(store);
  assert.equal(result.updated, 0);
  const got = await store.get(rule.id);
  assert.equal(got.retrievalStrength, 1.0);
  assert.equal(got.state, 'active');
});

test('runDecayPass purges unavailable entries when enabled', async () => {
  const store = await inMemoryStore();
  await store.open();
  const old = createMemoryEntry({ kind: 'domain', text: 'Very old', tags: ['a'] });
  old.state = 'unavailable';
  old.retrievalStrength = 0.01;
  old.createdAt = new Date(Date.now() - 180 * 86400000).toISOString();
  await store.store(old);
  const result = await runDecayPass(store, { purgeOnDecay: true, purgeAfterDays: 90 });
  assert.equal(result.purged, 1);
});

test('createDecayTimer tick runs a pass', async () => {
  const store = await inMemoryStore();
  await store.open();
  const entry = createMemoryEntry({ kind: 'domain', text: 'Fact', tags: ['a'] });
  entry.lastPromotedAt = new Date(Date.now() - 14 * 86400000).toISOString();
  await store.store(entry);
  const timer = createDecayTimer(store, { logger: { info() {}, warn() {} } });
  const result = await timer.tick();
  assert.ok(result.updated >= 1);
  timer.stop();
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-decay-timer.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/decay/timer.mjs tests/host-memory-decay-timer.test.mjs
git commit -m "feat(memory): add decay timer with runDecayPass export"
```

---

### Task 7: Prediction-error gating (dedup)

Similarity check on every write to long-term memory. Trigram similarity as default strategy. Decides create/merge/reinforce based on thresholds.

**Files:**
- Create: `host/memory/dedup/trigram.mjs`
- Create: `host/memory/dedup/index.mjs`
- Test: `tests/host-memory-dedup.test.mjs`

**Interfaces:**
- Consumes: any store from Tasks 2-4, `processReview()` from Task 5
- Produces: `createDedupGate({ store, engine, strategy, reinforceThreshold, mergeThreshold })` returning `{ process(newEntry) → { action: 'created'|'merged'|'reinforced', entry } }`

- [ ] **Step 1: Write trigram similarity**

```js
// host/memory/dedup/trigram.mjs
export function trigrams(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  if (normalized.length < 3) return new Set([normalized]);
  const set = new Set();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a, b) {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}
```

- [ ] **Step 2: Write dedup gate**

```js
// host/memory/dedup/index.mjs
import { trigramSimilarity } from './trigram.mjs';

export function createDedupGate({
  store,
  engine,
  strategy = 'trigram',
  reinforceThreshold = 0.92,
  mergeThreshold = 0.75,
} = {}) {
  const similarityFn = strategy === 'trigram' ? trigramSimilarity : trigramSimilarity;

  async function findBestMatch(newEntry) {
    const candidates = await store.query({ kinds: [newEntry.kind] });
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      if (!candidate.tags.some(t => newEntry.tags.includes(t)) && newEntry.tags.length > 0 && candidate.tags.length > 0) continue;
      const score = similarityFn(newEntry.text, candidate.text);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return { match: best, score: bestScore };
  }

  function resolveText(existing, incoming) {
    const SOURCE_PRIORITY = { human: 3, system: 2, agent: 1 };
    const existingPri = SOURCE_PRIORITY[existing.source] ?? 0;
    const incomingPri = SOURCE_PRIORITY[incoming.source] ?? 0;
    if (incomingPri > existingPri) return incoming.text;
    if (incomingPri < existingPri) return existing.text;
    return incoming.text;
  }

  return {
    async process(newEntry) {
      const { match, score } = await findBestMatch(newEntry);

      if (match && score >= reinforceThreshold) {
        const reviewPatch = engine ? engine.processReview(match, 3) : {};
        const updated = await store.update(match.id, {
          ...reviewPatch,
          storageStrength: Math.min(1, (match.storageStrength ?? 0.6) + 0.05),
        });
        return { action: 'reinforced', entry: updated, matchId: match.id, score };
      }

      if (match && score >= mergeThreshold) {
        const mergedText = resolveText(match, newEntry);
        const reviewPatch = engine ? engine.processReview(match, 3) : {};
        const updated = await store.update(match.id, {
          text: mergedText,
          tags: [...new Set([...match.tags, ...newEntry.tags])],
          ...reviewPatch,
          storageStrength: Math.min(1, (match.storageStrength ?? 0.6) + 0.05),
        });
        return { action: 'merged', entry: updated, matchId: match.id, score };
      }

      await store.store(newEntry);
      return { action: 'created', entry: newEntry, score: score ?? 0 };
    },
  };
}
```

- [ ] **Step 3: Write tests**

```js
// tests/host-memory-dedup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trigramSimilarity } from '../host/memory/dedup/trigram.mjs';
import { createDedupGate } from '../host/memory/dedup/index.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';

test('trigramSimilarity: identical strings → 1.0', () => {
  assert.equal(trigramSimilarity('hello world', 'hello world'), 1.0);
});

test('trigramSimilarity: completely different → near 0', () => {
  const score = trigramSimilarity('the quick brown fox', 'xyz abc def ghi');
  assert.ok(score < 0.2, `expected < 0.2, got ${score}`);
});

test('trigramSimilarity: near-duplicate → > 0.9', () => {
  const score = trigramSimilarity(
    'The staging DB resets every Sunday at 2am',
    'The staging DB resets every Sunday at 2am UTC',
  );
  assert.ok(score > 0.9, `expected > 0.9, got ${score}`);
});

test('trigramSimilarity: partial overlap → 0.5-0.9', () => {
  const score = trigramSimilarity(
    'The staging DB resets weekly',
    'The staging database resets every Sunday at 2am',
  );
  assert.ok(score > 0.3 && score < 0.9, `expected 0.3-0.9, got ${score}`);
});

test('dedup gate: creates new entry when no match', async () => {
  const store = { entries: new Map() };
  store.query = async () => [];
  store.store = async (e) => store.entries.set(e.id, e);
  const gate = createDedupGate({ store });
  const entry = createMemoryEntry({ kind: 'domain', text: 'Brand new fact', tags: ['new'] });
  const result = await gate.process(entry);
  assert.equal(result.action, 'created');
});

test('dedup gate: reinforces on >92% match', async () => {
  const existing = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am', tags: ['db'] });
  const store = {
    query: async () => [existing],
    update: async (id, patch) => ({ ...existing, ...patch }),
    store: async () => {},
  };
  const engine = createFsrs6Engine();
  const gate = createDedupGate({ store, engine });
  const incoming = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am UTC', tags: ['db'] });
  const result = await gate.process(incoming);
  assert.equal(result.action, 'reinforced');
});

test('dedup gate: merges on 75-92% match, human text wins over agent', async () => {
  const existing = createMemoryEntry({ kind: 'domain', text: 'The staging DB resets weekly', tags: ['db'], source: 'agent' });
  existing.source = 'agent';
  let updatedPatch = null;
  const store = {
    query: async () => [existing],
    update: async (id, patch) => { updatedPatch = patch; return { ...existing, ...patch }; },
    store: async () => {},
  };
  const engine = createFsrs6Engine();
  const gate = createDedupGate({ store, engine });
  const incoming = createMemoryEntry({ kind: 'domain', text: 'The staging database resets every Sunday at 2am', tags: ['db'], source: 'human' });
  const result = await gate.process(incoming);
  assert.equal(result.action, 'merged');
  assert.equal(updatedPatch.text, incoming.text);
});
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/host-memory-dedup.test.mjs`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add host/memory/dedup/trigram.mjs host/memory/dedup/index.mjs tests/host-memory-dedup.test.mjs
git commit -m "feat(memory): add prediction-error gating with trigram similarity"
```

---

### Task 8: Working context (in-run compaction)

Manages observation history during a single run. Two compaction strategies: `summarise` (LLM call) and `sliding-window` (drop oldest). Auto-fallback on failure.

**Files:**
- Create: `host/memory/working-context.mjs`
- Test: `tests/host-memory-working-context.test.mjs`

**Interfaces:**
- Consumes: `fleetApi.executePrompt()` (existing kit API)
- Produces: `createWorkingContext({ fleetApi, maxTurns, compactionStrategy, fallbackStrategy, keepRecent })` returning `{ append(obs), forPrompt(), history() }`

- [ ] **Step 1: Write working context**

```js
// host/memory/working-context.mjs
export function createWorkingContext({
  fleetApi,
  maxTurns = 50,
  compactionStrategy = 'summarise',
  fallbackStrategy = 'sliding-window',
  keepRecent = 25,
  logger = console,
} = {}) {
  const raw = [];
  let compacted = null;

  async function summarise(entries) {
    const text = entries.map((e, i) => `[${i + 1}] ${e.tool ?? e.type ?? 'step'}: ${e.text ?? e.result ?? JSON.stringify(e).slice(0, 200)}`).join('\n');
    const prompt = `Summarise the following agent observation history into a concise paragraph. Preserve key facts, decisions, and results. Do not add new information.\n\n${text}`;
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const summary = typeof response === 'string' ? response : (response?.content ?? []).map(p => p.text ?? '').join('\n');
    return { type: 'summary', text: summary };
  }

  function slidingWindow(all) {
    return all.slice(-keepRecent);
  }

  return {
    append(observation) {
      raw.push(observation);
    },

    async forPrompt() {
      if (raw.length <= maxTurns) return [...raw];

      const toCompact = raw.slice(0, raw.length - keepRecent);
      const recent = raw.slice(-keepRecent);

      if (compactionStrategy === 'summarise') {
        try {
          compacted = await summarise(toCompact);
          return [compacted, ...recent];
        } catch (err) {
          logger.warn?.(`[memory/working-context] summarise failed, falling back to ${fallbackStrategy}: ${err?.message ?? err}`);
          return slidingWindow(raw);
        }
      }

      return slidingWindow(raw);
    },

    history() {
      return [...raw];
    },
  };
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-working-context.test.mjs
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
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-working-context.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/working-context.mjs tests/host-memory-working-context.test.mjs
git commit -m "feat(memory): add working context with summarise and sliding-window compaction"
```

---

### Task 9: Run state (checkpoint / resume)

Checkpoint after each step so crashed processes can resume. Uses the pluggable memory store.

**Files:**
- Create: `host/memory/run-state.mjs`
- Test: `tests/host-memory-run-state.test.mjs`

**Interfaces:**
- Consumes: any store from Tasks 2-4
- Produces: `createRunState({ store, maxConsecutiveFailures, logger })` returning `{ save(taskId, snapshot), load(taskId), clear(taskId), hasIdempotencyKey(taskId, key), addIdempotencyKey(taskId, key) }`

- [ ] **Step 1: Write run state**

```js
// host/memory/run-state.mjs
export function createRunState({ store, maxConsecutiveFailures = 3, logger = console } = {}) {
  let consecutiveFailures = 0;

  return {
    async save(taskId, snapshot) {
      try {
        const entry = {
          id: `rs-${taskId}`,
          kind: 'procedure',
          text: JSON.stringify(snapshot),
          tags: ['__run_state__'],
          source: 'system',
          confidence: 1.0,
          storageStrength: 1.0,
          retrievalStrength: 1.0,
          state: 'active',
          stability: 1.0,
          difficulty: 0,
          reps: 0,
          lapses: 0,
          lastPromotedAt: new Date().toISOString(),
          lastReviewRating: null,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          useCount: 0,
          metadata: { type: 'checkpoint', taskId },
        };
        const existing = await store.get(entry.id);
        if (existing) {
          await store.update(entry.id, { text: entry.text, lastPromotedAt: entry.lastPromotedAt });
        } else {
          await store.store(entry);
        }
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        const level = consecutiveFailures >= maxConsecutiveFailures ? 'error' : 'warn';
        logger[level]?.(`[memory/run-state] checkpoint save failed (${consecutiveFailures}x): ${err?.message ?? err}`);
      }
    },

    async load(taskId) {
      try {
        const entry = await store.get(`rs-${taskId}`);
        if (!entry) return null;
        return JSON.parse(entry.text);
      } catch (err) {
        logger.warn?.(`[memory/run-state] checkpoint load failed: ${err?.message ?? err}`);
        return null;
      }
    },

    async clear(taskId) {
      try {
        await store.remove(`rs-${taskId}`);
      } catch (err) {
        logger.warn?.(`[memory/run-state] checkpoint clear failed: ${err?.message ?? err}`);
      }
    },

    async hasIdempotencyKey(taskId, key) {
      const snapshot = await this.load(taskId);
      if (!snapshot) return false;
      return (snapshot.idempotencyKeys ?? []).includes(key);
    },

    async addIdempotencyKey(taskId, key) {
      const snapshot = await this.load(taskId);
      if (!snapshot) return;
      const keys = snapshot.idempotencyKeys ?? [];
      if (!keys.includes(key)) {
        keys.push(key);
        snapshot.idempotencyKeys = keys;
        await this.save(taskId, snapshot);
      }
    },
  };
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-run-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunState } from '../host/memory/run-state.mjs';
import { createFilesystemStore } from '../host/memory/store/filesystem.mjs';

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-rs-'));
  const store = createFilesystemStore({ dir });
  await store.open();
  return store;
}

test('save and load checkpoint', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  await rs.save('task-1', { stepIndex: 3, plan: { steps: ['a', 'b', 'c'] }, idempotencyKeys: ['k1'] });
  const loaded = await rs.load('task-1');
  assert.equal(loaded.stepIndex, 3);
  assert.deepEqual(loaded.idempotencyKeys, ['k1']);
  await store.close();
});

test('load returns null when no checkpoint', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  assert.equal(await rs.load('nonexistent'), null);
  await store.close();
});

test('clear removes checkpoint', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  await rs.save('task-2', { stepIndex: 1 });
  await rs.clear('task-2');
  assert.equal(await rs.load('task-2'), null);
  await store.close();
});

test('save failure logs warning and continues', async () => {
  const warnings = [];
  const failStore = {
    get: async () => null,
    store: async () => { throw new Error('disk full'); },
    update: async () => { throw new Error('disk full'); },
  };
  const rs = createRunState({ store: failStore, logger: { warn: (m) => warnings.push(m), error: () => {} } });
  await rs.save('task-3', { stepIndex: 1 });
  assert.ok(warnings.length > 0);
});

test('idempotency key tracking', async () => {
  const store = await makeStore();
  const rs = createRunState({ store });
  await rs.save('task-4', { stepIndex: 2, idempotencyKeys: ['k1'] });
  assert.ok(await rs.hasIdempotencyKey('task-4', 'k1'));
  assert.ok(!(await rs.hasIdempotencyKey('task-4', 'k2')));
  await rs.addIdempotencyKey('task-4', 'k2');
  assert.ok(await rs.hasIdempotencyKey('task-4', 'k2'));
  await store.close();
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-run-state.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/run-state.mjs tests/host-memory-run-state.test.mjs
git commit -m "feat(memory): add run state checkpoint/resume"
```

---

### Task 10: Long-term memory module

The core orchestrator. Wires store + decay engine + dedup gate. Exposes `query`, `store`, `get`, `update`, `remove`, `promote`. Handles recall ranking (rules first → active by strength → dormant backfill).

**Files:**
- Create: `host/memory/long-term.mjs`
- Test: `tests/host-memory-long-term.test.mjs`

**Interfaces:**
- Consumes: store (Tasks 2-4), `createFsrs6Engine()` (Task 5), `createDecayTimer()` (Task 6), `createDedupGate()` (Task 7)
- Produces: `createLongTermMemory({ store, decayConfig, dedupConfig, recallLimit, logger })` returning `{ open(), close(), store(entry), get(id), update(id, patch), remove(id), query(opts), promote(id), recall(task) }`

- [ ] **Step 1: Write long-term memory module**

```js
// host/memory/long-term.mjs
import { createFsrs6Engine } from './decay/fsrs6.mjs';
import { createDecayTimer } from './decay/timer.mjs';
import { createDedupGate } from './dedup/index.mjs';
import { createMemoryEntry } from './store/interface.mjs';

export function createLongTermMemory({
  store,
  decayConfig = {},
  dedupConfig = {},
  recallLimit = 20,
  maxEntries = 500,
  recallFailurePolicy = 'blank-slate',
  autoLearn = false,
  events = null,
  logger = console,
} = {}) {
  const engine = createFsrs6Engine({
    thresholds: decayConfig.thresholds,
  });

  const timer = decayConfig.mode !== 'none' && decayConfig.mode !== 'manual'
    ? createDecayTimer(store, {
        engine,
        intervalMs: decayConfig.intervalMs,
        thresholds: decayConfig.thresholds,
        purgeOnDecay: decayConfig.purgeOnDecay,
        purgeAfterDays: decayConfig.purgeAfterDays,
        logger,
      })
    : null;

  const dedup = dedupConfig.enabled !== false
    ? createDedupGate({
        store,
        engine,
        strategy: dedupConfig.strategy,
        reinforceThreshold: dedupConfig.reinforceThreshold,
        mergeThreshold: dedupConfig.mergeThreshold,
      })
    : null;

  return {
    engine,
    timer,

    async open() {
      await store.open();
      timer?.start();
    },

    async close() {
      timer?.stop();
      await store.close();
    },

    async store(entry) {
      const memEntry = entry.id && entry.createdAt ? entry : createMemoryEntry(entry);
      if (maxEntries) {
        const current = await store.count({});
        if (current >= maxEntries) {
          logger.warn?.(`[memory/long-term] maxEntries (${maxEntries}) reached — rejecting new entry`);
          return { action: 'rejected', reason: 'max_entries', entry: memEntry };
        }
      }
      let result;
      if (dedup) {
        result = dedup.process(memEntry);
      } else {
        await store.store(memEntry);
        result = { action: 'created', entry: memEntry };
      }
      events?.emit('memory:store', { entry: (await result).entry ?? memEntry, dedupResult: (await result).action });
      return result;
    },

    async get(id) { return store.get(id); },

    async update(id, patch) { return store.update(id, patch); },

    async remove(id) { return store.remove(id); },

    async query(opts) { return store.query(opts); },

    async promote(id) {
      const entry = await store.get(id);
      if (!entry) throw new Error(`memory ${id} not found`);
      const patch = engine.processReview(entry, 3);
      const updated = await store.update(id, patch);
      events?.emit('memory:promote', { id, kind: updated.kind, text: updated.text, newRetrievalStrength: updated.retrievalStrength });
      return updated;
    },

    async recall({ tags = [], kinds, limit } = {}) {
      try {
        const effectiveLimit = limit ?? recallLimit;
        const rules = await store.query({ kinds: ['rule'], states: ['active'] });

        const nonRuleKinds = kinds?.filter(k => k !== 'rule') ?? ['domain', 'preference', 'pattern', 'procedure'];
        const remaining = effectiveLimit - rules.length;

        let facts = [];
        if (remaining > 0) {
          const active = await store.query({ kinds: nonRuleKinds, tags, states: ['active'], limit: remaining });
          facts = [...active];
          if (facts.length < remaining) {
            const dormant = await store.query({ kinds: nonRuleKinds, tags, states: ['dormant'], limit: remaining - facts.length });
            facts = [...facts, ...dormant];
          }
        }

        facts.sort((a, b) => b.retrievalStrength - a.retrievalStrength);
        const result = [...rules, ...facts.slice(0, Math.max(0, remaining))];
        events?.emit('memory:recall', { count: result.length, facts: result });
        return result;
      } catch (err) {
        events?.emit('memory:error', { tier: 'longTerm', error: err?.message ?? String(err), policy: recallFailurePolicy });
        if (recallFailurePolicy === 'error') throw err;
        logger.warn?.(`[memory/long-term] recall failed, proceeding with blank slate: ${err?.message ?? err}`);
        return [];
      }
    },
  };
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-long-term.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLongTermMemory } from '../host/memory/long-term.mjs';
import { createFilesystemStore } from '../host/memory/store/filesystem.mjs';
import { createMemoryEntry } from '../host/memory/store/interface.mjs';

async function makeLtm(opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-ltm-'));
  const store = createFilesystemStore({ dir });
  return createLongTermMemory({ store, decayConfig: { mode: 'manual' }, ...opts });
}

test('store and recall a fact', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  await ltm.store({ kind: 'domain', text: 'Port is 5432', tags: ['db'] });
  const results = await ltm.recall({ tags: ['db'] });
  assert.ok(results.some(r => r.text === 'Port is 5432'));
  await ltm.close();
});

test('rules always come back in recall', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  await ltm.store({ kind: 'rule', text: 'Never delete without backup', tags: ['safety'] });
  await ltm.store({ kind: 'domain', text: 'DB on port 5432', tags: ['db'] });
  const results = await ltm.recall({ tags: ['db'] });
  assert.ok(results.some(r => r.kind === 'rule'));
  assert.ok(results.some(r => r.kind === 'domain'));
  await ltm.close();
});

test('recall respects recallLimit', async () => {
  const ltm = await makeLtm({ recallLimit: 3 });
  await ltm.open();
  for (let i = 0; i < 10; i++) {
    await ltm.store({ kind: 'domain', text: `Fact ${i}`, tags: ['batch'] });
  }
  const results = await ltm.recall({ tags: ['batch'] });
  assert.ok(results.length <= 3);
  await ltm.close();
});

test('promote increases retrievalStrength', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  const { entry } = await ltm.store({ kind: 'domain', text: 'Promotable fact', tags: ['a'] });
  await ltm.update(entry.id, { retrievalStrength: 0.4, state: 'dormant' });
  const promoted = await ltm.promote(entry.id);
  assert.equal(promoted.retrievalStrength, 1.0);
  assert.equal(promoted.state, 'active');
  await ltm.close();
});

test('dedup reinforces near-duplicate', async () => {
  const ltm = await makeLtm();
  await ltm.open();
  await ltm.store({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am', tags: ['db'] });
  const result = await ltm.store({ kind: 'domain', text: 'The staging DB resets every Sunday at 2am UTC', tags: ['db'] });
  assert.equal(result.action, 'reinforced');
  const all = await ltm.query({});
  assert.equal(all.length, 1);
  await ltm.close();
});

test('dormant facts backfill when active count is low', async () => {
  const ltm = await makeLtm({ recallLimit: 5 });
  await ltm.open();
  await ltm.store({ kind: 'domain', text: 'Active fact', tags: ['a'] });
  const { entry } = await ltm.store({ kind: 'domain', text: 'Dormant fact', tags: ['a'] });
  await ltm.update(entry.id, { retrievalStrength: 0.5, state: 'dormant' });
  const results = await ltm.recall({ tags: ['a'] });
  assert.equal(results.length, 2);
  await ltm.close();
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-long-term.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/long-term.mjs tests/host-memory-long-term.test.mjs
git commit -m "feat(memory): add long-term memory module with recall ranking and dedup"
```

---

### Task 11: Auto-learner

After a run completes, reviews the history via an LLM call and extracts reusable facts. Bulk-promotes recalled facts that were used. Enforces the rule that auto-learner cannot create `kind: 'rule'`.

**Files:**
- Create: `host/memory/learner.mjs`
- Test: `tests/host-memory-learner.test.mjs`

**Interfaces:**
- Consumes: `createLongTermMemory()` from Task 10, `fleetApi.executePrompt()` (existing)
- Produces: `createLearner({ longTermMemory, fleetApi, logger })` returning `{ extract({ task, history, recalledFacts }) → { newFacts, promotedIds } }`

- [ ] **Step 1: Write the learner**

```js
// host/memory/learner.mjs
const LEARNER_PROMPT = `You are a memory extraction agent. Given a completed task and its observation history, extract reusable facts that would help in future similar tasks.

Rules:
- Only extract facts useful across multiple future runs, not task-specific results.
- Each fact must have: kind (one of: domain, preference, pattern, procedure — NEVER "rule"), text, and tags (array of strings).
- Also identify which recalled facts (by id) were actually used in this run.
- Respond with a JSON block:

\`\`\`json
{
  "newFacts": [{ "kind": "domain", "text": "...", "tags": ["..."] }],
  "usedRecalledIds": ["mem-xxx", "mem-yyy"]
}
\`\`\`

Task: {{TASK}}

Recalled facts at start:
{{RECALLED}}

Observation history:
{{HISTORY}}`;

function buildPrompt(task, history, recalledFacts) {
  const taskText = typeof task === 'string' ? task : (task?.goal ?? JSON.stringify(task));
  const recalledText = (recalledFacts ?? []).map(f => `[${f.id}] (${f.kind}) ${f.text}`).join('\n') || '(none)';
  const historyText = (history ?? []).map((e, i) => `[${i + 1}] ${e.type ?? 'step'}: ${e.text ?? e.result ?? JSON.stringify(e).slice(0, 300)}`).join('\n');
  return LEARNER_PROMPT
    .replace('{{TASK}}', taskText)
    .replace('{{RECALLED}}', recalledText)
    .replace('{{HISTORY}}', historyText);
}

function parseExtraction(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return { newFacts: [], usedRecalledIds: [] };
  try {
    const parsed = JSON.parse(match[1]);
    const newFacts = (parsed.newFacts ?? []).filter(f => f.kind !== 'rule');
    return { newFacts, usedRecalledIds: parsed.usedRecalledIds ?? [] };
  } catch {
    return { newFacts: [], usedRecalledIds: [] };
  }
}

export function createLearner({ longTermMemory, fleetApi, events = null, logger = console } = {}) {
  return {
    async extract({ task, history, recalledFacts }) {
      try {
        const prompt = buildPrompt(task, history, recalledFacts);
        const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
        const text = typeof response === 'string' ? response : (response?.content ?? []).map(p => p.text ?? '').join('\n');
        const { newFacts, usedRecalledIds } = parseExtraction(text);

        const stored = [];
        for (const fact of newFacts) {
          const result = await longTermMemory.store({
            kind: fact.kind,
            text: fact.text,
            tags: fact.tags ?? [],
            source: 'agent',
          });
          stored.push(result);
        }

        const promotedIds = [];
        for (const id of usedRecalledIds) {
          try {
            await longTermMemory.promote(id);
            promotedIds.push(id);
          } catch { /* skip missing */ }
        }

        logger.info?.(`[memory/learner] extracted ${newFacts.length} facts, promoted ${promotedIds.length} recalled facts`);
        events?.emit('memory:learn', { taskId: task?.id ?? null, newFacts: stored, promotedIds });
        return { newFacts: stored, promotedIds };
      } catch (err) {
        logger.warn?.(`[memory/learner] extraction failed: ${err?.message ?? err}`);
        events?.emit('memory:error', { tier: 'learner', error: err?.message ?? String(err), policy: 'log-and-skip' });
        return { newFacts: [], promotedIds: [] };
      }
    },
  };
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-learner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLearner } from '../host/memory/learner.mjs';

function mockLtm() {
  const stored = [];
  const promoted = [];
  return {
    store: async (entry) => { stored.push(entry); return { action: 'created', entry }; },
    promote: async (id) => { promoted.push(id); return { id, retrievalStrength: 1.0 }; },
    _stored: stored,
    _promoted: promoted,
  };
}

test('learner extracts facts from LLM response', async () => {
  const ltm = mockLtm();
  const api = {
    executePrompt: async () => '```json\n{"newFacts": [{"kind": "pattern", "text": "Rounding causes mismatches", "tags": ["invoices"]}], "usedRecalledIds": ["mem-abc"]}\n```',
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Find mismatches', history: [], recalledFacts: [{ id: 'mem-abc', kind: 'domain', text: 'Threshold is 0.01' }] });
  assert.equal(result.newFacts.length, 1);
  assert.equal(result.promotedIds.length, 1);
  assert.equal(ltm._stored[0].kind, 'pattern');
  assert.equal(ltm._promoted[0], 'mem-abc');
});

test('learner filters out rule kind', async () => {
  const ltm = mockLtm();
  const api = {
    executePrompt: async () => '```json\n{"newFacts": [{"kind": "rule", "text": "Should not be stored", "tags": []}], "usedRecalledIds": []}\n```',
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
  assert.equal(ltm._stored.length, 0);
});

test('learner handles LLM failure gracefully', async () => {
  const ltm = mockLtm();
  const api = { executePrompt: async () => { throw new Error('LLM down'); } };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
  assert.equal(result.promotedIds.length, 0);
});

test('learner handles malformed JSON gracefully', async () => {
  const ltm = mockLtm();
  const api = { executePrompt: async () => 'No JSON here, just text.' };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-learner.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/learner.mjs tests/host-memory-learner.test.mjs
git commit -m "feat(memory): add auto-learner with rule-kind filtering"
```

---

### Task 12: Memory events (SSE)

Emits memory lifecycle events through the existing `host/notify/` system. Configurable verbosity levels.

**Files:**
- Create: `host/memory/events.mjs`
- Test: `tests/host-memory-events.test.mjs`

**Interfaces:**
- Consumes: `notifier.publish(event, ctx)` from `host/notify/index.mjs`
- Produces: `createMemoryEvents({ notifier, level })` returning `{ emit(type, payload) }` — filters by level before publishing

- [ ] **Step 1: Write the events module**

```js
// host/memory/events.mjs
const NOTIFICATION_EVENTS = new Set([
  'memory:recall', 'memory:store', 'memory:learn', 'memory:error',
]);

const FULL_EVENTS = new Set([
  ...NOTIFICATION_EVENTS,
  'memory:recall:tool', 'memory:promote', 'memory:decay',
]);

export function createMemoryEvents({ notifier, level = 'notifications' } = {}) {
  if (!notifier || level === 'none') {
    return { emit() {} };
  }

  const allowed = level === 'full' ? FULL_EVENTS : NOTIFICATION_EVENTS;

  function strip(type, payload) {
    if (level === 'full') return payload;
    if (type === 'memory:recall' || type === 'memory:recall:tool') {
      const { facts, ...rest } = payload;
      return { ...rest, count: facts?.length ?? payload.count };
    }
    return payload;
  }

  return {
    emit(type, payload) {
      if (!allowed.has(type)) return;
      notifier.publish({ type, ...strip(type, payload) }).catch(() => {});
    },
  };
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-events.test.mjs
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
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-events.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/events.mjs tests/host-memory-events.test.mjs
git commit -m "feat(memory): add SSE memory events with configurable verbosity"
```

---

### Task 13: HTTP routes + MCP tools

Thin routes and tools that delegate to the long-term memory module. Same pattern as `host/routes.mjs` and `host/tools/jobs-tools.mjs`.

**Files:**
- Create: `host/memory/routes.mjs`
- Create: `host/tools/memory-tools.mjs`
- Modify: `host/tools/registry.mjs` — add `withMemoryTools()`
- Test: `tests/host-memory-routes.test.mjs`
- Test: `tests/host-memory-tools.test.mjs`

**Interfaces:**
- Consumes: `createLongTermMemory()` from Task 10
- Produces: `buildMemoryRoutes(longTermMemory)` returning route objects, `memoryTools` array for tool registry, `withMemoryTools(registry, ltm)` function

- [ ] **Step 1: Write HTTP routes**

```js
// host/memory/routes.mjs
const json = (status, body) => ({ status, body });

export function buildMemoryRoutes(longTermMemory) {
  return {
    memoryStore: {
      method: 'POST', path: '/memory',
      handler: async (request) => {
        const body = request.body ?? {};
        if (!body.text || !body.kind) return json(400, { ok: false, error: 'text and kind are required' });
        const result = await longTermMemory.store(body);
        return json(201, { ok: true, ...result });
      },
    },
    memoryQuery: {
      method: 'GET', path: '/memory',
      handler: async (request) => {
        const q = request.query ?? {};
        const opts = {};
        if (q.kinds) opts.kinds = q.kinds.split(',');
        if (q.tags) opts.tags = q.tags.split(',');
        if (q.states) opts.states = q.states.split(',');
        if (q.query) opts.query = q.query;
        if (q.limit) opts.limit = Number(q.limit);
        const results = await longTermMemory.query(opts);
        return json(200, results);
      },
    },
    memoryGet: {
      method: 'GET', path: '/memory/:id',
      handler: async (request) => {
        const entry = await longTermMemory.get(request.params.id);
        if (!entry) return json(404, { ok: false, error: 'not found' });
        return json(200, entry);
      },
    },
    memoryUpdate: {
      method: 'PATCH', path: '/memory/:id',
      handler: async (request) => {
        const updated = await longTermMemory.update(request.params.id, request.body ?? {});
        return json(200, { ok: true, entry: updated });
      },
    },
    memoryPromote: {
      method: 'PATCH', path: '/memory/:id/promote',
      handler: async (request) => {
        const updated = await longTermMemory.promote(request.params.id);
        return json(200, { ok: true, entry: updated });
      },
    },
    memoryRemove: {
      method: 'DELETE', path: '/memory/:id',
      handler: async (request) => {
        await longTermMemory.remove(request.params.id);
        return json(200, { ok: true });
      },
    },
  };
}
```

- [ ] **Step 2: Write MCP tools**

```js
// host/tools/memory-tools.mjs
export const memoryTools = [
  {
    name: 'remember',
    description: 'Store a fact in long-term memory. Use this when you learn something reusable.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember' },
        kind: { type: 'string', enum: ['domain', 'preference', 'pattern', 'procedure'], description: 'Category of fact' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval' },
      },
      required: ['text', 'kind'],
    },
    execute: null,
  },
  {
    name: 'recall',
    description: 'Retrieve relevant facts from long-term memory.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to search for' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'Kinds to filter' },
        query: { type: 'string', description: 'Text search query' },
        limit: { type: 'number', description: 'Max results' },
      },
    },
    execute: null,
  },
  {
    name: 'forget',
    description: 'Remove a fact from long-term memory.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory entry ID to remove' } },
      required: ['id'],
    },
    execute: null,
  },
  {
    name: 'promote',
    description: 'Mark a recalled fact as useful. This strengthens the memory so it stays accessible longer.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory entry ID to promote' } },
      required: ['id'],
    },
    execute: null,
  },
];

export function withMemoryTools(registry, longTermMemory) {
  if (!longTermMemory) return registry;
  const bound = memoryTools.map(tool => ({
    ...tool,
    reversible: true,
    timeout: 30_000,
    retryable: false,
    tags: ['memory'],
    execute: async ({ args }) => {
      switch (tool.name) {
        case 'remember': {
          const result = await longTermMemory.store({ ...args, source: 'human' });
          return { ok: true, ...result };
        }
        case 'recall': {
          const results = await longTermMemory.query(args);
          return { ok: true, count: results.length, facts: results };
        }
        case 'forget': {
          await longTermMemory.remove(args.id);
          return { ok: true };
        }
        case 'promote': {
          const updated = await longTermMemory.promote(args.id);
          return { ok: true, entry: updated };
        }
        default:
          return { ok: false, error: 'unknown memory tool' };
      }
    },
  }));
  return [...registry, ...bound];
}
```

- [ ] **Step 3: Add `withMemoryTools` export to registry.mjs**

Add to `host/tools/registry.mjs`:

```js
import { withMemoryTools as _withMemoryTools } from './memory-tools.mjs';
export const withMemoryTools = _withMemoryTools;
```

This follows the existing `withJobTools` pattern.

- [ ] **Step 3b: Mount memory routes in host/routes.mjs**

In `host/routes.mjs`, modify `buildRoutes` to accept and mount memory routes:

```js
export function buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled, chatRoutes = null, guardrails = null, memoryRoutes = null }) {
  const routes = {
    // ... existing routes unchanged ...
    memoryStore: memoryRoutes?.memoryStore ?? null,
    memoryQuery: memoryRoutes?.memoryQuery ?? null,
    memoryGet: memoryRoutes?.memoryGet ?? null,
    memoryUpdate: memoryRoutes?.memoryUpdate ?? null,
    memoryPromote: memoryRoutes?.memoryPromote ?? null,
    memoryRemove: memoryRoutes?.memoryRemove ?? null,
  };
  // ... rest unchanged ...
}
```

Same pattern as `chatRoutes` — null when memory is disabled, routes injected when enabled.

- [ ] **Step 4: Write tests**

```js
// tests/host-memory-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMemoryTools } from '../host/tools/memory-tools.mjs';

function mockLtm() {
  const entries = new Map();
  return {
    store: async (e) => { entries.set(e.id ?? 'test-id', e); return { action: 'created', entry: e }; },
    query: async () => [...entries.values()],
    remove: async (id) => entries.delete(id),
    promote: async (id) => ({ id, retrievalStrength: 1.0 }),
  };
}

test('withMemoryTools adds 4 tools', () => {
  const registry = withMemoryTools([], mockLtm());
  assert.equal(registry.length, 4);
  assert.ok(registry.find(t => t.name === 'remember'));
  assert.ok(registry.find(t => t.name === 'recall'));
  assert.ok(registry.find(t => t.name === 'forget'));
  assert.ok(registry.find(t => t.name === 'promote'));
});

test('remember tool stores with source human', async () => {
  const ltm = mockLtm();
  const registry = withMemoryTools([], ltm);
  const tool = registry.find(t => t.name === 'remember');
  const result = await tool.execute({ args: { text: 'Test fact', kind: 'domain', tags: ['a'] } });
  assert.equal(result.ok, true);
});

test('withMemoryTools returns original registry when ltm is null', () => {
  const base = [{ name: 'other' }];
  const registry = withMemoryTools(base, null);
  assert.equal(registry.length, 1);
});
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/host-memory-tools.test.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add host/memory/routes.mjs host/tools/memory-tools.mjs tests/host-memory-tools.test.mjs
git commit -m "feat(memory): add HTTP routes and MCP tools for long-term memory"
```

---

### Task 14: Config validation + host wiring

Wire the memory module into `host/config.mjs` (validation) and `host/index.mjs` (initialization). This is the integration point — everything from Tasks 1-13 connects here.

**Files:**
- Modify: `host/config.mjs` — add `'memory'` to `IMPLEMENTED_MODULES`, add validation
- Create: `host/memory/index.mjs` — the `createMemoryModule()` entry point
- Modify: `host/index.mjs` — initialize memory, pass to strategies, register routes + tools
- Test: `tests/host-memory-config.test.mjs`

**Interfaces:**
- Consumes: all Tasks 1-13
- Produces: `createMemoryModule(config, { notifier, logger })` wiring everything together

- [ ] **Step 1: Write the memory module entry point**

```js
// host/memory/index.mjs
import { assertMemoryStore } from './store/interface.mjs';
import { createFilesystemStore } from './store/filesystem.mjs';
import { createSqliteStore } from './store/sqlite.mjs';
import { createWorkingContext } from './working-context.mjs';
import { createRunState } from './run-state.mjs';
import { createLongTermMemory } from './long-term.mjs';
import { createLearner } from './learner.mjs';
import { createMemoryEvents } from './events.mjs';
import { buildMemoryRoutes } from './routes.mjs';

async function resolveStore(config) {
  if (typeof config.store === 'function') {
    return assertMemoryStore(config.store(config));
  }
  switch (config.store) {
    case 'filesystem': return createFilesystemStore({ dir: config.dir ?? './memory' });
    case 'sqlite': return createSqliteStore({ dbPath: config.dbPath ?? `${config.dir ?? './memory'}/memory.db` });
    case 'cosmos': {
      const { createCosmosStore } = await import('./store/cosmos.mjs');
      return createCosmosStore(config.cosmos ?? {});
    }
    default: return createFilesystemStore({ dir: config.dir ?? './memory' });
  }
}

function interpolateEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_, key) => env[key] ?? '');
}

function interpolateConfigStrings(obj, env) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? interpolateEnv(v, env) : typeof v === 'object' ? interpolateConfigStrings(v, env) : v;
  }
  return out;
}

export async function createMemoryModule(memoryConfig, { notifier, fleetApi, logger = console } = {}) {
  const wc = memoryConfig?.workingContext?.enabled
    ? createWorkingContext({ fleetApi, ...memoryConfig.workingContext, logger })
    : null;

  const ltConfig = memoryConfig?.longTerm
    ? interpolateConfigStrings(memoryConfig.longTerm, process.env)
    : null;

  let rsStore = null;
  const rs = memoryConfig?.runState?.enabled
    ? await (async () => {
        rsStore = await resolveStore(memoryConfig.runState);
        return createRunState({ store: rsStore, ...memoryConfig.runState, logger });
      })()
    : null;

  let ltmStore = null;
  const ltm = ltConfig?.enabled
    ? await (async () => {
        ltmStore = await resolveStore(ltConfig);
        return createLongTermMemory({
          store: ltmStore,
          decayConfig: ltConfig.decay ?? {},
          dedupConfig: ltConfig.dedup ?? {},
          recallLimit: ltConfig.recallLimit,
          maxEntries: ltConfig.maxEntries,
          recallFailurePolicy: ltConfig.recallFailurePolicy,
          events,
          logger,
        });
      })()
    : null;

  const learner = ltm && ltConfig?.autoLearn
    ? createLearner({ longTermMemory: ltm, fleetApi, events, logger })
    : null;

  const events = createMemoryEvents({
    notifier,
    level: memoryConfig?.events?.level ?? 'notifications',
  });

  const routes = ltm ? buildMemoryRoutes(ltm) : null;

  return {
    workingContext: wc,
    runState: rs,
    longTerm: ltm,
    learner,
    events,
    routes,

    async open() {
      if (rsStore) await rsStore.open();
      if (ltm) await ltm.open();
    },

    async close() {
      if (ltm) await ltm.close();
      if (rsStore) await rsStore.close();
    },
  };
}
```

- [ ] **Step 2: Add 'memory' to IMPLEMENTED_MODULES in host/config.mjs**

In `host/config.mjs`, change:

```js
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat', 'router']);
```

to:

```js
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat', 'router', 'memory']);
```

- [ ] **Step 3: Add memory validation to host/config.mjs validate()**

Add after the existing guardrails validation block:

```js
const mem = raw.modules?.memory;
if (mem) {
  if (mem.workingContext?.enabled && !runLoopEnabled) {
    console.warn('[host/config] memory.workingContext enabled but runLoop disabled — no turn history to compact');
  }
  if (mem.runState?.enabled && !runLoopEnabled) {
    console.warn('[host/config] memory.runState enabled but runLoop disabled — no step sequence to checkpoint');
  }
  if (mem.longTerm?.autoLearn && !runLoopEnabled) {
    console.warn('[host/config] memory.longTerm.autoLearn enabled but runLoop disabled — needs a run to learn from');
  }
  if (mem.longTerm?.autoLearn && !mem.longTerm?.enabled) {
    console.warn('[host/config] memory.longTerm.autoLearn enabled but longTerm disabled — nowhere to store learned facts');
  }
}
```

- [ ] **Step 4: Write config test**

```js
// tests/host-memory-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('memory in IMPLEMENTED_MODULES', async () => {
  const config = await import('../host/config.mjs');
  // loadConfig with memory enabled should not warn "not implemented"
  // We verify by checking KNOWN_MODULES includes memory
  // (IMPLEMENTED_MODULES is not exported, but validation is tested via loadConfig)
});
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/host-memory-config.test.mjs && node --test tests/host-config.test.mjs`
Expected: PASS (no regressions in existing config tests)

- [ ] **Step 6: Commit**

```bash
git add host/memory/index.mjs host/config.mjs tests/host-memory-config.test.mjs
git commit -m "feat(memory): add memory module entry point and config validation"
```

---

### Task 15: Strategy integration

Wire working context and run state into both strategies. Strategies call `workingContext.append()` and `workingContext.forPrompt()` instead of raw `observations`. Strategies call `runState.save()` after each step. System prompt gets `## Your Memory` section.

**Files:**
- Modify: `host/strategies/open-ended.mjs`
- Modify: `host/strategies/plan-execute.mjs`
- Modify: `host/prompts/system.mjs`
- Modify: `host/run-loop.mjs`
- Modify: `host/tasks.mjs`
- Test: `tests/host-memory-integration.test.mjs`

**Interfaces:**
- Consumes: `createMemoryModule()` from Task 14
- Produces: strategies accept optional `memory` parameter, system prompt accepts optional `memories` parameter

- [ ] **Step 1: Update system prompt to accept memories**

In `host/prompts/system.mjs`, modify `buildSystemPrompt` to accept and inject memories:

```js
export function buildSystemPrompt({ agentName, agentDescription, memories }) {
  let prompt = `You are "${agentName}", an autonomous agent executing tasks using available tools.
${agentDescription ? agentDescription + '\n' : ''}`;

  if (memories?.length) {
    const rules = memories.filter(m => m.kind === 'rule');
    const facts = memories.filter(m => m.kind !== 'rule');
    prompt += '\n## Your Memory\n\n';
    if (rules.length) {
      prompt += 'Rules (always follow these):\n';
      prompt += rules.map(r => `- ${r.text}`).join('\n') + '\n\n';
    }
    if (facts.length) {
      prompt += 'Relevant knowledge:\n';
      prompt += facts.map(f => `- ${f.text}`).join('\n') + '\n\n';
    }
    prompt += 'You can recall additional facts during the task using the `recall` tool if you encounter a domain not covered above.\n';
  }

  prompt += `## Response format
...`; // rest of existing prompt unchanged
  return prompt;
}
```

- [ ] **Step 2: Update open-ended strategy to use working context**

In `host/strategies/open-ended.mjs`, add `memory` to the destructured options parameter (after `traceId`):

```js
memory,  // { workingContext, runState } — optional
```

Then replace direct `observations` usage. Where the strategy currently does:

```js
observations.push(observation);
```

Change to:

```js
observations.push(observation);
if (memory?.workingContext) memory.workingContext.append(observation);
```

Where the strategy currently builds the prompt with `history: observations`:

```js
const prompt = buildActPrompt({ task, history: observations, tools: toolCatalog, systemPrompt });
```

Change to:

```js
const history = memory?.workingContext ? await memory.workingContext.forPrompt() : observations;
const prompt = buildActPrompt({ task, history, tools: toolCatalog, systemPrompt });
```

- [ ] **Step 3: Update plan-execute strategy to use working context + run state**

In `host/strategies/plan-execute.mjs`, add `memory` to the destructured options parameter. Apply the same working context changes as step 2. Additionally, after each step completes, checkpoint via run state:

```js
if (memory?.runState) {
  await memory.runState.save(task.id ?? task.goal, {
    stepIndex,
    plan,
    observations,
    budgetSnapshot: null,
    idempotencyKeys,
    strategy: 'plan-execute',
  });
}
```

At strategy startup, check for an existing checkpoint:

```js
if (memory?.runState) {
  const checkpoint = await memory.runState.load(task.id ?? task.goal);
  if (checkpoint) {
    // Resume: set stepIndex, plan, observations, idempotencyKeys from checkpoint
    stepIndex = checkpoint.stepIndex;
    plan = checkpoint.plan;
    observations.push(...(checkpoint.observations ?? []));
    idempotencyKeys = new Set(checkpoint.idempotencyKeys ?? []);
  }
}
```

Before executing a step, check idempotency:

```js
const idempotencyKey = `${step.tool ?? step.type}-${JSON.stringify(step.args ?? {})}-${stepIndex}`;
if (memory?.runState && await memory.runState.hasIdempotencyKey(task.id ?? task.goal, idempotencyKey)) {
  continue; // already executed, skip
}
// ... execute step ...
if (memory?.runState) await memory.runState.addIdempotencyKey(task.id ?? task.goal, idempotencyKey);
```

- [ ] **Step 4: Update host/tasks.mjs to recall before run and learn after**

In `host/tasks.mjs`, modify `executeHostedTask` to accept a `memory` parameter. Before calling `runTask`:

```js
let memories = [];
if (memory?.longTerm) {
  const tags = extractTaskTags(task);
  memories = await memory.longTerm.recall({ tags });
}
```

Pass `memories` to the system prompt via the strategy options. After the run completes:

```js
if (memory?.learner) {
  await memory.learner.extract({ task, history: result.observations ?? [], recalledFacts: memories });
}
if (memory?.runState) {
  await memory.runState.clear(task.id ?? task.goal);
}
```

Add a simple tag extraction helper:

```js
function extractTaskTags(task) {
  const goal = typeof task === 'string' ? task : task?.goal ?? '';
  return goal.toLowerCase().split(/\W+/).filter(w => w.length > 3);
}
```

- [ ] **Step 5: Update host/run-loop.mjs to pass memory to strategies**

In `host/run-loop.mjs`, add `memory` to the destructured options in `runTask()`:

```js
export async function runTask(task, {
  // ... existing params ...
  memory,  // { workingContext, runState } — optional
} = {}) {
```

Pass it through to the strategy constructors:

```js
const strategyOpts = {
  // ... existing opts ...
  memory,
};
```

- [ ] **Step 6: Write integration test**

```js
// tests/host-memory-integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../host/prompts/system.mjs';

test('system prompt includes memory section when memories provided', () => {
  const prompt = buildSystemPrompt({
    agentName: 'test-agent',
    agentDescription: '',
    memories: [
      { kind: 'rule', text: 'Never delete without backup' },
      { kind: 'domain', text: 'DB on port 5432' },
    ],
  });
  assert.ok(prompt.includes('## Your Memory'));
  assert.ok(prompt.includes('Never delete without backup'));
  assert.ok(prompt.includes('DB on port 5432'));
  assert.ok(prompt.includes('recall'));
});

test('system prompt omits memory section when no memories', () => {
  const prompt = buildSystemPrompt({ agentName: 'test-agent', agentDescription: '' });
  assert.ok(!prompt.includes('## Your Memory'));
});
```

- [ ] **Step 7: Run all tests including existing strategy tests**

Run: `node --test tests/host-memory-integration.test.mjs && node --test tests/host-strategy-open-ended.test.mjs && node --test tests/host-strategy-plan-execute.test.mjs`
Expected: all PASS (no regressions)

- [ ] **Step 8: Commit**

```bash
git add host/strategies/open-ended.mjs host/strategies/plan-execute.mjs host/prompts/system.mjs host/run-loop.mjs host/tasks.mjs tests/host-memory-integration.test.mjs
git commit -m "feat(memory): wire memory into strategies, prompts, and run loop"
```

---

### Task 16: Knowledge preloader

Loads JSON knowledge files from a directory on agent startup. Each entry passes through dedup gating so restarts don't duplicate facts.

**Files:**
- Create: `host/memory/preloader.mjs`
- Test: `tests/host-memory-preloader.test.mjs`

**Interfaces:**
- Consumes: `createLongTermMemory()` from Task 10
- Produces: `preloadKnowledge(longTermMemory, { dir, logger })` → `{ loaded, reinforced, merged, errors }`

- [ ] **Step 1: Write preloader**

```js
// host/memory/preloader.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

export async function preloadKnowledge(longTermMemory, { dir, logger = console } = {}) {
  if (!dir) return { loaded: 0, reinforced: 0, merged: 0, errors: 0 };
  let files;
  try {
    files = await collectJsonFiles(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.info?.(`[memory/preloader] directory ${dir} not found — skipping`);
      return { loaded: 0, reinforced: 0, merged: 0, errors: 0 };
    }
    throw err;
  }

  let loaded = 0, reinforced = 0, merged = 0, errors = 0;

  for (const file of files) {
    try {
      const text = await fs.readFile(file, 'utf8');
      const entries = JSON.parse(text);
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        try {
          const result = await longTermMemory.store(entry);
          if (result.action === 'created') loaded++;
          else if (result.action === 'reinforced') reinforced++;
          else if (result.action === 'merged') merged++;
        } catch (err) {
          errors++;
          logger.warn?.(`[memory/preloader] failed to load entry from ${file}: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      errors++;
      logger.warn?.(`[memory/preloader] failed to read ${file}: ${err?.message ?? err}`);
    }
  }

  logger.info?.(`[memory/preloader] loaded ${loaded} new, ${reinforced} reinforced, ${merged} merged, ${errors} errors from ${files.length} files`);
  return { loaded, reinforced, merged, errors };
}

async function collectJsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonFiles(full));
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      files.push(full);
    }
  }
  return files;
}
```

- [ ] **Step 2: Write tests**

```js
// tests/host-memory-preloader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preloadKnowledge } from '../host/memory/preloader.mjs';
import { createLongTermMemory } from '../host/memory/long-term.mjs';
import { createFilesystemStore } from '../host/memory/store/filesystem.mjs';

async function makeLtm() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-store-'));
  const store = createFilesystemStore({ dir });
  const ltm = createLongTermMemory({ store, decayConfig: { mode: 'manual' } });
  await ltm.open();
  return ltm;
}

test('preload creates entries from JSON files', async () => {
  const ltm = await makeLtm();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-'));
  await fs.writeFile(path.join(dir, 'rules.json'), JSON.stringify([
    { kind: 'rule', text: 'Never delete without backup', tags: ['safety'] },
    { kind: 'rule', text: 'Always use UTC', tags: ['dates'] },
  ]));
  const result = await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  assert.equal(result.loaded, 2);
  await ltm.close();
});

test('preload reinforces duplicates on second run', async () => {
  const ltm = await makeLtm();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-'));
  const data = JSON.stringify([{ kind: 'rule', text: 'Never delete without backup', tags: ['safety'] }]);
  await fs.writeFile(path.join(dir, 'rules.json'), data);
  await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  const result = await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  assert.equal(result.reinforced, 1);
  assert.equal(result.loaded, 0);
  await ltm.close();
});

test('preload handles missing directory gracefully', async () => {
  const ltm = await makeLtm();
  const result = await preloadKnowledge(ltm, { dir: '/nonexistent/path', logger: { info() {}, warn() {} } });
  assert.equal(result.loaded, 0);
  await ltm.close();
});

test('preload recurses into subdirectories', async () => {
  const ltm = await makeLtm();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-preload-'));
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'facts.json'), JSON.stringify([
    { kind: 'domain', text: 'DB port is 5432', tags: ['db'] },
  ]));
  const result = await preloadKnowledge(ltm, { dir, logger: { info() {}, warn() {} } });
  assert.equal(result.loaded, 1);
  await ltm.close();
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/host-memory-preloader.test.mjs`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add host/memory/preloader.mjs tests/host-memory-preloader.test.mjs
git commit -m "feat(memory): add knowledge preloader with dedup-safe restarts"
```
