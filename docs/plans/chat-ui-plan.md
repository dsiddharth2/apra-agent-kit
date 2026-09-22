# Fleet Agent Kit — Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person opens `/chat` on a running host, types a message, watches the plan tick off live over SSE, and reads the answer, with the feature switched on by one config flag and every raw event mirrored to the browser console.

**Architecture:** The neutral comm contract gains a `{ status, headers, text }` response so any adapter can serve HTML and JS. A new `modules.chat` config block gates two routes, `GET /chat` and `GET /chat/app.mjs`, built by `host/chat/routes.mjs` and mounted through the existing `buildRoutes`. All client rendering decisions live in a pure reducer, `host/chat/transcript.mjs`, which node tests drive with the real progress-event shapes; `app.mjs` is thin DOM glue around `fetch('/task')`, `EventSource`, and `DELETE /jobs/:id`.

**Tech Stack:** Node 22 (`node:test`, `node:fs/promises`), Express 5 and raw `node:http` adapters already in the repo, vanilla browser JS and CSS. No new dependencies, no bundler.

**Spec:** `docs/specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md`

## Global Constraints

- Node `>=22.16` (`package.json` engines). No new `dependencies` or `devDependencies`. No frontend framework, bundler, or TypeScript.
- Project name is `apra-agent-kit` everywhere. Never write `workflow-kit` in code or docs.
- Docs never use the words "Phase 1/2/3/4" in user-facing prose. Existing script names `test:phase2` / `test:phase4` stay.
- Commits: no AI attribution lines, ever. Every "Commit" step means: stage the listed files, show `git status`, and commit **only after the user approves**. Never push to `main`, `master`, or `development`; the working branch is `feature/sse-chat-demo-ui`.
- `tests/package-scripts.test.mjs` fails if any `test:*` script references a missing `tests/...` path. The `test:chat` script is added only in Task 5, after all three of its files exist.
- `host/chat/app.mjs` must contain no `import` or `export` statement; it is served concatenated after `transcript.mjs` with that file's `export` keywords stripped.
- All text from the user or the server reaches the DOM through `textContent`, never `innerHTML`.
- Default when `modules.chat` is absent: disabled. Existing tests must stay green with the flag off.

---

## What already exists (read before starting)

| Export | File | Signature / shape |
|---|---|---|
| `buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled })` | `host/routes.mjs` | returns `{ health, mcp, task, jobGet, jobCancel, jobEvents }`; null entries are not mounted |
| `writeNodeResponse(res, response)`, `runHandler`, `buildRequest`, `matchRoute`, `requestSignal` | `comm/router.mjs` | response forms today: `{ status, headers?, body? }` (JSON) and `{ status, headers?, stream }` (SSE) |
| `loadConfig(dir, env)` | `host/config.mjs` | validates `runLoop`, `budgets`, `guardrails`, `dispatch`, `notify`; returns frozen config with `modules.notify` always resolved and `modules.dispatch` resolved only when enabled |
| `startHost({ fleetApi, dispatcher, port, bindHost, adapter, createAdapter, env, registry, configDir, authenticate, runLoop, budgets, guardrails, dispatch, notify, durableClient })` | `host/index.mjs` | returns `{ host, jobs, notifier, callTool, close, stop, config, registry }`; `createHost()` builder has `.runLoop() .budget() .guardrails() .dispatch() .notify()` |
| `richEvent(event, { stepIndex })`, `describeEvent`, `executeHostedTask` | `host/tasks.mjs` | `richEvent` maps run-loop events to `{ kind, message, stepIndex?, step?, plan?, result?, error?, willRetry?, reviewType?, approved?, feedback? }` with `kind ∈ plan replan step_started step_completed step_failed review` |
| `progressEvent(jobId, iteration, detail, now)`, `queuedEvent`, `startedEvent`, `settledEvent(jobId, { status, result, error })`, `TERMINAL_STATUSES` | `host/jobs/record.mjs` | SSE `data` payloads are exactly these objects plus `seq` |
| `formatSse`, `createSseHandler` | `host/notify/sse.mjs` | frames: `id: <seq>\nevent: <type>\ndata: <json>\n\n`; `type ∈ queued started progress settled`; heartbeat `: ping` |
| `runCommContract(name, createAdapter)` | `tests/helpers/comm-contract.mjs` | run for `express` and `raw-http` by `tests/comm-contract.test.mjs` |
| `createMockFleetApi({ members, commandPayload, promptResponses })`, `rosterNames(n)` | `tests/helpers/mock-fleet.mjs` | `promptResponses` array is indexed by prompt call count, last entry repeats |
| `readSse(response)` | `tests/helpers/sse.mjs` | async iterator of `{ id, event, data }`, skips heartbeats |
| `WorkerDispatcher`, `WorkerPool.create({ config })` | `pool/worker-dispatcher.mjs`, `pool/worker-pool.mjs` | see `makeDispatcher()` in `tests/host-index.test.mjs:47` |

Baseline before Task 1: `npm run test:host && npm run test:phase4` both green on `feature/sse-chat-demo-ui`.

---

## File structure

```
comm/
  interface.mjs                 MOD  Task 1  document the text response form
  router.mjs                    MOD  Task 1  writeNodeResponse handles { text }
tests/helpers/comm-contract.mjs MOD  Task 1  text response case (runs on every adapter)
host/
  config.mjs                    MOD  Task 2  resolveChatConfig, chat validation, CHAT_ENABLED
  chat/
    transcript.mjs              NEW  Task 3  pure reducer for one chat turn
    routes.mjs                  NEW  Task 4  buildChatRoutes, escapeHtml, stripExports
    index.html                  NEW  Task 4  page markup + styles, {{title}} placeholder
    app.mjs                     NEW  Task 4  DOM glue: submit, EventSource, console log, render
  routes.mjs                    MOD  Task 4  accept chatRoutes
  index.mjs                     MOD  Task 5  resolve chat config, build chat routes, builder .chat(), log line
host.config.mjs                 MOD  Task 5  chat: { enabled: true }
tests/
  host-config.test.mjs          MOD  Task 2
  host-chat-transcript.test.mjs NEW  Task 3
  host-chat-routes.test.mjs     NEW  Task 4
  host-routes.test.mjs          MOD  Task 4
  host-chat-e2e.test.mjs        NEW  Task 5
package.json                    MOD  Task 5  test:chat script
docs/
  chat-ui.md                    NEW  Task 6
  architecture.md, README.md, docs/README.md   MOD  Task 6
```

---

### Task 1: Text responses in the neutral comm contract

**Files:**
- Modify: `comm/router.mjs:54-74` (`writeNodeResponse`)
- Modify: `comm/interface.mjs:20-21` (contract comment)
- Test: `tests/helpers/comm-contract.mjs` (new case; runs via `tests/comm-contract.test.mjs`)

**Interfaces:**
- Consumes: nothing new.
- Produces: a third response form `{ status, headers?, text: string }` that every adapter serves verbatim with the given `content-type` (default `text/plain; charset=utf-8`) and a correct `content-length`. Task 4 returns this form from the chat routes.

- [ ] **Step 1: Write the failing contract test**

Append this test inside `runCommContract` in `tests/helpers/comm-contract.mjs`, before the final `stop() closes the listener` test:

```js
  test(`${name}: text response is served verbatim with its content type`, async () => {
    await withAdapter({
      page: { method: 'GET', path: '/chat', auth: false, handler: async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<h1>hi</h1>' }) },
      plain: { method: 'GET', path: '/plain', auth: false, handler: async () => ({ status: 200, text: 'ok' }) },
    }, async (base) => {
      const page = await fetch(`${base}/chat`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(page.headers.get('content-length'), '11');
      assert.equal(await page.text(), '<h1>hi</h1>');
      const plain = await fetch(`${base}/plain`);
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(await plain.text(), 'ok');
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/comm-contract.test.mjs`
Expected: the two new tests (`express: text response …`, `raw-http: text response …`) FAIL. Today `writeNodeResponse` falls through to the JSON branch, so the body is `""` and the content type is `application/json`.

- [ ] **Step 3: Implement the text branch in the router**

In `comm/router.mjs`, replace `writeNodeResponse` with:

```js
export async function writeNodeResponse(res, response) {
  const headers = { ...(response.headers ?? {}) };
  if (response.stream) {
    if (!headers['content-type']) headers['content-type'] = 'text/event-stream';
    res.writeHead(response.status ?? 200, headers);
    res.flushHeaders?.();
    try {
      for await (const chunk of response.stream) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    } finally {
      res.end();
    }
    return;
  }
  if (typeof response.text === 'string') {
    const payload = Buffer.from(response.text, 'utf8');
    headers['content-type'] = headers['content-type'] ?? 'text/plain; charset=utf-8';
    headers['content-length'] = String(payload.byteLength);
    res.writeHead(response.status ?? 200, headers);
    res.end(payload);
    return;
  }
  const body = response.body === undefined ? '' : JSON.stringify(response.body);
  headers['content-type'] = headers['content-type'] ?? 'application/json';
  res.writeHead(response.status ?? 200, headers);
  res.end(body);
}
```

- [ ] **Step 4: Document the form in the contract comment**

In `comm/interface.mjs`, replace the two `response =` lines with:

```js
//   response = { status, headers?, body? }                          // JSON body
//            | { status, headers?, stream: AsyncIterable<string> }  // chunked text (SSE)
//            | { status, headers?, text: string }                   // plain text / HTML / JS, served verbatim
//              text defaults content-type to text/plain; charset=utf-8 and always sets content-length.
```

- [ ] **Step 5: Run the contract and host suites**

Run: `node --test tests/comm-contract.test.mjs && npm run test:host`
Expected: all PASS, including both new text cases.

- [ ] **Step 6: Commit (after user approval)**

```bash
git add comm/router.mjs comm/interface.mjs tests/helpers/comm-contract.mjs
git status
git commit -m "feat: text responses in the neutral comm contract"
```

---

### Task 2: `modules.chat` config and validation

**Files:**
- Modify: `host/config.mjs`
- Test: `tests/host-config.test.mjs` (append)

**Interfaces:**
- Consumes: `resolveNotifyConfigWithEnv` (already imported), `modules.dispatch` resolution (already present).
- Produces: `export function resolveChatConfig(raw, { env, name }) → { enabled: boolean, title: string }` and `config.modules.chat` always present on the frozen config. Task 5 calls `resolveChatConfig` for builder overrides. Error messages, exact text:
  - `chat enabled but dispatch disabled — the chat page streams job events; enable dispatch or disable chat`
  - `chat enabled but notify.sse disabled — the chat page needs the SSE stream`
  - `chat.title must be a non-empty string`

- [ ] **Step 1: Write the failing tests**

Append to `tests/host-config.test.mjs`:

```js
const chatBase = (chat, extra = '') => `export default {
  name: 'chat-host', fleet: {}, comm: { adapter: 'express' },
  modules: {
    runLoop: { enabled: true },
    dispatch: { enabled: true, store: { kind: 'memory' } },
    ${extra}
    chat: ${chat},
  } };`;
const testEnv = { NODE_ENV: 'test' };

test('chat absent resolves to disabled with title defaulting to name', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default { name: 'plain-host', fleet: {}, comm: { adapter: 'express' } };`);
  const config = await loadConfig(dir, testEnv);
  assert.deepEqual(config.modules.chat, { enabled: false, title: 'plain-host' });
});

test('chat enabled with dispatch and sse resolves; title falls back to name', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true }`));
  const config = await loadConfig(dir, testEnv);
  assert.deepEqual(config.modules.chat, { enabled: true, title: 'chat-host' });
});

test('chat.title is kept when given', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true, title: 'Travel agent' }`));
  const config = await loadConfig(dir, testEnv);
  assert.equal(config.modules.chat.title, 'Travel agent');
});

test('chat enabled without dispatch throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', `export default {
    name: 'x', fleet: {}, comm: { adapter: 'express' },
    modules: { runLoop: { enabled: true }, chat: { enabled: true } } };`);
  await assert.rejects(() => loadConfig(dir, testEnv), /chat enabled but dispatch disabled/);
});

test('chat enabled with notify.sse disabled throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true }`, `notify: { sse: { enabled: false } },`));
  await assert.rejects(() => loadConfig(dir, testEnv), /chat enabled but notify\.sse disabled/);
});

test('CHAT_ENABLED env overrides the file in both directions', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true }`));
  const off = await loadConfig(dir, { ...testEnv, CHAT_ENABLED: 'false' });
  assert.equal(off.modules.chat.enabled, false);
  const dir2 = await tmpDir();
  await writeConfig(dir2, 'host.config.mjs', chatBase(`{ enabled: false }`));
  const on = await loadConfig(dir2, { ...testEnv, CHAT_ENABLED: 'true' });
  assert.equal(on.modules.chat.enabled, true);
});

test('chat.title must be a non-empty string', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, 'host.config.mjs', chatBase(`{ enabled: true, title: '' }`));
  await assert.rejects(() => loadConfig(dir, testEnv), /chat\.title must be a non-empty string/);
  const dir2 = await tmpDir();
  await writeConfig(dir2, 'host.config.mjs', chatBase(`{ enabled: true, title: 42 }`));
  await assert.rejects(() => loadConfig(dir2, testEnv), /chat\.title must be a non-empty string/);
});

test('resolveChatConfig is exported for builder overrides', async () => {
  const { resolveChatConfig } = await import('../host/config.mjs');
  assert.deepEqual(resolveChatConfig({ enabled: true }, { env: {}, name: 'n' }), { enabled: true, title: 'n' });
  assert.deepEqual(resolveChatConfig(undefined, { env: {}, name: 'n' }), { enabled: false, title: 'n' });
  assert.deepEqual(resolveChatConfig({ enabled: true }, { env: { CHAT_ENABLED: '0' }, name: 'n' }), { enabled: false, title: 'n' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/host-config.test.mjs`
Expected: the eight new tests FAIL (`modules.chat` is `undefined` today, `resolveChatConfig` is not exported).

- [ ] **Step 3: Implement**

In `host/config.mjs`:

Change the two module sets:

```js
const KNOWN_MODULES = new Set(['runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch', 'notify', 'chat']);
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat']);
```

Add this exported function after `loadConfig`:

```js
// modules.chat → { enabled, title }. CHAT_ENABLED=true|false|1|0 wins over the file.
export function resolveChatConfig(raw = {}, { env = process.env, name = '' } = {}) {
  const chat = { enabled: !!raw?.enabled, title: raw?.title === undefined ? name : raw.title };
  const flag = String(env.CHAT_ENABLED ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') chat.enabled = true;
  else if (flag === '0' || flag === 'false') chat.enabled = false;
  if (typeof chat.title !== 'string' || !chat.title.trim()) {
    throw new Error('chat.title must be a non-empty string');
  }
  return chat;
}
```

In `validate`, after the line `modules.notify = notify;` and before `return Object.freeze({`, add:

```js
  const chat = resolveChatConfig(modules.chat, { env, name: raw.name });
  if (chat.enabled) {
    if (!modules.dispatch?.enabled) {
      throw new Error('chat enabled but dispatch disabled — the chat page streams job events; enable dispatch or disable chat');
    }
    if (!notify.sse.enabled) {
      throw new Error('chat enabled but notify.sse disabled — the chat page needs the SSE stream');
    }
  }
  modules.chat = chat;
```

Note `modules.dispatch` is the resolved dispatch object only when `dispatch.enabled` was true (the earlier `if (modules.dispatch?.enabled)` block assigns it); otherwise it is the raw block or `undefined`, and `?.enabled` is falsy either way.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/host-config.test.mjs`
Expected: all PASS, including the pre-existing tests (none of them set `chat`, so they get `{ enabled: false, title: <name> }`).

- [ ] **Step 5: Run the wider host suites**

Run: `npm run test:host && npm run test:phase4`
Expected: all PASS.

- [ ] **Step 6: Commit (after user approval)**

```bash
git add host/config.mjs tests/host-config.test.mjs
git status
git commit -m "feat: chat module config with dispatch and sse validation"
```

---

### Task 3: Transcript reducer

**Files:**
- Create: `host/chat/transcript.mjs`
- Test: `tests/host-chat-transcript.test.mjs`

**Interfaces:**
- Consumes: SSE event payloads as produced by `queuedEvent`, `startedEvent`, `progressEvent(jobId, iteration, richEvent(raw))`, `settledEvent` from `host/jobs/record.mjs` and `host/tasks.mjs`.
- Produces (all pure, no DOM, no imports; Task 4 serves this file to the browser with `export` stripped and Task 5's e2e test imports it directly):

```js
export function initialTurn(goal)                      // → Turn with status 'submitting'
export function accepted(turn, { jobId, position })    // → status 'queued'
export function submitFailed(turn, { message })        // → status 'error', error.message
export function cancelling(turn)                       // → status 'cancelling' if live, else unchanged
export function reduce(turn, event)                    // → Turn; ignores events once terminal
export function isLive(turn)                           // → true unless terminal or 'error'
// Turn = { goal, jobId, status, position, iteration, plan, replans, reviews, answer, error }
// status ∈ submitting queued running cancelling completed failed cancelled budget_exceeded error
// plan = null | { steps: [{ index, type, tool?, description, status, result?, error? }] }
// step.status ∈ pending running completed failed retrying
// reviews = [{ reviewType, approved, feedback }]
```

- [ ] **Step 1: Write the failing tests**

Create `tests/host-chat-transcript.test.mjs`:

```js
// tests/host-chat-transcript.test.mjs
// Drives the reducer with the exact payloads the SSE stream carries: record.mjs
// event builders wrapped around tasks.mjs richEvent output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richEvent } from '../host/tasks.mjs';
import { queuedEvent, startedEvent, progressEvent, settledEvent } from '../host/jobs/record.mjs';

const { initialTurn, accepted, submitFailed, cancelling, reduce, isLive } = await import('../host/chat/transcript.mjs');

const JOB = 'job-1';
const prog = (raw, iteration = 1) => progressEvent(JOB, iteration, richEvent(raw));
const play = (turn, events) => events.reduce(reduce, turn);
const started = () => play(accepted(initialTurn('weather?'), { jobId: JOB, position: 1 }), [queuedEvent(JOB, 1), startedEvent(JOB)]);

const PLAN = { type: 'plan', _replan: false, plan: { steps: [
  { type: 'tool', tool: 'weather', args: { city: 'London' } },
  { type: 'reason', prompt: 'Compose briefing' },
] } };

test('initialTurn, accepted, queued, started', () => {
  const t0 = initialTurn('weather?');
  assert.deepEqual(t0, { goal: 'weather?', jobId: null, status: 'submitting', position: null, iteration: 0, plan: null, replans: 0, reviews: [], answer: null, error: null });
  assert.equal(isLive(t0), true);
  const t1 = accepted(t0, { jobId: JOB, position: 2 });
  assert.equal(t1.status, 'queued'); assert.equal(t1.jobId, JOB); assert.equal(t1.position, 2);
  const t2 = reduce(t1, queuedEvent(JOB, 3));
  assert.equal(t2.position, 3);
  const t3 = reduce(t2, startedEvent(JOB));
  assert.equal(t3.status, 'running');
});

test('plan → steps tick → review → settled completed', () => {
  let t = reduce(started(), prog(PLAN, 1));
  assert.equal(t.iteration, 1);
  assert.deepEqual(t.plan.steps, [
    { index: 0, type: 'tool', tool: 'weather', description: 'weather', status: 'pending' },
    { index: 1, type: 'reason', description: 'Compose briefing', status: 'pending' },
  ]);
  t = reduce(t, prog({ type: 'review', approved: true, feedback: null }, 2));
  assert.deepEqual(t.reviews, [{ reviewType: 'plan', approved: true, feedback: null }]);
  t = reduce(t, prog({ type: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' }, args: { city: 'London' } }, 3));
  assert.equal(t.plan.steps[0].status, 'running');
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'weather', stepIndex: 0, ok: true, result: '15°C cloudy' }, 4));
  assert.equal(t.plan.steps[0].status, 'completed');
  assert.equal(t.plan.steps[0].result, '15°C cloudy');
  t = reduce(t, prog({ type: 'step_started', stepIndex: 1, step: { type: 'reason' } }, 5));
  t = reduce(t, prog({ type: 'observation', stepType: 'reason', stepIndex: 1, ok: true, text: 'briefing' }, 6));
  assert.equal(t.plan.steps[1].status, 'completed');
  assert.equal(t.plan.steps[1].result, 'briefing');
  t = reduce(t, settledEvent(JOB, { status: 'completed', result: 'London is 15°C' }));
  assert.equal(t.status, 'completed'); assert.equal(t.answer, 'London is 15°C'); assert.equal(t.error, null);
  assert.equal(isLive(t), false);
});

test('step failure with retry, then success', () => {
  let t = reduce(started(), prog(PLAN, 1));
  t = reduce(t, prog({ type: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' } }, 2));
  t = reduce(t, prog({ type: 'step_failed', stepIndex: 0, step: { type: 'tool', tool: 'weather' }, error: 'timeout', willRetry: true }, 3));
  assert.equal(t.plan.steps[0].status, 'retrying'); assert.equal(t.plan.steps[0].error, 'timeout');
  t = reduce(t, prog({ type: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' } }, 4));
  assert.equal(t.plan.steps[0].status, 'running');
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'weather', stepIndex: 0, ok: true, result: 'ok' }, 5));
  assert.equal(t.plan.steps[0].status, 'completed'); assert.equal(t.plan.steps[0].error, null);
  t = reduce(t, prog({ type: 'step_failed', stepIndex: 1, step: { type: 'reason' }, error: 'boom', willRetry: false }, 6));
  assert.equal(t.plan.steps[1].status, 'failed');
});

test('replan replaces the checklist and counts', () => {
  let t = reduce(started(), prog(PLAN, 1));
  t = reduce(t, prog({ type: 'review', approved: false, feedback: 'add timezone' }, 2));
  t = reduce(t, prog({ type: 'plan', _replan: true, plan: { steps: [{ type: 'tool', tool: 'timezone' }] } }, 3));
  assert.equal(t.replans, 1);
  assert.deepEqual(t.plan.steps.map(s => s.tool), ['timezone']);
  assert.deepEqual(t.reviews, [{ reviewType: 'plan', approved: false, feedback: 'add timezone' }]);
});

test('open-ended run with no plan and no stepIndex grows the checklist in order', () => {
  let t = started();
  t = reduce(t, prog({ type: 'action', tool: 'weather', args: {} }, 1));
  assert.deepEqual(t.plan.steps, [{ index: 0, type: 'tool', tool: 'weather', description: 'weather', status: 'running' }]);
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'weather', ok: true, result: 'sunny' }, 2));
  assert.equal(t.plan.steps.length, 1);
  assert.equal(t.plan.steps[0].status, 'completed'); assert.equal(t.plan.steps[0].result, 'sunny');
  t = reduce(t, prog({ type: 'action', tool: 'textstats', args: {} }, 3));
  assert.equal(t.plan.steps.length, 2);
  assert.equal(t.plan.steps[1].index, 1); assert.equal(t.plan.steps[1].status, 'running');
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'textstats', ok: false, error: 'bad input' }, 4));
  assert.equal(t.plan.steps[1].status, 'failed'); assert.equal(t.plan.steps[1].error, 'bad input');
});

test('non-completed settles carry an error; later events are ignored', () => {
  const base = started();
  const failed = reduce(base, settledEvent(JOB, { status: 'failed', error: { code: 'run_failed', message: 'unexpected: kaboom' } }));
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.error, { code: 'run_failed', message: 'unexpected: kaboom' }); assert.equal(failed.answer, null);
  const cancelled = reduce(base, settledEvent(JOB, { status: 'cancelled' }));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error.message, 'cancelled');
  const budget = reduce(base, settledEvent(JOB, { status: 'budget_exceeded', error: { code: 'budget_exceeded', message: 'maxIterations' } }));
  assert.equal(budget.status, 'budget_exceeded'); assert.equal(budget.error.message, 'maxIterations');
  const replayed = reduce(reduce(failed, startedEvent(JOB)), prog(PLAN, 9));
  assert.deepEqual(replayed, failed);
});

test('submitFailed, cancelling, and malformed events', () => {
  const t0 = initialTurn('x');
  const bad = submitFailed(t0, { message: 'queue_full (retry in 30s)' });
  assert.equal(bad.status, 'error'); assert.equal(bad.error.message, 'queue_full (retry in 30s)'); assert.equal(isLive(bad), false);
  const live = started();
  const c = cancelling(live);
  assert.equal(c.status, 'cancelling'); assert.equal(isLive(c), true);
  assert.equal(reduce(c, prog(PLAN, 1)).status, 'cancelling');          // progress does not un-cancel
  assert.equal(cancelling(bad), bad);                                   // no-op when not live
  assert.deepEqual(reduce(live, null), live);
  assert.deepEqual(reduce(live, { type: 'progress', kind: 'mystery', iteration: 7 }), { ...live, iteration: 7 });
  assert.deepEqual(reduce(live, { type: 'nonsense' }), live);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-chat-transcript.test.mjs`
Expected: FAIL at import, `Cannot find module '.../host/chat/transcript.mjs'`.

- [ ] **Step 3: Create the reducer**

Create `host/chat/transcript.mjs`:

```js
// host/chat/transcript.mjs
// Pure transcript state for one chat turn. No DOM, no globals, no imports.
// node:test imports this file as an ES module; the browser receives it inlined
// ahead of app.mjs with the `export` keywords stripped (see host/chat/routes.mjs),
// so every declaration here must be a top-level const/function.

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

export function initialTurn(goal) {
  return { goal, jobId: null, status: 'submitting', position: null, iteration: 0, plan: null, replans: 0, reviews: [], answer: null, error: null };
}

export function isLive(turn) {
  return !TERMINAL.has(turn.status) && turn.status !== 'error';
}

export function accepted(turn, { jobId, position = null }) {
  return { ...turn, jobId, status: 'queued', position };
}

export function submitFailed(turn, { message }) {
  return { ...turn, status: 'error', error: { message: String(message ?? 'submit failed') } };
}

export function cancelling(turn) {
  return isLive(turn) ? { ...turn, status: 'cancelling' } : turn;
}

// 'cancelling' is sticky until settled; everything else that is live becomes 'running'.
function liveStatus(turn) {
  return turn.status === 'cancelling' ? 'cancelling' : 'running';
}

function describeStep(step) {
  return step?.description ?? step?.tool ?? step?.type ?? 'step';
}

function planFromEvent(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return {
    steps: steps.map((s, i) => ({
      index: Number.isInteger(s.index) ? s.index : i,
      type: s.type ?? 'step',
      ...(s.tool ? { tool: s.tool } : {}),
      description: describeStep(s),
      status: 'pending',
    })),
  };
}

// Find the checklist row an event refers to. With a stepIndex, match by index and
// append if unknown. Without one (open-ended strategy): step_started appends, while
// completed/failed update the most recent running or retrying row.
function locateStep(steps, event, { create }) {
  const hasIndex = Number.isInteger(event.stepIndex);
  let i = hasIndex ? steps.findIndex(s => s.index === event.stepIndex) : -1;
  if (i < 0 && !hasIndex && !create) {
    for (let k = steps.length - 1; k >= 0; k--) {
      if (steps[k].status === 'running' || steps[k].status === 'retrying') { i = k; break; }
    }
  }
  if (i < 0) {
    steps.push({
      index: hasIndex ? event.stepIndex : steps.length,
      type: event.step?.type ?? 'step',
      ...(event.step?.tool ? { tool: event.step.tool } : {}),
      description: describeStep(event.step),
      status: 'pending',
    });
    i = steps.length - 1;
  }
  return i;
}

function updateStep(turn, event, patch, opts) {
  const steps = (turn.plan?.steps ?? []).map(s => ({ ...s }));
  const i = locateStep(steps, event, opts);
  steps[i] = { ...steps[i], ...patch };
  return { ...turn, plan: { steps } };
}

function reduceProgress(turn, event) {
  const next = { ...turn, status: liveStatus(turn) };
  switch (event.kind) {
    case 'plan':
      return { ...next, plan: planFromEvent(event.plan) };
    case 'replan':
      return { ...next, plan: planFromEvent(event.plan), replans: turn.replans + 1 };
    case 'step_started':
      return updateStep(next, event, { status: 'running' }, { create: true });
    case 'step_completed':
      return updateStep(next, event, { status: 'completed', result: event.result?.result ?? null, error: null }, { create: false });
    case 'step_failed':
      return updateStep(next, event, { status: event.willRetry ? 'retrying' : 'failed', error: event.error ?? 'unknown error' }, { create: false });
    case 'review':
      return { ...next, reviews: [...turn.reviews, { reviewType: event.reviewType ?? 'plan', approved: !!event.approved, feedback: event.feedback ?? null }] };
    default:
      return next;
  }
}

function settledError(event, status) {
  if (event.error && typeof event.error === 'object') {
    return { ...(event.error.code ? { code: event.error.code } : {}), message: event.error.message ?? status };
  }
  return { message: event.error ? String(event.error) : status };
}

export function reduce(turn, event) {
  if (!event || typeof event !== 'object') return turn;
  if (!isLive(turn)) return turn;
  const next = Number.isInteger(event.iteration) ? { ...turn, iteration: event.iteration } : turn;
  switch (event.type) {
    case 'queued':
      return { ...next, status: 'queued', position: event.position ?? null };
    case 'started':
      return { ...next, status: liveStatus(next) };
    case 'progress':
      return reduceProgress(next, event);
    case 'settled': {
      const status = TERMINAL.has(event.status) ? event.status : 'failed';
      if (status === 'completed') return { ...next, status, answer: event.result ?? null, error: null };
      return { ...next, status, answer: null, error: settledError(event, status) };
    }
    default:
      return next;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/host-chat-transcript.test.mjs`
Expected: 7 tests PASS. If `plan → steps tick` fails on the `description` of step 0, check `formatPlanSteps` in `host/tasks.mjs:24-33`: it sets `description: s.prompt ?? s.tool ?? s.type`, so a tool step's description equals its tool name and a reason step's description is its prompt. The reducer must copy `description` as-is.

- [ ] **Step 5: Commit (after user approval)**

```bash
git add host/chat/transcript.mjs tests/host-chat-transcript.test.mjs
git status
git commit -m "feat: pure transcript reducer for the chat page"
```

---

### Task 4: Chat routes, page, and client

**Files:**
- Create: `host/chat/routes.mjs`
- Create: `host/chat/index.html`
- Create: `host/chat/app.mjs`
- Modify: `host/routes.mjs:12-17`
- Test: `tests/host-chat-routes.test.mjs` (new), `tests/host-routes.test.mjs` (append)

**Interfaces:**
- Consumes: the `{ text }` response form (Task 1); `transcript.mjs` (Task 3) whose exported names `initialTurn accepted submitFailed cancelling reduce isLive` are used as globals by `app.mjs`.
- Produces:
  - `export async function buildChatRoutes({ chatConfig, hostName, dir }) → { chatPage, chatScript }` (both `null` when `chatConfig.enabled` is false). Task 5 calls it with `chatConfig = config.modules.chat`.
  - `export function escapeHtml(s)`, `export function stripExports(source)`.
  - `buildRoutes({ …, chatRoutes })` spreads `chatRoutes.chatPage` / `chatRoutes.chatScript` into the route table; both default to `null`.

- [ ] **Step 1: Write the failing route tests**

Create `tests/host-chat-routes.test.mjs`:

```js
// tests/host-chat-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildChatRoutes, escapeHtml, stripExports } = await import('../host/chat/routes.mjs');

test('escapeHtml escapes the five HTML metacharacters', () => {
  assert.equal(escapeHtml(`<b class="x">it's & done</b>`), '&lt;b class=&quot;x&quot;&gt;it&#39;s &amp; done&lt;/b&gt;');
});

test('stripExports removes export keywords only at declaration starts', () => {
  const src = 'export function a() {}\nexport const B = 1;\nconst txt = "export const";\n  export function inner() {}\n';
  assert.equal(stripExports(src), 'function a() {}\nconst B = 1;\nconst txt = "export const";\n  export function inner() {}\n');
});

test('chat disabled yields null routes', async () => {
  assert.deepEqual(await buildChatRoutes({ chatConfig: { enabled: false, title: 'x' }, hostName: 'h' }), { chatPage: null, chatScript: null });
  assert.deepEqual(await buildChatRoutes({}), { chatPage: null, chatScript: null });
});

test('chat page route serves HTML with the escaped title and the script tag', async () => {
  const { chatPage } = await buildChatRoutes({ chatConfig: { enabled: true, title: '<Travel> & "Co"' }, hostName: 'h' });
  assert.equal(chatPage.method, 'GET'); assert.equal(chatPage.path, '/chat'); assert.equal(chatPage.auth, false);
  const res = await chatPage.handler({ method: 'GET', path: '/chat', params: {}, query: {}, headers: {}, body: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.match(res.text, /<title>&lt;Travel&gt; &amp; &quot;Co&quot;<\/title>/);
  assert.doesNotMatch(res.text, /\{\{title\}\}/);
  assert.doesNotMatch(res.text, /<Travel>/);
  assert.match(res.text, /<script type="module" src="\/chat\/app\.mjs"><\/script>/);
  for (const id of ['status', 'transcript', 'composer', 'goal', 'send', 'stop']) assert.match(res.text, new RegExp(`id="${id}"`), `missing #${id}`);
});

test('chat script route serves reducer plus app as one import-free module', async () => {
  const { chatScript } = await buildChatRoutes({ chatConfig: { enabled: true, title: 't' }, hostName: 'h' });
  assert.equal(chatScript.method, 'GET'); assert.equal(chatScript.path, '/chat/app.mjs'); assert.equal(chatScript.auth, false);
  const res = await chatScript.handler({ method: 'GET', path: '/chat/app.mjs', params: {}, query: {}, headers: {}, body: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.doesNotMatch(res.text, /^\s*(import|export)\b/m);
  for (const fn of ['function initialTurn', 'function accepted', 'function submitFailed', 'function cancelling', 'function reduce', 'function isLive']) assert.ok(res.text.includes(fn), `missing ${fn}`);
  assert.ok(res.text.indexOf('function reduce') < res.text.indexOf('new EventSource'), 'reducer must precede app code');
  assert.ok(res.text.includes("fetch('/task'"));
  assert.ok(res.text.includes('console.group'));
  assert.doesNotMatch(res.text, /innerHTML/);
});

test('served script parses as JavaScript', async () => {
  const { chatScript } = await buildChatRoutes({ chatConfig: { enabled: true, title: 't' }, hostName: 'h' });
  const { text } = await chatScript.handler({ method: 'GET', path: '/chat/app.mjs', params: {}, query: {}, headers: {}, body: null });
  assert.doesNotThrow(() => new Function(text));   // syntax check only; never executed
});
```

Append to `tests/host-routes.test.mjs`:

```js
test('buildRoutes mounts chat routes only when given', async () => {
  const base = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal(base.chatPage, null); assert.equal(base.chatScript, null);
  const chatPage = { method: 'GET', path: '/chat', auth: false, handler: async () => ({ status: 200, text: 'x' }) };
  const chatScript = { method: 'GET', path: '/chat/app.mjs', auth: false, handler: async () => ({ status: 200, text: 'y' }) };
  const withChat = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true, chatRoutes: { chatPage, chatScript } });
  assert.equal(withChat.chatPage, chatPage); assert.equal(withChat.chatScript, chatScript);
  assert.deepEqual(Object.keys(withChat), ['health', 'mcp', 'task', 'jobGet', 'jobCancel', 'jobEvents', 'chatPage', 'chatScript']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-chat-routes.test.mjs tests/host-routes.test.mjs`
Expected: the chat-routes file FAILS at import (`Cannot find module '.../host/chat/routes.mjs'`); the new `host-routes` test FAILS because `chatPage` is `undefined`, not `null`.

- [ ] **Step 3: Wire `chatRoutes` into `buildRoutes`**

In `host/routes.mjs`, change the signature and the initial table:

```js
export function buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled, chatRoutes = null }) {
  const routes = {
    health: { method: 'GET', path: '/health', auth: false, handler: async () => json(200, { ok: true }) },
    mcp: { method: 'POST', path: '/mcp', raw: true, handler: mcpRaw, web: mcpWeb },
    task: null, jobGet: null, jobCancel: null, jobEvents: null,
    chatPage: chatRoutes?.chatPage ?? null, chatScript: chatRoutes?.chatScript ?? null,
  };
```

- [ ] **Step 4: Create `host/chat/routes.mjs`**

```js
// host/chat/routes.mjs
// Two unauthenticated GET routes: the chat page and its single client script.
// Both files are read once when the routes are built and held in memory. There
// is no path parameter and no directory walk, so nothing else can be served.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// transcript.mjs is a real ES module for node:test. The browser gets it inlined
// ahead of app.mjs as one script, so drop `export` from top-level declarations.
export function stripExports(source) {
  return source.replace(/^export (?=(?:async )?(?:function|const|let|class)\b)/gm, '');
}

export async function buildChatRoutes({ chatConfig, hostName, dir = HERE } = {}) {
  if (!chatConfig?.enabled) return { chatPage: null, chatScript: null };
  const title = escapeHtml(chatConfig.title ?? hostName ?? 'apra-agent-kit');
  const read = (name) => fs.readFile(path.join(dir, name), 'utf8');
  const [html, transcript, app] = await Promise.all([read('index.html'), read('transcript.mjs'), read('app.mjs')]);
  const page = html.replaceAll('{{title}}', title);
  const script = `${stripExports(transcript)}\n${app}`;
  const serve = (text, contentType) => async () => ({
    status: 200,
    headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
    text,
  });
  return {
    chatPage:   { method: 'GET', path: '/chat',         auth: false, handler: serve(page, 'text/html; charset=utf-8') },
    chatScript: { method: 'GET', path: '/chat/app.mjs', auth: false, handler: serve(script, 'text/javascript; charset=utf-8') },
  };
}
```

- [ ] **Step 5: Create `host/chat/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --ink: #1c1f24; --muted: #6b7280; --line: #e5e7eb; --ok: #15803d; --bad: #b91c1c; --run: #2563eb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--ink); background: var(--bg); display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--card); }
  header h1 { font-size: 16px; margin: 0; }
  .pill { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--line); color: var(--muted); }
  .pill.running, .pill.queued, .pill.submitting, .pill.cancelling { background: #dbeafe; color: var(--run); }
  .pill.completed { background: #dcfce7; color: var(--ok); }
  .pill.failed, .pill.cancelled, .pill.budget_exceeded, .pill.error { background: #fee2e2; color: var(--bad); }
  #transcript { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .user, .assistant { max-width: 760px; padding: 12px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
  .user { align-self: flex-end; background: #dbeafe; }
  .assistant { align-self: flex-start; background: var(--card); border: 1px solid var(--line); width: 100%; }
  .status { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .notice { font-size: 12px; color: var(--run); margin: 4px 0; }
  ol.plan { margin: 6px 0; padding-left: 0; list-style: none; }
  ol.plan li { padding: 3px 0; }
  li.running { color: var(--run); } li.completed { color: var(--ok); } li.failed { color: var(--bad); } li.retrying { color: #b45309; }
  details summary { cursor: pointer; }
  details pre { margin: 4px 0 0 18px; padding: 8px; background: var(--bg); border-radius: 6px; font-size: 12px; max-height: 240px; overflow: auto; white-space: pre-wrap; }
  pre.error { color: var(--bad); }
  .reviews { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .badge.ok { color: var(--ok); } .badge.no { color: var(--bad); }
  .answer { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  pre.answer { font-size: 12px; overflow: auto; }
  .error-card { margin-top: 8px; color: var(--bad); }
  form { display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--card); }
  textarea { flex: 1; resize: none; min-height: 44px; max-height: 160px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
  button { padding: 0 16px; border: 0; border-radius: 8px; font: inherit; cursor: pointer; background: var(--run); color: #fff; }
  button#stop { background: var(--bad); }
  button:disabled { opacity: .45; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>{{title}}</h1>
  <span id="status" class="pill idle">idle</span>
</header>
<main id="transcript" aria-live="polite"></main>
<form id="composer">
  <textarea id="goal" rows="2" placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)" autofocus></textarea>
  <button id="send" type="submit">Send</button>
  <button id="stop" type="button" disabled>Stop</button>
</form>
<script type="module" src="/chat/app.mjs"></script>
</body>
</html>
```

- [ ] **Step 6: Create `host/chat/app.mjs`**

```js
// host/chat/app.mjs
// DOM glue for the chat page. Served after transcript.mjs (exports stripped) as
// one module, so initialTurn / accepted / submitFailed / cancelling / reduce /
// isLive are already in scope. No import or export statements in this file.
/* global initialTurn, accepted, submitFailed, cancelling, reduce, isLive */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const transcriptEl = $('#transcript');
  const composerEl = $('#composer');
  const goalEl = $('#goal');
  const sendEl = $('#send');
  const stopEl = $('#stop');
  const pillEl = $('#status');

  const ICONS = { pending: '○', running: '◔', completed: '✓', failed: '✗', retrying: '↻' };
  let current = null;   // { turn, card, source, grouped }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statusText(turn) {
    switch (turn.status) {
      case 'submitting': return 'sending…';
      case 'queued': return turn.position ? `queued #${turn.position}` : 'queued';
      case 'running': return turn.iteration ? `running · iteration ${turn.iteration}` : 'running';
      case 'cancelling': return 'cancelling…';
      case 'completed': return 'done';
      case 'error': return 'error';
      default: return turn.status.replace('_', ' ');
    }
  }

  function stepLabel(step) {
    const name = step.tool ?? step.type;
    const extra = step.description && step.description !== name ? ` — ${step.description}` : '';
    return `${ICONS[step.status] ?? '○'} ${name}${extra}`;
  }

  function renderCard(card, turn) {
    card.replaceChildren();
    card.append(el('div', `status ${turn.status}`, statusText(turn)));
    if (turn.replans) card.append(el('div', 'notice', `Plan revised (${turn.replans})`));
    if (turn.plan) {
      const list = el('ol', 'plan');
      for (const step of turn.plan.steps) {
        const li = el('li', `step ${step.status}`);
        if (step.result != null || step.error) {
          const details = el('details');
          details.append(el('summary', null, stepLabel(step)));
          details.append(el('pre', step.error ? 'error' : null, step.error ?? step.result));
          li.append(details);
        } else {
          li.append(el('span', null, stepLabel(step)));
        }
        list.append(li);
      }
      card.append(list);
    }
    if (turn.reviews.length) {
      const row = el('div', 'reviews');
      for (const review of turn.reviews) {
        const badge = el('span', `badge ${review.approved ? 'ok' : 'no'}`, `${review.reviewType} review ${review.approved ? '✓' : '✗'}`);
        if (review.feedback) badge.title = review.feedback;
        row.append(badge);
      }
      card.append(row);
    }
    if (turn.status === 'completed') {
      card.append(typeof turn.answer === 'string'
        ? el('div', 'answer', turn.answer)
        : el('pre', 'answer', JSON.stringify(turn.answer, null, 2)));
    } else if (turn.error) {
      card.append(el('div', 'error-card', `${turn.status}: ${turn.error.message}`));
    }
    pillEl.textContent = statusText(turn);
    pillEl.className = `pill ${turn.status}`;
  }

  function setBusy(busy) {
    sendEl.disabled = busy;
    goalEl.disabled = busy;
    const canStop = busy && current?.turn.jobId && isLive(current.turn) && current.turn.status !== 'cancelling';
    stopEl.disabled = !canStop;
  }

  function finish() {
    if (current.source) { current.source.close(); current.source = null; }
    if (current.grouped) { console.groupEnd(); current.grouped = false; }
    setBusy(false);
    if (current.turn.status === 'completed') goalEl.value = '';
    goalEl.focus();
  }

  function apply(fn) {
    current.turn = fn(current.turn);
    renderCard(current.card, current.turn);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    if (isLive(current.turn)) setBusy(true); else finish();
  }

  function subscribe(url) {
    const source = new EventSource(url);
    current.source = source;
    for (const type of ['queued', 'started', 'progress', 'settled']) {
      source.addEventListener(type, (msg) => {
        let event;
        try { event = JSON.parse(msg.data); } catch (err) { console.error('unparseable event', msg.data, err); return; }
        console.log(event.type, event.kind ?? '', event);
        apply((turn) => reduce(turn, event));
      });
    }
    source.onerror = (err) => console.error('event stream error; the browser will reconnect with Last-Event-ID', err);
  }

  async function send(goal) {
    transcriptEl.append(el('div', 'user', goal));
    const card = el('div', 'assistant');
    transcriptEl.append(card);
    current = { turn: initialTurn(goal), card, source: null, grouped: false };
    renderCard(card, current.turn);
    setBusy(true);

    let res, body;
    try {
      res = await fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });
      body = await res.json().catch(() => null);
    } catch (err) {
      console.error('submit failed', err);
      apply((turn) => submitFailed(turn, { message: err.message }));
      return;
    }
    if (res.status !== 202) {
      const retry = res.headers.get('retry-after');
      const message = `${body?.message ?? body?.error ?? `HTTP ${res.status}`}${retry ? ` (retry in ${retry}s)` : ''}`;
      console.error('submit rejected', res.status, body);
      apply((turn) => submitFailed(turn, { message }));
      return;
    }
    console.group(`job ${body.jobId}`);
    current.grouped = true;
    console.log('accepted', body);
    apply((turn) => accepted(turn, { jobId: body.jobId, position: body.position }));
    subscribe(body.links?.events ?? `/jobs/${body.jobId}/events`);
  }

  async function stop() {
    if (!current?.turn.jobId || !isLive(current.turn)) return;
    stopEl.disabled = true;
    let res, body;
    try {
      res = await fetch(`/jobs/${current.turn.jobId}`, { method: 'DELETE' });
      body = await res.json().catch(() => null);
    } catch (err) {
      console.error('cancel failed', err);
      stopEl.disabled = false;
      return;
    }
    console.log('cancel', res.status, body);
    if (res.status === 200 || res.status === 202) apply((turn) => cancelling(turn));
    else stopEl.disabled = false;   // 409 already terminal: the settled event will land, or has
  }

  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const goal = goalEl.value.trim();
    if (goal && !sendEl.disabled) send(goal);
  });
  goalEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composerEl.requestSubmit(); }
  });
  stopEl.addEventListener('click', stop);
})();
```

- [ ] **Step 7: Run the route tests**

Run: `node --test tests/host-chat-routes.test.mjs tests/host-routes.test.mjs`
Expected: all PASS. If `served script parses as JavaScript` fails, the message names the syntax error; fix `app.mjs`, not the test. If `stripExports` leaves an `export` behind, the `import-free module` test names it.

- [ ] **Step 8: Run the host suite**

Run: `npm run test:host`
Expected: PASS (routes signature change is backward compatible).

- [ ] **Step 9: Commit (after user approval)**

```bash
git add host/chat/routes.mjs host/chat/index.html host/chat/app.mjs host/routes.mjs tests/host-chat-routes.test.mjs tests/host-routes.test.mjs
git status
git commit -m "feat: chat page and client served through the comm contract"
```

---

### Task 5: Host integration, builder, demo config, offline end-to-end test

**Files:**
- Modify: `host/index.mjs` (imports, `resolveModules`, `startHost` signature and body, log line, `createHost` builder)
- Modify: `host.config.mjs` (enable chat for the demo agent)
- Modify: `package.json` (`test:chat` script)
- Test: `tests/host-chat-e2e.test.mjs` (new)

**Interfaces:**
- Consumes: `resolveChatConfig` (Task 2), `buildChatRoutes` (Task 4), `buildRoutes({ …, chatRoutes })` (Task 4), `initialTurn accepted reduce` (Task 3).
- Produces: `startHost({ …, chat })` option and `createHost().chat(config)` builder method; when chat is on the startup log ends with `, chat at /chat`.

- [ ] **Step 1: Write the failing end-to-end test**

Create `tests/host-chat-e2e.test.mjs`:

```js
// tests/host-chat-e2e.test.mjs
// Offline proof of the chat page's contract: mock Fleet, scripted plan-execute
// run, real HTTP, real SSE, real reducer. No token, no network, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';
import { readSse } from './helpers/sse.mjs';

const { startHost, createHost } = await import('../host/index.mjs');
const { initialTurn, accepted, reduce } = await import('../host/chat/transcript.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-chat-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

const WEATHER = JSON.stringify({
  ok: true, location: 'London', temp_c: '15', temp_f: '59', feels_like_c: '14', humidity: '72',
  description: 'Cloudy', wind_speed_kmph: '11', wind_dir: 'WSW', visibility_km: '10', uv_index: '3',
});

// doer plans one weather step, reviewer approves, doer reports done. Same script
// as tests/host-strategy-plan-execute.test.mjs "simple plan".
const planFleet = () => createMockFleetApi({
  members: rosterNames(2),
  commandPayload: WEATHER,
  promptResponses: [
    '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}\n```',
    '```review\n{"approved": true}\n```',
    '```done\n{"result": "London is 15°C and cloudy", "summary": "Done"}\n```',
  ],
});

const chatHost = (extra = {}) => startHost({
  port: 0, env: { ...process.env, NODE_ENV: 'test' },
  runLoop: { enabled: true, strategy: 'plan-execute' },
  dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 2, concurrency: 1 },
  chat: { title: 'Chat e2e' },
  ...extra,
});

const url = (host, p) => `http://127.0.0.1:${host.port()}${p}`;

test('chat page, script, task, SSE, and reducer agree end to end', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { host, close, config } = await chatHost({ fleetApi: planFleet(), dispatcher });
  try {
    assert.deepEqual(config.modules.chat, { enabled: true, title: 'Chat e2e' });

    const page = await fetch(url(host, '/chat'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Chat e2e<\/title>/);

    const script = await fetch(url(host, '/chat/app.mjs'));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);
    assert.match(await script.text(), /new EventSource/);

    const res = await fetch(url(host, '/task'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'Weather in London' }) });
    assert.equal(res.status, 202);
    const body = await res.json();
    let turn = accepted(initialTurn('Weather in London'), { jobId: body.jobId, position: body.position });

    const kinds = [];
    for await (const frame of readSse(await fetch(url(host, body.links.events)))) {
      if (frame.event === 'progress') kinds.push(frame.data.kind);
      turn = reduce(turn, frame.data);
      if (frame.event === 'settled') break;
    }
    assert.ok(kinds.includes('plan'), `expected a plan event, got ${kinds.join(',')}`);
    assert.ok(kinds.includes('step_completed'), `expected step_completed, got ${kinds.join(',')}`);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.answer, 'London is 15°C and cloudy');
    assert.equal(turn.plan.steps[0].tool, 'weather');
    assert.equal(turn.plan.steps[0].status, 'completed');
    assert.ok(turn.reviews.some(r => r.approved));
  } finally { await close(); }
});

test('CHAT_ENABLED=false turns chat off even though the repo config enables it', async () => {
  // No `chat` override, so the flag comes from host.config.mjs (enabled after
  // Task 5 Step 4); the env override must win and leave every other route intact.
  const dispatcher = await makeDispatcher();
  const { host, close, config } = await chatHost({ fleetApi: planFleet(), dispatcher, chat: undefined, env: { ...process.env, NODE_ENV: 'test', CHAT_ENABLED: 'false' } });
  try {
    assert.equal(config.modules.chat.enabled, false);
    assert.equal((await fetch(url(host, '/chat'))).status, 404);
    assert.equal((await fetch(url(host, '/health'))).status, 200);
  } finally { await close(); }
});

test('chat override without dispatch fails fast and unwinds', async () => {
  const dispatcher = await makeDispatcher();
  await assert.rejects(
    () => startHost({ port: 0, env: { ...process.env, NODE_ENV: 'test' }, fleetApi: planFleet(), dispatcher, runLoop: { enabled: true, strategy: 'open-ended' }, dispatch: { enabled: false }, chat: { enabled: true } }),
    /chat enabled but dispatch disabled/,
  );
  await dispatcher.close();
});

test('createHost().chat() flows through the builder', async () => {
  const dispatcher = await makeDispatcher();
  const agent = createHost({ fleetApi: planFleet(), dispatcher, env: { ...process.env, NODE_ENV: 'test' } })
    .runLoop({ strategy: 'plan-execute' })
    .dispatch({ store: { kind: 'memory' } })
    .chat({ title: 'Builder chat' })
    .build();
  const { host, close, config } = await agent.start({ port: 0 });
  try {
    assert.deepEqual(config.modules.chat, { enabled: true, title: 'Builder chat' });
    assert.equal((await fetch(url(host, '/chat'))).status, 200);
  } finally { await close(); }
});
```

Note on the third test: `startHost` with `dispatch: { enabled: false }` and the repo's `host.config.mjs` (which enables dispatch) still ends up with dispatch disabled because builder overrides win in `resolveModules`; the chat check must therefore run on the *resolved* `dispatchEnabled`, not on the file.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/host-chat-e2e.test.mjs`
Expected: FAIL. `startHost` ignores `chat`, `config.modules.chat` on the file-loaded config comes back `{ enabled: false, … }` from Task 2, and `/chat` is 404 in the first test; the builder test fails with `.chat is not a function`.

- [ ] **Step 3: Integrate in `host/index.mjs`**

Add imports next to the existing ones:

```js
import { loadConfig, resolveChatConfig } from './config.mjs';
import { buildChatRoutes } from './chat/routes.mjs';
```

(Replace the existing `import { loadConfig } from './config.mjs';` line.)

Extend `resolveModules`:

```js
function resolveModules(config, { runLoop, budgets, guardrails, dispatch, notify, chat } = {}) {
  return {
    runLoopConfig: runLoop ?? config.modules?.runLoop,
    budgetsConfig: budgets ?? config.modules?.budgets,
    guardrailsConfig: guardrails ?? config.modules?.guardrails,
    dispatchConfig: dispatch ?? config.modules?.dispatch,
    notifyConfig: notify ?? config.modules?.notify,
    chatOverride: chat ?? null,
  };
}
```

Add `chat: chatOption` to the `startHost` parameter list, after `notify: notifyOption`. Pass it into `resolveModules`:

```js
  const resolved = resolveModules(config, {
    runLoop: runLoopOption, budgets: budgetsOption, guardrails: guardrailsOption, dispatch: dispatchOption, notify: notifyOption, chat: chatOption,
  });
```

Directly after the line `const notifyConfig = resolveNotifyConfigWithEnv(resolved.notifyConfig ?? {}, env);` add:

```js
  // Chat rides on the async job routes and the SSE stream. When the flag comes
  // from the file, loadConfig already validated it against the file's dispatch
  // and notify blocks; builder overrides can change both, so check the resolved
  // values here and unwind exactly like a jobs-backend failure would.
  const chatConfig = resolved.chatOverride
    ? resolveChatConfig(resolved.chatOverride, { env, name: config.name })
    : config.modules.chat;
  const chatProblem = !chatConfig.enabled ? null
    : !dispatchEnabled ? 'chat enabled but dispatch disabled — the chat page streams job events; enable dispatch or disable chat'
    : !notifyConfig.sse.enabled ? 'chat enabled but notify.sse disabled — the chat page needs the SSE stream'
    : null;
  if (chatProblem) {
    try { await ownDispatcher?.close(); } catch { /* preserve original error */ }
    try { await stopFleet?.(); } catch { /* preserve original error */ }
    throw new Error(chatProblem);
  }
```

Replace the `buildRoutes` call:

```js
  const chatRoutes = await buildChatRoutes({ chatConfig, hostName: config.name });
  const routes = buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb: null, runLoopEnabled, chatRoutes });
```

Extend the startup log:

```js
  console.log(
    `host '${config.name}' listening on http://${bindHost}:${adapter.port() ?? '(platform)'} ` +
    `(worker capacity ${activeDispatcher.capacity}${jobs ? `, jobs backend ${dispatchConfig.backend}` : ''}` +
    `${chatConfig.enabled ? ', chat at /chat' : ''})`,
  );
```

Expose the resolved chat config on the returned `config` so tests and callers see the effective value. Change the `return` at the end of `startHost` to:

```js
  const effectiveConfig = Object.freeze({ ...config, modules: Object.freeze({ ...config.modules, chat: chatConfig }) });
  return { host: adapter, jobs, notifier, callTool, close, stop: close, config: effectiveConfig, registry: toolRegistry };
```

Add the builder method in `createHost`, after `notify(config)`:

```js
    chat(config)       { overrides.chat = { enabled: true, ...(config ?? {}) }; return builder; },
```

- [ ] **Step 4: Enable chat in the demo config**

In `host.config.mjs`, after the `notify` block inside `modules`, add:

```js
    chat: {
      enabled: true,
      title: 'Fleet Agent Kit — travel research agent',
    },
```

- [ ] **Step 5: Add the `test:chat` script**

In `package.json` `scripts`, after `"test:phase4"`, add:

```json
    "test:chat": "node --test tests/host-chat-routes.test.mjs tests/host-chat-transcript.test.mjs tests/host-chat-e2e.test.mjs",
```

- [ ] **Step 6: Run the new script and the full offline host suites**

Run: `npm run test:chat && npm run test:host && npm run test:phase4 && node --test tests/package-scripts.test.mjs`
Expected: all PASS. If the e2e `settled` never arrives within the timeout, check the mock `promptResponses` count against the strategy's prompt order (plan → review → done); an extra reviewer prompt means `minReviewPolicy` changed, and the test's plan step must keep `"review": false`.

- [ ] **Step 7: Manual browser check**

Run: `npm run host` (needs the Fleet token in the environment, as for any live run). Open `http://127.0.0.1:3000/chat`. Send one message such as `What is the weather in London right now?`. Confirm:
- the pill goes `sending… → queued → running → done`;
- a plan checklist appears and steps change from `○` to `◔` to `✓`;
- the answer renders under the checklist;
- the browser console shows a `job <id>` group containing `accepted`, `queued`, `started`, every `progress` with its `kind`, and `settled`;
- pressing Stop during a run shows `cancelling…` then a `cancelled` error card.
Stop the host with Ctrl+C. Record anything that did not match in the PR description; do not silently patch the tests to fit.

- [ ] **Step 8: Commit (after user approval)**

```bash
git add host/index.mjs host.config.mjs package.json tests/host-chat-e2e.test.mjs
git status
git commit -m "feat: wire the chat page into the host, builder, and demo config"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/chat-ui.md`
- Modify: `docs/architecture.md` (host file table at ~line 171 and host config example at ~line 369)
- Modify: `docs/README.md` (documents table and specs table)
- Modify: `README.md` (docs table at ~line 51)

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–5. Every route, flag, and message quoted below must match the code.
- Produces: user-facing docs. No phase numbers in prose.

- [ ] **Step 1: Write `docs/chat-ui.md`**

```markdown
# Chat UI

A built-in chat page served by the host. Turn it on when the deployment is a
single agent and you want a browser front door on it. Nothing else changes:
`/task`, `/jobs`, `/mcp`, and `/health` keep working for every other client.

## Enable it

```js
// host.config.mjs
modules: {
  runLoop:  { enabled: true, strategy: 'plan-execute' },
  dispatch: { enabled: true },                    // required: the page submits jobs
  notify:   { sse: { enabled: true } },           // required: the page streams events
  chat:     { enabled: true, title: 'Travel agent' },   // title defaults to config.name
}
```

Or from the builder: `createHost().dispatch({}).chat({ title: 'Travel agent' })`.

`CHAT_ENABLED=true|false` overrides the file. Startup fails with a clear message
if chat is on while dispatch or SSE is off.

Then `npm run host` and open `http://127.0.0.1:3000/chat`.

## Routes

| Method | Path | Auth | Serves |
|---|---|---|---|
| GET | `/chat` | no | the page, with the title injected |
| GET | `/chat/app.mjs` | no | the client script (reducer + DOM glue, one file) |

Both are read from `host/chat/` once at startup and served from memory with
`cache-control: no-cache`. The page itself is public, like `/health`; the calls
it makes (`POST /task`, `GET /jobs/:id/events`, `DELETE /jobs/:id`) go through
the host's `authenticate` like any other client.

## What a turn looks like

Each message is a fresh task with only that goal; there is no conversation
memory yet. The page:

1. `POST /task { goal }` → `202 { jobId, links.events }`.
2. Opens an `EventSource` on `links.events`.
3. Renders one assistant card per message:
   - a status line: `queued #n`, `running · iteration k`, `cancelling…`, `done`;
   - a plan checklist from the `plan` event: `○` pending, `◔` running,
     `✓` completed, `✗` failed, `↻` retrying; steps with output are expandable;
   - `Plan revised (n)` when a `replan` arrives, with the new checklist;
   - review badges, `plan review ✓` / `step review ✗`, feedback on hover;
   - the answer once `settled` reports `completed` (text, or pretty JSON for
     an object result), or an error card for `failed`, `cancelled`,
     `budget_exceeded`.

With the `open-ended` strategy there is no plan event; the checklist grows one
row per step as the agent acts.

One run at a time per tab: the composer is disabled until the job settles.
Enter sends, Shift+Enter inserts a newline. **Stop** sends `DELETE /jobs/:id`.

## Console log

Every raw event is mirrored to the browser console in a group named
`job <id>`: the `202` body as `accepted`, then each SSE frame as
`console.log(type, kind, payload)`, plus any submit or cancel errors. Open
DevTools to debug the backend from the same page.

## Reconnects and errors

- If the stream drops, the browser reconnects with `Last-Event-ID` and the host
  replays what was missed. The page closes the stream itself after `settled`.
- `429 queue_full`, `400`, `503 shutting_down`, and network failures show inline
  in the card with the server's message and, for 429, the `retry-after` seconds.
- A host restart mid-run is reported by the reconnecting stream exactly as the
  jobs backend reports it.

## Not included

Conversation memory, login or tokens, several concurrent runs per tab, history
after a reload, and any frontend framework or build step. Because
`EventSource` cannot set headers, a future token scheme needs cookies or a query
parameter.
```

- [ ] **Step 2: Update `docs/architecture.md`**

In the `host/` file table, after the `config.mjs` row, add:

```markdown
| `chat/routes.mjs` | `buildChatRoutes()` — serves `/chat` and `/chat/app.mjs` from memory when `modules.chat` is enabled. |
| `chat/transcript.mjs` | Pure reducer that turns job events into the chat card state; shared by the browser and the tests. |
| `chat/app.mjs`, `chat/index.html` | The chat page: submit a task, stream its events, render the plan checklist and answer. |
```

Change the `config.mjs` row text to end with `(`runLoop`, `budgets`, `guardrails`, `dispatch`, `notify`, `chat`).`.

In the host config example, after the `guardrails` block, add:

```js
    chat: {
      enabled: true,                 // serves /chat; needs dispatch + notify.sse
      title: 'Travel agent',         // defaults to name
    },
```

After the sentence `When `runLoop` is enabled, the host mounts `POST /task`. …`, add:

```markdown
When `chat` is enabled, the host also mounts `GET /chat` and `GET /chat/app.mjs`; see
[chat-ui.md](chat-ui.md). Comm adapters serve these through the contract's text response
form (`{ status, headers, text }`), alongside the JSON and stream forms.
```

- [ ] **Step 3: Update `docs/README.md` and `README.md`**

In `docs/README.md`, add a row to the documents table:

```markdown
| [chat-ui.md](chat-ui.md) | You want the built-in chat page: enabling it, what the card shows, the console event log, and its limits. |
```

and a row to the specs table:

```markdown
| [specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md](specs/2026-09-18-fleet-agent-kit-chat-ui-spec.md) | Implemented | Built-in chat page over the job SSE stream. |
```

In `README.md`, add a row to the docs table after the `run-loop.md` row:

```markdown
| [docs/chat-ui.md](docs/chat-ui.md) | Built-in chat page: turn on `modules.chat`, open `/chat` |
```

- [ ] **Step 4: Check the docs rule**

Run: `grep -n "Phase [0-9]" docs/chat-ui.md README.md docs/architecture.md docs/README.md`
Expected: no matches in text you added (pre-existing spec-table rows that name phases in their file names are fine).

- [ ] **Step 5: Commit (after user approval)**

```bash
git add docs/chat-ui.md docs/architecture.md docs/README.md README.md
git status
git commit -m "docs: chat page guide and architecture updates"
```

---

## Done when

- `npm run test:chat && npm run test:host && npm run test:phase4 && node --test tests/comm-contract.test.mjs tests/package-scripts.test.mjs` is green.
- `npm run host` with the repo config prints `… chat at /chat)` and the manual check in Task 5 Step 7 passes.
- With `CHAT_ENABLED=false npm run host`, `/chat` is 404 and `/health` is 200.
- The branch `feature/sse-chat-demo-ui` has one commit per task, no AI attribution, and a PR is opened against `feature/fleet-agent-kit-phase4` (not `main`).
