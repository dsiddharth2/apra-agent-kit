// evals/graders/exact-match.mjs
import { deepStrictEqual } from 'node:assert';

export default function exactMatch(expected, actual) {
  if (expected.status && actual.status !== expected.status) {
    return { pass: false, score: 0, reason: `status: expected "${expected.status}", got "${actual.status}"` };
  }
  if (expected.result === undefined) {
    // The no-status string is the vacuous pass. A real status check must name
    // expected.status so a missing spread of scorer.expected cannot look the same.
    if (expected.status) {
      return { pass: true, score: 1, reason: `status matched "${expected.status}"` };
    }
    return { pass: true, score: 1, reason: 'status matched, no result check' };
  }
  try {
    deepStrictEqual(actual.result, expected.result);
    return { pass: true, score: 1, reason: 'result matched' };
  } catch {
    return {
      pass: false, score: 0,
      reason: `expected: ${JSON.stringify(expected.result)}, got: ${JSON.stringify(actual.result)}`,
    };
  }
}
