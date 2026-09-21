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
