// host/config.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDispatchConfig, resolveNotifyConfigWithEnv } from './jobs/config.mjs';

const SUPPORTED_ADAPTERS = new Set(['express', 'raw-http', 'azure-functions']);
const KNOWN_MODULES = new Set(['runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch', 'notify']);
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify']);

export async function loadConfig(configDir, env = process.env) {
  const raw = await resolveConfig(configDir);
  return validate(raw, env);
}

async function resolveConfig(dir) {
  const mjsPath = path.join(dir, 'host.config.mjs');
  try {
    const mod = await import(pathToFileURL(mjsPath).href);
    return mod.default;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' && !err.message?.includes('Cannot find module')) {
      throw err;
    }
  }

  const jsonPath = path.join(dir, 'host.config.json');
  try {
    const text = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  throw new Error(`host.config.mjs (or .json) not found in ${dir}`);
}

function validate(raw, env) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config must be an object');
  }
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error('config.name is required (non-empty string)');
  }
  if (!raw.fleet || typeof raw.fleet !== 'object') {
    throw new Error('config.fleet is required (object)');
  }
  if (!raw.comm || typeof raw.comm !== 'object') {
    throw new Error('config.comm is required (object)');
  }
  if (!SUPPORTED_ADAPTERS.has(raw.comm.adapter)) {
    throw new Error(
      `unsupported comm adapter: "${raw.comm.adapter}" — supported: ${[...SUPPORTED_ADAPTERS].join(', ')}`,
    );
  }

  const port = raw.comm.port ?? Number(env.PORT ?? 3000);
  const host = raw.comm.host ?? env.MCP_BIND_HOST ?? '127.0.0.1';

  if (raw.modules && typeof raw.modules === 'object') {
    for (const key of Object.keys(raw.modules)) {
      if (!KNOWN_MODULES.has(key)) {
        console.warn(`[host/config] unknown module "${key}" — ignored`);
      } else if (raw.modules[key]?.enabled && !IMPLEMENTED_MODULES.has(key)) {
        console.warn(
          `[host/config] ${key} enabled but not implemented in this version — ignored`,
        );
      }
    }

    if (raw.modules?.budgets?.enabled && !raw.modules?.runLoop?.enabled) {
      console.warn(
        '[host/config] budgets enabled but runLoop disabled — budget enforcement will not run; disable budgets or enable runLoop',
      );
    }
  }

  const modules = { ...(raw.modules ?? {}) };
  const runLoopEnabled = !!modules.runLoop?.enabled;
  const budgetsConfig = modules.budgets?.enabled ? modules.budgets : null;

  if (modules.dispatch?.enabled) {
    if (!runLoopEnabled) throw new Error('dispatch enabled but runLoop disabled — there is nothing to run; enable runLoop or disable dispatch');
    const dispatch = resolveDispatchConfig(modules.dispatch, { env, budgetsConfig });
    if (dispatch.backend === 'durable' && raw.comm.adapter !== 'azure-functions') {
      throw new Error('dispatch.backend "durable" requires comm.adapter "azure-functions"');
    }
    if (raw.comm.adapter === 'azure-functions' && dispatch.backend === 'in-process') {
      console.warn('[host/config] in-process jobs on azure-functions — jobs are lost when the instance recycles; use backend "durable"');
    }
    if (typeof budgetsConfig?.timeoutMs === 'number' && budgetsConfig.timeoutMs > dispatch.durable.maxActivityMs) {
      console.warn(`[host/config] budgets.timeoutMs ${budgetsConfig.timeoutMs} exceeds dispatch.durable.maxActivityMs ${dispatch.durable.maxActivityMs}; the platform may kill the activity before budgets fire`);
    }
    if (dispatch.store.kind === 'memory' && env.NODE_ENV !== 'test') {
      console.warn('[host/config] dispatch.store.kind "memory" — jobs are lost on restart');
    }
    modules.dispatch = dispatch;
  }

  const notify = resolveNotifyConfigWithEnv(modules.notify ?? {}, env);
  if (notify.webhook.allowHttp) console.warn('[host/config] notify.webhook.allowHttp is on — plain-http callback URLs are accepted');
  modules.notify = notify;

  return Object.freeze({
    name: raw.name,
    description: raw.description ?? '',
    fleet: Object.freeze({ ...raw.fleet }),
    comm: Object.freeze({
      adapter: raw.comm.adapter,
      port,
      host,
    }),
    modules: Object.freeze(modules),
  });
}
