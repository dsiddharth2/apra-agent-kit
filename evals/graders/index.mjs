// evals/graders/index.mjs
import exactMatch from './exact-match.mjs';
import contains from './contains.mjs';
import pattern from './pattern.mjs';
import trajectoryMatch from './trajectory-match.mjs';
import budgetCheck from './budget-check.mjs';
import llmJudge from './llm-judge.mjs';
import { loadCustom } from './custom.mjs';

const BUILT_IN = {
  'exact-match': exactMatch,
  'contains': contains,
  'pattern': pattern,
  'trajectory-match': trajectoryMatch,
  'budget-check': budgetCheck,
  'llm-judge': llmJudge,
};

export function resolveGrader(name, { suiteDir } = {}) {
  if (BUILT_IN[name]) return BUILT_IN[name];
  if (name.startsWith('./') || name.endsWith('.mjs')) {
    return loadCustom(name, suiteDir);
  }
  throw new Error(`unknown grader: "${name}"`);
}
