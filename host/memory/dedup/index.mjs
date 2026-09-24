import { trigramSimilarity } from './trigram.mjs';

export function createDedupGate({
  store,
  engine,
  strategy = 'trigram',
  reinforceThreshold = 0.92,
  mergeThreshold = 0.75,
} = {}) {
  const similarityFn = strategy === 'trigram' ? trigramSimilarity : trigramSimilarity;

  async function findBestMatch(newEntry) {
    const candidates = await store.query({ kinds: [newEntry.kind] });
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      if (!candidate.tags.some(t => newEntry.tags.includes(t)) && newEntry.tags.length > 0 && candidate.tags.length > 0) continue;
      const score = similarityFn(newEntry.text, candidate.text);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return { match: best, score: bestScore };
  }

  function resolveText(existing, incoming) {
    const SOURCE_PRIORITY = { human: 3, system: 2, agent: 1 };
    const existingPri = SOURCE_PRIORITY[existing.source] ?? 0;
    const incomingPri = SOURCE_PRIORITY[incoming.source] ?? 0;
    if (incomingPri > existingPri) return incoming.text;
    if (incomingPri < existingPri) return existing.text;
    return incoming.text;
  }

  return {
    async process(newEntry) {
      const { match, score } = await findBestMatch(newEntry);

      if (match && score >= reinforceThreshold) {
        const reviewPatch = engine ? engine.processReview(match, 3) : {};
        const updated = await store.update(match.id, {
          ...reviewPatch,
          storageStrength: Math.min(1, (match.storageStrength ?? 0.6) + 0.05),
        });
        return { action: 'reinforced', entry: updated, matchId: match.id, score };
      }

      if (match && score >= mergeThreshold) {
        const mergedText = resolveText(match, newEntry);
        const reviewPatch = engine ? engine.processReview(match, 3) : {};
        const updated = await store.update(match.id, {
          text: mergedText,
          tags: [...new Set([...match.tags, ...newEntry.tags])],
          ...reviewPatch,
          storageStrength: Math.min(1, (match.storageStrength ?? 0.6) + 0.05),
        });
        return { action: 'merged', entry: updated, matchId: match.id, score };
      }

      await store.store(newEntry);
      return { action: 'created', entry: newEntry, score: score ?? 0 };
    },
  };
}
