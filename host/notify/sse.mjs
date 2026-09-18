// host/notify/sse.mjs
import { TERMINAL_STATUSES } from '../jobs/record.mjs';

export function formatSse({ seq, ...event }) {
  return `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
};

export function createSseHandler({ jobs, heartbeatMs = 25_000 }) {
  return async function sseHandler(request) {
    const jobId = request.params?.id;
    const record = jobId ? await jobs.get(jobId) : null;
    if (!record) return { status: 404, body: { ok: false, error: 'not_found' } };

    const lastId = Number(request.headers?.['last-event-id'] ?? 0);
    const afterSeq = Number.isFinite(lastId) ? lastId : 0;
    const signal = request.signal;

    async function* stream() {
      // Subscribe BEFORE replaying so nothing slips between the two; dedupe by seq.
      const pending = [];
      let wake = null;
      let ended = false;
      const push = (e) => { pending.push(e); wake?.(); };
      const unsubscribe = TERMINAL_STATUSES.has(record.status) ? () => {} : jobs.subscribe(jobId, push);
      const onAbort = () => { ended = true; wake?.(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const heartbeat = setInterval(() => push({ heartbeat: true }), heartbeatMs);
      heartbeat.unref?.();

      let lastSeq = afterSeq;
      try {
        for (const e of await jobs.events(jobId, { afterSeq })) {
          if (e.seq > lastSeq) { lastSeq = e.seq; yield formatSse(e); }
          if (e.type === 'settled') return;
        }
        if (TERMINAL_STATUSES.has(record.status)) return;

        while (!ended && !signal?.aborted) {
          if (pending.length === 0) {
            await new Promise((resolve) => { wake = resolve; });
            wake = null;
            continue;
          }
          const e = pending.shift();
          if (e.heartbeat) { yield ': ping\n\n'; continue; }
          if (e.seq <= lastSeq) continue;
          lastSeq = e.seq;
          yield formatSse(e);
          if (e.type === 'settled') return;
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      }
    }

    return { status: 200, headers: { ...HEADERS }, stream: stream() };
  };
}
