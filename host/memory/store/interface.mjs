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
