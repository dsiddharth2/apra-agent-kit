const REQUIRED = ['start', 'stop', 'getSchedules'];

export function assertSchedulerBackend(obj) {
  const missing = REQUIRED.filter(k => typeof obj?.[k] !== 'function');
  if (missing.length) throw new Error(`scheduler backend missing: ${missing.join(', ')}`);
  return obj;
}
