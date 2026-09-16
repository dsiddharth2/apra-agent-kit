// tests/host-response-parser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseResponse } = await import('../host/response-parser.mjs');

test('extracts tool_call block', () => {
  const text = `I need to check the weather.

\`\`\`tool_call
{"tool": "weather", "args": {"city": "London"}}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'tool_call');
  assert.deepEqual(result.payload, { tool: 'weather', args: { city: 'London' } });
  assert.equal(result.reasoning, 'I need to check the weather.');
});

test('extracts plan block', () => {
  const text = `Here is my plan.

\`\`\`plan
{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'plan');
  assert.equal(result.payload.steps.length, 1);
  assert.equal(result.payload.steps[0].tool, 'weather');
});

test('extracts done block', () => {
  const text = `All done.

\`\`\`done
{"result": "London is 15°C", "summary": "Weather check completed."}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'done');
  assert.equal(result.payload.result, 'London is 15°C');
  assert.equal(result.payload.summary, 'Weather check completed.');
});

test('extracts review block', () => {
  const text = `Plan looks good.

\`\`\`review
{"approved": true}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'review');
  assert.equal(result.payload.approved, true);
});

test('extracts review block with feedback', () => {
  const text = `Two problems found.

\`\`\`review
{"approved": false, "feedback": "Step 2 uses wrong tool."}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'review');
  assert.equal(result.payload.approved, false);
  assert.equal(result.payload.feedback, 'Step 2 uses wrong tool.');
});

test('extracts step_review block', () => {
  const text = `Result looks correct.

\`\`\`step_review
{"approved": true}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'step_review');
  assert.equal(result.payload.approved, true);
});

test('extracts step_review rejection', () => {
  const text = `Wrong city returned.

\`\`\`step_review
{"approved": false, "feedback": "Got London instead of Paris."}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'step_review');
  assert.equal(result.payload.approved, false);
  assert.equal(result.payload.feedback, 'Got London instead of Paris.');
});

test('returns thinking when no block found', () => {
  const text = 'Let me think about this for a moment...';
  const result = parseResponse(text);
  assert.equal(result.type, 'thinking');
  assert.equal(result.reasoning, text);
  assert.equal(result.payload, null);
});

test('returns error for malformed JSON inside block', () => {
  const text = `Here we go.

\`\`\`tool_call
{not valid json}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'error');
  assert.ok(result.message.includes('JSON'));
});

test('first block wins when multiple blocks present', () => {
  const text = `Doing both.

\`\`\`tool_call
{"tool": "weather", "args": {}}
\`\`\`

\`\`\`done
{"result": "done"}
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'tool_call');
});

test('extracts reasoning text before block', () => {
  const text = `First I will check the weather.
Then I can compose a briefing.

\`\`\`tool_call
{"tool": "weather", "args": {"city": "Tokyo"}}
\`\`\``;
  const result = parseResponse(text);
  assert.ok(result.reasoning.includes('First I will check the weather'));
  assert.ok(result.reasoning.includes('Then I can compose'));
});

test('handles block with extra whitespace', () => {
  const text = `Ok.

\`\`\`  tool_call  
  {"tool": "weather", "args": {}}  
\`\`\``;
  const result = parseResponse(text);
  assert.equal(result.type, 'tool_call');
  assert.equal(result.payload.tool, 'weather');
});
