// host/notify/webhook.mjs
export function createWebhookChannel({
  retries = 3, sendProgress = false, fetchImpl = globalThis.fetch, logger = console, baseDelayMs = 1000,
} = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return {
    async publish(event, { callbackUrl } = {}) {
      if (!callbackUrl) return;
      if (event.type !== 'settled' && !(sendProgress && event.type === 'progress')) return;
      const { seq, ...body } = event;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetchImpl(callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fleet-job-id': event.jobId, 'x-fleet-event-seq': String(seq ?? '') },
            body: JSON.stringify(body),
          });
          if (res.ok) return;
        } catch (err) {
          logger.warn(`[webhook] ${callbackUrl} failed: ${err?.message ?? err} (attempt ${attempt}/${retries})`);
        }
        if (attempt < retries) await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
      logger.warn(`[webhook] gave up delivering ${event.type} for job ${event.jobId} to ${callbackUrl}`);
    },
  };
}
