// Config shipped inside the Functions image. Same modules as the repo config,
// with the Azure adapter and the Durable jobs backend.
export default {
  name: 'apra-agent-kit',
  description: 'Fleet Agent Kit — Azure Functions host',
  fleet: {},
  comm: { adapter: 'azure-functions' },
  modules: {
    runLoop: {
      enabled: true, strategy: 'plan-execute',
      maxReplanAttempts: 3, maxReviewAttempts: 2, maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible', maxNoActionTurns: 3,
    },
    budgets: { enabled: true, maxIterations: 25, maxCostUsd: 5.00, maxTokens: 500_000, timeoutMs: 600_000 },
    guardrails: { enabled: true, defaultPolicy: 'allow', validateInputs: true, dryRunMode: false },
    dispatch: { enabled: true, backend: 'durable', maxQueueSize: 100 },
    notify: { sse: { enabled: true } },
    chat: { enabled: true, title: 'Fleet Agent Kit — Azure Functions' },
  },
};
