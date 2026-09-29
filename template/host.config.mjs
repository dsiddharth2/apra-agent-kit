// Host configuration for {{PROJECT_NAME}}.
// See docs/getting-started.md for a walkthrough of each option.
export default {
  name: '{{PROJECT_NAME}}',
  description: 'A Fleet agent built with the workflow kit.',

  agentDescription: `Describe your agent's domain expertise, which tools to use
and when, and any domain-specific rules. This becomes the system prompt extension
the LLM sees before every task. Be directive — "ALWAYS use the X tool" is better
than "you can use X".`,

  fleet: {},

  comm: {
    adapter: 'express',
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,
    },
    dispatch: {
      enabled: true,
      store: { kind: 'sqlite', dbPath: './jobs.db' },
      concurrency: 2,
      maxQueueSize: 10,
    },
    notify: {
      sse: { enabled: true },
    },
    chat: {
      enabled: true,
      title: '{{PROJECT_NAME}}',
      themes: ['apra'],
    },
    router: {
      enabled: true,
      fallbackStrategy: 'open-ended',
    },

    // -- Scheduler (uncomment to enable recurring workflow runs) --
    //
    // scheduler: {
    //   enabled: true,
    //   schedules: [
    //     {
    //       name: 'example-schedule',
    //       workflow: 'hello',           // must match a registered workflow
    //       args: {},                     // workflow arguments
    //       cron: '0 9 * * *',           // 9am daily
    //       timezone: 'UTC',             // IANA timezone
    //       overlap: 'queue',            // 'queue' or 'skip'
    //     },
    //   ],
    // },

    // -- Memory (uncomment tiers you need) --
    //
    // memory: {
    //   // Conversation context — carries prior chat turns across tasks in a session.
    //   // The agent can reference earlier results ("book the cheapest one").
    //   conversationContext: {
    //     enabled: true,
    //     mode: 'store',                      // 'store' (server persists) or 'passthrough' (caller sends history)
    //     store: 'sqlite',
    //     dbPath: './memory/conversation.db',
    //     maxRecentTurns: 6,                  // verbatim turns in prompt
    //     maxTotalTurns: 20,                  // cap per session
    //     compactionStrategy: 'summarise',    // 'summarise' or 'sliding-window'
    //     answerMaxChars: 500,
    //   },
    //
    //   // Run state — crash recovery for interrupted tasks.
    //   runState: {
    //     enabled: true,
    //     store: 'sqlite',
    //     dbPath: './memory/run-state.db',
    //   },
    //
    //   // Long-term memory — cross-session facts with FSRS-6 decay.
    //   // Adds remember/recall/forget/promote tools to the agent.
    //   longTerm: {
    //     enabled: true,
    //     store: 'sqlite',
    //     dbPath: './memory/memory.db',
    //     autoLearn: true,                    // extract facts after each task
    //     decay: { mode: 'auto', intervalMs: 120_000 },
    //     dedup: { enabled: true },
    //     recallLimit: 20,
    //     maxEntries: 500,
    //   },
    // },
  },
};
