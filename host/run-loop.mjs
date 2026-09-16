// host/run-loop.mjs
import { createOpenEndedStrategy } from './strategies/open-ended.mjs';
import { createPlanExecuteStrategy } from './strategies/plan-execute.mjs';

export async function runTask(task, {
  strategy = 'open-ended',
  tools,
  fleetApi,
  signal,
  budgets,
  guardrails,
  maxReplanAttempts = 3,
  maxReviewAttempts = 2,
  maxStepReviewAttempts = 2,
  maxNoActionTurns = 3,
  minReviewPolicy = 'irreversible',
  agentName,
  agentDescription,
} = {}) {
  const strategyOpts = {
    task, tools, fleetApi, guardrails,
    maxReplanAttempts, maxReviewAttempts, maxStepReviewAttempts,
    maxNoActionTurns, minReviewPolicy, agentName, agentDescription,
  };

  const strat = strategy === 'plan-execute'
    ? createPlanExecuteStrategy(strategyOpts)
    : createOpenEndedStrategy(strategyOpts);

  let result = null;
  let status = 'failed';

  try {
    for await (const event of strat.iterate()) {
      if (signal?.aborted) {
        status = 'cancelled';
        break;
      }

      if (event.type === 'prompt_usage' && budgets) {
        const chars = typeof event.text === 'string' ? event.text.length : 0;
        budgets.record({ responseChars: chars });
        const check = budgets.check();
        if (!check.ok) {
          status = 'budget_exceeded';
          result = { budgetReason: check.reason, limit: check.limit, actual: check.actual };
          break;
        }
      }

      if (event.type === 'done') {
        result = event.result;
        status = 'completed';
        break;
      }

      if (event.type === 'error') {
        status = 'failed';
        result = { error: event.reason, message: event.message };
        break;
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      status = 'cancelled';
    } else {
      status = 'failed';
      result = { error: 'unexpected', message: String(err?.message ?? err) };
    }
  }

  const history = strat.history().map(o =>
    o.type === 'observation' && o.result?.error ? { ...o, ...o.result } : o,
  );

  return {
    status,
    result,
    history,
    budget: budgets?.snapshot() ?? null,
  };
}
