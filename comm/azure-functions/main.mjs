// comm/azure-functions/main.mjs
// Entry point loaded by the Azure Functions host (wwwroot package.json "main").
// Registers HTTP functions (via the adapter), the orchestrator, and the activity.
import { app } from '@azure/functions';
import * as df from 'durable-functions';
import { startHost } from '../../host/index.mjs';
import { createAzureFunctionsAdapter } from './http.mjs';
import { registerDurableFunctions } from './index.mjs';

// HTTP triggers get a Durable client per invocation. host/jobs/durable.mjs wants
// one stable client object, so proxy every method to the current invocation's client.
let currentContext = null;
const clientInput = df.input.durableClient();
const durableClient = new Proxy({}, {
  get: (_, method) => (...args) => df.getClient(currentContext)[method](...args),
});
app.hook.preInvocation((ctx) => { currentContext = ctx.invocationContext; });

const started = await startHost({
  createAdapter: () => createAzureFunctionsAdapter({ extraInputs: [clientInput] }),
  durableClient,
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
