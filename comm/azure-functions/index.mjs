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
