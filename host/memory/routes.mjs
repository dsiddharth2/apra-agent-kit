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
