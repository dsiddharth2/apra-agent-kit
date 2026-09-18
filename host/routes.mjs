import { JobQueueFullError, JobsClosedError, InvalidCallbackUrlError } from './jobs/interface.mjs';

const json = (status, body, headers) => ({ status, body, ...(headers ? { headers } : {}) });

function syncResponse(result) {
  if (result.status === 'failed' && result.result?.error === 'dispatch_failed') {
    return json(503, { ok: false, error: 'dispatch_failed', message: result.result.message });
  }
  return json(200, result);
}

export function buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled }) {
  const routes = {
    health: { method: 'GET', path: '/health', auth: false, handler: async () => json(200, { ok: true }) },
    mcp: { method: 'POST', path: '/mcp', raw: true, handler: mcpRaw, web: mcpWeb },
    task: null, jobGet: null, jobCancel: null, jobEvents: null,
  };

  if (runLoopEnabled) {
    routes.task = {
      method: 'POST', path: '/task',
      handler: async (request) => {
        const body = request.body ?? {};
        if (typeof body.goal !== 'string' || !body.goal.trim()) {
          return json(400, { ok: false, error: 'invalid_task', message: 'goal (string) is required' });
        }
        const wait = String(request.query.wait ?? '').toLowerCase();
        if (!jobs || wait === 'true' || wait === '1') {
          return syncResponse(await runSync(body, { signal: request.signal }));
        }
        const { callbackUrl, metadata, ...task } = body;
        try {
          const out = await jobs.submit(task, { callbackUrl, metadata: { ...(metadata ?? {}), user: request.user?.id ?? null } });
          return json(202, { ...out, links: { self: `/jobs/${out.jobId}`, events: `/jobs/${out.jobId}/events` } });
        } catch (err) {
          if (err instanceof JobQueueFullError) return json(429, { ok: false, error: 'queue_full', message: err.message }, { 'retry-after': '30' });
          if (err instanceof InvalidCallbackUrlError) return json(400, { ok: false, error: 'invalid_callback_url', message: err.message });
          if (err instanceof JobsClosedError) return json(503, { ok: false, error: 'shutting_down', message: err.message });
          if (err instanceof TypeError) return json(400, { ok: false, error: 'invalid_task', message: err.message });
          throw err;
        }
      },
    };
  }

  if (jobs) {
    routes.jobGet = {
      method: 'GET', path: '/jobs/:id',
      handler: async ({ params }) => {
        const record = await jobs.get(params.id);
        return record ? json(200, record) : json(404, { ok: false, error: 'not_found' });
      },
    };
    routes.jobCancel = {
      method: 'DELETE', path: '/jobs/:id',
      handler: async ({ params }) => {
        const out = await jobs.cancel(params.id);
        if (out.ok && out.status === 'cancelling') return json(202, out);
        if (out.ok) return json(200, out);
        if (out.status === null) return json(404, { ok: false, error: 'not_found' });
        return json(409, { ok: false, error: 'already_terminal', status: out.status });
      },
    };
    if (notifier?.sseHandler) {
      routes.jobEvents = { method: 'GET', path: '/jobs/:id/events', handler: notifier.sseHandler };
    }
  }
  return routes;
}
