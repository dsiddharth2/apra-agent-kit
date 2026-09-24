export function trigrams(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  if (normalized.length < 3) return new Set([normalized]);
  const set = new Set();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a, b) {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}
