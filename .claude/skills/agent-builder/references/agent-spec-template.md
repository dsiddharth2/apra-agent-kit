# {{AGENT_NAME}} — Agent Specification

**Date**: {{DATE}}
**Status**: Draft

## Purpose

{{One paragraph: what this agent does, who it's for, why it exists.}}

## Workflows

{{For each workflow, fill one of these blocks:}}

### {{workflow-name}}

- **Description**: {{what it does}}
- **Trigger**: {{how it's invoked — MCP tool call, CLI, scheduled, etc.}}
- **Flow**:
  1. {{phase 1 — what happens}}
  2. {{phase 2 — what happens}}
  3. {{...}}
- **Inputs**: `{ {{arg}}: {{type}} }` — {{description}}
- **Outputs**: `{ {{field}}: {{type}} }` — {{description}}
- **Error handling**: {{what happens on failure — retry, fallback, abort}}

## Tools

{{For each Python tool:}}

### {{tool-name}}

- **Description**: {{what it does}}
- **Language**: Python (stdlib only, no pip dependencies)
- **Input**: `sys.argv[1]` = {{arg1}}, `sys.argv[2]` = {{arg2}}, ...
- **Output**: JSON to stdout: `{ "ok": true, {{fields}} }`
- **External dependencies**: {{APIs, services, or "none"}}

## Fleet Members

{{For each member role:}}

### {{role-name}} (used as `member_name: '{{role-name}}'`)

- **Purpose**: {{what this member does in the workflow}}
- **Runs**: {{which workflows/tools this member executes}}
- **Concurrency**: {{notes on busy-wait, sequential vs parallel}}

## MCP Registry

{{For each exposed tool:}}

### `{{tool-name}}`

- **Description**: {{for the model that decides which tool to call}}
- **Input schema** (zod):
  ```javascript
  z.object({
    {{field}}: z.{{type}}().describe('{{description}}'),
  })
  ```
- **Annotations**: `{ readOnlyHint: {{bool}}, idempotentHint: {{bool}} }`
- **reversible** (boolean): writes must set `reversible: false` (host default is reversible and skips approval)

## Host Configuration

### Strategy
- **Run-loop strategy**: {{plan-execute or open-ended — pick based on workflow shape}}
- **Router fallback**: {{matches strategy}}

### Agent Description (system prompt extension)
```
{{Multi-line agentDescription that tells the LLM what domain it's in, which tools
to use and when, and any domain-specific rules. Be directive — "ALWAYS use X"
not "you can use X". This is the most important configuration for agent behavior.}}
```

### Modules
- **runLoop**: {{enabled, strategy, max iterations}}
- **budgets**: {{enabled, maxCostUsd, maxTokens, timeoutMs}}
- **guardrails**: {{enabled, defaultPolicy}}
- **dispatch**: {{enabled, backend, concurrency}}
- **chat**: {{enabled, title}}
- **router**: {{enabled, fallbackStrategy}}
- **memory**: {{if applicable — conversationContext (mode, store), runState (enabled), longTerm (enabled, autoLearn, decay, dedup)}}

### API Keys & Environment
- {{ENV_VAR_NAME}}: {{what it's for, how it reaches the Python tools}}
- ...

## Memory Configuration

{{Fill based on interview memory question. Omit this entire section if "No memory".}}

{{If conversation context:}}
### Conversation Context
- **Mode**: {{store — server persists turns in SQLite/Cosmos, client sends sessionId; or passthrough — caller sends conversation[] with each request}}
- **Store**: {{sqlite or cosmos}}
- **Max recent turns**: {{number of verbatim turns kept in prompt, default 6}}
- **Max total turns**: {{cap per session before oldest are evicted, default 20}}
- **Compaction**: {{summarise — LLM summarises old turns; or sliding-window — just drop them}}
- **Answer truncation**: {{max chars for stored answers, default 500}}

{{If long-term memory:}}
### Long-Term Memory
- **Store**: {{sqlite or cosmos}}
- **Auto-learn**: {{true — learner extracts facts after each task; or false — only explicit remember tool calls}}
- **Decay**: {{auto with intervalMs — timer-based; or on-recall — decay runs when facts are queried}}
- **Dedup**: {{enabled — reject duplicate facts; or disabled}}
- **Max entries**: {{cap before oldest decayed entries are purged}}
- **Preload directory**: {{path to .json files with seed knowledge, or "none"}}
- **Memory tool coaching**: {{what the agentDescription should say about when to use remember/recall — e.g. "ALWAYS recall relevant knowledge before planning"}}

### Run State
- **Enabled**: {{true for crash recovery, false if not needed}}
- **Store**: {{sqlite — same adapter as long-term}}

## Scheduled Workflows

{{Fill if the agent needs recurring runs. Omit this entire section if no schedules.}}

| Schedule | Workflow | Args | Cron | Timezone | Overlap |
|----------|----------|------|------|----------|---------|
| {{name}} | {{workflow}} | {{args}} | {{cron expression}} | {{IANA tz}} | {{queue or skip}} |

- **Why scheduled**: {{why this workflow needs to run on a timer}}
- **Result delivery**: {{webhook URL, or "poll via jobs API", or "SSE"}}

## Error Handling & Edge Cases

{{Failure modes identified during grilling:}}

- **{{scenario}}**: {{what happens}} → {{mitigation}}
- ...

{{Cost/budget guardrails if applicable:}}

- {{guardrail description}}

## Testing Strategy

### Unit tests (offline, no Fleet required)
- {{test-name}}: {{what it verifies}}
- ...

### Integration tests (requires Fleet running)
- {{test-name}}: {{what it verifies}}
- ...

### Mock strategy
- `createMockFleetApi` from `tests/helpers/mock-fleet.mjs` — launcher-level tests; available in the Kit repo.
- `fakeContext` — for workflow-body tests; this is what scaffolded `npm create` projects currently ship (`template/tests/hello.test.mjs` after PR #29). Use it when `tests/helpers/mock-fleet.mjs` is not present.
- Mock `executeCommand` to return expected tool JSON
- Mock `executePrompt` to return expected agent text

## Deployment

- **Dockerfile**: {{changes — additional apt packages, pip packages, env vars}}
- **docker-compose.yml**: {{changes — new env vars, ports, volumes}}
- **Environment variables**: {{list of .env entries with descriptions}}
- **MCP server**: {{any configuration changes}}
- **Production notes**: {{scaling, monitoring, secrets management}}

## Acceptance Criteria

- [ ] {{concrete pass/fail condition}}
- [ ] {{concrete pass/fail condition}}
- [ ] ...
