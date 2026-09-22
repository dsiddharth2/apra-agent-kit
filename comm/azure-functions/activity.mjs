// comm/azure-functions/activity.mjs
// The run loop inside a Durable activity. Progress events are pushed directly
// to the jobs backend's SSE subscribers (bypassing the orchestrator) so the
// chat UI can show tool execution in real time.
import { executeHostedTask, settleWhenAborted } from '../../host/tasks.mjs';
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

    const emit = (event) => {
      if (hostCtx.jobs?.emitEvent) {
        hostCtx.jobs.emitEvent(jobId, event);
      }
    };

    const cancelPoll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId, { showHistory: false, showInput: false });
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* transient; next tick retries */ }
    }, pollMs);
    cancelPoll.unref?.();

    try {
      const run = await settleWhenAborted(
        executeHostedTask({ ...task, id: jobId }, {
          api: hostCtx.api,
          activeDispatcher: hostCtx.activeDispatcher,
          toolRegistry: hostCtx.toolRegistry,
          runLoopConfig: hostCtx.runLoopConfig,
          routerConfig: hostCtx.routerConfig,
          budgetsConfig: hostCtx.budgetsConfig,
          guardrailsMod: hostCtx.guardrailsMod,
          signal: controller.signal,
          onProgress: (progress) => emit({ type: 'progress', jobId, at: iso(), ...progress }),
        }),
        controller.signal,
      );
      const settled = settleFromRunResult(run);
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
        settled.status = 'cancelled';
        settled.result = null;
        settled.error = null;
      }
      emit({ type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result ?? null, error: settled.error ?? null, routedTo: run.routedTo ?? null });
      if (hostCtx.notifier && callbackUrl) {
        await hostCtx.notifier.publish(
          { type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result, error: settled.error },
          { callbackUrl },
        );
      }
      // Durable Functions caps activity return values at 16 KB (UTF-16).
      // The full result is already emitted via SSE (emit) and webhook
      // (notifier) above, so the orchestrator only needs a slim payload.
      const { history, budget, ...trimmed } = settled;
      if (run.routedTo) trimmed.routedTo = run.routedTo;
      const json = JSON.stringify(trimmed);
      if (json.length > 12_000 && typeof trimmed.result === 'string') {
        trimmed.result = trimmed.result.slice(0, 2000) + '\n\n[Full result delivered via SSE]';
      }
      return trimmed;
    } finally {
      clearInterval(cancelPoll);
    }
  };
}
