// evals/graders/llm-judge.mjs
export default async function llmJudge(expected, actual) {
  const fleetApi = expected._fleetApi;
  if (!fleetApi) return { pass: false, score: 0, reason: 'llm-judge requires _fleetApi on expected' };

  const task = expected._task ?? {};
  const prompt = `You are an eval judge. Grade the agent's output against the rubric.

Task goal: ${task.goal ?? 'unknown'}
Rubric: ${expected.rubric ?? 'no rubric provided'}
Agent output: ${JSON.stringify(actual.result)}
Agent status: ${actual.status}

Think step by step, then respond with JSON:
{ "pass": true/false, "score": 0.0-1.0, "reason": "your reasoning" }`;

  try {
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const text = response?.content?.[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*"pass"[\s\S]*\}/);
    if (!jsonMatch) {
      return { pass: false, score: 0, reason: `could not parse judge response` };
    }
    const verdict = JSON.parse(jsonMatch[0]);
    let score = typeof verdict.score === 'number' ? verdict.score : (verdict.pass ? 1 : 0);
    if (expected.scoreScale && typeof expected.scoreScale === 'number') {
      score = score / expected.scoreScale;
    }
    score = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
    const pass = verdict.pass ?? (score >= 0.6);
    return { pass, score, reason: verdict.reason ?? 'no reason given' };
  } catch (err) {
    return { pass: false, score: 0, reason: `llm-judge error: ${err.message}` };
  }
}
