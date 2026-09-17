// host/tasks.mjs
// The one function both the sync /task route and every jobs backend call.
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { runTask } from './run-loop.mjs';
import { createBudgets } from './budgets.mjs';

export const PROGRESS_TYPES = new Set(['plan', 'action', 'observation', 'review', 'step_review']);

export function describeEvent(event) {
  switch (event.type) {
    case 'action':      return `calling ${event.tool}`;
    case 'observation': return `observed ${event.tool ?? event.stepType ?? 'step'}`;
    case 'plan':        return `plan with ${event.plan?.steps?.length ?? 0} steps`;
    case 'review':      return `plan review ${event.approved ? 'approved' : 'rejected'}`;
    case 'step_review': return `step review ${event.approved ? 'approved' : 'rejected'}: ${event.step}`;
    default:            return event.type;
  }
}

export function mergeBudgetConfig(baseConfig, task) {
  const merged = { ...baseConfig };
  const constraints = task.constraints ?? {};
  const budgetOverride = task.budget ?? {};
  const pickStricter = (key, source) => {
    const values = [source[key], merged[key]].filter(v => typeof v === 'number');
    if (values.length) merged[key] = Math.min(...values);
  };
  pickStricter('maxIterations', constraints);
  pickStricter('timeoutMs', constraints);
  pickStricter('maxCostUsd', budgetOverride);
  pickStricter('maxTokens', budgetOverride);
  return merged;
}

export async function executeHostedTask(task, {
  api, activeDispatcher, toolRegistry, runLoopConfig, budgetsConfig, guardrailsMod, jobs, signal, onProgress,
}) {
  const fullTask = { id: task.id ?? `t-${Date.now().toString(36)}`, ...task };
  const budgetsMod = budgetsConfig ? createBudgets(mergeBudgetConfig(budgetsConfig, fullTask)) : null;
  let lease;
  try {
    lease = await activeDispatcher.dispatch({ signal });
  } catch (err) {
    return {
      taskId: fullTask.id,
      status: 'failed',
      result: { error: 'dispatch_failed', message: String(err?.message ?? err) },
      history: [],
      budget: null,
    };
  }
  try {
    const result = await runTask(fullTask, {
      strategy: runLoopConfig.strategy ?? 'open-ended',
      tools: toolRegistry,
      fleetApi: createPooledFleetApi(api, lease),
      budgets: budgetsMod,
      guardrails: guardrailsMod,
      ...runLoopConfig,
      jobs,
      signal,
      onIteration: onProgress,
    });
    return { taskId: fullTask.id, ...result };
  } finally {
    await lease.release();
  }
}
