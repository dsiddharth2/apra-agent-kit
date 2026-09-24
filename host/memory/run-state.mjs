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
