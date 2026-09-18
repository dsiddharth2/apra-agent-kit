// comm/azure-functions/orchestrator.mjs
// One orchestration per job. Deterministic: it only reacts to Durable-delivered
// tasks (activity completion, 'progress' events, 'cancel' events). The activity
// (activity.mjs) is the run loop; this generator only records what it is told.
//
// customStatus contract read by host/jobs/durable.mjs:
//   { status, events: [{ seq, ...JobEvent }] (ring of 50, queued/started/settled always kept),
//     progress: { iteration, message, at }, cancelRequested, startedAt, finishedAt }
import { ACTIVITY_NAME } from '../../host/jobs/durable.mjs';
import { ringEvents } from '../../host/jobs/record.mjs';

export function buildOrchestrator({ ringSize = 50 } = {}) {
  return function* runTaskOrchestrator(context) {
    const df = context.df;
    const input = df.getInput();
    const jobId = df.instanceId;
    const nowIso = () => (df.currentUtcDateTime ?? new Date()).toISOString();

    let seq = 0;
    const events = [];
    const push = (e) => { seq += 1; events.push({ ...e, seq }); };
    const state = {
      status: 'queued', events, progress: { iteration: 0, message: null, at: null },
      cancelRequested: false, startedAt: null, finishedAt: null,
    };
    const publish = () => df.setCustomStatus({ ...state, events: ringEvents(events, ringSize) });

    push(input.queuedEvent ?? { type: 'queued', jobId, at: nowIso(), position: 1 });
    publish();

    const activity = df.callActivity(ACTIVITY_NAME, { ...input, jobId });

    let started = false;
    const markStarted = (at) => {
      if (started) return;
      started = true;
      state.status = 'processing';
      state.startedAt = at;
      push({ type: 'started', jobId, at });
    };

    for (;;) {
      const progress = df.waitForExternalEvent('progress');
      const cancel = df.waitForExternalEvent('cancel');
      const winner = yield df.Task.any([activity, progress, cancel]);
      if (winner === activity) break;
      if (winner === cancel) {
        state.cancelRequested = true;
        publish();
        continue;
      }
      const e = progress.result;
      markStarted(e.at);
      if (e.type === 'progress') {
        push(e);
        state.progress = { iteration: e.iteration, message: e.message, at: e.at };
      }
      publish();
    }

    const output = activity.result;
    const at = nowIso();
    markStarted(state.startedAt ?? at);
    state.status = output.status;
    state.finishedAt = at;
    push({ type: 'settled', jobId, at, status: output.status, result: output.result ?? null, error: output.error ?? null });
    publish();
    return output;
  };
}

export const runTaskOrchestrator = buildOrchestrator();
