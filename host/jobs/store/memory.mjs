import { TERMINAL_STATUSES } from '../record.mjs';

const clone = (v) => structuredClone(v);

export function createMemoryStore() {
  const records = new Map();
  const events = new Map(); // jobId → [{ seq, ...event }]

  return {
    async open() {},
    async close() {},

    async insert(record) {
      if (records.has(record.id)) throw new Error(`job ${record.id} already exists`);
      records.set(record.id, clone(record));
    },

    async get(id) {
      const r = records.get(id);
      return r ? clone(r) : null;
    },

    async update(id, patch) {
      const r = records.get(id);
      if (!r) throw new Error(`job ${id} not found`);
      const next = { ...r, ...clone(patch) };
      records.set(id, next);
      return clone(next);
    },

    async claim(id, startedAt) {
      const r = records.get(id);
      if (!r || r.status !== 'queued') return false;
      records.set(id, { ...r, status: 'processing', startedAt });
      return true;
    },

    async listByStatus(status) {
      return [...records.values()]
        .filter(r => r.status === status)
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id))
        .map(clone);
    },

    async countByStatus() {
      const out = {};
      for (const r of records.values()) out[r.status] = (out[r.status] ?? 0) + 1;
      return out;
    },

    async appendEvent(jobId, event) {
      const list = events.get(jobId) ?? [];
      const seq = list.length + 1;
      list.push({ seq, ...clone(event) });
      events.set(jobId, list);
      return seq;
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      return (events.get(jobId) ?? []).filter(e => e.seq > afterSeq).map(clone);
    },

    async purgeFinishedBefore(isoTimestamp) {
      let n = 0;
      for (const [id, r] of records) {
        if (TERMINAL_STATUSES.has(r.status) && r.finishedAt && r.finishedAt < isoTimestamp) {
          records.delete(id); events.delete(id); n += 1;
        }
      }
      return n;
    },
  };
}
