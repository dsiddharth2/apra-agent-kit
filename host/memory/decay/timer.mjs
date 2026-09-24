// host/memory/decay/timer.mjs
import { createFsrs6Engine } from './fsrs6.mjs';
import { DEFAULT_THRESHOLDS } from './interface.mjs';

export async function runDecayPass(store, {
  engine = createFsrs6Engine(),
  thresholds = DEFAULT_THRESHOLDS,
  purgeOnDecay = false,
  purgeAfterDays = 90,
} = {}) {
  const now = new Date();
  const candidates = await store.query({ states: ['active', 'dormant', 'silent'] });
  let updated = 0;
  const stateChanges = [];

  for (const entry of candidates) {
    if (!engine.shouldProcess(entry)) continue;
    const r = engine.computeRetrievability(entry, now);
    const newState = engine.computeState(r, thresholds);
    if (Math.abs(r - entry.retrievalStrength) > 0.001 || newState !== entry.state) {
      const oldState = entry.state;
      await store.update(entry.id, { retrievalStrength: r, state: newState });
      updated++;
      if (oldState !== newState) stateChanges.push({ id: entry.id, from: oldState, to: newState });
    }
  }

  let purged = 0;
  if (purgeOnDecay) {
    const cutoff = new Date(now.getTime() - purgeAfterDays * 86400000).toISOString();
    purged = await store.purge({ states: ['unavailable'], olderThan: cutoff });
  }

  return { processed: candidates.length, updated, stateChanges, purged };
}

export function createDecayTimer(store, {
  engine,
  intervalMs = 3600000,
  thresholds,
  purgeOnDecay = false,
  purgeAfterDays = 90,
  logger = console,
} = {}) {
  let handle = null;

  const opts = { engine, thresholds, purgeOnDecay, purgeAfterDays };
  let inFlight = false;

  async function tick() {
    if (inFlight) return null;
    inFlight = true;
    try {
      const result = await runDecayPass(store, opts);
      if (result.updated > 0) {
        logger.info?.(`[memory/decay] updated ${result.updated}/${result.processed} entries, ${result.stateChanges.length} state changes`);
      }
      if (result.purged > 0) {
        logger.info?.(`[memory/decay] purged ${result.purged} unavailable entries`);
      }
      return result;
    } catch (err) {
      logger.warn?.(`[memory/decay] pass failed: ${err?.message ?? err}`);
      return null;
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (handle) return;
      handle = setInterval(tick, intervalMs);
      if (handle.unref) handle.unref();
    },
    stop() {
      if (handle) { clearInterval(handle); handle = null; }
    },
    tick,
  };
}
