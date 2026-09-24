export function createWorkingContext({
  fleetApi,
  maxTurns = 50,
  compactionStrategy = 'summarise',
  fallbackStrategy = 'sliding-window',
  keepRecent = 25,
  logger = console,
} = {}) {
  const raw = [];
  let compacted = null;

  async function summarise(entries) {
    const text = entries.map((e, i) => `[${i + 1}] ${e.tool ?? e.type ?? 'step'}: ${e.text ?? e.result ?? JSON.stringify(e).slice(0, 200)}`).join('\n');
    const prompt = `Summarise the following agent observation history into a concise paragraph. Preserve key facts, decisions, and results. Do not add new information.\n\n${text}`;
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const summary = typeof response === 'string' ? response : (response?.content ?? []).map(p => p.text ?? '').join('\n');
    return { type: 'summary', text: summary };
  }

  function slidingWindow(all) {
    return all.slice(-keepRecent);
  }

  return {
    append(observation) {
      raw.push(observation);
    },

    async forPrompt() {
      if (raw.length <= maxTurns) return [...raw];

      const toCompact = raw.slice(0, raw.length - keepRecent);
      const recent = raw.slice(-keepRecent);

      if (compactionStrategy === 'summarise') {
        try {
          compacted = await summarise(toCompact);
          return [compacted, ...recent];
        } catch (err) {
          logger.warn?.(`[memory/working-context] summarise failed, falling back to ${fallbackStrategy}: ${err?.message ?? err}`);
          return slidingWindow(raw);
        }
      }

      return slidingWindow(raw);
    },

    history() {
      return [...raw];
    },
  };
}
