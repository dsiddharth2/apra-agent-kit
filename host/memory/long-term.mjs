// host/memory/long-term.mjs
import { createFsrs6Engine } from './decay/fsrs6.mjs';
import { createDecayTimer } from './decay/timer.mjs';
import { createDedupGate } from './dedup/index.mjs';
import { createMemoryEntry } from './store/interface.mjs';

export function createLongTermMemory({
  store,
  decayConfig = {},
  dedupConfig = {},
  recallLimit = 20,
  maxEntries = 500,
  recallFailurePolicy = 'blank-slate',
  autoLearn = false,
  events = null,
  logger = console,
} = {}) {
  const engine = createFsrs6Engine({
    thresholds: decayConfig.thresholds,
  });

  const timer = decayConfig.mode !== 'none' && decayConfig.mode !== 'manual'
    ? createDecayTimer(store, {
        engine,
        intervalMs: decayConfig.intervalMs,
        thresholds: decayConfig.thresholds,
        purgeOnDecay: decayConfig.purgeOnDecay,
        purgeAfterDays: decayConfig.purgeAfterDays,
        events,
        logger,
      })
    : null;

  const dedup = dedupConfig.enabled !== false
    ? createDedupGate({
        store,
        engine,
        strategy: dedupConfig.strategy,
        reinforceThreshold: dedupConfig.reinforceThreshold,
        mergeThreshold: dedupConfig.mergeThreshold,
      })
    : null;

  return {
    engine,
    timer,

    async open() {
      await store.open();
      timer?.start();
    },

    async close() {
      timer?.stop();
      await store.close();
    },

    async store(entry) {
      const memEntry = entry.id && entry.createdAt ? entry : createMemoryEntry(entry);
      const atCap = Boolean(maxEntries) && (await store.count({})) >= maxEntries;
      let result;
      if (dedup) {
        result = await dedup.process(memEntry, { allowCreate: !atCap });
      } else if (atCap) {
        result = { action: 'rejected', reason: 'max_entries', entry: memEntry };
      } else {
        await store.store(memEntry);
        result = { action: 'created', entry: memEntry };
      }
      if (result.action === 'rejected') {
        logger.warn?.(`[memory/long-term] maxEntries (${maxEntries}) reached — rejecting new entry`);
        return result;
      }
      events?.emit('memory:store', { entry: result.entry ?? memEntry, dedupResult: result.action });
      return result;
    },

    async get(id) { return store.get(id); },

    async update(id, patch) { return store.update(id, patch); },

    async remove(id) { return store.remove(id); },

    async query(opts) { return store.query(opts); },

    async promote(id) {
      const entry = await store.get(id);
      if (!entry) throw new Error(`memory ${id} not found`);
      const patch = engine.processReview(entry, 3);
      const updated = await store.update(id, patch);
      events?.emit('memory:promote', { id, kind: updated.kind, text: updated.text, newRetrievalStrength: updated.retrievalStrength });
      return updated;
    },

    async recall({ tags = [], kinds, limit, taskId } = {}) {
      try {
        const effectiveLimit = limit ?? recallLimit;
        const rules = await store.query({ kinds: ['rule'], states: ['active'] });

        const nonRuleKinds = kinds?.filter(k => k !== 'rule') ?? ['domain', 'preference', 'pattern', 'procedure'];
        const room = Math.max(0, effectiveLimit - rules.length);

        let facts = [];
        if (room > 0 && nonRuleKinds.length > 0) {
          const active = await store.query({ kinds: nonRuleKinds, tags, states: ['active'], limit: room });
          facts = [...active];
          if (facts.length < room) {
            const dormant = await store.query({ kinds: nonRuleKinds, tags, states: ['dormant'], limit: room - facts.length });
            facts = [...facts, ...dormant];
          }
        }

        facts.sort((a, b) => b.retrievalStrength - a.retrievalStrength);
        const result = [...rules, ...facts].slice(0, effectiveLimit);
        events?.emit('memory:recall', {
          count: result.length,
          facts: result,
          ...(taskId != null && taskId !== '' ? { taskId } : {}),
        });
        return result;
      } catch (err) {
        events?.emit('memory:error', { tier: 'longTerm', error: err?.message ?? String(err), policy: recallFailurePolicy });
        if (recallFailurePolicy === 'error') throw err;
        logger.warn?.(`[memory/long-term] recall failed, proceeding with blank slate: ${err?.message ?? err}`);
        return [];
      }
    },
  };
}
