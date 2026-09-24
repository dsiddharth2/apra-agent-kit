// host/tools/memory-tools.mjs
import * as z from 'zod/v4';

const memoryKind = z.enum(['domain', 'preference', 'pattern', 'procedure']);

export const memoryTools = [
  {
    name: 'remember',
    description: 'Store a fact in long-term memory. Use this when you learn something reusable.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      kind: memoryKind.describe('Category of fact'),
      tags: z.array(z.string()).optional().describe('Tags for retrieval'),
    }),
    run: null,
  },
  {
    name: 'recall',
    description: 'Retrieve relevant facts from long-term memory.',
    inputSchema: z.object({
      tags: z.array(z.string()).optional().describe('Tags to search for'),
      kinds: z.array(z.string()).optional().describe('Kinds to filter'),
      query: z.string().optional().describe('Text search query'),
      limit: z.number().optional().describe('Max results'),
    }),
    run: null,
  },
  {
    name: 'forget',
    description: 'Remove a fact from long-term memory.',
    inputSchema: z.object({
      id: z.string().describe('Memory entry ID to remove'),
    }),
    run: null,
  },
  {
    name: 'promote',
    description: 'Mark a recalled fact as useful. This strengthens the memory so it stays accessible longer.',
    inputSchema: z.object({
      id: z.string().describe('Memory entry ID to promote'),
    }),
    run: null,
  },
];

export function withMemoryTools(registry, longTermMemory, events = null) {
  if (!longTermMemory) return registry;
  const bound = memoryTools.map(tool => ({
    ...tool,
    reversible: true,
    timeout: 30_000,
    retryable: false,
    tags: ['memory'],
    async run({ args }) {
      switch (tool.name) {
        case 'remember': {
          const result = await longTermMemory.store({ ...args, source: 'human' });
          if (result?.action === 'rejected') return { ok: false, ...result };
          return { ok: true, ...result };
        }
        case 'recall': {
          const results = await longTermMemory.query(args);
          events?.emit('memory:recall:tool', { count: results.length, facts: results });
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
