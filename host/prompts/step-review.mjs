export function buildStepReviewPrompt({ task, step, result, history, systemPrompt }) {
  return `${systemPrompt}

## Your role

You are the reviewer. Verify that this step's result is correct and appropriate for the task.

## Task

Goal: ${task.goal}

## Step executed

${JSON.stringify(step, null, 2)}

## Step result

${JSON.stringify(result, null, 2)}

## History so far

${JSON.stringify(history, null, 2)}

## Instructions

Respond with a \`step_review\` block. Approve if the result is correct. Reject with feedback explaining what is wrong.`;
}
