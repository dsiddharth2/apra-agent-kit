# Agent Eval Research

> How the industry evaluates AI agents, and what it means for Fleet Agent Kit

**Sources:** Anthropic, OpenAI, Braintrust, LangSmith, Inspect AI (UK AISI)

---

## Why Evals Matter for Fleet

Every framework and vendor converges on the same point: **without evals, you cannot improve an agent**. When you change a prompt, swap a model, adjust a strategy, or add a tool, the only way to know whether the change helped is to measure before and after on the same test cases. Anthropic puts it bluntly: evals are "one of the most impactful things you can do" when building on foundation models.

For Fleet Agent Kit specifically, evals serve three purposes:

1. **Regression detection** — When you ship a new version of the kit (new strategy, new prompt builder, new guardrails rule), evals catch silent regressions before users do.
2. **Prompt and strategy tuning** — The run loop's prompt builders (system, act, plan, replan, reason, review) are the primary lever for agent quality. Evals give you a quantitative signal to iterate on them.
3. **User-facing quality assurance** — Users building agents with the kit need to evaluate their own agents. Shipping an eval harness means they can measure their agent's quality from day one.

---

## The Universal Eval Loop

Every framework — Braintrust, LangSmith, OpenAI, Inspect AI — implements the same core loop, just with different naming:

```
Dataset (input + expected)
    ↓
Run the agent (or model)
    ↓
Grade the output (scorer / grader / evaluator)
    ↓
Report (pass/fail, score, cost, time)
    ↓
Analyze failures → improve prompt/tools/strategy
    ↓
Re-run → compare against baseline
```

The terms vary but the anatomy is identical:

| Concept | Braintrust | LangSmith | Inspect AI | OpenAI |
|---|---|---|---|---|
| Test cases | Dataset | Dataset | Task samples | JSONL records |
| Run output | Experiment | Experiment | Eval log | Eval run |
| Grading fn | Scorer (0-1) | Evaluator | Scorer | Grader |
| LLM judge | LLM-as-judge | LLM-as-judge | model_graded_qa | Model-graded |
| Trajectory | Trace scorer | agentevals | Transcript | — |

---

## Three Tiers of Grading

Every framework organizes graders into the same three tiers, ordered by speed and cost:

### Tier 1 — Code-Based (Deterministic)

**Exact match, contains, pattern, schema validation**

Fast, free, and perfectly reproducible. Use for tasks with clear-cut correct answers: classification, structured output, status codes, tool selection.

- **Exact match** — `deepEqual(expected, actual)`
- **Contains** — output includes all expected substrings
- **Pattern** — regex match on output
- **Schema** — output parses as valid JSON / matches a Zod schema
- **F1 / precision / recall** — for extraction tasks

### Tier 2 — LLM-as-Judge

**A model grades another model's output**

Flexible enough for nuanced judgment (tone, helpfulness, factual accuracy). Costs one LLM call per case. Anthropic, Braintrust, and LangSmith all converge on the same best practices:

- Use a **stronger model** to grade a weaker one
- Give the judge a **detailed rubric**, not vague instructions
- Use **chain-of-thought**: reason first, then score
- Return **structured output** (yes/no, 1-5 scale, JSON)
- **Validate against human judgment** on a sample before scaling
- LLM judges have bias: they favor **longer, more confident-sounding** output

### Tier 3 — Human Grading

**Expert review with rubrics**

Highest quality, slowest, most expensive. Use to validate your LLM-as-judge before scaling, and for subjective quality (creativity, empathy, style). LangSmith provides annotation queues and pairwise comparison.

> **Anthropic's key insight:** "Prioritize volume over quality." More test cases with slightly noisier automated grading beats fewer perfectly hand-graded examples. Start with 10-20 cases, expand from real failures.

---

## Agent-Specific Eval Patterns

Agents differ from simple model calls because they run multi-step tool loops. The industry has developed specific patterns for evaluating them:

### 1. Outcome-Based (Did it get the right answer?)

The simplest and most important: run the agent on a task, check whether the final result is correct. This is what Inspect AI's submit-and-score loop does, and what our Phase 3 spec's `exact-match` and `contains` graders target. Every eval starts here.

### 2. Trajectory Evaluation (Did it take the right steps?)

LangChain's `agentevals` package is the most developed here. It evaluates the *sequence of tool calls* an agent made, not just the final answer:

- **Strict match** — same tools, same order
- **Unordered match** — same tools, any order
- **Subset match** — agent didn't call tools beyond the expected set
- **Superset match** — agent called at least the expected tools (extras are fine)
- **Tool args matching** — exact, ignore, subset, or custom comparator per tool

This matters for Fleet because a plan-execute agent might get the right answer but waste 10 steps doing it, or call irreversible tools unnecessarily.

### 3. Multi-Dimensional Scoring

Anthropic recommends evaluating agents across multiple dimensions simultaneously. A single pass/fail misses critical quality signals:

| Dimension | What it measures |
|---|---|
| **Task fidelity** | Did the agent complete the task correctly, including edge cases? |
| **Efficiency** | How many steps/tokens/dollars did it take? Budget tracking. |
| **Tool discipline** | Did it call the right tools? Avoid irreversible tools when unnecessary? |
| **Consistency** | Same input → similar output across multiple runs? |
| **Guardrail compliance** | Did it respect safety constraints, budget limits, approval flows? |
| **Latency** | Wall-clock time for real-time use cases. |

### 4. Sandboxed Execution

Inspect AI runs agent tool calls in Docker containers with network isolation. For Fleet, the existing mock/scripted fleet API serves a similar purpose — it isolates tests from real LLM calls. But for agents that write files or call external APIs, sandboxing matters.

### 5. The Closed Offline ↔ Online Loop

Braintrust's most powerful pattern: production failures feed back into the eval dataset. The loop is:

```
Deploy agent → Monitor production traces → Score live outputs
    ↓
Flag failures → Add failing cases to eval dataset
    ↓
Fix prompt/strategy → Re-run eval → Verify no regression
    ↓
Redeploy
```

This is why the Phase 3 spec's JSON report format matters — it enables this loop.

---

## Detailed Framework Findings

### Anthropic's Approach

Source: https://docs.anthropic.com/en/docs/build-with-claude/develop-tests

Anthropic structures eval development as a two-part process:

**Part 1 — Define success criteria.** Good criteria must be:
- **Specific** — clearly define what you want (e.g., "accurate sentiment classification," not "good performance")
- **Measurable** — quantitative metrics or well-defined qualitative scales
- **Achievable** — based on industry benchmarks, not unrealistic targets
- **Relevant** — aligned with the application's purpose

**Quantitative metrics they list:** Task-specific (F1, BLEU, perplexity), generic (accuracy, precision, recall), operational (response time, uptime).

**Part 2 — Build evaluations.** Three design principles:
1. Be task-specific — mirror real-world task distribution, include edge cases
2. Automate when possible — structure questions for automated grading
3. Prioritize volume over quality — more questions with slightly noisier automated grading beats fewer hand-graded ones

**Specific eval patterns Anthropic demonstrates with code:**

| Pattern | Technique | Use case |
|---|---|---|
| Task fidelity | Exact match | Sentiment classification (1000 tweets) |
| Consistency | Cosine similarity (SBERT) | FAQ bot (50 groups of paraphrased questions) |
| Relevance/coherence | ROUGE-L | Summarization (200 articles) |
| Factual accuracy | LLM-graded precision/recall/F1 | RAG systems |
| Tone and style | LLM-graded Likert scale (1-5) | Customer service |
| Privacy preservation | LLM-graded binary classification | Medical chatbot PHI detection |
| Context utilization | LLM-graded ordinal scale (1-5) | Conversation coherence |

**LLM-as-judge best practices:**
1. Create detailed rubrics with exact criteria
2. Request structured outputs (yes/no, 1-5 scale), not open-ended judgments
3. Reason-then-judge pattern (chain-of-thought before scoring)
4. Use a separate grader model from the generator
5. Validate on a sample set before running full suite

**Test case design:** Include happy path cases, edge cases (multitopic content, implicit info, sarcasm, typos, overly long inputs), and at least 100 cases for reliable statistics.

### OpenAI's Approach

Source: https://cookbook.openai.com/examples/evaluation/getting_started_with_openai_evals

Two main evaluation types:

**A. Code-Based / Deterministic Grading:**
- String match for factual QA (e.g., "What year was Obama elected?" → check for "2008")
- Structural validation (e.g., attempt to parse as JSON)
- Built-in metrics: `match`, `includes`, `fuzzyMatch`

**B. Model-Graded Evaluation (two-stage):**
- Stage 1: Model answers the question
- Stage 2: A different model judges the answer
- Best practice: Use GPT-4 to grade GPT-3.5; give the grader chain-of-thought reasoning
- Model grading has an error rate — validate with human evaluation first

**Dataset format:** JSONL records with `input` (array of chat messages), `ideal` (expected answer).

**Key iteration tension:** When failures happen, decide whether to refine the prompt (push model toward more consistent output) or refine the eval criteria (recognize functional equivalency). For production use cases with variation, explore model-graded evaluations over strict string matching.

**CI/CD integration:** Make evals part of the pipeline to gate deployments on desired accuracy.

### Braintrust's Approach

Source: https://www.braintrust.dev/docs/guides/evals

**Five-stage evaluation lifecycle:**
1. **Iterate in playgrounds** — rapid prototyping of prompts and scorers
2. **Promote to experiment** — immutable snapshot for comparison
3. **Automate in CI/CD** — catch regressions on every PR
4. **Score in production** — monitor live traffic asynchronously
5. **Feed back** — pull production failures into the offline dataset

**Scorer types:**
- **Autoevals** (prebuilt): Factuality, semantic similarity, Levenshtein, JSON validation, SQL validation
- **LLM-as-judge**: Natural language criteria, flexible but biased toward longer/more confident output
- **Custom code**: Full programmatic control for business rules

**Scorer scopes:**
- **Span**: Individual LLM response or tool call
- **Trace**: One complete multi-step trace
- **Group**: Multiple related traces (e.g., multi-turn conversation by session_id)

**Dataset management:**
- Versioned collections with `input`, `expected`, `metadata`, `tags`
- Build from production logs, not just hand-crafted examples
- Performance tracking shows how each row performs across experiments

**Iterative improvement loop (6 steps):**
1. Identify failures — sort by score, look for patterns
2. Expand dataset — add failing cases (failures > successes for dataset building)
3. Establish baseline — run experiment before making changes
4. Make targeted change — one thing at a time
5. Verify without regression — compare against baseline, check for regressions
6. Repeat — merge new rows, update baseline

**Best practices:**
- Start with 5-10 representative examples, not a large easy dataset
- Validate scorers on obvious cases (correct should score ~1, wrong should score ~0)
- Account for nondeterminism with larger datasets or trial counts
- Segment results by metadata — aggregate scores hide problems
- Use multiple scorers per case
- Balance cost and quality: LLM-as-judge is flexible but expensive

### LangSmith/LangChain's Approach

Source: https://docs.smith.langchain.com/evaluation

**Framework architecture:**
- **Datasets**: Input + optional reference output pairs
- **Target functions**: The app or component under test
- **Evaluators**: Workspace-level resources attachable to multiple projects

**Evaluator types:**
- **Code evaluators** — deterministic, rule-based
- **LLM-as-judge** — reference-free (safety, coherence) or reference-based (factual accuracy)
- **Pairwise** — compare two app versions for relative quality
- **Composite** — weighted combination of multiple scores
- **Summary** — aggregate metrics across an entire experiment (precision, recall, F1)

**Agent trajectory evaluation (`agentevals` package):**

Trajectories are lists of OpenAI-format messages (user, assistant with tool_calls, tool responses).

Trajectory match modes:
- `strict` — same tool calls, same order
- `unordered` — same tool calls, any order
- `subset` — agent's trajectory is a subset of reference
- `superset` — agent's trajectory is a superset of reference

Tool args match modes:
- `exact` — arguments must be identical
- `ignore` — any two calls to the same tool are equivalent
- `subset`/`superset` — subset/superset of args
- Per-tool custom matchers (e.g., case-insensitive comparison)

**Trajectory LLM-as-Judge:** Uses prebuilt prompts:
- `TRAJECTORY_ACCURACY_PROMPT` — reference-free, evaluates if trajectory is logical and efficient
- `TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE` — reference-based, compares against a reference trajectory

**Prebuilt evaluator prompts (openevals package):**
- Quality: CONCISENESS, CORRECTNESS, HALLUCINATION, ANSWER_RELEVANCE, PLAN_ADHERENCE, CODE_CORRECTNESS, LAZINESS
- Safety: TOXICITY, FAIRNESS
- Security: PII_LEAKAGE, PROMPT_INJECTION, CODE_INJECTION
- RAG: Correctness, Helpfulness, Groundedness, Retrieval Relevance

**Multiturn simulation:** `run_multiturn_simulation()` orchestrates interactions between the app and simulated users for generating representative conversation trajectories.

### Inspect AI (UK AISI) Approach

Source: https://inspect.ai-safety-institute.org.uk/agents.html

**Core architecture — the Agent protocol:**
An agent is a function that takes and returns an `AgentState` with just two fields: `messages` (conversation history) and `output` (last model output). This minimal interface lets the same agent serve as:
1. A top-level solver for a task
2. A standalone runner via `run()`
3. A delegate in a multi-agent system via `handoff()`
4. A tool available to a model via `as_tool()`

**Built-in agent types:**

**ReAct Agent (`react()`):**
- Tool loop with explicit `submit()` tool
- Multiple attempts: invoke scorer after each submission, allow retries if incorrect
- Compaction: automatic context window management (edit, summary, trim, auto, native strategies)
- Refusal handling: retry when model hits content filters
- Alternate model support for the agent loop

**Deep Agent (`deepagent()`):**
- Subagent delegation with three built-in subagents:
  - `research()` — read-only information gathering
  - `plan()` — structured task decomposition
  - `general()` — full autonomous task completion
- Persistent memory tool (survives context compaction)
- Structured planning with `todo_write()` tool
- Background dispatch: subagents can run concurrently

**Scoring architecture:**

Scores have: `value` (string/int/float/bool), `answer` (extracted text), `explanation`, `reason`, `metadata`.

Built-in correctness constants: `CORRECT` (1.0), `INCORRECT` (0.0), `PARTIAL` (0.5), `NOANSWER` (0.0).

Standard scorers:
- Text matching: `includes()`, `match()`, `pattern()`, `answer()`, `exact()`, `f1()`
- Model graded: `model_graded_qa()`, `model_graded_fact()`
- Mathematical: `math()` (mathematical equivalence)
- Multiple choice: `choice()` (handles unshuffling)

**Agent-specific scoring patterns:**
1. Submit-and-score loop: agent submits answer → scorer grades → if incorrect, agent retries
2. Sandbox-aware scorers: inspect sandbox filesystem state
3. Transcripts for trajectory analysis: rich per-sample views of every step (model calls, tool calls, state changes as JSON patches)
4. Multiple scorers per task for different quality dimensions
5. Deferred scoring: score after the fact, edit scores

**Sandboxed execution:**
- Tool calls run in Docker containers with `network_mode: none`
- Each sample gets its own sandbox instance (never shared)
- Per-sample setup: custom Dockerfile, files copied in, setup bash scripts
- Resource limits: max sandboxes (2x CPU), max subprocesses (CPU count), container-level cpus/mem_limit
- 8 environment types: docker, local, k8s, daytona, modal, ec2, proxmox, vagrant

**Agent limits:** Token, message, time, and cost limits at sample, agent, or scoped levels. Behavior varies by context (as solver: terminates sample; via `run()`: returns error; as tool: returns message to model but continues).

---

## What Fleet's Phase 3 Spec Gets Right

- **Direct function call mode** — Calling `executeHostedTask()` directly (no HTTP) is exactly what Inspect AI and Braintrust recommend. Removes network latency and makes tests hermetic.
- **Pluggable graders with a factory** — The four-grader model (exact-match, contains, llm-judge, custom) maps cleanly to the industry's three-tier system.
- **Scripted fleet integration** — `createScriptedFleetApi()` gives deterministic, zero-cost test runs for CI/CD gating.
- **JSON reports for machine consumption** — Structured reports enable the offline→online feedback loop and comparison across runs.

---

## What to Add Beyond the Phase 3 Spec

Based on the research, these additions would bring Fleet's eval to industry standard:

### A. Trajectory Grading

The spec only grades the final result. Add graders that inspect the `history` array (tool calls, observations) returned by `executeHostedTask()`:

```js
// evals/graders/trajectory.mjs
export function trajectoryMatch(expected, actual, { mode = 'superset' } = {}) {
  const expectedTools = expected.trajectory.map(t => t.tool);
  const actualTools = actual.history
    .filter(h => h.type === 'action')
    .map(h => h.tool);

  switch (mode) {
    case 'strict':    // same tools, same order
    case 'unordered': // same tools, any order
    case 'subset':    // didn't call extra tools
    case 'superset':  // called at least these tools
  }
}
```

### B. Multi-Scorer Per Case

Instead of one grader per case, allow an array of scorers that each produce a named score:

```json
{
  "id": "inv-001",
  "task": { "goal": "Find mismatched invoices" },
  "scorers": [
    { "name": "correctness", "grader": "exact-match", "expected": { "count": 3 } },
    { "name": "efficiency",  "grader": "budget-check", "maxCost": 0.10 },
    { "name": "trajectory",  "grader": "trajectory-match",
      "expected": { "trajectory": [{ "tool": "query_ledger" }] },
      "mode": "superset" }
  ]
}
```

### C. Baseline Comparison

Braintrust's core loop: every eval run compares against a named baseline. Store baseline reports and diff them:

```
npm run eval -- --suite=demo                  # creates report
npm run eval -- --suite=demo --baseline=latest # compares against last run

# Output:
# inv-001  correctness  ✓→✓  efficiency  0.03→0.05 (regression)
```

### D. Budget and Efficiency Scorer

The run loop already returns `budget: { iterations, estimatedCost }`. A built-in scorer that grades on efficiency:

```js
// evals/graders/budget-check.mjs
export function budgetCheck(expected, actual) {
  const cost = actual.budget?.estimatedCost ?? 0;
  const maxCost = expected.maxCost;
  return {
    pass: cost <= maxCost,
    score: Math.max(0, 1 - cost / maxCost),
    reason: `$${cost.toFixed(3)} of $${maxCost} budget`
  };
}
```

### E. Consistency Scorer (Best-of-N)

Run the same case N times and check output similarity. Catches nondeterministic failures that single runs miss. Anthropic and Braintrust both recommend this. Add a `trials` field per case.

### F. Suite Metadata for Segmented Analysis

Braintrust's lesson: "An overall 0.85 can mask a 0.40 on a critical input type." Add tags and metadata to cases, then break down reports by tag:

```
fleet-agent-kit eval — 2026-09-25
  By tag:
    happy-path     10/10  100%   $0.30
    edge-case       5/8    62%   $0.25  ← needs work
    error-handling  7/7   100%   $0.12
```

---

## The Fleet Eval Grader Lineup

Combining the Phase 3 spec with the research, here's the full grader set:

| Grader | Tier | What it checks | Cost |
|---|---|---|---|
| `exact-match` | Code | deepEqual on result field | Free |
| `contains` | Code | Output includes expected substrings | Free |
| `pattern` | Code | Regex match on output | Free |
| `schema` | Code | Output validates against a Zod schema | Free |
| `trajectory-match` | Code | Tool call sequence (strict/unordered/sub/superset) | Free |
| `budget-check` | Code | Cost/iterations within limits | Free |
| `llm-judge` | LLM | Open-ended quality assessment with rubric | 1 LLM call |
| `custom` | Any | User-supplied function | Varies |

---

## Implementation Roadmap

Build order, from the research and codebase analysis:

### Phase 1: Grader factory

Pure functions, no dependencies on the host. `evals/graders/` with each grader as a module, an `index.mjs` factory, and full unit tests. Start here because everything depends on it and nothing depends on anything else.

### Phase 2: Runner core

`evals/runner.mjs` — loads suite JSON, wires up `executeHostedTask()` with a scripted fleet and mock dispatcher (patterns already exist in `tests/helpers/`), runs graders, outputs to stdout and JSON. No CLI parsing yet — just the programmatic API.

### Phase 3: Reporting and baselines

JSON report writer, baseline comparison (diff two report files), human-readable stdout with per-tag breakdown. The report format from Phase 3 spec is solid — extend it with multi-scorer support and baseline deltas.

### Phase 4: CLI and config

Add `evals` to `IMPLEMENTED_MODULES`, `"eval"` script in package.json, CLI argument parsing (`--suite`, `--tag`, `--parallel`, `--baseline`).

### Phase 5: Trajectory and efficiency graders

Build on the history array that `runTask()` returns. Trajectory-match, budget-check, and step-count graders. These are the agent-specific graders that differentiate Fleet's eval from generic LLM evals.

### Phase 6: Demo suites and documentation

Ship example suites that exercise the kit's own capabilities: a happy-path task, an error-handling case, a budget-exceeded case, a trajectory check. These also serve as the kit's own regression tests.

> **Key principle from Braintrust:** Start with 5-10 representative test cases, not a big dataset of easy cases. Expand guided by actual failures. Build datasets from failures, not successes — datasets of easy cases give a false sense of quality.

---

## How This Maps to Existing Code

| Existing code | Eval role |
|---|---|
| `executeHostedTask()` | The "task function" every framework evaluates |
| `createScriptedFleetApi()` | Deterministic mock (Inspect AI's sandbox equivalent) |
| `createMockFleetApi()` | Simple mock for unit-level grader tests |
| `runTask().history` | The trajectory for trajectory graders |
| `budgets.snapshot()` | Cost/efficiency data for budget-check grader |
| `createWorkerDispatcher()` | Needs a test double for eval isolation |
| `host.config.mjs` modules | Evals config block (suiteDir, reportDir, parallel) |

---

## Fleet-Specific Design Decisions

### Scripted vs Live Evals

Suites should declare their fleet mode. **Scripted** (using `createScriptedFleetApi`) for CI/CD — deterministic, zero cost, fast. **Live** for periodic quality checks — hits real Fleet members, measures real model behavior, costs money. Most evals should be scripted; live evals run on a schedule or before releases.

### Strategy-Aware Testing

A case can force a strategy (`"strategy": "plan-execute"`) or let the router decide. This tests both the strategies and the router's classification.

### Guardrails as a Scored Dimension

Run cases with guardrails enabled and check that irreversible tools were properly gated. This is unique to Fleet — no other framework has this built in.

### Memory Integration (When Phase 3 Memory Ships)

The spec's `preloadMemory` field is the right approach. Cases can pre-load facts and test whether the agent uses them correctly. This enables testing the "teaching" system.

---

## Hallucination and Quality Verification Patterns

From Anthropic's guidance on reducing hallucinations, applicable to Fleet's eval:

1. **Allow "I don't know"** — Explicitly permit uncertainty in agent prompts. Eval cases can test whether the agent admits uncertainty on impossible tasks rather than hallucinating.
2. **Quote-then-analyze** — For document-based tasks, have the agent extract quotes first, then reason. Eval can check for grounded responses.
3. **Self-verification loop** — Agent drafts, then reviews each claim against sources, retracting unsupported claims. Eval cases can test the retraction behavior.
4. **Best-of-N verification** — Run the same prompt multiple times and compare outputs. Inconsistencies indicate hallucination risk. This maps directly to the consistency scorer.
5. **External knowledge restriction** — Instruct the agent to use only provided documents. Eval cases can verify no external information leaks in.

---

## Summary

The industry has converged on a clear model for agent evals:

1. **Start with outcome-based grading** — does the agent get the right answer?
2. **Add trajectory grading** — does it take reasonable steps?
3. **Score multiple dimensions** — correctness, efficiency, safety, consistency
4. **Compare against baselines** — every change is measured against the last known-good
5. **Feed production failures back** — the eval dataset grows from real failures, not synthetic perfection
6. **Automate in CI/CD** — no merge without passing evals

Fleet Agent Kit has all the building blocks already (`executeHostedTask`, scripted fleet, budgets, history arrays, guardrails). The eval harness wires them together into a measurement loop.
