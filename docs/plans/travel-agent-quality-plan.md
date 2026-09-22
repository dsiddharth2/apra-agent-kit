# Travel Agent Output Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Fleet Agent Kit's travel planning output from generic/hallucinated responses to structured, factual, comprehensive trip plans.

**Architecture:** Prompt-first approach — 6 prompt templates gain travel-domain rules (destination fidelity, date anchoring, structured output template), the agent config gains a travel specialist persona, 2 new Python tools provide attraction discovery and route distance data, and 2 existing tools gain resilience fallbacks.

**Tech Stack:** Node.js (prompt templates, registry), Python (tool scripts), Wikipedia API, OSRM API, Nominatim API

**Spec:** `docs/specs/2026-09-21-travel-agent-output-quality-spec.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `host/prompts/system.mjs` | Modify | Add destination fidelity, date anchoring, structured output rules |
| `host/prompts/plan.mjs` | Modify | Add travel-aware research sequence instructions |
| `host/prompts/review.mjs` | Modify | Add travel-specific review criteria |
| `host/prompts/execute.mjs` | Modify | Add output template for final done block |
| `host/prompts/reason.mjs` | Modify | Add tool-data referencing instruction |
| `host/prompts/replan.mjs` | Modify | Add destination/date preservation constraint |
| `host.config.mjs` | Modify | Add `agentDescription` |
| `host.config.local-functions.mjs` | Modify | Add same `agentDescription` |
| `deploy/azure-functions/host.config.mjs` | Modify | Add same `agentDescription` |
| `tools/places-of-interest/places_of_interest.py` | Create | Wikipedia attraction search |
| `tools/route-distance/route_distance.py` | Create | OSRM driving distance calculator |
| `mcp/registry.mjs` | Modify | Add 2 new tool entries |
| `tools/travel-advisory/travel_advisory.py` | Modify | Add graceful fallback on API failure |
| `tools/public-holidays/public_holidays.py` | Modify | Add hardcoded holiday fallback |
| `tests/host-prompts.test.mjs` | Modify | Add tests for new prompt content |

---

### Task 1: System Prompt — Add Travel Rules

**Files:**
- Modify: `host/prompts/system.mjs`
- Test: `tests/host-prompts.test.mjs`

- [ ] **Step 1: Write failing tests for new system prompt rules**

Add to `tests/host-prompts.test.mjs`:

```js
test('buildSystemPrompt includes destination fidelity rule', () => {
  const p = buildSystemPrompt({ agentName: 'travel-agent', agentDescription: '' });
  assert.ok(p.includes('Destination Fidelity'));
  assert.ok(p.includes('never substitute'));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-prompts.test.mjs`
Expected: 3 new tests FAIL (destination fidelity, date anchoring, structured output). The agentDescription test may already pass since the existing code injects it.

- [ ] **Step 3: Update system prompt with travel rules**

Replace the full content of `host/prompts/system.mjs`:

```js
export function buildSystemPrompt({ agentName, agentDescription }) {
  return `You are "${agentName}", an autonomous agent executing tasks using available tools.
${agentDescription ? agentDescription + '\n' : ''}
## Response format

Wrap every decision in a fenced JSON block. Always include your reasoning BEFORE the block.

### To call a tool:
\`\`\`tool_call
{"tool": "<tool_name>", "args": {<arguments>}}
\`\`\`

### To propose a plan (plan-execute strategy):
\`\`\`plan
{"steps": [
  {"type": "tool", "tool": "<name>", "args": {}, "reason": "why", "review": false},
  {"type": "reason", "prompt": "what to think about", "review": true}
]}
\`\`\`

Step types:
- "tool": call a tool. Provide args when known. Use empty args {} when values depend on prior steps — you will be asked to fill them in at execution time.
- "reason": LLM reasoning step — analyze data, compose text, make decisions without calling a tool.

Set "review": true for irreversible actions, results feeding critical downstream steps, and complex reasoning. Set "review": false for simple factual lookups.

### To signal completion:
\`\`\`done
{"result": <final_answer>, "summary": "one-line summary"}
\`\`\`

### When reviewing a plan:
\`\`\`review
{"approved": true}
\`\`\`
or
\`\`\`review
{"approved": false, "feedback": "what needs to change"}
\`\`\`

### When reviewing a step result:
\`\`\`step_review
{"approved": true}
\`\`\`
or
\`\`\`step_review
{"approved": false, "feedback": "what is wrong"}
\`\`\`

## Rules
- One tool call per turn.
- Always include reasoning before the block.
- Never call tools that do not exist.
- If a tool is denied by guardrails, choose an alternative or report that the task cannot be completed.

## Destination Fidelity
The user's requested destination is non-negotiable. Never substitute, expand, or redirect to a different destination. If the user says "Himachal", plan for Himachal Pradesh — not Andaman, not Goa, not anywhere else. If the user says "Paris", plan for Paris — not Rome, not Barcelona. Echo the exact destination and dates back in your first reasoning before any plan or tool call.

## Date Anchoring
Extract the exact travel dates and duration from the user's goal. Every day in your itinerary must have a concrete date. If the user says "from 2nd October for 10 days", that means Oct 2-11. Use these dates when calling weather/forecast tools and in the final output.

## Structured Travel Output
When completing a travel planning task, your done result MUST include:
1. A trip overview (destination, dates, highlights, budget tier)
2. A day-by-day itinerary with: date, location, morning/afternoon/evening activities, accommodation, transport between locations, meal recommendations, estimated daily cost
3. A budget summary table (accommodation, transport, food, activities, total)
4. Practical tips (packing, permits, visas, safety, local customs, connectivity)
5. Caveats (what could not be verified, what needs manual booking)
6. Use the destination's local currency for costs; include INR equivalent in parentheses for international trips`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All tests PASS including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add host/prompts/system.mjs tests/host-prompts.test.mjs
git commit -m "feat(prompts): add travel rules to system prompt — destination fidelity, date anchoring, structured output"
```

---

### Task 2: Plan Prompt — Travel-Aware Research Sequence

**Files:**
- Modify: `host/prompts/plan.mjs`
- Test: `tests/host-prompts.test.mjs`

- [ ] **Step 1: Write failing test**

Add to `tests/host-prompts.test.mjs`:

```js
test('buildPlanPrompt includes travel research instructions', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildPlanPrompt({ task: sampleTask, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('EXTRACT from the goal'));
  assert.ok(p.includes('research sequence'));
  assert.ok(p.includes('places-of-interest'));
  assert.ok(p.includes('route-distance'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/host-prompts.test.mjs`
Expected: FAIL — plan prompt does not contain the new text.

- [ ] **Step 3: Update plan prompt**

Replace the full content of `host/prompts/plan.mjs`:

```js
export function buildPlanPrompt({ task, tools, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}
${task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : ''}

## Available tools

${tools}

## Instructions

Create a plan to accomplish this task. Before writing the plan:

1. EXTRACT from the goal: destination, travel dates, duration, number of travelers, budget preference, any specific interests or constraints. State these explicitly in your reasoning.

2. PLAN a research sequence that gathers real data before composing the output:
   - Start with geography/overview (wikipedia-summary for the destination region)
   - Check weather/forecast for the travel dates
   - Research attractions and points of interest (places-of-interest tool)
   - Check public holidays and travel advisories for the destination country
   - Calculate distances/travel times between planned cities (route-distance tool)
   - Convert currency if international travel (currency tool)
   - Check visa requirements and travel advisories for the destination country (travel-advisory tool)
   - Compose the final itinerary using all gathered data (reason step with review:true)

3. Use available tools for real data rather than relying on memory. Set review:true on the final composition step — that is where quality matters most.

Respond with a \`plan\` block containing the steps.`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/prompts/plan.mjs tests/host-prompts.test.mjs
git commit -m "feat(prompts): add travel-aware research sequence to plan prompt"
```

---

### Task 3: Review Prompt — Travel-Specific Criteria

**Files:**
- Modify: `host/prompts/review.mjs`
- Test: `tests/host-prompts.test.mjs`

- [ ] **Step 1: Write failing test**

Add to `tests/host-prompts.test.mjs`:

```js
test('buildReviewPrompt includes travel review criteria', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const p = buildReviewPrompt({ task: sampleTask, plan: samplePlan, tools: toolCatalog, systemPrompt: sys });
  assert.ok(p.includes('DESTINATION MATCH'));
  assert.ok(p.includes('DATE COVERAGE'));
  assert.ok(p.includes('RESEARCH BEFORE COMPOSITION'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/host-prompts.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Update review prompt**

Replace the full content of `host/prompts/review.mjs`:

```js
export function buildReviewPrompt({ task, plan, tools, systemPrompt }) {
  return `${systemPrompt}

## Your role

You are the reviewer. Evaluate the proposed plan for completeness, correct tool selection, safety, and whether the review flags are set appropriately.

## Task

Goal: ${task.goal}

## Proposed plan

${JSON.stringify(plan, null, 2)}

## Available tools

${tools}

## Instructions

Respond with a \`review\` block. Approve if the plan is sound. Reject with feedback if there are issues — include suggestions for review flag adjustments if needed.

When reviewing a travel plan specifically, also check:
- DESTINATION MATCH: Does every step target the user's requested destination, not a different one? This is the most critical check. If the plan researches or builds an itinerary for any destination other than the one the user asked for, reject immediately.
- DATE COVERAGE: Does the plan cover all requested travel days? If the user asked for 10 days, the final itinerary must have 10 days.
- RESEARCH BEFORE COMPOSITION: Are tool calls for real data scheduled before the reasoning/composition step? The plan should not compose an itinerary before gathering weather, attractions, and distance data.
- PRACTICAL COMPLETENESS: Does the plan include weather research, transport logistics, accommodation, activities, and budget considerations?
- TOOL USAGE: Are the right tools being used? (e.g., places-of-interest for attractions, route-distance for travel times, forecast for weather, currency for international trips)`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/prompts/review.mjs tests/host-prompts.test.mjs
git commit -m "feat(prompts): add travel-specific review criteria to review prompt"
```

---

### Task 4: Execute Prompt — Output Template on Final Step

**Files:**
- Modify: `host/prompts/execute.mjs`
- Test: `tests/host-prompts.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to `tests/host-prompts.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-prompts.test.mjs`
Expected: FAIL — execute prompt has no output template.

- [ ] **Step 3: Update execute prompt**

Replace the full content of `host/prompts/execute.mjs`:

```js
const TRAVEL_OUTPUT_TEMPLATE = `
Your done result must be a comprehensive trip plan formatted as follows:

# {Destination} Trip Plan — {Start Date} to {End Date}

## Trip Overview
Destination, duration, travel style, budget tier, top highlights (3-5 bullets)

## Day-by-Day Itinerary

### Day 1: {Weekday, Date} — {City/Area}
**Getting There**: Transport from origin/previous location (mode, duration, cost)
**Morning**: Activity with specific details (timings, entry fees if any)
**Afternoon**: Activity with details
**Evening**: Activity / leisure / local market exploration
**Stay**: Specific area/type of accommodation with price range
**Meals**: Local specialties to try, recommended restaurants/areas
**Day Cost Estimate**: {local currency amount} (~INR equivalent for international) per person

(repeat for each day)

## Budget Summary
| Category | Estimated Cost (per person) |
|----------|----------------------------|
| Accommodation (X nights) | amount |
| Transport (inter-city) | amount |
| Local transport | amount |
| Food & drinks | amount |
| Activities & entry fees | amount |
| Miscellaneous (10%) | amount |
| **Total** | **amount** |

For Indian domestic trips, use INR directly. For international trips, show local currency with INR equivalent.

## Practical Tips
- What to pack for the season and terrain
- Permits, visas, or bookings needed in advance
- Local customs, language tips, safety notes, tipping norms
- Currency & payments: local currency, card acceptance, ATM availability
- Connectivity: SIM/eSIM options, power adapter type
- Best apps/resources for the destination

## Caveats & Booking Notes
- What the agent verified with tools vs. estimated from knowledge
- Items that need manual booking (flights, hotels, permits)
- Weather data limitations (if forecast does not cover travel dates)

Include the same content as a JSON object in a json code fence after the markdown, with keys: destination, dates, duration, days (array of day objects), budget, tips, caveats.`;

export function buildExecutePrompt({ task, plan, stepIndex, observation, systemPrompt }) {
  const isFinalStep = stepIndex >= (plan.steps?.length ?? 1) - 1;

  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Current plan

${JSON.stringify(plan, null, 2)}

## Completed step ${stepIndex + 1}

Result: ${JSON.stringify(observation, null, 2)}

## Instructions

The previous step has completed. Continue with the next step in the plan, or respond with a \`done\` block if all steps are complete.${isFinalStep ? '\n' + TRAVEL_OUTPUT_TEMPLATE : ''}`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add host/prompts/execute.mjs tests/host-prompts.test.mjs
git commit -m "feat(prompts): add structured travel output template to final execute prompt"
```

---

### Task 5: Reason and Replan Prompts — Minor Additions

**Files:**
- Modify: `host/prompts/reason.mjs`
- Modify: `host/prompts/replan.mjs`
- Test: `tests/host-prompts.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to `tests/host-prompts.test.mjs`:

```js
test('buildReasonPrompt includes tool-data referencing instruction', () => {
  const sys = buildSystemPrompt({ agentName: 'test', agentDescription: '' });
  const step = { type: 'reason', prompt: 'Compose a briefing', review: false };
  const p = buildReasonPrompt({ task: sampleTask, step, history: sampleHistory, systemPrompt: sys });
  assert.ok(p.includes('reference actual data from tool results'));
  assert.ok(p.includes('acknowledge the gap'));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-prompts.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Update reason prompt**

Replace the full content of `host/prompts/reason.mjs`:

```js
export function buildReasonPrompt({ task, step, history, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Reasoning step

${step.prompt}

## Observation history

${JSON.stringify(history, null, 2)}

## Instructions

Perform the reasoning described above using the observation history. Respond with your analysis directly — do not wrap it in a fenced block. Your response will be recorded as an observation for subsequent steps.

When reasoning about travel plans, reference actual data from tool results (weather readings, distances, attraction lists) rather than inventing facts. If a tool returned an error or no data, acknowledge the gap explicitly and state that the information is estimated.`;
}
```

- [ ] **Step 4: Update replan prompt**

Replace the full content of `host/prompts/replan.mjs`:

```js
export function buildReplanPrompt({ task, plan, history, failedStep, reviewerFeedback, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Previous plan

${JSON.stringify(plan, null, 2)}

## Execution history

${JSON.stringify(history, null, 2)}

${failedStep ? `## Failed step\n\n${JSON.stringify(failedStep, null, 2)}` : ''}

${reviewerFeedback ? `## Reviewer feedback\n\n${reviewerFeedback}` : ''}

## Instructions

The previous plan could not be completed. Create a revised plan for the remaining work, accounting for what has already been done and the feedback above. Respond with a \`plan\` block.

IMPORTANT: A replan must preserve the user's original destination and dates. Replanning means adjusting the research approach or itinerary structure, never changing where or when the user is traveling.`;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add host/prompts/reason.mjs host/prompts/replan.mjs tests/host-prompts.test.mjs
git commit -m "feat(prompts): add tool-data referencing to reason, destination preservation to replan"
```

---

### Task 6: Agent Persona — Config Files + Plumbing

**Files:**
- Modify: `host.config.mjs`
- Modify: `host.config.local-functions.mjs`
- Modify: `deploy/azure-functions/host.config.mjs`
- Modify: `host/config.mjs:149` (preserve `agentDescription` on frozen config)
- Modify: `host/index.mjs:110` (inject `agentName`/`agentDescription` into `runLoopConfig`)

- [ ] **Step 1: Define the shared agentDescription string**

The same string goes into all three config files. Here is the value:

```
You are a knowledgeable travel planning specialist covering both Indian domestic and international travel. You have deep expertise in:

**Indian domestic travel:**
- Destinations: hill stations, beaches, heritage circuits, wildlife, pilgrimage routes, NE India
- Seasonal awareness: monsoons (Jun-Sep), winter pass closures (Oct-Mar), peak seasons, festivals
- Budget tiers: backpacker (INR 1,500-3,000/day), mid-range (INR 3,000-8,000/day), premium (INR 8,000+/day)
- Transport: Indian Railways, state roadways, domestic flights, local taxis, shared jeeps
- Practical: permits (Ladakh, NE India, Andaman), altitude sickness, road conditions

**International travel:**
- Destinations: Southeast Asia, Europe, Middle East, East Asia, Americas, Africa, Oceania
- Visa & documentation: tourist visas, e-visas, visa-on-arrival countries for Indian passport holders
- Budget awareness: adapts currency and cost estimates to the destination country
- Transport: international flights, rail passes (Eurail, JR Pass), local transit, car rentals
- Practical: travel insurance, SIM/eSIM, power adapters, cultural etiquette, tipping norms

Always use the destination's local currency for costs; include INR equivalent when the traveler is likely Indian. Use available tools to verify weather, distances, holidays, and attractions rather than relying on memory. When tool data is unavailable, clearly state what is estimated vs. verified.
```

- [ ] **Step 2: Add agentDescription to host.config.mjs**

In `host.config.mjs`, add an `agentDescription` field at the top level of the config, after the `description` field:

```js
export default {
  name: 'apra-agent-kit',
  description: 'Fleet Agent Kit — travel research agent',
  agentDescription: `You are a knowledgeable travel planning specialist covering both Indian domestic and international travel. You have deep expertise in:

**Indian domestic travel:**
- Destinations: hill stations, beaches, heritage circuits, wildlife, pilgrimage routes, NE India
- Seasonal awareness: monsoons (Jun-Sep), winter pass closures (Oct-Mar), peak seasons, festivals
- Budget tiers: backpacker (INR 1,500-3,000/day), mid-range (INR 3,000-8,000/day), premium (INR 8,000+/day)
- Transport: Indian Railways, state roadways, domestic flights, local taxis, shared jeeps
- Practical: permits (Ladakh, NE India, Andaman), altitude sickness, road conditions

**International travel:**
- Destinations: Southeast Asia, Europe, Middle East, East Asia, Americas, Africa, Oceania
- Visa & documentation: tourist visas, e-visas, visa-on-arrival countries for Indian passport holders
- Budget awareness: adapts currency and cost estimates to the destination country
- Transport: international flights, rail passes (Eurail, JR Pass), local transit, car rentals
- Practical: travel insurance, SIM/eSIM, power adapters, cultural etiquette, tipping norms

Always use the destination's local currency for costs; include INR equivalent when the traveler is likely Indian. Use available tools to verify weather, distances, holidays, and attractions rather than relying on memory. When tool data is unavailable, clearly state what is estimated vs. verified.`,

  fleet: {},
  // ... rest of config unchanged
};
```

- [ ] **Step 3: Add same agentDescription to host.config.local-functions.mjs**

Same pattern — add `agentDescription` field with the identical string after `description`.

- [ ] **Step 4: Add same agentDescription to deploy/azure-functions/host.config.mjs**

Same pattern — add `agentDescription` field with the identical string after `description`.

- [ ] **Step 5: Plumb agentDescription through to the run loop**

The call chain is: `host/index.mjs` builds `runLoopConfig` → `host/tasks.mjs:176-182` spreads it into `runTask()` → `host/run-loop.mjs:20-21` passes `agentName`/`agentDescription` to the strategy → strategy calls `buildSystemPrompt({ agentName, agentDescription })`.

Currently `runLoopConfig` comes from `config.modules.runLoop` which does NOT contain `agentName` or `agentDescription`. The config's `agentDescription` is a top-level key. We need to inject it into `runLoopConfig`.

**Edit `host/index.mjs:110`** — after `createPhase2Modules` returns `runLoopConfig`, override it to include the agent identity:

Find this line:
```js
const { runLoopEnabled, runLoopConfig, budgetsConfig, guardrailsMod } = createPhase2Modules(toolRegistry, resolved);
```

Replace with:
```js
const phase2 = createPhase2Modules(toolRegistry, resolved);
const { runLoopEnabled, budgetsConfig, guardrailsMod } = phase2;
const runLoopConfig = {
  ...phase2.runLoopConfig,
  agentName: config.name,
  agentDescription: config.agentDescription ?? '',
};
```

This ensures `agentName` and `agentDescription` are in `runLoopConfig`, and since `host/tasks.mjs:182` does `...runLoopConfig`, they flow into `runTask()` which already accepts them at `host/run-loop.mjs:20-21`.

Also need to validate `agentDescription` is passed through in `host/config.mjs`. In the `validate` function, preserve it on the frozen config object.

**Edit `host/config.mjs:149-159`** — add `agentDescription` to the frozen return:

Find:
```js
  return Object.freeze({
    name: raw.name,
    description: raw.description ?? '',
    fleet: Object.freeze({ ...raw.fleet }),
```

Replace with:
```js
  return Object.freeze({
    name: raw.name,
    description: raw.description ?? '',
    agentDescription: raw.agentDescription ?? '',
    fleet: Object.freeze({ ...raw.fleet }),
```

- [ ] **Step 6: Run existing config tests**

Run: `node --test tests/host-config.test.mjs`
Expected: All PASS — `agentDescription` is not a validated field, so adding it should not break validation.

- [ ] **Step 7: Commit**

```bash
git add host.config.mjs host.config.local-functions.mjs deploy/azure-functions/host.config.mjs host/tasks.mjs host/index.mjs
git commit -m "feat(config): add travel agent persona via agentDescription in all config files"
```

---

### Task 7: New Tool — places-of-interest

**Files:**
- Create: `tools/places-of-interest/places_of_interest.py`
- Modify: `mcp/registry.mjs`

- [ ] **Step 1: Create the Python script**

Create `tools/places-of-interest/places_of_interest.py`:

```python
import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_places(location, limit=8):
    query = f"{location} tourism attractions things to do"
    try:
        search = _get(
            f"https://en.wikipedia.org/w/api.php"
            f"?action=query&list=search"
            f"&srsearch={urllib.request.quote(query)}"
            f"&srlimit={limit}&format=json"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"wikipedia search failed: {exc}"})

    results = search.get("query", {}).get("search", [])
    if not results:
        return json.dumps({"ok": False, "error": f"No results for: {location}"})

    page_ids = [str(r["pageid"]) for r in results]
    try:
        extracts = _get(
            f"https://en.wikipedia.org/w/api.php"
            f"?action=query&prop=extracts&exintro=true&explaintext=true"
            f"&pageids={'|'.join(page_ids)}&format=json"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"wikipedia extract failed: {exc}"})

    pages = extracts.get("query", {}).get("pages", {})
    places = []
    for r in results:
        pid = str(r["pageid"])
        page = pages.get(pid, {})
        extract = page.get("extract", "")
        if len(extract) > 500:
            extract = extract[:497] + "..."
        places.append({
            "title": r.get("title", ""),
            "extract": extract,
            "pageid": r["pageid"],
        })

    return json.dumps({
        "ok": True,
        "location": location,
        "count": len(places),
        "places": places,
    })


if __name__ == "__main__":
    loc = " ".join(sys.argv[1:-1]) if len(sys.argv) > 2 and sys.argv[-1].isdigit() else " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "London"
    lim = int(sys.argv[-1]) if len(sys.argv) > 2 and sys.argv[-1].isdigit() else 8
    if len(sys.argv) == 2:
        loc = sys.argv[1]
    print(fetch_places(loc, lim))
```

- [ ] **Step 2: Test the script locally**

Run: `python tools/places-of-interest/places_of_interest.py "Manali"`
Expected: JSON output with `ok: true`, a `places` array with Wikipedia articles about Manali tourism.

Run: `python tools/places-of-interest/places_of_interest.py "Shimla" 5`
Expected: JSON with 5 results.

- [ ] **Step 3: Add registry entry in mcp/registry.mjs**

Add this entry to the `defaultRegistry` array in `mcp/registry.mjs`, after the `wikipedia-summary` entry:

```js
  {
    name: 'places-of-interest',
    description:
      'Searches Wikipedia for tourist attractions, activities, and points of interest at a location. ' +
      'Returns titles and summary extracts for the top results. Read-only, no LLM tokens.',
    inputSchema: z.object({
      location: z.string().describe('Location to search for (e.g. Manali, Shimla, Himachal Pradesh).'),
      limit: z.number().optional().describe('Max results to return (1-20). Defaults to 8.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const location = shellEscape(args.location);
      const limit = args.limit ?? 8;
      const script = path.join(toolsDir, 'places-of-interest', 'places_of_interest.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${location}" ${limit}`,
      });
      return parseToolOutput(raw);
    },
  },
```

- [ ] **Step 4: Run registry tests**

Run: `node --test tests/host-registry.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/places-of-interest/places_of_interest.py mcp/registry.mjs
git commit -m "feat(tools): add places-of-interest tool — Wikipedia attraction search"
```

---

### Task 8: New Tool — route-distance

**Files:**
- Create: `tools/route-distance/route_distance.py`
- Modify: `mcp/registry.mjs`

- [ ] **Step 1: Create the Python script**

Create `tools/route-distance/route_distance.py`:

```python
import json
import ssl
import sys
import time
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def _geocode(city):
    data = _get(
        f"https://nominatim.openstreetmap.org/search"
        f"?q={urllib.request.quote(city)}&format=json&limit=1"
    )
    if not data:
        return None
    return {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"]), "name": data[0].get("display_name", city)}


def route_distance(from_city, to_city):
    try:
        origin = _geocode(from_city)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"Failed to geocode '{from_city}': {exc}"})
    if not origin:
        return json.dumps({"ok": False, "error": f"Could not find location: {from_city}"})

    time.sleep(1)

    try:
        dest = _geocode(to_city)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"Failed to geocode '{to_city}': {exc}"})
    if not dest:
        return json.dumps({"ok": False, "error": f"Could not find location: {to_city}"})

    try:
        route = _get(
            f"https://router.project-osrm.org/route/v1/driving/"
            f"{origin['lon']},{origin['lat']};{dest['lon']},{dest['lat']}"
            f"?overview=false"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"OSRM routing failed: {exc}"})

    if route.get("code") != "Ok" or not route.get("routes"):
        return json.dumps({"ok": False, "error": f"No driving route found between {from_city} and {to_city}"})

    leg = route["routes"][0]
    distance_km = round(leg["distance"] / 1000, 1)
    duration_sec = leg["duration"]
    hours = int(duration_sec // 3600)
    minutes = int((duration_sec % 3600) // 60)
    duration_text = f"{hours}h {minutes}m" if hours else f"{minutes}m"

    return json.dumps({
        "ok": True,
        "from": {"name": from_city, "display_name": origin["name"]},
        "to": {"name": to_city, "display_name": dest["name"]},
        "distance_km": distance_km,
        "duration_hours": round(duration_sec / 3600, 1),
        "duration_text": duration_text,
        "mode": "driving",
    })


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: route_distance.py <from_city> <to_city>"}))
        sys.exit(1)
    print(route_distance(sys.argv[1], sys.argv[2]))
```

- [ ] **Step 2: Test the script locally**

Run: `python tools/route-distance/route_distance.py "Shimla" "Manali"`
Expected: JSON with `ok: true`, `distance_km` ~250, `duration_text` ~7-8h.

Run: `python tools/route-distance/route_distance.py "Delhi" "Shimla"`
Expected: JSON with `ok: true`, ~340km, ~6-7h.

- [ ] **Step 3: Add registry entry in mcp/registry.mjs**

Add this entry to the `defaultRegistry` array, after the `places-of-interest` entry:

```js
  {
    name: 'route-distance',
    description:
      'Calculates driving distance and estimated travel time between two cities using ' +
      'OpenStreetMap routing. Returns distance in km, duration in hours, and a human-readable ' +
      'duration string. Read-only, no LLM tokens. Rate limited (1 req/sec for geocoding).',
    inputSchema: z.object({
      from: z.string().describe('Origin city name (e.g. Delhi, Shimla).'),
      to: z.string().describe('Destination city name (e.g. Manali, Dharamshala).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const from = shellEscape(args.from);
      const to = shellEscape(args.to);
      const script = path.join(toolsDir, 'route-distance', 'route_distance.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${from}" "${to}"`,
      });
      return parseToolOutput(raw);
    },
  },
```

- [ ] **Step 4: Run registry tests**

Run: `node --test tests/host-registry.test.mjs`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/route-distance/route_distance.py mcp/registry.mjs
git commit -m "feat(tools): add route-distance tool — OSRM driving distance calculator"
```

---

### Task 9: Fix travel-advisory Tool — Graceful Fallback

**Files:**
- Modify: `tools/travel-advisory/travel_advisory.py`

- [ ] **Step 1: Add graceful fallback to travel_advisory.py**

The script currently returns a hard error JSON when the API fails. Add a fallback after the existing `_get_insecure` attempt. Replace the `fetch_advisory` function:

```python
def fetch_advisory(country_code):
    data = None
    try:
        data = _get(f"https://www.travel-advisory.info/api?countrycode={urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError):
        try:
            data = _get_insecure(f"https://www.travel-advisory.info/api?countrycode={urllib.request.quote(country_code.upper())}")
        except (urllib.error.URLError, TimeoutError):
            pass

    if data is None:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "score": None,
            "message": "Travel advisory data is temporarily unavailable. Check travel.state.gov (US), gov.uk/foreign-travel-advice (UK), or smartraveller.gov.au (AU) for current advisories.",
            "source": "fallback",
            "updated": None,
        })

    api_status = data.get("api_status", {})
    if api_status.get("reply", {}).get("code") != 200:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "score": None,
            "message": "Travel advisory data is temporarily unavailable. Check travel.state.gov (US), gov.uk/foreign-travel-advice (UK), or smartraveller.gov.au (AU) for current advisories.",
            "source": "fallback",
            "updated": None,
        })

    entry = (data.get("data") or {}).get(country_code.upper())
    if not entry:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "score": None,
            "message": f"No specific advisory data for {country_code.upper()}. Check official government travel advisory sites for current information.",
            "source": "fallback",
            "updated": None,
        })

    advisory = entry.get("advisory", {})
    return json.dumps({
        "ok": True,
        "country": entry.get("name", country_code),
        "country_code": country_code.upper(),
        "score": advisory.get("score"),
        "message": advisory.get("message", ""),
        "updated": advisory.get("updated", ""),
        "source": advisory.get("source", ""),
    })
```

Key change: instead of returning `ok: false` on API failure, return `ok: true` with `source: "fallback"` and a helpful message pointing to official advisory sites. This lets the agent continue planning without flagging a tool failure.

- [ ] **Step 2: Test locally**

Run: `python tools/travel-advisory/travel_advisory.py IN`
Expected: JSON with `ok: true` — either real data or the fallback message.

- [ ] **Step 3: Commit**

```bash
git add tools/travel-advisory/travel_advisory.py
git commit -m "fix(tools): travel-advisory returns graceful fallback instead of hard error on API failure"
```

---

### Task 10: Fix public-holidays Tool — Hardcoded Fallback

**Files:**
- Modify: `tools/public-holidays/public_holidays.py`

- [ ] **Step 1: Add holiday fallback data and fallback logic**

Add a `_FALLBACK_HOLIDAYS` dict and update `fetch_holidays` to use it when the API fails. After the existing imports, add:

```python
_FALLBACK_HOLIDAYS = {
    "IN": [
        {"date": "{yr}-01-26", "name": "Republic Day", "name_en": "Republic Day", "types": ["Public"]},
        {"date": "{yr}-03-14", "name": "Holi", "name_en": "Holi", "types": ["Public"]},
        {"date": "{yr}-04-14", "name": "Ambedkar Jayanti", "name_en": "Ambedkar Jayanti", "types": ["Public"]},
        {"date": "{yr}-08-15", "name": "Independence Day", "name_en": "Independence Day", "types": ["Public"]},
        {"date": "{yr}-10-02", "name": "Gandhi Jayanti", "name_en": "Gandhi Jayanti", "types": ["Public"]},
        {"date": "{yr}-10-12", "name": "Dussehra", "name_en": "Dussehra", "types": ["Public"]},
        {"date": "{yr}-11-01", "name": "Diwali", "name_en": "Diwali", "types": ["Public"]},
        {"date": "{yr}-12-25", "name": "Christmas", "name_en": "Christmas", "types": ["Public"]},
    ],
    "US": [
        {"date": "{yr}-01-01", "name": "New Year's Day", "name_en": "New Year's Day", "types": ["Public"]},
        {"date": "{yr}-07-04", "name": "Independence Day", "name_en": "Independence Day", "types": ["Public"]},
        {"date": "{yr}-11-28", "name": "Thanksgiving", "name_en": "Thanksgiving", "types": ["Public"]},
        {"date": "{yr}-12-25", "name": "Christmas", "name_en": "Christmas", "types": ["Public"]},
    ],
    "GB": [
        {"date": "{yr}-01-01", "name": "New Year's Day", "name_en": "New Year's Day", "types": ["Public"]},
        {"date": "{yr}-12-25", "name": "Christmas", "name_en": "Christmas", "types": ["Public"]},
        {"date": "{yr}-12-26", "name": "Boxing Day", "name_en": "Boxing Day", "types": ["Public"]},
    ],
    "JP": [
        {"date": "{yr}-01-01", "name": "New Year", "name_en": "New Year's Day", "types": ["Public"]},
        {"date": "{yr}-02-11", "name": "National Foundation Day", "name_en": "National Foundation Day", "types": ["Public"]},
        {"date": "{yr}-05-03", "name": "Constitution Day", "name_en": "Constitution Memorial Day", "types": ["Public"]},
    ],
    "TH": [
        {"date": "{yr}-04-13", "name": "Songkran", "name_en": "Songkran", "types": ["Public"]},
        {"date": "{yr}-12-05", "name": "King's Birthday", "name_en": "King's Birthday", "types": ["Public"]},
    ],
    "AE": [
        {"date": "{yr}-12-02", "name": "National Day", "name_en": "National Day", "types": ["Public"]},
    ],
}


def _resolve_fallback(country_code, year):
    templates = _FALLBACK_HOLIDAYS.get(country_code.upper())
    if not templates:
        return None
    holidays = []
    for t in templates:
        h = dict(t)
        h["date"] = h["date"].replace("{yr}", str(year))
        h["fixed"] = True
        h["global"] = True
        holidays.append(h)
    return holidays
```

Then update `fetch_holidays` to try the API first, fall back on failure:

```python
def fetch_holidays(country_code, year=None):
    if year is None:
        year = datetime.now().year

    data = None
    api_error = None
    try:
        data = _get(f"https://date.nager.at/api/v3/PublicHolidays/{year}/{urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError) as exc:
        api_error = str(exc)
    except (json.JSONDecodeError, ValueError):
        api_error = "API returned empty response"

    if data is not None and isinstance(data, list):
        holidays = []
        for h in data:
            holidays.append({
                "date": h.get("date"),
                "name": h.get("localName"),
                "name_en": h.get("name"),
                "fixed": h.get("fixed"),
                "global": h.get("global"),
                "types": h.get("types", []),
            })
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "year": year,
            "count": len(holidays),
            "holidays": holidays,
        })

    fallback = _resolve_fallback(country_code, year)
    if fallback:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "year": year,
            "count": len(fallback),
            "holidays": fallback,
            "source": "fallback",
            "note": f"API unavailable ({api_error or 'no data'}); showing major fixed-date holidays only. Some movable holidays (Eid, Easter, Diwali exact date) may differ.",
        })

    return json.dumps({
        "ok": True,
        "country_code": country_code.upper(),
        "year": year,
        "count": 0,
        "holidays": [],
        "source": "fallback",
        "note": f"Holiday data unavailable for {country_code.upper()} ({api_error or 'no data'}). Check local sources for public holidays.",
    })
```

- [ ] **Step 2: Test locally**

Run: `python tools/public-holidays/public_holidays.py IN 2026`
Expected: JSON with `ok: true` — either real API data or fallback with Indian holidays.

Run: `python tools/public-holidays/public_holidays.py XX 2026`
Expected: JSON with `ok: true`, empty holidays array, fallback note.

- [ ] **Step 3: Commit**

```bash
git add tools/public-holidays/public_holidays.py
git commit -m "fix(tools): public-holidays returns fallback holidays for common countries on API failure"
```

---

### Task 11: Run Full Test Suite and Verify

**Files:**
- No changes — verification only.

- [ ] **Step 1: Run prompt tests**

Run: `node --test tests/host-prompts.test.mjs`
Expected: All PASS.

- [ ] **Step 2: Run Phase 2 tests (run loop, strategies, budgets, guardrails)**

Run: `npm run test:phase2`
Expected: All PASS — prompt changes should not break the strategy or run loop.

- [ ] **Step 3: Run Phase 4 tests (jobs, notify, comm, durable)**

Run: `npm run test:phase4`
Expected: All PASS — no changes to jobs/comm layer.

- [ ] **Step 4: Run host tests (config, registry, executor, routes)**

Run: `npm run test:host`
Expected: All PASS — registry has new entries, config has new field.

- [ ] **Step 5: Run chat tests**

Run: `npm run test:chat`
Expected: All PASS — no chat changes.

- [ ] **Step 6: Test new Python tools manually**

```bash
python tools/places-of-interest/places_of_interest.py "Himachal Pradesh"
python tools/places-of-interest/places_of_interest.py "Paris" 5
python tools/route-distance/route_distance.py "Delhi" "Manali"
python tools/route-distance/route_distance.py "Paris" "Nice"
python tools/travel-advisory/travel_advisory.py IN
python tools/travel-advisory/travel_advisory.py FR
python tools/public-holidays/public_holidays.py IN 2026
python tools/public-holidays/public_holidays.py JP 2026
```

Expected: All return `ok: true` JSON with reasonable data.

- [ ] **Step 7: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: test verification and fixups"
```
