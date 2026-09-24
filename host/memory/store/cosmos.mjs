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
      // Cosmos is eventually consistent; a query immediately after store may miss the entry.
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
      // Cosmos is eventually consistent; recently stored entries may not appear yet.
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
      const sql = `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.retrievalStrength DESC`;
      const { resources } = await container.items.query({ query: sql, parameters: params }).fetchAll();
      let results = resources.map(fromDoc);
      if (tags?.length) results = results.filter(e => e.tags.some(t => tags.includes(t)));
      if (limit) results = results.slice(0, limit);
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
