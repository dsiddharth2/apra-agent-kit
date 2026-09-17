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

The previous plan could not be completed. Create a revised plan for the remaining work, accounting for what has already been done and the feedback above. Respond with a \`plan\` block.`;
}
