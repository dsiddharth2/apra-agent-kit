// evals/baseline.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

export async function findLatestReport(suiteName, reportDir, { excludeTimestamp } = {}) {
  let files;
  try { files = await fs.readdir(reportDir); } catch { return null; }
  const excludeSuffix = excludeTimestamp?.replace(/[:.]/g, '-');
  const matching = files
    .filter(f => f.startsWith(`${suiteName}-`) && f.endsWith('.json'))
    .filter(f => !excludeSuffix || !f.includes(excludeSuffix))
    .sort()
    .reverse();
  if (matching.length === 0) return null;
  const text = await fs.readFile(path.join(reportDir, matching[0]), 'utf8');
  return JSON.parse(text);
}

export async function findReportByTimestamp(suiteName, timestamp, reportDir) {
  const files = await fs.readdir(reportDir);
  const match = files.find(f => f.startsWith(`${suiteName}-`) && f.includes(timestamp.replace(/[:.]/g, '-')));
  if (!match) return null;
  const text = await fs.readFile(path.join(reportDir, match), 'utf8');
  return JSON.parse(text);
}

export function diffReports(baseline, current) {
  const baseMap = new Map(baseline.results.map(r => [r.id, r]));
  const curMap = new Map(current.results.map(r => [r.id, r]));

  const fixed = [];
  const regressions = [];
  const scoreChanges = [];
  const added = [];
  const removed = [];

  for (const [id, cur] of curMap) {
    const base = baseMap.get(id);
    if (!base) { added.push(cur); continue; }
    const curPass = Object.values(cur.scores).every(s => s.pass);
    const basePass = Object.values(base.scores).every(s => s.pass);
    if (!basePass && curPass) fixed.push({ id, base, current: cur });
    else if (basePass && !curPass) regressions.push({ id, base, current: cur });
    else {
      for (const [name, curScore] of Object.entries(cur.scores)) {
        const baseScore = base.scores?.[name];
        if (baseScore && Math.abs(curScore.score - baseScore.score) > 0.01) {
          scoreChanges.push({ id, scorer: name, from: baseScore.score, to: curScore.score });
        }
      }
    }
  }

  for (const [id, base] of baseMap) {
    if (!curMap.has(id)) removed.push(base);
  }

  return { fixed, regressions, scoreChanges, added, removed };
}
