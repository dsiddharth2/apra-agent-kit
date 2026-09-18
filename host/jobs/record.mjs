// host/jobs/record.mjs
import { randomUUID } from 'node:crypto';
import { IllegalTransitionError } from './interface.mjs';

export const STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled', 'budget_exceeded'];
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

const TRANSITIONS = {
  queued: new Set(['processing', 'cancelled']),
  processing: TERMINAL_STATUSES,
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function newJobId() {
  return `job-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

export function createRecord(task, { id = newJobId(), callbackUrl = null, metadata = {}, now = new Date() } = {}) {
  return {
    id,
    status: 'queued',
    task: {
      goal: task.goal,
      inputs: task.inputs ?? {},
      constraints: task.constraints ?? {},
      budget: task.budget ?? {},
    },
    submittedAt: iso(now),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    result: null,
    history: [],
    budget: null,
    progress: { iteration: 0, message: null, at: null },
    callbackUrl,
    metadata: metadata ?? {},
    error: null,
  };
}

export const queuedEvent = (jobId, position, now = new Date()) =>
  ({ type: 'queued', jobId, at: iso(now), position });
export const startedEvent = (jobId, now = new Date()) =>
  ({ type: 'started', jobId, at: iso(now) });
export const progressEvent = (jobId, iteration, detail, now = new Date()) => {
  if (typeof detail === 'string') {
    return { type: 'progress', jobId, at: iso(now), iteration, message: detail };
  }
  return { type: 'progress', jobId, at: iso(now), iteration, ...detail };
};
export const settledEvent = (jobId, { status, result = null, error = null }, now = new Date()) =>
  ({ type: 'settled', jobId, at: iso(now), status, result, error });

// Keep the newest `max` events, but never drop queued/started/settled.
export function ringEvents(events, max = 50) {
  if (events.length <= max) return events;
  const keep = events.filter(e => e.type !== 'progress');
  const budget = Math.max(0, max - keep.length);
  const progress = events.filter(e => e.type === 'progress').slice(-budget);
  return events.filter(e => e.type !== 'progress' || progress.includes(e));
}

// Run loop → { status, result, error }. The run loop puts failure details in
// `result`; the job record wants them in `error`.
export function settleFromRunResult(run) {
  const base = { history: run.history ?? [], budget: run.budget ?? null };
  if (run.status === 'failed') {
    const code = run.result?.error === 'dispatch_failed' ? 'dispatch_failed' : 'run_failed';
    const message = run.result?.error
      ? `${run.result.error}: ${run.result.message ?? ''}`.trim().replace(/:$/, '')
      : 'run loop failed';
    return { status: 'failed', result: null, error: { code, message }, ...base };
  }
  return { status: run.status, result: run.result ?? null, error: null, ...base };
}
