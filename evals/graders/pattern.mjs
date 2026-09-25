// evals/graders/pattern.mjs
export default function pattern(expected, actual) {
  const body = typeof actual.result === 'string'
    ? actual.result
    : JSON.stringify(actual.result ?? '');
  const text = `${actual.status}\n${body}`;
  const re = new RegExp(expected.pattern, expected.flags ?? '');
  const matched = re.test(text);
  return {
    pass: matched,
    score: matched ? 1 : 0,
    reason: matched ? `matched /${expected.pattern}/` : `no match for /${expected.pattern}/`,
  };
}
