export default function trajectoryMatch(expected, actual) {
  const expectedTools = (expected.trajectory ?? []).map(t => t.tool);
  const history = actual.history ?? [];
  const actions = history.filter(h => h.type === 'action');
  const actualTools = (actions.length > 0
    ? actions
    : history.filter(h => h.type === 'observation' && (h.tool != null || h.stepType === 'tool'))
  ).map(h => h.tool);
  const mode = expected.mode ?? 'superset';

  switch (mode) {
    case 'strict': {
      if (actualTools.length !== expectedTools.length) {
        return { pass: false, score: 0, reason: `expected ${expectedTools.length} tools, got ${actualTools.length}` };
      }
      for (let i = 0; i < expectedTools.length; i++) {
        if (actualTools[i] !== expectedTools[i]) {
          return { pass: false, score: 0, reason: `step ${i}: expected "${expectedTools[i]}", got "${actualTools[i]}"` };
        }
      }
      return { pass: true, score: 1, reason: `${expectedTools.length} tools in exact order` };
    }
    case 'unordered': {
      const missing = expectedTools.filter(t => !actualTools.includes(t));
      const extra = actualTools.filter(t => !expectedTools.includes(t));
      if (missing.length > 0 || extra.length > 0) {
        const parts = [];
        if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
        if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
        return { pass: false, score: 0, reason: parts.join('; ') };
      }
      return { pass: true, score: 1, reason: `all ${expectedTools.length} tools called` };
    }
    case 'subset': {
      const allowed = new Set(expectedTools);
      const unexpected = actualTools.filter(t => !allowed.has(t));
      if (unexpected.length > 0) {
        return { pass: false, score: 0, reason: `unexpected tools: ${unexpected.join(', ')}` };
      }
      return { pass: true, score: 1, reason: `all tools within allowed set` };
    }
    case 'superset': {
      const actualSet = new Set(actualTools);
      const missing = expectedTools.filter(t => !actualSet.has(t));
      if (missing.length > 0) {
        return { pass: false, score: 0, reason: `missing tools: ${missing.join(', ')}` };
      }
      return { pass: true, score: 1, reason: `all ${expectedTools.length} expected tools called` };
    }
    default:
      return { pass: false, score: 0, reason: `unknown mode: "${mode}"` };
  }
}
