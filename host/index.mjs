import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { buildMcpServer } from '../mcp/server.mjs';
import { authenticate as defaultAuthenticate } from '../mcp/auth.mjs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { loadConfig } from './config.mjs';
import { extendRegistry } from './tools/registry.mjs';
import { executeTool } from './tools/executor.mjs';
import { createExpressAdapter } from '../comm/express.mjs';
import { runTask } from './run-loop.mjs';
import { createBudgets } from './budgets.mjs';
import { createGuardrails } from './guardrails.mjs';

const SUPPORTED_ADAPTERS = { express: createExpressAdapter };

function resolveAdapter(name) {
  const factory = SUPPORTED_ADAPTERS[name];
  if (!factory) throw new Error(`unsupported comm adapter: "${name}"`);
  return factory();
}

function defaultConfigDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function resolvePhase2Modules(config, { runLoop, budgets, guardrails } = {}) {
  return {
    runLoopConfig: runLoop ?? config.modules?.runLoop,
    budgetsConfig: budgets ?? config.modules?.budgets,
    guardrailsConfig: guardrails ?? config.modules?.guardrails,
  };
}

function createPhase2Modules(toolRegistry, { runLoopConfig, budgetsConfig, guardrailsConfig }) {
  const runLoopEnabled = runLoopConfig?.enabled ?? !!runLoopConfig?.strategy;
  const budgetsEnabled = budgetsConfig && (budgetsConfig.enabled ?? true);
  const guardrailsEnabled = guardrailsConfig && (guardrailsConfig.enabled ?? true);
  const guardrailsMod = guardrailsEnabled
    ? createGuardrails(guardrailsConfig, toolRegistry, executeTool)
    : null;
  const budgetsMod = budgetsEnabled ? createBudgets(budgetsConfig) : null;
  return { runLoopEnabled, runLoopConfig, budgetsConfig: budgetsEnabled ? budgetsConfig : null, budgetsMod, guardrailsMod };
}

function mergeBudgetConfig(baseConfig, task) {
  const merged = { ...baseConfig };
  const constraints = task.constraints ?? {};
  const budgetOverride = task.budget ?? {};

  const pickStricter = (configKey, ...sources) => {
    const values = sources
      .map(src => src[configKey])
      .filter(v => typeof v === 'number');
    if (typeof merged[configKey] === 'number') values.push(merged[configKey]);
    if (values.length === 0) return;
    merged[configKey] = Math.min(...values);
  };

  pickStricter('maxIterations', constraints);
  pickStricter('timeoutMs', constraints);
  pickStricter('maxCostUsd', budgetOverride);
  pickStricter('maxTokens', budgetOverride);

  return merged;
}

function createRequestBudgets(budgetsConfig, task) {
  if (!budgetsConfig) return null;
  return createBudgets(mergeBudgetConfig(budgetsConfig, task));
}

async function executeHostedTask(task, {
  api,
  activeDispatcher,
  toolRegistry,
  runLoopConfig,
  budgetsConfig,
  guardrailsMod,
  signal,
}) {
  const fullTask = { id: task.id ?? `t-${Date.now().toString(36)}`, ...task };
  const budgetsMod = createRequestBudgets(budgetsConfig, fullTask);
  let lease;
  try {
    lease = await activeDispatcher.dispatch({ signal });
  } catch (err) {
    return {
      taskId: fullTask.id,
      status: 'failed',
      result: { error: 'dispatch_failed', message: String(err?.message ?? err) },
    };
  }
  try {
    const pooledApi = createPooledFleetApi(api, lease);
    const result = await runTask(fullTask, {
      strategy: runLoopConfig.strategy ?? 'open-ended',
      tools: toolRegistry,
      fleetApi: pooledApi,
      budgets: budgetsMod,
      guardrails: guardrailsMod,
      ...runLoopConfig,
      signal,
    });
    return { taskId: fullTask.id, ...result };
  } finally {
    await lease.release();
  }
}

// Thin entry point mirroring startMcpServer's injection pattern.
// Accepts optional fleetApi + dispatcher for testing. When omitted, spawns
// Fleet and creates the dispatcher from the pool, same as mcp/main.mjs.
export async function startHost({
  fleetApi,
  dispatcher,
  port,
  bindHost: bindHostOption,
  adapter: adapterName,
  createAdapter,
  env = process.env,
  registry,
  configDir,
  authenticate = defaultAuthenticate,
  runLoop: runLoopOption,
  budgets: budgetsOption,
  guardrails: guardrailsOption,
} = {}) {
  const config = await loadConfig(configDir ?? defaultConfigDir(), env);

  let api = fleetApi;
  let stopFleet = null;
  if (!api) {
    const { ensureApralabs } = await import('../transport/ensure-apralabs.mjs');
    ensureApralabs();
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try { await stopFleet?.(); } catch { /* preserve original error */ }
      throw err;
    }
  }

  const toolRegistry = registry ?? extendRegistry();
  const phase2 = createPhase2Modules(
    toolRegistry,
    resolvePhase2Modules(config, {
      runLoop: runLoopOption,
      budgets: budgetsOption,
      guardrails: guardrailsOption,
    }),
  );
  const { runLoopEnabled, runLoopConfig, budgetsConfig, guardrailsMod } = phase2;

  const mcpExecute = guardrailsMod
    ? (tool, executorArgs) => guardrailsMod.execute(tool, executorArgs)
    : (tool, executorArgs) => executeTool(tool, executorArgs);

  const mcpHandler = async (req, res) => {
    const server = buildMcpServer({
      fleetApi: api,
      dispatcher: activeDispatcher,
      registry: toolRegistry,
      execute: mcpExecute,
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  };

  const adapter = createAdapter
    ? createAdapter()
    : resolveAdapter(adapterName ?? config.comm.adapter);
  const listenPort = port ?? config.comm.port;
  const bindHost = bindHostOption ?? config.comm.host;

  try {
    await adapter.start({
      routes: {
        mcp: mcpHandler,
        task: runLoopEnabled
          ? async (req, res) => {
              const result = await executeHostedTask(req.body, {
                api,
                activeDispatcher,
                toolRegistry,
                runLoopConfig,
                budgetsConfig,
                guardrailsMod,
              });
              if (result.status === 'failed' && result.result?.error === 'dispatch_failed') {
                res.status(503).json({
                  ok: false,
                  error: 'dispatch_failed',
                  message: result.result.message,
                });
                return;
              }
              res.json(result);
            }
          : null,
        jobs: null,
        health: (req, res) => res.json({ ok: true }),
      },
      port: listenPort,
      host: bindHost,
      authenticate,
    });
  } catch (err) {
    try { await adapter.stop(); } catch { /* preserve */ }
    try { await ownDispatcher?.close(); } catch { /* preserve */ }
    try { await stopFleet?.(); } catch { /* preserve */ }
    throw err;
  }

  console.log(
    `host '${config.name}' listening on http://${bindHost}:${adapter.port()} ` +
    `(worker capacity ${activeDispatcher.capacity})`,
  );

  async function callTool(name, args = {}, { signal } = {}) {
    const tool = toolRegistry.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: 'not_found', message: `tool "${name}" not found` };
    }
    let lease;
    try {
      lease = await activeDispatcher.dispatch({ signal });
    } catch (err) {
      return {
        ok: false,
        error: 'dispatch_failed',
        message: String(err?.message ?? err),
      };
    }
    try {
      const executorArgs = {
        fleetApi: createPooledFleetApi(api, lease),
        args,
        signal: lease.signal ?? signal,
        reportPhase: () => {},
        workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer },
      };
      return guardrailsMod
        ? await guardrailsMod.execute(tool, executorArgs)
        : await executeTool(tool, executorArgs);
    } finally {
      await lease.release();
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    activeDispatcher.beginShutdown();
    await adapter.stop();
    await ownDispatcher?.close();
    await stopFleet?.();
  };

  return {
    host: adapter,
    callTool,
    close,
    stop: close,
    config,
    registry: toolRegistry,
  };
}

// Builder API — sugar over startHost.
export function createHost(options = {}) {
  let overrides = { ...options };

  const builder = {
    tools(registry)   { overrides.registry = registry; return builder; },
    comm(commConfig)  {
      if (commConfig && typeof commConfig === 'object') {
        if ('port' in commConfig) overrides.port = commConfig.port;
        if ('host' in commConfig) overrides.bindHost = commConfig.host;
        if ('adapter' in commConfig) overrides.adapter = commConfig.adapter;
      }
      return builder;
    },
    runLoop(config)    { overrides.runLoop = { enabled: true, ...config }; return builder; },
    budget(config)     { overrides.budgets = config; return builder; },
    guardrails(config) { overrides.guardrails = config; return builder; },
    build() {
      const hostOptions = overrides;
      return {
        start: (startOpts = {}) => startHost({ ...hostOptions, ...startOpts }),
        run: async (task, runOpts = {}) => {
          const config = await loadConfig(
            hostOptions.configDir ?? defaultConfigDir(),
            hostOptions.env ?? process.env,
          );
          const toolRegistry = hostOptions.registry ?? extendRegistry();
          const { runLoopEnabled, runLoopConfig, budgetsConfig, guardrailsMod } = createPhase2Modules(
            toolRegistry,
            resolvePhase2Modules(config, hostOptions),
          );
          if (!runLoopEnabled) {
            throw new Error('run loop is not enabled');
          }
          const api = hostOptions.fleetApi;
          const activeDispatcher = hostOptions.dispatcher;
          if (!api || !activeDispatcher) {
            throw new Error('fleetApi and dispatcher are required for agent.run()');
          }
          return executeHostedTask(task, {
            api,
            activeDispatcher,
            toolRegistry,
            runLoopConfig,
            budgetsConfig,
            guardrailsMod,
            signal: runOpts.signal,
          });
        },
      };
    },
  };
  return builder;
}

// Main module guard — same pattern as mcp/main.mjs.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startHost();
    const shutdown = async () => { await close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
