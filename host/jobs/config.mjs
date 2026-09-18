// host/jobs/config.mjs
import path from 'node:path';
import { resolveNotifyConfig } from '../notify/index.mjs';

export const DISPATCH_DEFAULTS = {
  enabled: false,
  backend: 'in-process',
  maxQueueSize: 100,
  concurrency: 1,
  retentionMs: 86_400_000,
  drainMs: 30_000,
  store: { kind: 'sqlite', dbPath: path.join('workdir', 'jobs.db') },
  durable: { taskHub: 'fleetjobs', pollMs: 2000, maxActivityMs: 3_600_000 },
};
const BACKENDS = new Set(['in-process', 'durable']);
const STORE_KINDS = new Set(['sqlite', 'memory']);

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

export function resolveDispatchConfig(raw = {}, { env = process.env, budgetsConfig = null } = {}) {
  const merged = {
    ...DISPATCH_DEFAULTS, ...raw,
    store: { ...DISPATCH_DEFAULTS.store, ...(raw.store ?? {}) },
    durable: { ...DISPATCH_DEFAULTS.durable, ...(raw.durable ?? {}) },
  };
  merged.backend = env.JOBS_BACKEND || merged.backend;
  merged.maxQueueSize = intEnv(env, 'JOBS_MAX_QUEUE_SIZE', merged.maxQueueSize);
  merged.concurrency = intEnv(env, 'JOBS_CONCURRENCY', merged.concurrency);
  merged.retentionMs = intEnv(env, 'JOBS_RETENTION_MS', merged.retentionMs);
  merged.store.dbPath = env.JOBS_DB_PATH || merged.store.dbPath;
  merged.durable.taskHub = env.DURABLE_TASK_HUB || merged.durable.taskHub;
  if (merged.leaseTimeoutMs === undefined) {
    merged.leaseTimeoutMs = typeof budgetsConfig?.timeoutMs === 'number' ? budgetsConfig.timeoutMs + 60_000 : 660_000;
  }
  if (!BACKENDS.has(merged.backend)) throw new Error(`dispatch.backend must be one of ${[...BACKENDS].join(', ')}, got "${merged.backend}"`);
  if (!STORE_KINDS.has(merged.store.kind)) throw new Error(`dispatch.store.kind must be one of ${[...STORE_KINDS].join(', ')}, got "${merged.store.kind}"`);
  return merged;
}

export function resolveNotifyConfigWithEnv(raw = {}, env = process.env) {
  const config = resolveNotifyConfig(raw);
  const flag = String(env.WEBHOOK_ALLOW_HTTP ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') config.webhook.allowHttp = true;
  return config;
}
