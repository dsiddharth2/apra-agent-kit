// host/budgets.mjs

const DEFAULT_PRICING = {
  inputPer1k: 0.003,
  outputPer1k: 0.015,
};

export function createBudgets(config = {}) {
  const pricing = config.pricing ?? DEFAULT_PRICING;
  const startTime = Date.now();
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  function record(usage = {}) {
    iterations++;
    if (typeof usage.inputTokens === 'number') {
      totalInputTokens += usage.inputTokens;
    }
    if (typeof usage.outputTokens === 'number') {
      totalOutputTokens += usage.outputTokens;
    } else if (typeof usage.responseChars === 'number') {
      totalOutputTokens += Math.ceil(usage.responseChars / 4);
    }
  }

  function snapshot() {
    const totalTokens = totalInputTokens + totalOutputTokens;
    const estimatedCostUsd =
      (totalInputTokens / 1000) * pricing.inputPer1k +
      (totalOutputTokens / 1000) * pricing.outputPer1k;
    return {
      iterations,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCostUsd,
      elapsedMs: Date.now() - startTime,
    };
  }

  function check() {
    if (typeof config.maxIterations === 'number' && iterations >= config.maxIterations) {
      return { ok: false, reason: 'max_iterations' };
    }
    const totalTokens = totalInputTokens + totalOutputTokens;
    if (typeof config.maxTokens === 'number' && totalTokens >= config.maxTokens) {
      return { ok: false, reason: 'max_tokens' };
    }
    if (typeof config.maxCostUsd === 'number') {
      const cost =
        (totalInputTokens / 1000) * pricing.inputPer1k +
        (totalOutputTokens / 1000) * pricing.outputPer1k;
      if (cost > config.maxCostUsd) {
        return { ok: false, reason: 'max_cost' };
      }
    }
    if (typeof config.timeoutMs === 'number') {
      if (Date.now() - startTime >= config.timeoutMs) {
        return { ok: false, reason: 'timeout' };
      }
    }
    return { ok: true };
  }

  return { check, record, snapshot };
}
