const TRAVEL_OUTPUT_TEMPLATE = `
Your done result must be a comprehensive trip plan formatted as follows:

# {Destination} Trip Plan — {Start Date} to {End Date}

## Trip Overview
Destination, duration, travel style, budget tier, top highlights (3-5 bullets)

## Day-by-Day Itinerary

### Day 1: {Weekday, Date} — {City/Area}
**Getting There**: Transport from origin/previous location (mode, duration, cost)
**Morning**: Activity with specific details (timings, entry fees if any)
**Afternoon**: Activity with details
**Evening**: Activity / leisure / local market exploration
**Stay**: Specific area/type of accommodation with price range
**Meals**: Local specialties to try, recommended restaurants/areas
**Day Cost Estimate**: {local currency amount} (~INR equivalent for international) per person

(repeat for each day)

## Budget Summary
| Category | Estimated Cost (per person) |
|----------|----------------------------|
| Accommodation (X nights) | amount |
| Transport (inter-city) | amount |
| Local transport | amount |
| Food & drinks | amount |
| Activities & entry fees | amount |
| Miscellaneous (10%) | amount |
| **Total** | **amount** |

For Indian domestic trips, use INR directly. For international trips, show local currency with INR equivalent.

## Practical Tips
- What to pack for the season and terrain
- Permits, visas, or bookings needed in advance
- Local customs, language tips, safety notes, tipping norms
- Currency & payments: local currency, card acceptance, ATM availability
- Connectivity: SIM/eSIM options, power adapter type
- Best apps/resources for the destination

## Caveats & Booking Notes
- What the agent verified with tools vs. estimated from knowledge
- Items that need manual booking (flights, hotels, permits)
- Weather data limitations (if forecast does not cover travel dates)

Include the same content as a JSON object in a json code fence after the markdown, with keys: destination, dates, duration, days (array of day objects), budget, tips, caveats.`;

export function buildExecutePrompt({ task, plan, stepIndex, observation, systemPrompt }) {
  const isFinalStep = stepIndex >= (plan.steps?.length ?? 1) - 1;

  return `${systemPrompt}

## Task

Goal: ${task.goal}

## Current plan

${JSON.stringify(plan, null, 2)}

## Completed step ${stepIndex + 1}

Result: ${JSON.stringify(observation, null, 2)}

## Instructions

The previous step has completed. Continue with the next step in the plan, or respond with a \`done\` block if all steps are complete.${isFinalStep ? '\n' + TRAVEL_OUTPUT_TEMPLATE : ''}`;
}
