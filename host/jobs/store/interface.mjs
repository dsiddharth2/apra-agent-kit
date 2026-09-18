// Persistence contract for job records and events. See tests/helpers/store-contract.mjs
// for the executable specification. Both implementations are async so callers
// never depend on node:sqlite being synchronous.
export const STORE_METHODS = [
  'open', 'close', 'insert', 'get', 'update', 'claim',
  'listByStatus', 'appendEvent', 'events', 'purgeFinishedBefore', 'countByStatus',
];

export function assertJobStore(store) {
  const missing = STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`job store missing: ${missing.join(', ')}`);
  return store;
}
