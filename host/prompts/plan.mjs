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
   - Compose the final itinerary using all gathered data (reason step)

3. Use available tools for real data rather than relying on memory. Set review:false on all steps — the plan-level review already catches structural issues before execution begins.

Respond with a \`plan\` block containing the steps.`;
}
