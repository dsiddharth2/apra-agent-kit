import { JobQueueFullError, JobsClosedError, validateCallbackUrl } from './interface.mjs';
import {
  TERMINAL_STATUSES, createRecord, queuedEvent, startedEvent, progressEvent, settledEvent, settleFromRunResult,
} from './record.mjs';

const FORCE_SETTLE_AFTER_ABORT_MS = 30_000;

export function createInProcessJobs({
  store, runJob, notifier = null, config, logger = console, now = () => new Date(),
  allowHttpCallbacks = false,
}) {
  if (!store) throw new Error('createInProcessJobs requires store');
  if (typeof runJob !== 'function') throw new Error('createInProcessJobs requires runJob');
  const {
    maxQueueSize = 100, concurrency: requestedConcurrency = 1, leaseTimeoutMs = 660_000,
    retentionMs = 86_400_000, drainMs = 30_000, capacity = 1,
    sweepIntervalMs = Math.max(1000, Math.min(15_000, Math.floor(leaseTimeoutMs / 4))),
  } = config ?? {};

  let concurrency = requestedConcurrency;
  if (concurrency > capacity) {
    logger.warn(`[jobs] dispatch.concurrency ${concurrency} exceeds worker capacity ${capacity}; clamping`);
    concurrency = Math.max(1, capacity);
  }

  const queue = [];                    // job ids in submit order
  const running = new Map();           // jobId → { controller, startedAt, promise }
  const subscribers = new Map();       // jobId → Set<fn>
  const callbackUrls = new Map();      // jobId → callbackUrl (for notifier ctx)
  let closed = false;
  let started = false;
  let sweepTimer = null;
  let purgeTimer = null;

  const iso = () => now().toISOString();

  async function publish(jobId, event) {
    const seq = await store.appendEvent(jobId, event);
    const full = { seq, ...event };
    for (const fn of subscribers.get(jobId) ?? []) {
      try { fn(full); } catch (err) { logger.warn(`[jobs] subscriber error: ${err?.message ?? err}`); }
    }
    if (notifier) {
      try { await notifier.publish(full, { callbackUrl: callbackUrls.get(jobId) ?? null }); }
      catch (err) { logger.warn(`[jobs] notifier error: ${err?.message ?? err}`); }
    }
    return full;
  }

  async function settle(jobId, { status, result, error, history = [], budget = null }) {
    await store.update(jobId, { status, result, error, history, budget, finishedAt: iso() });
    await publish(jobId, settledEvent(jobId, { status, result, error }, now()));
    callbackUrls.delete(jobId);
    if (TERMINAL_STATUSES.has(status)) subscribers.delete(jobId);
  }

  async function runOne(jobId) {
    const startedAt = iso();
    const claimed = await store.claim(jobId, startedAt);
    if (!claimed) return;                                   // cancelled meanwhile or claimed elsewhere
    const record = await store.get(jobId);
    const controller = new AbortController();
    const entry = { controller, startedAt, promise: null };
    running.set(jobId, entry);
    await publish(jobId, startedEvent(jobId, now()));

    const onProgress = async ({ iteration, message }) => {
      if (controller.signal.aborted) return;
      await store.update(jobId, { progress: { iteration, message, at: iso() } });
      await publish(jobId, progressEvent(jobId, iteration, message, now()));
    };

    const task = { id: jobId, ...record.task };
    const run = Promise.resolve()
      .then(() => runJob(task, { signal: controller.signal, onProgress }))
      .catch(err => ({ status: 'failed', result: { error: 'run_failed', message: String(err?.message ?? err) }, history: [], budget: null }));

    // If aborted and the run loop does not return within the grace period, settle anyway.
    let forceTimer = null;
    const forced = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => {
        forceTimer = setTimeout(() => resolve({ status: 'cancelled', result: null, history: [], budget: null }), FORCE_SETTLE_AFTER_ABORT_MS);
        forceTimer.unref?.();
      }, { once: true });
    });

    entry.promise = (async () => {
      const outcome = await Promise.race([run, forced]);
      clearTimeout(forceTimer);
      running.delete(jobId);
      const reason = controller.signal.aborted ? controller.signal.reason : null;
      let settled = settleFromRunResult(outcome);
      if (reason === 'lease_expired') {
        settled = { ...settled, status: 'failed', result: null, error: { code: 'lease_expired', message: `exceeded leaseTimeoutMs ${leaseTimeoutMs}` } };
      } else if (reason === 'shutdown') {
        settled = { ...settled, status: 'failed', result: null, error: { code: 'interrupted', message: 'host shut down while processing' } };
      } else if (reason === 'cancelled') {
        settled = { ...settled, status: 'cancelled', error: null };
      }
      await settle(jobId, settled);
      pump();
    })();
    return entry.promise;
  }

  function pump() {
    if (closed) return;
    while (running.size < concurrency && queue.length > 0) {
      const jobId = queue.shift();
      void runOne(jobId).catch(err => logger.warn(`[jobs] runOne failed: ${err?.message ?? err}`));
    }
  }

  async function sweepLeases() {
    const cutoff = now().getTime() - leaseTimeoutMs;
    for (const [jobId, entry] of running) {
      if (!entry.controller.signal.aborted && new Date(entry.startedAt).getTime() < cutoff) {
        logger.warn(`[jobs] job ${jobId} exceeded leaseTimeoutMs; aborting`);
        entry.controller.abort('lease_expired');
      }
    }
  }

  async function purge() {
    const cutoff = new Date(now().getTime() - retentionMs).toISOString();
    const n = await store.purgeFinishedBefore(cutoff);
    if (n) logger.info(`[jobs] purged ${n} finished jobs older than ${cutoff}`);
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await store.open();
      for (const r of await store.listByStatus('processing')) {
        await store.update(r.id, {
          status: 'failed', finishedAt: iso(),
          error: { code: 'interrupted', message: 'process restarted while job was processing' },
        });
        await publish(r.id, settledEvent(r.id, { status: 'failed', result: null, error: { code: 'interrupted', message: 'process restarted while job was processing' } }, now()));
      }
      for (const r of await store.listByStatus('queued')) {
        queue.push(r.id);
        if (r.callbackUrl) callbackUrls.set(r.id, r.callbackUrl);
      }
      await purge();
      sweepTimer = setInterval(() => void sweepLeases(), sweepIntervalMs); sweepTimer.unref?.();
      purgeTimer = setInterval(() => void purge(), Math.max(60_000, Math.floor(retentionMs / 24))); purgeTimer.unref?.();
      pump();
    },

    async stop({ drainMs: drain = drainMs } = {}) {
      closed = true;
      clearInterval(sweepTimer); clearInterval(purgeTimer);
      const inflight = [...running.values()].map(e => e.promise);
      if (inflight.length) {
        await Promise.race([Promise.allSettled(inflight), new Promise(r => setTimeout(r, drain))]);
        for (const entry of running.values()) entry.controller.abort('shutdown');
        await Promise.allSettled([...running.values()].map(e => e.promise));
      }
      await store.close();
    },

    async submit(task, { callbackUrl, metadata } = {}) {
      if (closed) throw new JobsClosedError();
      if (!task || typeof task.goal !== 'string' || !task.goal.trim()) throw new TypeError('task.goal is required');
      const url = validateCallbackUrl(callbackUrl, { allowHttp: allowHttpCallbacks });
      if (queue.length >= maxQueueSize) throw new JobQueueFullError();
      const record = createRecord(task, { callbackUrl: url, metadata, now: now() });
      await store.insert(record);
      if (url) callbackUrls.set(record.id, url);
      queue.push(record.id);
      // Position is FIFO rank among unfinished jobs. pump() may already have
      // shifted an earlier id off `queue`, so queue.length alone is too small.
      const counts = await store.countByStatus();
      const position = (counts.queued ?? 0) + (counts.processing ?? 0);
      await publish(record.id, queuedEvent(record.id, position, now()));
      pump();
      return { jobId: record.id, status: 'queued', position };
    },

    async get(jobId) { return store.get(jobId); },

    async cancel(jobId) {
      const record = await store.get(jobId);
      if (!record) return { ok: false, status: null };
      if (TERMINAL_STATUSES.has(record.status)) return { ok: false, status: record.status };
      if (record.status === 'queued') {
        const idx = queue.indexOf(jobId);
        if (idx >= 0) queue.splice(idx, 1);
        await settle(jobId, { status: 'cancelled', result: null, error: null });
        return { ok: true, status: 'cancelled' };
      }
      const entry = running.get(jobId);
      if (entry && !entry.controller.signal.aborted) entry.controller.abort('cancelled');
      return { ok: true, status: 'cancelling' };
    },

    subscribe(jobId, onEvent) {
      const set = subscribers.get(jobId) ?? new Set();
      set.add(onEvent); subscribers.set(jobId, set);
      return () => { set.delete(onEvent); if (set.size === 0) subscribers.delete(jobId); };
    },

    async events(jobId, { afterSeq = 0 } = {}) { return store.events(jobId, { afterSeq }); },

    stats() {
      return { queued: queue.length, processing: running.size, capacity: concurrency, maxQueueSize };
    },
  };
}
