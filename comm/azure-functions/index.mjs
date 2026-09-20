// comm/azure-functions/index.mjs
// Registers the orchestrator and activity with Durable Functions.
export async function registerDurableFunctions({ hostContextFactory, pollMs = 2000 }) {
  const df = await import('durable-functions');
  const { ORCHESTRATOR_NAME, ACTIVITY_NAME } = await import('../../host/jobs/durable.mjs');
  const { runTaskOrchestrator } = await import('./orchestrator.mjs');
  const { createRunTaskActivity, setHostContextFactory } = await import('./activity.mjs');

  setHostContextFactory(hostContextFactory);
  const clientInput = df.input.durableClient();
  df.app.orchestration(ORCHESTRATOR_NAME, runTaskOrchestrator);
  df.app.activity(ACTIVITY_NAME, {
    extraInputs: [clientInput],
    handler: createRunTaskActivity({ getClient: (context) => df.getClient(context), pollMs }),
  });
  return { df, clientInput };
}

const ACTIVE_STATUSES = ['Pending', 'Running', 'Suspended', 'ContinuedAsNew'];

export async function purgeStaleOrchestrations(client, { logger = console } = {}) {
  try {
    const stale = await client.getStatusBy({ runtimeStatus: ACTIVE_STATUSES });
    if (!stale.length) return;
    logger.warn(`[durable] purging ${stale.length} stale orchestration(s) from previous run`);
    for (const inst of stale) {
      try {
        await client.terminate(inst.instanceId, 'purged at startup — stale from previous host');
        await client.purgeInstanceHistory(inst.instanceId);
      } catch (err) {
        logger.warn(`[durable] purge ${inst.instanceId} failed: ${err?.message ?? err}`);
      }
    }
    const completed = await client.getStatusBy({ runtimeStatus: ['Completed', 'Failed', 'Terminated', 'Canceled'] });
    if (completed.length) {
      await client.purgeInstanceHistoryBy({
        createdTimeTo: new Date(),
        runtimeStatus: ['Completed', 'Failed', 'Terminated', 'Canceled'],
      });
      logger.warn(`[durable] purged ${completed.length} completed orchestration(s)`);
    }
  } catch (err) {
    logger.warn(`[durable] startup purge failed (non-fatal): ${err?.message ?? err}`);
  }
}
