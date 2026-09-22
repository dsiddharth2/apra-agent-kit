# Agent Builder Skill — Guided Agent Creation for the Fleet Agent Kit

**Date**: 2026-09-22
**Status**: Proposed
**Scope**: New Claude skill shipping with the Kit — interview, spec generation, implementation plan handoff
**Issue**: [#53](https://github.com/dsiddharth2/apra-agent-kit/issues/53)
**Depends on**: [#29](https://github.com/dsiddharth2/apra-agent-kit/pull/29) (`npm create @dsiddharth2/fleet-agent`)

## Problem

Building a Fleet agent today requires knowing the Kit's file conventions (workflow body + launcher + registry entry + tools + tests + deployment config), understanding Fleet member semantics, and manually writing a spec and plan before touching code. A developer new to the Kit faces a steep ramp-up even with the hello-workflow starter from `npm create`.

There is no guided path from "I have an idea for an agent" to "here's a complete spec and implementation plan I can execute."

## Vision

Write a spec, delegate to a sprint (Fleet Sprint or superpowers), get a complete working agent — not just config — in 1-2 days.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Target user | Any developer using the Kit | Onboarding-friendly, not power-user-only; explanations baked in |
| Interview style | Hybrid wizard + Socratic grilling | Wizard gets completeness; grilling gets depth on risky/interesting areas |
| Spec output | Markdown spec in `docs/specs/` | Matches existing Kit conventions; human-readable; version-controlled |
| Plan output | Markdown plan in `docs/plans/` | Matches existing Kit conventions; feeds into writing-plans skill |
| Implementation | Agnostic — superpowers or Fleet Sprint | Skill produces spec + plan; developer picks execution tool |
| Distribution | Ships with the Kit repo | Included in `npm create` scaffolded projects; zero extra setup |
| Skill dependencies | Reuses superpowers (brainstorming, writing-plans) | Delegates process to proven skills; installs them if missing |
| Scope of spec | Full stack (workflows, tools, tests, members, deployment) | "Not just config" — a complete blueprint from code to production |

---

## Architecture

### Skill File Structure

```
.claude/skills/agent-builder/
├── SKILL.md                              # Orchestrator — phases, triggers, checklist
├── references/
│   ├── agent-spec-template.md            # Blank spec template with all required sections
│   └── kit-file-conventions.md           # Maps spec sections → concrete Kit files
```

Ships in the Kit repo. When `npm create @dsiddharth2/fleet-agent` scaffolds a project, these files are included in the template so every new project gets the skill.

### Phase Flow

```
Developer invokes /agent-builder
        │
        ▼
┌─ Phase 0: Prerequisites ─────────────────────┐
│  Is this a Kit project? If not → scaffold     │
│  Are superpowers installed? If not → install   │
│  Is Fleet running? If not → guide setup        │
└───────────────────┬───────────────────────────┘
                    ▼
┌─ Phase 0.5: Scaffold ────────────────────────┐
│  Ask agent name (first wizard question)       │
│  npm create @dsiddharth2/fleet-agent <name>   │
│  cd into new project folder                   │
│  Run doctor check                             │
│  (Skip if project folder already exists)      │
└───────────────────┬───────────────────────────┘
                    ▼
┌─ Phase 1: Interview ─────────────────────────┐
│  Stage A: Structured wizard (6-7 questions)    │
│  Stage B: Socratic grilling (5-10 questions)  │
└───────────────────┬───────────────────────────┘
                    ▼
┌─ Phase 2: Spec Generation ───────────────────┐
│  Fill agent-spec-template.md with answers     │
│  Write to docs/specs/<date>-<name>-spec.md    │
│  Self-review pass (TODOs, contradictions)     │
│  User reviews spec                            │
└───────────────────┬───────────────────────────┘
                    ▼
┌─ Phase 3: Implementation Plan ───────────────┐
│  Invoke writing-plans with spec + conventions │
│  Output to docs/plans/<date>-<name>.md        │
│  User reviews plan                            │
└───────────────────┬───────────────────────────┘
                    ▼
┌─ Phase 4: Handoff ───────────────────────────┐
│  Present execution options:                   │
│   1. Superpowers (subagent-driven)            │
│   2. Fleet Sprint (auto-sprint)               │
│   3. Manual (just the plan)                   │
│  Skill's job ends here                        │
└───────────────────────────────────────────────┘
```

---

## Phase 0: Prerequisites

Three checks, each with auto-fix:

1. **Kit project detection**: Look for `mcp/registry.mjs`, `host/`, `transport/`. If missing, this isn't a Kit project — offer to scaffold one (flows into Phase 0.5).

2. **Superpowers installation**: Check if `brainstorming` and `writing-plans` skills are available. Check if `brainstorming` and `writing-plans` appear in the available-skills listing. If missing, install via `npx @anthropic-ai/superpowers` (or the current install mechanism). Tell the user what's being installed and why: "These skills handle the brainstorming and planning process — the agent-builder orchestrates them for Fleet agents specifically."

3. **Fleet status**: Run `apra-fleet status`. If not running, guide through: `apra-fleet start`, then the Kit's doctor check for remaining gaps (node version, python3, @apralabs symlink, OAuth token).

The skill does not proceed past Phase 0 until all prerequisites pass. But it fixes things rather than just reporting errors.

---

## Phase 0.5: Scaffold

Triggered when no Kit project exists or the developer is starting fresh.

1. **Ask agent name** — first wizard question, pulled forward because the folder name depends on it. Validates using the same npm name rules as `create/substitute.mjs` (non-empty, max 214 chars, no leading `.` or `_`).

2. **Run scaffold** — `npm create @dsiddharth2/fleet-agent <agent-name>`. This creates `./<agent-name>/` with the full starter project (hello workflow, starter registry, Dockerfile, docker-compose, tests).

3. **Change working directory** — all subsequent work happens inside the scaffolded project.

4. **Run doctor** — `npm run doctor` to verify the environment. Report results but don't block on non-critical failures (missing Docker is fine for local dev).

If the current directory is already a Kit project (Phase 0 detected it), skip Phase 0.5 entirely.

---

## Phase 1: Interview

### Stage A — Structured Wizard

Up to seven questions via `AskUserQuestion`, each with a brief explanation of why it matters:

| # | Question | Format | Why it matters |
|---|----------|--------|----------------|
| 1 | Agent name & one-liner — "What does this agent do in one sentence?" | Freeform | Seeds the spec's Purpose section and README |
| 2 | Domain — "What domain is this agent working in?" | Multiple choice + other (customer support, data pipeline, DevOps automation, content generation, research, etc.) | Shapes grilling questions and deployment assumptions |
| 3 | Inputs & outputs — "What goes in and what comes out?" | Freeform | Defines workflow args and return shapes |
| 4 | Tools needed — "What external things does the agent need to interact with?" | Multi-select + other (REST APIs, databases, file system, web scraping, CLI tools, Python scripts) | Determines which tools to generate |
| 5 | Workflow shape — "How does the agent's work flow?" | Multiple choice (linear pipeline, loop-until-done, fan-out-then-merge, human-in-the-loop, event-driven) | Determines workflow structure and member count |
| 6 | Members & roles — "How many Fleet members and what do they do?" | Multiple choice (single doer, doer + reviewer, custom roles) with explanation of what members are | Shapes the Fleet member spec and concurrency model |
| 7 | Deployment target — "Where will this run?" | Multiple choice (local dev only, Docker, cloud VM, Azure Functions) | Shapes the Deployment section of the spec |

Question 1 (agent name) may already be answered from Phase 0.5 scaffolding. If so, skip it and use the existing name.

### Stage B — Socratic Grilling

Conversational, one question at a time (no `AskUserQuestion` — natural messages like `grill-me`). The skill reads the wizard answers and asks the hard questions the developer hasn't thought about.

**Question selection adapts to the wizard answers:**

| Wizard Signal | Grilling Focus |
|---------------|----------------|
| Uses REST APIs | Reliability: timeouts, retries, rate limits, auth token refresh |
| Uses LLM (agent calls) | Cost: token budget, hallucination guardrails, what if the LLM is wrong? |
| Multiple members | Coordination: what if member A finishes before member B? Race conditions? |
| Loop-until-done workflow | Termination: what stops the loop? Max iterations? Cost ceiling? |
| Human-in-the-loop | Latency: what if the human doesn't respond? Timeout? Default action? |
| File system access | Safety: what files can it touch? Size limits? What if disk is full? |
| Any agent | "Why an agent, not a script?" — forces the developer to articulate the judgment call |
| Any agent | "If this ran 1000 times, what's the most common failure?" |
| Any agent | "What's the one thing that, if it went wrong, would make you regret building this?" |

The grilling ends when:
- The skill has probed all high-signal areas for this agent type, OR
- The developer says "enough" / "write the spec" / signals readiness

---

## Phase 2: Spec Generation

### Spec Template

The skill carries `references/agent-spec-template.md` with these sections:

```markdown
# <Agent Name> — Agent Specification

**Date**: <generated>
**Status**: Draft
**Generated by**: agent-builder skill

## Purpose
One paragraph: what this agent does, who it's for, why it exists.

## Workflows
For each workflow:
- Name, description, trigger
- Step-by-step flow (what each phase does)
- Inputs (args schema) and outputs (return shape)
- Error handling / retry strategy

## Tools
For each tool:
- Name, description
- Language (Python by default)
- Input args (from sys.argv), output format (JSON to stdout)
- External dependencies (APIs, packages, CLIs)

## Fleet Members
For each member:
- Role name (used as member_name in workflow)
- Purpose — what this member does
- Which workflows/tools it runs
- Concurrency notes

## MCP Registry
- Which workflows and tools are exposed as MCP tools
- Input schemas (zod) and descriptions
- Annotations (readOnlyHint, destructiveHint, openWorldHint)

## Error Handling & Edge Cases
- Failure modes identified during grilling
- Retry policies, fallbacks, circuit breakers
- What happens when external dependencies are down
- Cost/budget guardrails (if applicable)

## Testing Strategy
- Unit tests per workflow (using fakeContext mock pattern)
- Unit tests per tool (input/output validation)
- Integration tests (which require Fleet running)
- Mock strategy for offline testing

## Deployment
- Dockerfile changes (additional dependencies, env vars)
- docker-compose.yml changes (new services, ports, volumes)
- Environment variables (.env entries)
- MCP server configuration
- Production considerations (scaling, monitoring, secrets)

## Acceptance Criteria
- Concrete pass/fail conditions
- "Done" means all of these pass
```

### Generation Process

1. Fill each template section with interview answers and grilling insights.
2. Write to `docs/specs/<date>-<agent-name>-spec.md` inside the project.
3. **Self-review pass**: Scan for TODOs, placeholders, contradictions, vague requirements. Fix inline.
4. **User review gate**: "Spec written to `docs/specs/...`. Please review and let me know if you want changes before we write the implementation plan."

---

## Phase 3: Implementation Plan

After the user approves the spec, the skill invokes `writing-plans` with two inputs:

1. **The spec** — the approved markdown spec from Phase 2
2. **Kit file conventions** — from `references/kit-file-conventions.md`:

| Spec Section | Files to Create/Modify |
|---|---|
| Each workflow | `workflows/<name>/workflow.json` (metadata), `workflows/<name>/<name>.js` (body: exports `meta` + `main`), `workflows/<name>/main.mjs` (launcher: `withStandaloneLease` + `ensureApralabs` boilerplate) |
| Each tool | `tools/<name>/<name>.py` (stdlib Python, reads `sys.argv`, prints JSON to stdout) |
| MCP Registry | Add import + entry to `mcp/registry.mjs` (name, description, inputSchema with zod, annotations, run function) |
| Unit tests | `tests/<name>.test.mjs` per workflow (fakeContext pattern) and per tool |
| Deployment | Update `Dockerfile` (new deps), `docker-compose.yml` (env vars, ports), `.env.example` |

### Build Order

The plan follows a dependency-respecting build order so the project stays runnable at every step:

1. **Tools** — no dependencies, pure Python scripts
2. **Workflows** — depend on tools, follow body + launcher pattern
3. **Registry** — imports workflows and tools, wires MCP interface
4. **Tests** — verify each piece with fakeContext mocks
5. **Deployment** — Docker, env vars, compose updates
6. **Integration test** — end-to-end run with Fleet (if available)

### Output

Plan written to `docs/plans/<date>-<agent-name>.md`.

---

## Phase 4: Handoff

The skill prints a summary and presents execution options:

```
✓ Spec:  docs/specs/2026-09-22-<name>-spec.md
✓ Plan:  docs/plans/2026-09-22-<name>.md

Your agent has N workflows, M tools, and K tasks in the plan.

How would you like to build it?
  1. Execute with superpowers (subagent-driven, current session)
  2. Launch a Fleet Sprint (auto-sprint, parallel agents)
  3. I'll build it myself (just give me the plan)
```

The skill's job ends here. It produced the spec and plan — implementation is a separate concern using whatever tool fits.

---

## What This Skill Does NOT Do

- **Does not implement code** — produces spec + plan, delegates execution
- **Does not replace brainstorming** — uses brainstorming patterns but is domain-specific to Fleet agents. General ideation still uses brainstorming directly.
- **Does not manage Fleet members at runtime** — members are runtime config, not code. The spec documents them; the developer registers them.
- **Does not publish or deploy** — deployment section in the spec is a blueprint, not automation
- **Does not own the implementation loop** — test-fix-iterate is the execution tool's responsibility (auto-sprint cycles, superpowers verification, etc.)

---

## Trigger Conditions

The skill triggers when:
- User invokes `/agent-builder`
- User says "build an agent", "new agent", "create an agent", "I want to build..."
- User says "add a workflow" (in a Kit project context)
- User asks to design a Fleet agent or write an agent spec

The skill does NOT trigger for:
- General brainstorming (use `brainstorming` directly)
- Existing workflow modifications (use `senior-engineer` or similar)
- Fleet infrastructure questions (use `fleet` skill)
- Multi-agent system design without Fleet (use `agent-designer`)
