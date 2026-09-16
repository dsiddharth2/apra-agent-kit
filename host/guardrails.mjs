import path from 'node:path';
import os from 'node:os';

function resolvePolicy(tool, config) {
  if (config.policies?.[tool.name]) {
    return config.policies[tool.name];
  }
  if (tool.reversible === false) {
    return 'approve';
  }
  return config.defaultPolicy ?? 'allow';
}

function looksLikePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('~/')) return true;
  if (value.includes('..')) return true;
  return path.isAbsolute(value);
}

function resolveSandboxPath(value) {
  if (value.startsWith('~/')) {
    const home = os.homedir();
    return path.resolve(home, value.slice(2));
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(process.cwd(), value);
}

function isWithinWorkdir(resolvedPath, workdir) {
  const relative = path.relative(workdir, resolvedPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function collectPathStrings(value, paths = []) {
  if (typeof value === 'string') {
    if (looksLikePath(value)) paths.push(value);
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, paths);
    return paths;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPathStrings(item, paths);
  }
  return paths;
}

function checkSandbox(args, config) {
  if (!config.sandboxFs) return null;
  const workdir = path.resolve(config.workdir ?? 'workdir');
  for (const candidate of collectPathStrings(args)) {
    const resolved = resolveSandboxPath(candidate);
    if (!isWithinWorkdir(resolved, workdir)) {
      return { allowed: false, reason: 'sandbox_violation' };
    }
  }
  return null;
}

export function createGuardrails(config = {}, tools = [], executor) {
  function gate(tool, args) {
    if (config.validateInputs && tool.inputSchema) {
      const result = tool.inputSchema.safeParse(args);
      if (!result.success) {
        return { allowed: false, reason: 'validation_failed', details: result.error };
      }
    }

    const policy = resolvePolicy(tool, config);

    if (policy === 'deny') {
      return { allowed: false, reason: 'policy_denied', policy };
    }

    if (policy === 'approve') {
      return { allowed: false, reason: 'approval_denied', policy, needsCallback: true };
    }

    const sandboxDenied = checkSandbox(args, config);
    if (sandboxDenied) return sandboxDenied;

    return { allowed: true };
  }

  async function execute(tool, executorArgs) {
    if (config.validateInputs && tool.inputSchema) {
      const result = tool.inputSchema.safeParse(executorArgs.args);
      if (!result.success) {
        return { ok: false, error: 'guardrail_denied', reason: 'validation_failed', details: result.error };
      }
    }

    const policy = resolvePolicy(tool, config);

    if (policy === 'deny') {
      return { ok: false, error: 'guardrail_denied', reason: 'policy_denied' };
    }

    if (policy === 'approve') {
      if (!config.approvalCallback) {
        return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
      }
      const decision = await config.approvalCallback({ tool, args: executorArgs.args, context: executorArgs });
      if (decision !== 'approve') {
        return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
      }
    }

    const sandboxDenied = checkSandbox(executorArgs.args, config);
    if (sandboxDenied) {
      return { ok: false, error: 'guardrail_denied', reason: 'sandbox_violation' };
    }

    if (config.dryRunMode) {
      return { ok: false, error: 'guardrail_denied', reason: 'dry_run' };
    }

    return executor(tool, executorArgs);
  }

  function dryRun() {
    return config.dryRunMode === true;
  }

  return { gate, execute, dryRun };
}
