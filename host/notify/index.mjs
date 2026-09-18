// host/notify/index.mjs
import { createSseHandler } from './sse.mjs';
import { createWebhookChannel } from './webhook.mjs';

export const NOTIFY_DEFAULTS = {
  sse: { enabled: true, heartbeatMs: 25_000 },
  webhook: { enabled: true, sendProgress: false, allowHttp: false, retries: 3 },
};

export function resolveNotifyConfig(raw = {}) {
  return {
    sse: { ...NOTIFY_DEFAULTS.sse, ...(raw.sse ?? {}) },
    webhook: { ...NOTIFY_DEFAULTS.webhook, ...(raw.webhook ?? {}) },
  };
}

export function createNotifier(rawConfig, { jobs, logger = console, fetchImpl } = {}) {
  const config = resolveNotifyConfig(rawConfig);
  const channels = [];
  if (config.webhook.enabled) {
    channels.push(createWebhookChannel({ retries: config.webhook.retries, sendProgress: config.webhook.sendProgress, fetchImpl, logger }));
  }
  const sseHandler = config.sse.enabled && jobs
    ? createSseHandler({ jobs, heartbeatMs: config.sse.heartbeatMs })
    : null;

  return {
    config,
    sseHandler,
    async publish(event, ctx = {}) {
      await Promise.all(channels.map(c => c.publish(event, ctx).catch(err =>
        logger.warn(`[notify] channel error: ${err?.message ?? err}`))));
    },
    async stop() {},
  };
}
