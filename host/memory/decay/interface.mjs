// host/memory/decay/interface.mjs
export const DECAY_ENGINE_METHODS = [
  'computeRetrievability',
  'computeState',
  'processReview',
  'shouldProcess',
];

export const DEFAULT_THRESHOLDS = {
  active: 0.7,
  dormant: 0.4,
  silent: 0.1,
};

export function assertDecayEngine(engine) {
  const missing = DECAY_ENGINE_METHODS.filter(m => typeof engine?.[m] !== 'function');
  if (missing.length) throw new Error(`decay engine missing: ${missing.join(', ')}`);
  return engine;
}
