// tests/eval-graders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import exactMatch from '../evals/graders/exact-match.mjs';
import contains from '../evals/graders/contains.mjs';
import pattern from '../evals/graders/pattern.mjs';

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
