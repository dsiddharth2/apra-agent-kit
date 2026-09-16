export function buildActPrompt({ task, history, tools, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}
${task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : ''}

## Available tools

${tools}

## Observation history

${JSON.stringify(history, null, 2)}

## Instructions

Decide what to do next. You can:
- Call a tool: respond with a \`tool_call\` block.
- Finish: respond with a \`done\` block.

Choose the action that best advances the task toward completion.`;
}
