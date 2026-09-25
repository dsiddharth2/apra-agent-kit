// tests/eval-graders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import exactMatch from '../evals/graders/exact-match.mjs';
import contains from '../evals/graders/contains.mjs';
import pattern from '../evals/graders/pattern.mjs';
import trajectoryMatch from '../evals/graders/trajectory-match.mjs';
import budgetCheck from '../evals/graders/budget-check.mjs';
import llmJudge from '../evals/graders/llm-judge.mjs';

const historyWith = (...tools) => tools.map(tool => ({ type: 'action', tool }));

test('exact-match: passes when result matches', () => {
  const expected = { result: { count: 3 } };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('exact-match: fails when result differs', () => {
  const expected = { result: { count: 3 } };
  const actual = { status: 'completed', result: { count: 5 }, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
});

test('exact-match: checks status when expected.status present', () => {
  const expected = { status: 'completed', result: { count: 3 } };
  const actual = { status: 'failed', result: { count: 3 }, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, false);
});

test('exact-match: passes with status match', () => {
  const expected = { status: 'budget_exceeded' };
  const actual = { status: 'budget_exceeded', result: null, history: [], budget: null };
  const r = exactMatch(expected, actual);
  assert.equal(r.pass, true);
});

test('contains: passes when all substrings found', () => {
  const expected = { substrings: ['invoice', 'mismatch'] };
  const actual = { status: 'completed', result: 'Found invoice mismatch in ledger', history: [], budget: null };
  const r = contains(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('contains: fails with partial match', () => {
  const expected = { substrings: ['invoice', 'mismatch', 'total'] };
  const actual = { status: 'completed', result: 'Found invoice in ledger', history: [], budget: null };
  const r = contains(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.score > 0.3 && r.score < 0.4); // 1/3
  assert.ok(r.reason.includes('mismatch'));
  assert.ok(r.reason.includes('total'));
});

test('contains: stringifies non-string result', () => {
  const expected = { substrings: ['count', '3'] };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = contains(expected, actual);
  assert.equal(r.pass, true);
});

test('pattern: passes when regex matches', () => {
  const expected = { pattern: 'found \\d+ mismatches' };
  const actual = { status: 'completed', result: 'found 3 mismatches in ledger', history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('pattern: fails when regex does not match', () => {
  const expected = { pattern: 'found \\d+ mismatches' };
  const actual = { status: 'completed', result: 'no issues found', history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
});

test('pattern: respects flags', () => {
  const expected = { pattern: 'HELLO', flags: 'i' };
  const actual = { status: 'completed', result: 'hello world', history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, true);
});

test('pattern: stringifies non-string result', () => {
  const expected = { pattern: '"count":3' };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = pattern(expected, actual);
  assert.equal(r.pass, true);
});

test('trajectory-match: strict passes with exact order', () => {
  const expected = { mode: 'strict', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather', 'forecast'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: strict fails with wrong order', () => {
  const expected = { mode: 'strict', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('forecast', 'weather'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, false);
});

test('trajectory-match: unordered passes regardless of order', () => {
  const expected = { mode: 'unordered', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('forecast', 'weather'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: unordered fails with missing tool', () => {
  const expected = { mode: 'unordered', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather'), budget: null };
  const r = trajectoryMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('forecast'));
});

test('trajectory-match: subset passes when no extra tools', () => {
  const expected = { mode: 'subset', trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: subset fails with unexpected tool', () => {
  const expected = { mode: 'subset', trajectory: [{ tool: 'weather' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather', 'delete-all'), budget: null };
  const r = trajectoryMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('delete-all'));
});

test('trajectory-match: superset (default) passes with extra tools', () => {
  const expected = { trajectory: [{ tool: 'weather' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather', 'forecast', 'geocode'), budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('trajectory-match: superset fails when expected tool missing', () => {
  const expected = { trajectory: [{ tool: 'weather' }, { tool: 'forecast' }] };
  const actual = { status: 'completed', result: null, history: historyWith('weather'), budget: null };
  const r = trajectoryMatch(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('forecast'));
});

test('trajectory-match: ignores non-action history entries', () => {
  const expected = { trajectory: [{ tool: 'weather' }] };
  const history = [{ type: 'observation', tool: 'weather' }, { type: 'action', tool: 'weather' }, { type: 'plan' }];
  const actual = { status: 'completed', result: null, history, budget: null };
  assert.equal(trajectoryMatch(expected, actual).pass, true);
});

test('budget-check: passes within cost limit', () => {
  const expected = { maxCost: 0.10 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.03, iterations: 3 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, true);
  assert.ok(r.score > 0.5);
});

test('budget-check: fails over cost limit', () => {
  const expected = { maxCost: 0.05 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.08, iterations: 3 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, false);
});

test('budget-check: checks iterations when maxIterations set', () => {
  const expected = { maxCost: 1.00, maxIterations: 3 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.01, iterations: 5 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('iterations'));
});

test('budget-check: passes when both within limits', () => {
  const expected = { maxCost: 0.50, maxIterations: 10 };
  const actual = { status: 'completed', result: null, history: [], budget: { estimatedCost: 0.20, iterations: 5 } };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, true);
});

test('budget-check: passes with warning when budget is null', () => {
  const expected = { maxCost: 0.10 };
  const actual = { status: 'completed', result: null, history: [], budget: null };
  const r = budgetCheck(expected, actual);
  assert.equal(r.pass, true);
  assert.ok(r.reason.includes('no budget data'));
});

test('llm-judge: passes with positive judgment', async () => {
  const fakeFleet = {
    async executePrompt() {
      return { content: [{ type: 'text', text: '{"pass": true, "score": 0.9, "reason": "correct"}' }] };
    },
  };
  const expected = { rubric: 'Should return correct count', _task: { goal: 'Count items' }, _fleetApi: fakeFleet };
  const actual = { status: 'completed', result: { count: 3 }, history: [], budget: null };
  const r = await llmJudge(expected, actual);
  assert.equal(r.pass, true);
  assert.equal(r.score, 0.9);
});

test('llm-judge: fails with negative judgment', async () => {
  const fakeFleet = {
    async executePrompt() {
      return { content: [{ type: 'text', text: '{"pass": false, "score": 0.2, "reason": "wrong format"}' }] };
    },
  };
  const expected = { rubric: 'Should return structured data', _task: { goal: 'Format data' }, _fleetApi: fakeFleet };
  const actual = { status: 'completed', result: 'just text', history: [], budget: null };
  const r = await llmJudge(expected, actual);
  assert.equal(r.pass, false);
  assert.equal(r.score, 0.2);
});

test('llm-judge: handles unparseable response gracefully', async () => {
  const fakeFleet = {
    async executePrompt() {
      return { content: [{ type: 'text', text: 'I think this is good' }] };
    },
  };
  const expected = { rubric: 'test', _task: { goal: 'test' }, _fleetApi: fakeFleet };
  const actual = { status: 'completed', result: null, history: [], budget: null };
  const r = await llmJudge(expected, actual);
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('parse'));
});

import { resolveGrader } from '../evals/graders/index.mjs';

test('resolveGrader: resolves all built-in graders by name', () => {
  const names = ['exact-match', 'contains', 'pattern', 'trajectory-match', 'budget-check', 'llm-judge'];
  for (const name of names) {
    const grader = resolveGrader(name);
    assert.equal(typeof grader, 'function', `${name} should resolve to a function`);
  }
});

test('resolveGrader: throws on unknown name', () => {
  assert.throws(() => resolveGrader('nonexistent'), /unknown grader/);
});

test('resolveGrader: treats ./ prefix as custom path', async () => {
  // loadCustom returns an async import — test that the factory detects the pattern
  // We can't easily test a real file load here, but we verify the factory branches correctly
  assert.throws(() => resolveGrader('./does-not-exist.mjs', { suiteDir: '/tmp' }), /Cannot find module|ENOENT|ERR_MODULE_NOT_FOUND/);
});
