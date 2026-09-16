export function buildExecutePrompt({ task, plan, stepIndex, observation, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Current plan

${JSON.stringify(plan, null, 2)}

## Completed step ${stepIndex + 1}

Result: ${JSON.stringify(observation, null, 2)}

## Instructions

The previous step has completed. Continue with the next step in the plan, or respond with a \`done\` block if all steps are complete.`;
}
