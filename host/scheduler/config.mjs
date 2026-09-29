export const SCHEDULER_DEFAULTS = {
  enabled: false,
  schedules: [],
};

const OVERLAP_POLICIES = new Set(['queue', 'skip']);

export function resolveSchedulerConfig(raw = {}, { env = process.env, dispatchConfig } = {}) {
  const merged = { ...SCHEDULER_DEFAULTS, ...raw };

  const flag = String(env.SCHEDULER_ENABLED ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') merged.enabled = true;
  else if (flag === '0' || flag === 'false') merged.enabled = false;

  merged.backend = dispatchConfig?.backend ?? env.JOBS_BACKEND ?? 'in-process';

  merged.schedules = (merged.schedules ?? []).map(s => ({
    ...s,
    args: s.args ?? {},
    overlap: OVERLAP_POLICIES.has(s.overlap) ? s.overlap : 'queue',
  }));

  return merged;
}
