// host/memory/decay/fsrs6.mjs
import { DEFAULT_THRESHOLDS } from './interface.mjs';

// FSRS-6 pre-trained parameters (from the public Anki dataset, 700M+ reviews).
// These are the default w0–w20 values. Individual tuning is not needed for V1.
const DEFAULT_W = [
  0.4197, 1.1869, 3.0412, 15.2441,   // w0-w3: initial stability
  7.1434, 0.6477, 1.0007, 0.0674,     // w4-w7: difficulty
  1.6597, 0.1712, 1.0005,             // w8-w10: recall success
  2.0325, 0.0613,                     // w11-w12: recall failure
  0.3013, 0.7975,                     // w13-w14: short-term
  0.0000, 2.0902,                     // w15-w16: unused in V1
  0.5002, 0.2656,                     // w17-w18: unused in V1
  0.2485,                             // w19: unused in V1
  0.5,                                // w20: decay exponent
];

export function createFsrs6Engine({ w = DEFAULT_W, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const w20 = Math.max(0.01, Math.min(w[20] ?? 0.5, 2.0));
  const factor = Math.pow(0.9, -1.0 / w20) - 1;

  function computeRetrievability(entry, now = new Date()) {
    const lastPromoted = entry.lastPromotedAt ? new Date(entry.lastPromotedAt) : new Date(entry.createdAt);
    const elapsedDays = Math.max(0, (now.getTime() - lastPromoted.getTime()) / (1000 * 60 * 60 * 24));
    const stability = Math.max(0.01, entry.stability ?? 1.0);
    const r = Math.pow(1 + factor * elapsedDays / stability, -w20);
    return Math.max(0, Math.min(1, r));
  }

  function computeState(retrievability, thresholdsOverride) {
    const t = thresholdsOverride ?? thresholds;
    if (retrievability >= t.active) return 'active';
    if (retrievability >= t.dormant) return 'dormant';
    if (retrievability >= t.silent) return 'silent';
    return 'unavailable';
  }

  function processReview(entry, rating = 3) {
    const clampedRating = Math.max(1, Math.min(4, rating));
    const now = new Date();
    const lastPromoted = entry.lastPromotedAt ? new Date(entry.lastPromotedAt) : new Date(entry.createdAt);
    const elapsedDays = Math.max(0.01, (now.getTime() - lastPromoted.getTime()) / (1000 * 60 * 60 * 24));
    const oldStability = Math.max(0.01, entry.stability ?? 1.0);
    const oldDifficulty = Math.max(0, Math.min(1, entry.difficulty ?? 0.3));
    const r = computeRetrievability(entry, now);

    let newStability;
    let newDifficulty = oldDifficulty;
    const reps = (entry.reps ?? 0) + 1;
    let lapses = entry.lapses ?? 0;

    if (clampedRating === 1) {
      // Again — memory lapsed
      lapses += 1;
      newDifficulty = Math.min(1, oldDifficulty + 0.1);
      newStability = Math.max(0.01, oldStability * 0.5);
    } else {
      // Hard(2), Good(3), Easy(4)
      const difficultyDelta = clampedRating === 2 ? 0.05 : clampedRating === 4 ? -0.1 : 0;
      newDifficulty = Math.max(0, Math.min(1, oldDifficulty + difficultyDelta));
      const stabilityMultiplier = 1 + Math.exp(w[8] ?? 1.6) *
        (11 - oldDifficulty * 10) *
        Math.pow(oldStability, -(w[9] ?? 0.17)) *
        (Math.exp((1 - r) * (w[10] ?? 1.0)) - 1) *
        (clampedRating === 2 ? (w[13] ?? 0.3) : clampedRating === 4 ? (w[14] ?? 0.8) : 1);
      newStability = Math.max(0.01, oldStability * Math.max(1.01, stabilityMultiplier));
    }

    return {
      retrievalStrength: 1.0,
      storageStrength: Math.min(1, (entry.storageStrength ?? 0.6) + 0.05),
      state: 'active',
      stability: newStability,
      difficulty: newDifficulty,
      reps,
      lapses,
      lastPromotedAt: now.toISOString(),
      lastReviewRating: clampedRating,
    };
  }

  function shouldProcess(entry) {
    return entry.kind !== 'rule';
  }

  return { computeRetrievability, computeState, processReview, shouldProcess };
}
