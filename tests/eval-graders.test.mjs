// tests/eval-graders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import exactMatch from '../evals/graders/exact-match.mjs';

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
