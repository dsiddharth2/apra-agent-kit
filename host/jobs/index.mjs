import { assertJobsBackend } from './interface.mjs';
import { createInProcessJobs } from './in-process.mjs';
import { createMemoryStore } from './store/memory.mjs';
import { createSqliteStore } from './store/sqlite.mjs';

export async function createJobsBackend(dispatchConfig, {
  runJob, notifier = null, logger = console, capacity = 1, allowHttpCallbacks = false, durableClient = null,
}) {
  if (dispatchConfig.backend === 'durable') {
    const { createDurableJobs } = await import('./durable.mjs');
    return assertJobsBackend(createDurableJobs({ client: durableClient, config: dispatchConfig, notifier, logger, allowHttpCallbacks }));
  }
  const store = dispatchConfig.store.kind === 'memory'
    ? createMemoryStore()
    : createSqliteStore({ dbPath: dispatchConfig.store.dbPath });
  return assertJobsBackend(createInProcessJobs({
    store, runJob, notifier, logger, allowHttpCallbacks,
    config: { ...dispatchConfig, capacity },
  }));
}
