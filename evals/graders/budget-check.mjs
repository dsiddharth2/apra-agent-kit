// evals/graders/budget-check.mjs
export default function budgetCheck(expected, actual) {
  if (!actual.budget) {
    return { pass: true, score: 1, reason: 'no budget data (budgets module disabled)' };
  }
  const { estimatedCost = 0, iterations = 0 } = actual.budget;
  const parts = [];
  let pass = true;

  if (typeof expected.maxCost === 'number') {
    if (estimatedCost > expected.maxCost) pass = false;
    parts.push(`$${estimatedCost.toFixed(3)} of $${expected.maxCost.toFixed(3)} budget`);
  }
  if (typeof expected.maxIterations === 'number') {
    if (iterations > expected.maxIterations) pass = false;
    parts.push(`${iterations} of ${expected.maxIterations} iterations`);
  }

  const costScore = typeof expected.maxCost === 'number' && expected.maxCost > 0
    ? Math.max(0, 1 - estimatedCost / expected.maxCost)
    : 1;
  const iterScore = typeof expected.maxIterations === 'number' && expected.maxIterations > 0
    ? Math.max(0, 1 - iterations / expected.maxIterations)
    : 1;
  const score = Math.round(Math.min(costScore, iterScore) * 100) / 100;

  return { pass, score, reason: parts.join(', ') || 'no limits specified' };
}
