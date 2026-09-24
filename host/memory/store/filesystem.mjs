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
