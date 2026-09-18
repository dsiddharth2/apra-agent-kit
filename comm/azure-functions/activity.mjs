// comm/azure-functions/activity.mjs
// The run loop inside a Durable activity. Progress goes to the orchestrator as
// external events (raiseEvent 'progress'); cancellation is read back from the
// orchestrator's customStatus, polled from the task hub, because the activity
// can run on a different instance from the one that received DELETE /jobs/:id.
import { executeHostedTask } from '../../host/tasks.mjs';
import { settleFromRunResult } from '../../host/jobs/record.mjs';

let factory = null;
let contextPromise = null;

export function setHostContextFactory(fn) {
  factory = fn;
  contextPromise = null;
}

export function getHostContext() {
  if (!factory) return Promise.reject(new Error('host context factory not set; call setHostContextFactory first'));
  contextPromise ??= Promise.resolve().then(factory);
  return contextPromise;
}

export function createRunTaskActivity({ getClient, pollMs = 2000, getContext = getHostContext }) {
  return async function runTaskActivity(input, context) {
    const { jobId, task, callbackUrl } = input;
    const client = getClient(context);
    const hostCtx = await getContext();
    const controller = new AbortController();
    const iso = () => new Date().toISOString();

    const raise = async (event) => {
      try { await client.raiseEvent(jobId, 'progress', event); }
      catch (err) { context?.warn?.(`[activity] raiseEvent failed: ${err?.message ?? err}`); }
    };
    await raise({ type: 'started', jobId, at: iso() });

    const cancelPoll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId, { showHistory: false, showInput: false });
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* transient; next tick retries */ }
    }, pollMs);
    cancelPoll.unref?.();

    try {
      const run = await executeHostedTask({ ...task, id: jobId }, {
        api: hostCtx.api,
        activeDispatcher: hostCtx.activeDispatcher,
        toolRegistry: hostCtx.toolRegistry,
        runLoopConfig: hostCtx.runLoopConfig,
        budgetsConfig: hostCtx.budgetsConfig,
        guardrailsMod: hostCtx.guardrailsMod,
        signal: controller.signal,
        onProgress: (progress) => raise({ type: 'progress', jobId, at: iso(), ...progress }),
      });
      const settled = settleFromRunResult(run);
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
        settled.status = 'cancelled';
        settled.result = null;
        settled.error = null;
      }
      if (hostCtx.notifier && callbackUrl) {
        await hostCtx.notifier.publish(
          { type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result, error: settled.error },
          { callbackUrl },
        );
      }
      return settled;
    } finally {
      clearInterval(cancelPoll);
    }
  };
}
