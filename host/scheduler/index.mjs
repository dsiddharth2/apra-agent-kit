import { assertSchedulerBackend } from './interface.mjs';
import { createInProcessScheduler } from './in-process.mjs';

export async function createSchedulerBackend(config, { jobs, toolRegistry, logger }) {
  if (config.backend === 'durable') {
    try {
      const { createDurableScheduler } = await import('./durable.mjs');
      return assertSchedulerBackend(createDurableScheduler(config, { jobs, toolRegistry, logger }));
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('scheduler backend "durable" is not available in this build');
      }
      throw err;
    }
  }
  return assertSchedulerBackend(createInProcessScheduler(config, { jobs, toolRegistry, logger }));
}
