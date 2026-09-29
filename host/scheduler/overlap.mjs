const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

async function loadActiveRecords(jobs) {
  if (typeof jobs?.listByStatus === 'function') {
    const queued = await jobs.listByStatus('queued');
    const processing = await jobs.listByStatus('processing');
    return [...queued, ...processing];
  }
  if (Array.isArray(jobs?._records)) return jobs._records;
  return [];
}

export async function shouldRun(scheduleName, overlapPolicy, { jobs, logger }) {
  if (overlapPolicy === 'queue') return true;

  const records = await loadActiveRecords(jobs);
  const active = records.filter(
    r => !TERMINAL_STATUSES.has(r.status) && r.metadata?.schedule?.name === scheduleName,
  );

  if (active.length > 0) {
    logger.info?.(`[scheduler] skipping "${scheduleName}": previous run still active (job ${active[0].id})`);
    return false;
  }
  return true;
}
