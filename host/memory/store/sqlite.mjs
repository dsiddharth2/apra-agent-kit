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
