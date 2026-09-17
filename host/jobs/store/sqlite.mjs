// host/jobs/store/sqlite.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TERMINAL_STATUSES } from '../record.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  record       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  at     TEXT NOT NULL,
  event  TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
`;

export function createSqliteStore({ dbPath }) {
  if (!dbPath) throw new Error('createSqliteStore requires dbPath');
  let db = null;
  let stmts = null;

  const ensureOpen = () => { if (!db) throw new Error('sqlite store is not open'); };
  const terminalList = [...TERMINAL_STATUSES].map(s => `'${s}'`).join(',');

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
          insert: db.prepare('INSERT INTO jobs (id, status, submitted_at, started_at, finished_at, record) VALUES (?, ?, ?, ?, ?, ?)'),
          get: db.prepare('SELECT record FROM jobs WHERE id = ?'),
          update: db.prepare('UPDATE jobs SET status = ?, started_at = ?, finished_at = ?, record = ? WHERE id = ?'),
          claim: db.prepare("UPDATE jobs SET status = 'processing', started_at = ?, record = json_set(record, '$.status', 'processing', '$.startedAt', ?) WHERE id = ? AND status = 'queued'"),
          byStatus: db.prepare('SELECT record FROM jobs WHERE status = ? ORDER BY submitted_at ASC, id ASC'),
          count: db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
          nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE job_id = ?'),
          appendEvent: db.prepare('INSERT INTO events (job_id, seq, at, event) VALUES (?, ?, ?, ?)'),
          events: db.prepare('SELECT seq, event FROM events WHERE job_id = ? AND seq > ? ORDER BY seq ASC'),
          purgeEvents: db.prepare(`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE status IN (${terminalList}) AND finished_at IS NOT NULL AND finished_at < ?)`),
          purgeJobs: db.prepare(`DELETE FROM jobs WHERE status IN (${terminalList}) AND finished_at IS NOT NULL AND finished_at < ?`),
        };
      } catch (err) {
        try { db.close(); } catch { /* preserve original error */ }
        db = null;
        stmts = null;
        throw err;
      }
    },

    async close() {
      if (!db) return;
      db.close(); db = null; stmts = null;
    },

    async insert(record) {
      ensureOpen();
      if (stmts.get.get(record.id)) throw new Error(`job ${record.id} already exists`);
      stmts.insert.run(record.id, record.status, record.submittedAt, record.startedAt, record.finishedAt, JSON.stringify(record));
    },

    async get(id) {
      ensureOpen();
      const row = stmts.get.get(id);
      return row ? JSON.parse(row.record) : null;
    },

    async update(id, patch) {
      ensureOpen();
      const row = stmts.get.get(id);
      if (!row) throw new Error(`job ${id} not found`);
      const next = { ...JSON.parse(row.record), ...patch };
      stmts.update.run(next.status, next.startedAt, next.finishedAt, JSON.stringify(next), id);
      return next;
    },

    async claim(id, startedAt) {
      ensureOpen();
      const { changes } = stmts.claim.run(startedAt, startedAt, id);
      return changes === 1;
    },

    async listByStatus(status) {
      ensureOpen();
      return stmts.byStatus.all(status).map(r => JSON.parse(r.record));
    },

    async countByStatus() {
      ensureOpen();
      const out = {};
      for (const row of stmts.count.all()) out[row.status] = Number(row.n);
      return out;
    },

    async appendEvent(jobId, event) {
      ensureOpen();
      const { seq } = stmts.nextSeq.get(jobId);
      stmts.appendEvent.run(jobId, seq, event.at, JSON.stringify(event));
      return Number(seq);
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      ensureOpen();
      return stmts.events.all(jobId, afterSeq).map(r => ({ seq: Number(r.seq), ...JSON.parse(r.event) }));
    },

    async purgeFinishedBefore(isoTimestamp) {
      ensureOpen();
      stmts.purgeEvents.run(isoTimestamp);
      const { changes } = stmts.purgeJobs.run(isoTimestamp);
      return Number(changes);
    },
  };
}
