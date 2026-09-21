// tests/host-prompts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildSystemPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildStepReviewPrompt,
  buildExecutePrompt,
  buildResolveArgsPrompt,
  buildReasonPrompt,
  buildReplanPrompt,
  buildActPrompt,
} = await import('../host/prompts/index.mjs');
const { formatTools } = await import('../host/prompts/format-tools.mjs');

const sampleTools = [
  { name: 'weather', description: 'Get weather.', reversible: true },
  { name: 'timezone', description: 'Get time.', reversible: true },
];
const toolCatalog = formatTools(sampleTools);
const sampleTask = { id: 't-1', goal: 'Check the weather in London' };
const samplePlan = {
  steps: [
    { type: 'tool', tool: 'weather', args: { city: 'London' }, reason: 'Get weather', review: false },
  ],
};
const sampleHistory = [
  { type: 'observation', tool: 'weather', result: { ok: true, result: { temp_c: '15' } } },
];

test('buildSystemPrompt includes role and response format', () => {
  const p = buildSystemPrompt({ agentName: 'travel-agent', agentDescription: 'A travel helper' });
  assert.ok(p.includes('autonomous agent'));
  assert.ok(p.includes('tool_call'));
  assert.ok(p.includes('plan'));
  assert.ok(p.includes('done'));
  assert.ok(p.includes('review'));
  assert.ok(p.includes('travel-agent'));
});

test('buildSystemPrompt includes destination fidelity rule', () => {
  const p = buildSystemPrompt({ agentName: 'travel-agent', agentDescription: '' });
  assert.ok(p.includes('Destination Fidelity'));
  assert.ok(p.includes('Never substitute'));
});

test('buildSystemPrompt includes date anchoring rule', () => {
  const p = buildSystemPrompt({ agentName: 'travel-agent', agentDescription: '' });
  assert.ok(p.includes('Date Anchoring'));
  assert.ok(p.includes('concrete date'));
});

test('buildSystemPrompt includes structured travel output rule', () => {
  const p = buildSystemPrompt({ agentName: 'travel-agent', agentDescription: '' });
  assert.ok(p.includes('Structured Travel Output'));
  assert.ok(p.includes('day-by-day'));
  assert.ok(p.includes('budget summary'));
});

test('buildSystemPrompt includes agentDescription when provided', () => {
  const p = buildSystemPrompt({ agentName: 'agent', agentDescription: 'Specializes in travel' });
  assert.ok(p.includes('Specializes in travel'));
});

test('buildPlanPrompt includes task goal and tools', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildPlanPrompt({ task: sampleTask, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('Check the weather in London'));
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('plan'));
});

test('buildPlanPrompt includes travel research instructions', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildPlanPrompt({ task: sampleTask, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('EXTRACT from the goal'));
  assert.ok(p.includes('research sequence'));
  assert.ok(p.includes('places-of-interest'));
  assert.ok(p.includes('route-distance'));
});

test('buildReviewPrompt includes plan steps and task', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReviewPrompt({ task: sampleTask, plan: samplePlan, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('Check the weather'));
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('review'));
});

test('buildReviewPrompt includes travel review criteria', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReviewPrompt({ task: sampleTask, plan: samplePlan, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('DESTINATION MATCH'));
  assert.ok(p.includes('DATE COVERAGE'));
  assert.ok(p.includes('RESEARCH BEFORE COMPOSITION'));
});

test('buildStepReviewPrompt includes step and result', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = samplePlan.steps[0];
  const p = buildStepReviewPrompt({
    task: sampleTask, step, result: { ok: true, result: { temp_c: '15' } },
    history: sampleHistory, systemPrompt: sys,
  });
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('step_review'));
});

test('buildExecutePrompt includes step index and observation', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildExecutePrompt({
    task: sampleTask, plan: samplePlan, stepIndex: 0,
    observation: { ok: true, result: { temp_c: '15' } }, systemPrompt: sys,
  });
  assert.ok(p.includes('step'));
  assert.ok(p.includes('15'));
});

test('buildExecutePrompt includes output template on final step', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const plan = {
    steps: [
      { type: 'tool', tool: 'weather', args: { city: 'London' }, reason: 'Get weather', review: false },
      { type: 'reason', prompt: 'Compose itinerary', review: true },
    ],
  };
  const p = buildExecutePrompt({
    task: sampleTask, plan, stepIndex: 1,
    observation: { text: 'itinerary composed' }, systemPrompt: sys,
  });
  assert.ok(p.includes('Trip Overview'));
  assert.ok(p.includes('Day-by-Day Itinerary'));
  assert.ok(p.includes('Budget Summary'));
  assert.ok(p.includes('Practical Tips'));
});

test('buildExecutePrompt omits output template on non-final step', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const plan = {
    steps: [
      { type: 'tool', tool: 'weather', args: { city: 'London' }, reason: 'Get weather', review: false },
      { type: 'reason', prompt: 'Compose itinerary', review: true },
    ],
  };
  const p = buildExecutePrompt({
    task: sampleTask, plan, stepIndex: 0,
    observation: { ok: true, result: { temp_c: '15' } }, systemPrompt: sys,
  });
  assert.ok(!p.includes('Trip Overview'));
  assert.ok(!p.includes('Budget Summary'));
});

test('buildResolveArgsPrompt includes step and history', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = { type: 'tool', tool: 'textstats', args: {}, reason: 'Analyze text', review: false };
  const p = buildResolveArgsPrompt({ task: sampleTask, step, history: sampleHistory, systemPrompt: sys });
  assert.ok(p.includes('textstats'));
  assert.ok(p.includes('tool_call'));
});

test('buildReasonPrompt includes step prompt and history', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = { type: 'reason', prompt: 'Compose a briefing from the data', review: false };
  const p = buildReasonPrompt({ task: sampleTask, step, history: sampleHistory, systemPrompt: sys });
  assert.ok(p.includes('Compose a briefing'));
  assert.ok(p.includes('15'));
});

test('buildReasonPrompt includes tool-data referencing instruction', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = { type: 'reason', prompt: 'Compose a briefing', review: false };
  const p = buildReasonPrompt({ task: sampleTask, step, history: sampleHistory, systemPrompt: sys });
  assert.ok(p.includes('reference actual data from tool results'));
  assert.ok(p.includes('acknowledge the gap'));
});

test('buildReplanPrompt includes failure info and history', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReplanPrompt({
    task: sampleTask, plan: samplePlan, history: sampleHistory,
    failedStep: samplePlan.steps[0], reviewerFeedback: 'Wrong city used',
    systemPrompt: sys,
  });
  assert.ok(p.includes('Wrong city'));
  assert.ok(p.includes('plan'));
});

test('buildReplanPrompt includes destination preservation constraint', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReplanPrompt({
    task: sampleTask, plan: samplePlan, history: sampleHistory,
    failedStep: null, reviewerFeedback: 'Need more detail', systemPrompt: sys,
  });
  assert.ok(p.includes('preserve the user\'s original destination'));
  assert.ok(p.includes('never changing where'));
});

test('buildActPrompt includes task, history, and tools', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildActPrompt({ task: sampleTask, history: sampleHistory, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('Check the weather'));
  assert.ok(p.includes('weather'));
  assert.ok(p.includes('tool_call'));
  assert.ok(p.includes('done'));
});
