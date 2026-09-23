---
name: agent-builder
description: "Guided end-to-end agent creation for the Fleet Agent Kit — interview, spec, scaffold, implementation plan. Use when the user wants to build a new agent, add a workflow, design a Fleet agent, or says 'build an agent', 'new agent', 'create an agent', 'add a workflow', '/agent-builder'."
---

# Agent Builder

Build a complete Fleet agent from an idea. This skill walks any developer through
specifying, scaffolding, and planning a new agent — then hands off to an execution
tool (superpowers or Fleet Sprint) to build it.

**Output**: An agent spec (`docs/specs/`) and implementation plan (`docs/plans/`).

## Checklist

You MUST create a task for each of these phases and complete them in order:

1. **Phase 0 — Prerequisites**
2. **Phase 0.5 — Scaffold**
3. **Phase 1 — Interview** (Stage A: wizard, Stage B: grilling)
4. **Phase 2 — Spec generation**
5. **Phase 3 — Implementation plan**
6. **Phase 4 — Handoff**

---

## Phase 0: Prerequisites

Run three checks. Fix each problem before moving on — don't just report it.

### Check 1: Kit project detection

Look for `mcp/registry.mjs`, `host/`, and `transport/` in the current directory.

- **If found**: this is a Kit project. Skip Phase 0.5 (scaffold).
- **If not found**: tell the user "This doesn't look like a Fleet Agent Kit project.
  I'll scaffold one for you." Proceed to Phase 0.5.

### Check 2: Superpowers skills

Check if `brainstorming` and `writing-plans` appear in the available-skills listing.

- **If both present**: continue.
- **If missing**: tell the user "I need the superpowers skills (brainstorming and
  writing-plans) for the design and planning phases. Let me install them." Run:
  ```
  /plugin install superpowers@claude-plugins-official
  ```
  If that marketplace is unavailable:
  ```
  /plugin marketplace add obra/superpowers-marketplace
  /plugin install superpowers@superpowers-marketplace
  ```
  If install still fails, tell the user and continue — Phases 1–2 are
  self-contained; only Phase 3 needs `writing-plans`.
  Explain: "These skills handle the brainstorming and planning process — the
  agent-builder orchestrates them for Fleet agents specifically."

### Check 3: Fleet status

Run `apra-fleet status`.

- **If running**: continue.
- **If not running**: tell the user "Fleet isn't running. Let me start it." Run
  `apra-fleet start`. If that fails, run the Kit's doctor check (`npm run doctor`
  if available, or `node scripts/doctor.mjs`) and guide the user through fixing
  each issue.
- **Don't block on this** if the developer just wants to scaffold and spec — Fleet
  is only needed for integration testing later.

---

## Phase 0.5: Scaffold

**Skip this phase if Phase 0 detected a Kit project.**

Ask the developer for the agent name using AskUserQuestion:

> "What should your agent project be called? (lowercase, hyphens ok, npm package
> name rules — e.g. `my-weather-agent`, `data-pipeline-bot`)"

Validate: non-empty, max 214 chars, no leading `.` or `_`, matches
`/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/`.

Then scaffold:

```bash
npm create @dsiddharth2/fleet-agent <agent-name>
```

Change working directory into `./<agent-name>/`.

Run the doctor check:
```bash
npm run doctor
```

Report results. Don't block on non-critical failures (missing Docker is fine for
local dev).

Store the agent name — you'll use it throughout the remaining phases.

---

## Phase 1: Interview

### Stage A — Structured Wizard

Ask questions using AskUserQuestion. Batch related questions into multi-question
calls to keep the interview fast (4 rounds instead of 7).

Skip question 1 if the agent name was already collected in Phase 0.5. If skipped,
still ask the purpose only. Store the name for Phases 2–4 file paths
(`docs/specs/`, `docs/plans/`).

**Round 1: Purpose first** (single question, freeform)
> "What should this agent do? Describe what it does in a sentence or two."
> The developer's answer seeds the spec's Purpose section and the project README.
> After the answer, YOU derive the agent name from the description (lowercase,
> hyphens, npm name rules). Confirm it: "I'll call it `<derived-name>` — let me
> know if you want a different name." If the name was already set in Phase 0.5,
> still ask the purpose.

**Round 2: Domain + Deployment** (two questions in one AskUserQuestion call)
> Q1: "What domain is this agent working in?"
> Multiple choice + other: customer support, data pipeline, DevOps automation,
> content generation, health & wellness, research, monitoring/alerting,
> integrations/glue.
> This shapes the grilling questions and deployment assumptions.
>
> Q2: "Where will this run?"
> Multiple choice: local dev only, Docker (single container), cloud VM,
> Azure Functions.

**Round 3: I/O + Tools** (two questions in one AskUserQuestion call)
> Q1: "What goes in and what comes out?"
> Freeform. Define what triggers the agent (API call, schedule, user message)
> and what it produces (data, report, action, notification).
>
> Q2: "What external things does the agent need to interact with?"
> Multi-select + other: REST APIs, databases, file system, web scraping, CLI tools,
> Python scripts, other services.
> This determines which Python tools to generate.

**Round 4: Workflow + Members** (two questions in one AskUserQuestion call)
> Q1: "How does the agent's work flow?"
> Multiple choice: linear pipeline (A→B→C), loop-until-done (keep trying until
> success), fan-out-then-merge (parallel work then combine), human-in-the-loop
> (needs approval at a step), event-driven (reacts to triggers).
> Explain what each means for Kit newcomers.
>
> Q2: "How many Fleet members does this need and what do they do?"
> Multiple choice: single doer (one worker does everything), doer + reviewer
> (one builds, one checks), custom roles (describe your own).
> Explain: "A Fleet member is a Claude Code session running on a machine. Each
> member can run commands and answer prompts. Think of them as workers on a team."

### Stage B — Socratic Grilling

Switch to conversational mode. No more AskUserQuestion — ask naturally, one
question at a time, like the grill-me skill does.

Read the wizard answers and probe the areas that matter most for this agent type.

**Adapt questions based on wizard signals:**

| Wizard Signal | Ask About |
|---|---|
| Uses REST APIs (Q4) | Timeouts, retries, rate limits, auth token refresh, what if the API is down |
| Uses LLM / agent calls | Token budget, hallucination guardrails, what if the LLM gives wrong output |
| Multiple members (Q6) | What if member A finishes before B? Race conditions? Shared state? |
| Loop-until-done (Q5) | What stops the loop? Max iterations? Cost ceiling? Infinite loop risk? |
| Human-in-the-loop (Q5) | What if the human doesn't respond? Timeout? Default action? |
| File system access (Q4) | What files can it touch? Size limits? Permissions? What if disk is full? |
| Database access (Q4) | Connection pooling? Transactions? What if the DB is slow/down? |

**Always ask these three (any agent):**
1. "Why does this need an agent with LLM reasoning instead of a deterministic
   script? What's the judgment call it makes?"
2. "If this agent ran 1000 times, what would the most common failure be?"
3. "What's the one thing that, if it went wrong, would make you regret building
   this?"

**End the grilling when:**
- You've probed all high-signal areas for this agent type, OR
- The developer says "enough", "write the spec", "let's move on", or similar

---

## Phase 2: Spec Generation

Read the template at `references/agent-spec-template.md`.

Fill every section using the wizard answers and grilling insights:
- Replace `{{AGENT_NAME}}` with the agent name
- Replace `{{DATE}}` with today's date
- Fill all `{{placeholder}}` sections with concrete details from the interview
- For sections where the developer didn't provide enough detail, make a reasonable
  choice and note it (don't leave blanks or TODOs)

Write the completed spec to:
```
docs/specs/YYYY-MM-DD-<agent-name>-spec.md
```

### Self-review

After writing, scan the spec for:
1. **Placeholders**: Any remaining `{{...}}`, TBD, TODO? Fix them.
2. **Contradictions**: Do any sections conflict? Fix them.
3. **Vagueness**: Could any requirement be read two ways? Pick one and be explicit.
4. **Completeness**: Every spec section filled? Even if brief?

### User review gate

> "Spec written to `docs/specs/YYYY-MM-DD-<agent-name>-spec.md`. Please review
> and let me know if you want changes before I generate the implementation plan."

Wait for the user. If they request changes, make them and re-run the self-review.

---

## Phase 3: Implementation Plan

After the user approves the spec, invoke the `writing-plans` skill.

Pass it:
1. The approved spec file path
2. The instruction: "Output the plan to `docs/plans/YYYY-MM-DD-<agent-name>.md`.
   Use the Kit file conventions from `references/kit-file-conventions.md` to map
   spec sections to concrete files. Follow the build order: tools → workflows →
   registry → host config → system prompt → tests → deployment → integration test.

   **Critical — include these tasks that the build order requires:**
   - **Host Configuration** (`host.config.mjs`): configure `name`, `description`,
     `agentDescription` (a multi-line prompt that steers the LLM to use the
     agent's tools — not just a one-liner), and all required `modules`
     (`runLoop`, `dispatch`, `chat`, `router`, `budgets`, `guardrails`).
     Pick the right `runLoop.strategy` for the workflow shape (`plan-execute`
     for structured multi-step work, `open-ended` for conversational agents).
   - **System prompt tuning**: the `agentDescription` field in host.config.mjs
     IS the system prompt extension. It must tell the LLM what domain it's in,
     which tools to use and when, and any domain-specific rules. The default
     system prompt in `host/prompts/system.mjs` is generic — all agent-specific
     behavior comes from `agentDescription`.
   - **Agent README** (`README.md`): replace the starter README with
     documentation specific to this agent. The README must describe what the
     agent does, list every tool and workflow, document all env vars, and
     include a copy-pasteable Quick Start. Follow the Agent README template
     in `references/kit-file-conventions.md`. This task comes after deployment
     config and before integration testing.
   - **Stale session cleanup**: before the integration test task, include a step
     to clear any stale Fleet worker session logs so the agent starts fresh.
   - **API key propagation**: if the agent uses external APIs, the plan must
     show how API keys reach the Python tools. `executeCommand` does NOT
     inherit env vars from the parent shell. Pass keys via the command string
     (e.g. `SPOONACULAR_API_KEY=xxx python3 tool.py`) or as JSON args to the
     tool script."

The writing-plans skill handles the rest — task decomposition, code examples,
test-first approach, commit messages.

---

## Phase 4: Handoff

After the plan is written and the user has reviewed it, present execution options:

> "Your agent is fully specified and planned:
>
> - **Spec**: `docs/specs/YYYY-MM-DD-<agent-name>-spec.md`
> - **Plan**: `docs/plans/YYYY-MM-DD-<agent-name>.md`
>
> Your agent has N workflows, M tools, and K tasks in the plan.
>
> How would you like to build it?"

Use AskUserQuestion with three options:
1. **Execute with superpowers** — "Subagent-driven development in the current
   session. Each task gets a fresh subagent, with review between tasks."
2. **Launch a Fleet Sprint** — "Parallel agents via auto-sprint. Fastest for
   larger agents with independent tasks."
3. **Build it myself** — "Just the plan. I'll implement it on my own."

If option 1: invoke `superpowers:subagent-driven-development`.
If option 2: explain the auto-sprint args needed (issues, branch).
If option 3: the skill's job is done.

---

## What This Skill Does NOT Do

- **Does not implement code** — spec + plan only; execution is separate
- **Does not replace brainstorming** — this is Fleet-agent-specific brainstorming
- **Does not manage Fleet members at runtime** — members are runtime config
- **Does not publish or deploy** — deployment section is a blueprint, not automation
