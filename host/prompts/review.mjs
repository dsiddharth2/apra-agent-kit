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
