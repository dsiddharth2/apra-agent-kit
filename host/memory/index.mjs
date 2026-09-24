// host/memory/index.mjs
import { assertMemoryStore } from './store/interface.mjs';
import { createFilesystemStore } from './store/filesystem.mjs';
import { createSqliteStore } from './store/sqlite.mjs';
import { createWorkingContext } from './working-context.mjs';
import { createRunState } from './run-state.mjs';
import { createLongTermMemory } from './long-term.mjs';
import { createLearner } from './learner.mjs';
import { createMemoryEvents } from './events.mjs';
import { buildMemoryRoutes } from './routes.mjs';
import { preloadKnowledge } from './preloader.mjs';

async function resolveStore(config) {
  if (typeof config.store === 'function') {
    return assertMemoryStore(config.store(config));
  }
  switch (config.store) {
    case 'filesystem': return createFilesystemStore({ dir: config.dir ?? './memory' });
    case 'sqlite': return createSqliteStore({ dbPath: config.dbPath ?? `${config.dir ?? './memory'}/memory.db` });
    case 'cosmos': {
      const { createCosmosStore } = await import('./store/cosmos.mjs');
      return createCosmosStore(config.cosmos ?? {});
    }
    default: return createFilesystemStore({ dir: config.dir ?? './memory' });
  }
}

function interpolateEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_, key) => env[key] ?? '');
}

function interpolateConfigStrings(obj, env) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? interpolateEnv(v, env) : typeof v === 'object' ? interpolateConfigStrings(v, env) : v;
  }
  return out;
}

export async function createMemoryModule(memoryConfig, { notifier, fleetApi, logger = console } = {}) {
  const events = createMemoryEvents({
    notifier,
    level: memoryConfig?.events?.level ?? 'notifications',
  });

  const wcOptions = memoryConfig?.workingContext?.enabled
    ? { fleetApi, ...memoryConfig.workingContext, logger }
    : null;
  const wc = wcOptions ? createWorkingContext(wcOptions) : null;

  const ltConfig = memoryConfig?.longTerm
    ? interpolateConfigStrings(memoryConfig.longTerm, process.env)
    : null;

  let rsStore = null;
  const rs = memoryConfig?.runState?.enabled
    ? await (async () => {
        rsStore = await resolveStore(memoryConfig.runState);
        return createRunState({ ...memoryConfig.runState, store: rsStore, logger });
      })()
    : null;

  let ltmStore = null;
  const ltm = ltConfig?.enabled
    ? await (async () => {
        ltmStore = await resolveStore(ltConfig);
        return createLongTermMemory({
          store: ltmStore,
          decayConfig: ltConfig.decay ?? {},
          dedupConfig: ltConfig.dedup ?? {},
          recallLimit: ltConfig.recallLimit,
          maxEntries: ltConfig.maxEntries,
          recallFailurePolicy: ltConfig.recallFailurePolicy,
          events,
          logger,
        });
      })()
    : null;

  const learner = ltm && ltConfig?.autoLearn
    ? createLearner({ longTermMemory: ltm, fleetApi, events, logger })
    : null;

  const routes = ltm ? buildMemoryRoutes(ltm) : null;

  return {
    workingContext: wc,
    createRunWorkingContext() {
      return wcOptions ? createWorkingContext(wcOptions) : null;
    },
    runState: rs,
    longTerm: ltm,
    learner,
    events,
    routes,

    async open() {
      if (rsStore) await rsStore.open();
      if (ltm) {
        await ltm.open();
        if (ltConfig?.preloadDir) {
          try {
            await preloadKnowledge(ltm, { dir: ltConfig.preloadDir, logger });
          } catch (err) {
            logger.warn?.(`[memory/preloader] preload failed: ${err?.message ?? err}`);
          }
        }
      }
    },

    async close() {
      if (ltm) {
        try {
          await ltm.close();
        } catch (err) {
          logger.warn?.(`[memory] failed to close long-term memory: ${err?.message ?? err}`);
        }
      }
      if (rsStore) {
        try {
          await rsStore.close();
        } catch (err) {
          logger.warn?.(`[memory] failed to close run-state store: ${err?.message ?? err}`);
        }
      }
    },
  };
}
