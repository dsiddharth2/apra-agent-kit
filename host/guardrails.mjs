function resolvePolicy(tool, config) {
  if (config.policies?.[tool.name]) {
    return config.policies[tool.name];
  }
  if (tool.reversible === false) {
    return 'approve';
  }
  return config.defaultPolicy ?? 'allow';
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
