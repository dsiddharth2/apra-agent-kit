export function buildResolveArgsPrompt({ task, step, history, systemPrompt }) {
  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Current step

Tool: ${step.tool}
Reason: ${step.reason}
Planned args: ${JSON.stringify(step.args)}

## Observation history

${JSON.stringify(history, null, 2)}

## Instructions

This step has empty or partial args that depend on prior results. Given the observation history, provide the concrete arguments for this tool call. Respond with a \`tool_call\` block.`;
}
