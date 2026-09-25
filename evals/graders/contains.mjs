// evals/graders/contains.mjs
export default function contains(expected, actual) {
  const text = typeof actual.result === 'string'
    ? actual.result
    : JSON.stringify(actual.result ?? '');
  const subs = expected.substrings ?? [];
  if (subs.length === 0) return { pass: true, score: 1, reason: 'no substrings to check' };
  const missing = subs.filter(s => !text.includes(s));
  const found = subs.length - missing.length;
  const score = found / subs.length;
  if (missing.length === 0) {
    return { pass: true, score: 1, reason: `all ${subs.length} substrings found: ${subs.join(', ')}` };
  }
  return {
    pass: false,
    score: Math.round(score * 100) / 100,
    reason: `missing: ${missing.map(s => `'${s}'`).join(', ')}`,
  };
}
