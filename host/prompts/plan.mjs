export function buildPlanPrompt({ task, tools, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}
${task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : ''}

## Available tools

${tools}

## Instructions

Create a plan to accomplish this task. Respond with a \`plan\` block containing the steps. Each step should have a type ("tool" or "reason"), and a "review" flag.`;
}
