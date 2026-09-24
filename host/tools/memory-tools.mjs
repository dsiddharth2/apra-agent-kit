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
