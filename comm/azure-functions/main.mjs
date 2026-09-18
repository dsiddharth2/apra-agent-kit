// comm/azure-functions/main.mjs
// Entry point loaded by the Azure Functions host (wwwroot package.json "main").
// Registers HTTP functions (via the adapter), the orchestrator, and the activity.
import { app } from '@azure/functions';
import * as df from 'durable-functions';
import { startHost } from '../../host/index.mjs';
import { createAzureFunctionsAdapter, getHttpDurableClient } from './http.mjs';
import { registerDurableFunctions } from './index.mjs';

const clientInput = df.input.durableClient();

const started = await startHost({
  createAdapter: () => createAzureFunctionsAdapter({
    extraInputs: [clientInput],
    getClient: (context) => df.getClient(context),
  }),
  getDurableClient: getHttpDurableClient,
});

await registerDurableFunctions({
  pollMs: started.config.modules.dispatch?.durable?.pollMs ?? 2000,
  hostContextFactory: async () => ({
    api: started.fleetApi,
    activeDispatcher: started.dispatcher,
    toolRegistry: started.registry,
    runLoopConfig: started.runLoopConfig,
    budgetsConfig: started.budgetsConfig,
    guardrailsMod: started.guardrailsMod,
    notifier: started.notifier,
  }),
});

app.hook.appTerminate(async () => { await started.close(); });
