# Travel Agent Output Quality — Prompt & Tool Improvements

**Date**: 2026-09-21  
**Status**: Draft  
**Scope**: Prompt overhaul + 2 new tools + 2 tool fixes + agent persona  

## Problem

When asked "Plan a trip to Himachal from 2nd October this year for 10 days", the agent:

1. Planned for **Andaman Islands** instead of Himachal Pradesh — a destination hallucination
2. Produced an output with caveats about failed API lookups (travel-advisory 404, public-holidays empty)
3. Returned a flat summary paragraph, not a structured day-by-day itinerary
4. Had no way to discover attractions (only `wikipedia-summary` for a single known topic)
5. Had no way to estimate travel times between cities

The root causes are:
- **Generic prompts** with no travel-domain grounding or destination fidelity rules
- **No agent persona** — `agentDescription` is empty in config
- **Missing tools** for attraction discovery and route/distance calculation
- **Broken tools** — `travel-advisory` and `public-holidays` returning errors
- **No output template** — the `done` prompt gives zero structure guidance

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Approach | Prompts + tools (no strategy changes) | Fastest path to quality; strategy layer works fine |
| Research depth | Moderate (8-12 tool calls) | Region-level lookups + LLM knowledge for city details |
| Correctness | Stronger prompts, no input extraction phase | User prefers simplicity; prompts can enforce destination fidelity |
| Output format | Structured markdown + JSON + narrative | User wants rich, comprehensive, "amazing" output |
| Agent persona | Travel specialist | Grounds LLM responses in domain expertise |

## Changes

### 1. Agent Persona — `host.config.mjs`

Add `agentDescription` to the config object (and both azure-functions config variants):

```
agentDescription: `You are a knowledgeable travel planning specialist covering both Indian domestic
and international travel. You have deep expertise in:

**Indian domestic travel:**
- Destinations: hill stations, beaches, heritage circuits, wildlife, pilgrimage routes, NE India
- Seasonal awareness: monsoons (Jun-Sep), winter pass closures (Oct-Mar), peak seasons, festivals
- Budget tiers: backpacker (₹1,500-3,000/day), mid-range (₹3,000-8,000/day), premium (₹8,000+/day)
- Transport: Indian Railways, state roadways, domestic flights, local taxis, shared jeeps
- Practical: permits (Ladakh, NE India, Andaman), altitude sickness, road conditions

**International travel:**
- Destinations: Southeast Asia, Europe, Middle East, East Asia, Americas, Africa, Oceania
- Visa & documentation: tourist visas, e-visas, visa-on-arrival countries for Indian passport holders
- Budget awareness: adapts currency and cost estimates to the destination country
- Transport: international flights, rail passes (Eurail, JR Pass), local transit, car rentals
- Practical: travel insurance, SIM/eSIM, power adapters, cultural etiquette, tipping norms

**General:**
- Always use the destination's local currency for costs; include INR equivalent when the traveler
  is likely Indian
- Use available tools to verify weather, distances, holidays, and attractions rather than relying
  on memory. When tool data is unavailable, clearly state what is estimated vs. verified.`
```

This string is passed into `buildSystemPrompt({ agentName, agentDescription })` which already
injects it below the agent name.

### 2. System Prompt — `host/prompts/system.mjs`

Add three rules after the existing `## Rules` section:

**Rule: Destination Fidelity**
> The user's requested destination is non-negotiable. Never substitute, expand, or redirect to
> a different destination. If the user says "Himachal", plan for Himachal Pradesh. If "Goa",
> plan for Goa. Echo the exact destination and dates back in your first reasoning before any
> plan or tool call.

**Rule: Date Anchoring**
> Extract the exact travel dates and duration from the user's goal. Every day in your itinerary
> must have a concrete date. If the user says "from 2nd October for 10 days", that means
> Oct 2–11. Use these dates when calling weather/forecast tools and in the final output.

**Rule: Structured Travel Output**
> When completing a travel planning task, your `done` result MUST include:
> 1. A trip overview (destination, dates, highlights, budget tier)
> 2. A day-by-day itinerary with: date, location, morning/afternoon/evening activities,
>    accommodation, transport between locations, meal recommendations, estimated daily cost
> 3. A budget summary table (accommodation, transport, food, activities, total)
> 4. Practical tips (packing, permits, safety, local customs)
> 5. Caveats (what couldn't be verified, what needs manual booking)

These rules are appended to the existing rules list and apply regardless of strategy.

### 3. Plan Prompt — `host/prompts/plan.mjs`

Replace the generic instructions with travel-aware planning guidance:

```
## Instructions

Create a plan to accomplish this task. Before writing the plan:

1. EXTRACT from the goal: destination, travel dates, duration, number of travelers,
   budget preference, any specific interests or constraints. State these explicitly
   in your reasoning.

2. PLAN a research sequence:
   - Start with geography/overview (wikipedia-summary for the destination region)
   - Check weather/forecast for the travel dates
   - Research attractions and points of interest (places-of-interest tool)
   - Check public holidays and travel advisories
   - Calculate distances/travel times between planned cities (route-distance tool)
   - Convert currency if international travel (currency tool with destination country's currency)
   - Check visa requirements and travel advisories for the destination country (travel-advisory tool)
   - Compose the final itinerary using all gathered data (reason step with review:true)

3. Use available tools for real data rather than relying on memory. Set review:true
   on the final composition step — that's where quality matters most.

Respond with a `plan` block containing the steps.
```

### 4. Review Prompt — `host/prompts/review.mjs`

Add travel-specific review criteria after the existing instructions:

```
When reviewing a travel plan specifically, also check:
- DESTINATION MATCH: Does every step target the user's requested destination, not a
  different one? This is the most critical check.
- DATE COVERAGE: Does the plan cover all requested travel days?
- RESEARCH BEFORE COMPOSITION: Are tool calls for real data scheduled before the
  reasoning/composition step?
- PRACTICAL COMPLETENESS: Does the plan include weather research, transport logistics,
  accommodation, activities, and budget considerations?
- TOOL USAGE: Are the right tools being used? (e.g., places-of-interest for
  attractions, route-distance for travel times, forecast for weather)
```

### 5. Execute/Done Prompt — `host/prompts/execute.mjs`

When the final step has completed (`stepIndex === plan.steps.length - 1`), the execute
prompt should append the output template below. For mid-plan execute prompts (earlier steps),
keep the existing text unchanged. The detection is in `buildExecutePrompt` — check `stepIndex`
against `plan.steps.length - 1`:

```
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
**Day Cost Estimate**: {local currency amount} (~₹X,XXX) per person

(repeat for each day)

## Budget Summary
| Category | Estimated Cost (per person) |
|----------|----------------------------|
| Accommodation (X nights) | {amount in local currency} (~₹XX,XXX) |
| Transport (inter-city) | ... |
| Local transport | ... |
| Food & drinks | ... |
| Activities & entry fees | ... |
| Miscellaneous (10%) | ... |
| **Total** | **{local} (~₹XX,XXX)** |

For Indian domestic trips, use ₹ directly without the conversion parenthetical.

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
- Weather data limitations (if forecast doesn't cover travel dates)

Include the same content as a JSON object in a `json` code fence after the markdown,
with keys: destination, dates, duration, days (array of day objects), budget, tips, caveats.
```

### 6. Reason Prompt — `host/prompts/reason.mjs`

Add a single instruction line:

```
When reasoning about travel plans, reference actual data from tool results (weather readings,
distances, attraction lists) rather than inventing facts. If a tool returned an error or no
data, acknowledge the gap explicitly.
```

### 7. Replan Prompt — `host/prompts/replan.mjs`

Add constraint:

```
IMPORTANT: A replan must preserve the user's original destination and dates. Replanning means
adjusting the research approach or itinerary structure, never changing where or when the
user is traveling.
```

### 8. New Tool: `places-of-interest`

**File**: `tools/places-of-interest/places_of_interest.py`  
**Registry entry in**: `mcp/registry.mjs`

**Behavior**:
- Takes a `location` string (e.g., "Manali", "Shimla", "Himachal Pradesh")
- Queries Wikipedia API: `action=query&list=search&srsearch={location} tourism attractions things to do&srlimit={limit}`
- For each result, fetches the extract via `action=query&prop=extracts&exintro=true&explaintext=true`
- Returns JSON array: `[{ title, extract, pageid }]`
- Default limit: 8 results

**Schema**: `places-of-interest({ location: string, limit?: number })`  
**Tags**: `readOnlyHint: true, idempotentHint: true`  
**Description**: "Searches Wikipedia for tourist attractions, activities, and points of interest at a location. Returns titles and summary extracts. Read-only, no LLM tokens."

### 9. New Tool: `route-distance`

**File**: `tools/route-distance/route_distance.py`  
**Registry entry in**: `mcp/registry.mjs`

**Behavior**:
- Takes `from` and `to` city names
- Step 1: Geocode both cities via Nominatim (`nominatim.openstreetmap.org/search`)
- Step 2: Query OSRM demo server: `router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=false`
- Returns JSON: `{ from, to, distance_km, duration_hours, duration_text, mode: "driving" }`
- Falls back with error message if either city can't be geocoded or OSRM is unreachable
- Respects 1 req/sec rate limit for Nominatim (already enforced in geocode tool)

**Schema**: `route-distance({ from: string, to: string })`  
**Tags**: `readOnlyHint: true, idempotentHint: true`  
**Description**: "Calculates driving distance and estimated travel time between two cities using OpenStreetMap routing. Returns distance in km and duration. Read-only, no LLM tokens."

### 10. Fix Existing Tools

**`travel-advisory`** (`tools/travel-advisory/travel_advisory.py`):
- The script is correct — it uses `travel-advisory.info/api` which is a known flaky service
  (SSL cert issues, intermittent 404s). The `_get_insecure` fallback already exists but may
  still fail on timeouts.
- Fix: add a second fallback that returns a generic "advisory data temporarily unavailable —
  check travel.state.gov or smartraveller.gov.au manually" instead of a hard error, so the
  agent can continue planning without this data rather than flagging a tool failure.

**`public-holidays`** (`tools/public-holidays/public_holidays.py`):
- The script uses `date.nager.at/api/v3/PublicHolidays` which is correct. India (IN) is a
  supported country code. The 404/empty likely came from a transient API issue or the fleet
  member lacking network access.
- Fix: add a hardcoded fallback for major national holidays of the most common travel
  destinations (India, US, UK, Japan, Thailand, UAE, etc.) that kicks in when the API returns
  an error. For India: Republic Day, Independence Day, Gandhi Jayanti, Diwali, Holi, etc.
  For other countries: a small curated set of fixed-date holidays. This ensures the agent
  always has basic holiday data even when the API is down.

## Files Changed

| File | Change Type | Description |
|------|------------|-------------|
| `host.config.mjs` | Edit | Add `agentDescription` |
| `deploy/azure-functions/host.config.mjs` | Edit | Add same `agentDescription` |
| `host.config.local-functions.mjs` | Edit | Add same `agentDescription` |
| `host/prompts/system.mjs` | Edit | Add destination fidelity, date anchoring, output structure rules |
| `host/prompts/plan.mjs` | Edit | Add travel-aware planning instructions with research sequence |
| `host/prompts/review.mjs` | Edit | Add travel-specific review criteria |
| `host/prompts/execute.mjs` | Edit | Add output template for travel plan done blocks |
| `host/prompts/reason.mjs` | Edit | Add tool-data referencing instruction |
| `host/prompts/replan.mjs` | Edit | Add destination/date preservation constraint |
| `mcp/registry.mjs` | Edit | Add `places-of-interest` and `route-distance` entries |
| `tools/places-of-interest/places_of_interest.py` | New | Wikipedia attraction search script |
| `tools/route-distance/route_distance.py` | New | OSRM driving distance script |
| `tools/travel-advisory/travel_advisory.py` | Fix | Fix 404 API endpoint |
| `tools/public-holidays/public_holidays.py` | Fix | Fix empty/404 response |

## Testing

- Run existing test suites (`test:phase2`, `test:phase4`) to verify no regressions
- Manual test: submit `{ "goal": "Plan a trip to Himachal from 2nd October this year for 10 days" }` via `/task` and verify:
  - Output mentions Himachal Pradesh, not any other destination
  - Day-by-day itinerary covers Oct 2–11 (10 days)
  - Budget summary table is present
  - Practical tips section exists
  - JSON block is included after the markdown
- Manual test: submit a second trip (e.g., "Plan a trip to Goa for 5 days in December") to verify the prompts generalize

## Out of Scope

- Strategy layer changes (no new strategy file)
- Input extraction as a first-class phase (relying on prompt instructions instead)
- Output schema validation (trusting the LLM to follow the template)
- New accommodation/booking tools (no free APIs available)
- Chat UI changes (output renders fine in existing chat)
