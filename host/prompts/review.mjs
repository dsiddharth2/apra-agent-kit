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

Respond with a \`review\` block. Approve if the plan is sound. Reject with feedback if there are issues — include suggestions for review flag adjustments if needed.`;
}
