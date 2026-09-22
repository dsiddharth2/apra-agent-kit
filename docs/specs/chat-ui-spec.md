# Fleet Agent Kit — Chat UI Spec

Status: proposed
Branch: `feature/sse-chat-demo-ui` (cut from `feature/fleet-agent-kit-phase4` at `5e9f0e8`)

## What exists today

The host already runs tasks asynchronously and streams progress:

- `POST /task` returns `202 { jobId, status, position, links: { self, events } }`
  when dispatch is enabled (`host/routes.mjs`).
- `GET /jobs/:id/events` is a Server-Sent Events stream (`host/notify/sse.mjs`).
  Each frame is `id: <seq>`, `event: <type>`, `data: <json>`. Types are
  `queued`, `started`, `progress`, `settled`. Heartbeats are `: ping` comments.
  Reconnects with `Last-Event-ID` replay from that sequence number.
- `progress` events carry the rich shape from `richEvent` in `host/tasks.mjs`:
  `{ iteration, kind, message, stepIndex?, step?, plan?, result?, error?,
  willRetry?, reviewType?, approved?, feedback? }` with
  `kind ∈ plan | replan | step_started | step_completed | step_failed | review`.
- `settled` carries `{ status, result, error }` where `status ∈ completed |
  failed | cancelled | budget_exceeded`, `result` is whatever the run loop
  produced (a string or an object), and `error` is `{ code, message } | null`.
- `DELETE /jobs/:id` cancels: `202 { ok, status: 'cancelling' }` while running,
  `200` if it was still queued, `409` if already terminal.
- The neutral comm contract (`comm/interface.mjs`) knows two response shapes:
  JSON `{ status, headers?, body? }` and streamed text
  `{ status, headers?, stream }`. There is no way to serve an HTML page.
- Authentication is a pass-through stub that returns `{ id: 'anonymous' }`.

Everything above is exercised from the backend with curl and the test suite.
There is no way for a person to sit in front of the agent and talk to it.

## What this ships

A built-in chat page, served by the host itself, switched on by config. A person
types a message, the page submits it as a task, subscribes to the job's SSE
stream, shows the plan as a live checklist, and renders the final result as the
reply. Every raw SSE event is also logged to the browser console so the same
page doubles as a backend debugging view.

It is a **single-agent** feature: when a deployment is just this one host and the
operator wants a chat front door on it, they flip `modules.chat.enabled`. Nothing
else changes. `/task`, `/jobs`, `/mcp`, and `/health` keep working exactly as
before for every other client.

### Milestone

With `chat.enabled: true`, `npm run host` and opening `http://127.0.0.1:3000/chat`
in a browser lets a person send "plan a 3 day trip to Lisbon", watch the plan
steps tick off as the fleet works, and read the answer, with no build step and no
other process running. Turning the flag off makes `/chat` a 404 and leaves every
existing test green.

### Does not ship

- Conversation memory. Every message is a fresh task with only that goal. This
  is Phase 3 scope and the UI is written so a session concept can be added
  without changing the transcript rendering.
- Login, tokens, or any auth UI. The page rides on whatever `authenticate` the
  host is given. Because `EventSource` cannot set headers, a future token scheme
  will need cookies or a query parameter; that is out of scope here.
- Multiple concurrent runs from one tab, job history after a page reload,
  editing or re-sending past messages.
- A frontend framework, a bundler, TypeScript, or any new `dependencies`.
- A separately deployable frontend. The page is served by the host or not at all.

## Architecture

```
browser                                host
──────────────────────────────         ─────────────────────────────────────────
GET /chat            ───────────────▶  chat.page     → { status, headers, text }
GET /chat/app.mjs    ───────────────▶  chat.script   → { status, headers, text }
POST /task {goal}    ───────────────▶  task          → 202 { jobId, links }
new EventSource(links.events) ─────▶  jobEvents     → SSE queued/started/progress/settled
DELETE /jobs/:id     ───────────────▶  jobCancel
```

Two additions to the host, one small change to the comm contract:

1. **`modules.chat`** in config, validated in `host/config.mjs`, exposed on the
   builder as `.chat(config)`.
2. **`host/chat/`**: the page, the client module, a pure transcript reducer, and
   a route builder. `buildRoutes` mounts the two chat routes when chat is on.
3. **Text responses** in the neutral comm contract, so any adapter can serve the
   page. Express and raw-http pick it up through the shared router. The
   azure-functions adapter (Phase 4b, not yet written) inherits the requirement
   through the comm contract test.

Nothing in the run loop, jobs backends, notifier, or MCP layer changes.

## Configuration

```js
// host.config.mjs
modules: {
  // ...runLoop, budgets, guardrails, dispatch, notify as today
  chat: {
    enabled: true,           // default false when the block is absent
    title: 'Travel agent',   // optional; defaults to config.name
  },
},
```

Environment overrides: `CHAT_ENABLED=true|false` wins over the file, matching
how `JOBS_*` and notify env overrides already work. No other env keys.

Builder:

```js
createHost().chat({ title: 'Travel agent' })   // sets enabled: true, like .dispatch()
```

### Validation rules (`host/config.mjs`)

- `chat` is added to `KNOWN_MODULES` and `IMPLEMENTED_MODULES`.
- `chat.enabled` with `dispatch` disabled → **throw**
  `chat enabled but dispatch disabled — the chat page streams job events; enable dispatch or disable chat`.
- `chat.enabled` with `notify.sse.enabled: false` → **throw**
  `chat enabled but notify.sse disabled — the chat page needs the SSE stream`.
- `chat.title` present but not a non-empty string → **throw**.
- The resolved config always carries `modules.chat = { enabled, title }` so
  downstream code never checks for absence.

The repo's own `host.config.mjs` (the demo travel agent) turns chat on. The
default when the block is missing stays off, so existing deployments and tests
are unaffected.

## Neutral comm contract: text responses

`comm/interface.mjs` gains a third response form:

```
response = { status, headers?, body? }                          // JSON
         | { status, headers?, stream: AsyncIterable<string> }  // chunked text (SSE)
         | { status, headers?, text: string }                   // plain text / HTML / JS
```

`writeNodeResponse` in `comm/router.mjs` writes `text` with the supplied
`content-type` (default `text/plain; charset=utf-8`) and a computed
`content-length`. The `body` branch stays exactly as it is. Express and raw-http
need no adapter-level change because both delegate to `writeNodeResponse`.

`tests/helpers/comm-contract.mjs` gets one more case: a route returning
`{ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<h1>hi</h1>' }`
is served verbatim with that content type. Every adapter runs this contract, so
the future azure-functions adapter must implement it to pass.

## Routes

`host/chat/routes.mjs`:

```js
export async function buildChatRoutes({ chatConfig, hostName })
  → { chatPage, chatScript } | { chatPage: null, chatScript: null }
```

| name | method | path | auth | response |
|---|---|---|---|---|
| `chatPage` | GET | `/chat` | no | `text/html; charset=utf-8`, `index.html` with `{{title}}` replaced by the HTML-escaped title |
| `chatScript` | GET | `/chat/app.mjs` | no | `text/javascript; charset=utf-8`, concatenation of `transcript.mjs` (with its `export` keywords stripped) and `app.mjs` |

Both files are read from disk once when the routes are built and held in
memory; there is no per-request file IO and no directory listing or path
parameter, so nothing outside the two known files can ever be served.

`auth: false` matches `/health`. The page itself is not secret; the calls it
makes (`/task`, `/jobs/:id`, `/jobs/:id/events`) are authenticated by the host
as today, so a real `authenticate` still protects the agent.

Serving the script as one file by concatenation keeps `transcript.mjs` importable
by `node:test` (it is a normal ES module on disk) while the browser gets a single
classic module with no relative import to resolve. `app.mjs` must not contain
an `import` statement; it references the reducer's exports by name.

`buildRoutes` in `host/routes.mjs` accepts an extra `chatRoutes` argument and
spreads it into the route table. When chat is off both entries are `null`, and
the adapters already skip null routes. Route names are `chatPage` and
`chatScript`; a path clash is impossible because `/chat` is not used anywhere
else.

Cache headers on both routes: `cache-control: no-cache`. The page is tiny and
this avoids stale scripts during development.

## The page

`host/chat/index.html` is a single file with inline CSS. No external fonts,
scripts, or images. Layout:

- Header: the configured title, and a small status pill (`idle`, `queued #n`,
  `running`, `cancelling`, `done`, `failed`).
- Transcript: a scrolling column of turns.
- Composer: a textarea, a **Send** button, and a **Stop** button that is only
  enabled while a job is live.

Each turn is a user bubble followed by one assistant card. The card has:

1. A status line built from the reducer's `status` and `position`.
2. A **plan checklist** once a `plan` event arrives. Each step shows an icon
   (`○` pending, `◔` running, `✓` completed, `✗` failed, `↻` retrying), the
   step's tool name or type, and its description. A step whose result has
   arrived is a `<details>` block; the summary is the icon and description, the
   body is the result text or the error.
3. A **replan** notice when `replan` arrives (`Plan revised (2)`), and the
   checklist is replaced by the new plan.
4. **Review badges**: one per `review` event, `plan review ✓` or
   `step review ✗` with the feedback in a `title` attribute.
5. The **answer** once `settled` arrives with `status: completed`. A string
   result is rendered as text with newlines preserved. An object result is
   rendered as pretty-printed JSON in a `<pre>`.
6. An **error card** instead of an answer when `settled` reports `failed`,
   `cancelled`, or `budget_exceeded`, showing the status and `error.message`.

All user-supplied and server-supplied text is inserted with `textContent` or
escaped before it enters `innerHTML`. Nothing from the stream is ever
interpreted as markup.

Strategy independence: the `open-ended` strategy emits no `plan` event and its
`step_started` / `step_completed` events may lack `stepIndex`. The checklist
then grows one row per `step_started` in arrival order, so the card still
shows what the agent is doing.

## Client behaviour (`host/chat/app.mjs`)

Send:

1. Trim the textarea. Empty → do nothing.
2. Append the user bubble and an assistant card in state `submitting`; disable
   the composer.
3. `POST /task` with `{ goal }` and `content-type: application/json`. Relative
   URL, same origin, so it works behind any host and port.
4. On `202`, store `jobId` and open `new EventSource(links.events)`.
5. On any other status, render an inline error in the card from the response
   body's `message` (or the HTTP status when there is none) and re-enable the
   composer. `429 queue_full` shows the `retry-after` seconds in the message.
6. On network failure, same as 5 with the fetch error message.

Stream: `EventSource` only fires `onmessage` for unnamed events, and the host
names every frame. The client registers `addEventListener` for `queued`,
`started`, `progress`, and `settled`. Each listener parses `data`, logs it, and
feeds it to the reducer. `onerror` is logged; `EventSource` reconnects on its own
and sends `Last-Event-ID`, which the SSE handler already honours. When
`settled` arrives the client closes the `EventSource` explicitly so the browser
does not reconnect to a finished job.

Console log: at the first event of a job the client opens
`console.group('job <id>')`, logs every raw event as
`console.log(event.type, event.kind ?? '', event)`, and closes the group on
`settled` or on Stop. Errors from `fetch` or `EventSource` go to
`console.error` inside the same group. This is the full event log; the
transcript stays readable.

Stop: `DELETE /jobs/<id>`. `202` or `200` moves the card to `cancelling`; the
`settled` event with `status: cancelled` finishes it. `409` means it already
settled and is ignored. Stop is disabled while `submitting` (no job id yet).

One run at a time: the composer is disabled from Send until `settled` or a
submit error. Enter sends, Shift+Enter inserts a newline. On `settled` the
textarea is cleared and focused.

## Transcript reducer (`host/chat/transcript.mjs`)

Pure functions, no DOM, no globals, importable by `node:test`:

```js
export const initialTurn = (goal) => ({
  goal, jobId: null, status: 'submitting', position: null, iteration: 0,
  plan: null,            // { steps: [{ index, type, tool?, description, status, result?, error? }] } | null
  replans: 0,
  reviews: [],           // [{ reviewType, approved, feedback }]
  answer: null,          // settled.result when status === 'completed'
  error: null,           // { code?, message } for submit errors and non-completed settles
});

export function accepted(turn, { jobId, position })            → turn   // 202 received
export function submitFailed(turn, { message })                → turn   // non-202 or network error
export function reduce(turn, event)                            → turn   // one SSE event
export function cancelling(turn)                               → turn   // DELETE accepted
export function isLive(turn)                                   → boolean
```

`reduce` handles, by `event.type` then `event.kind`:

| event | effect |
|---|---|
| `queued` | `status: 'queued'`, `position` |
| `started` | `status: 'running'` |
| `progress` / `plan` | `plan` from `event.plan.steps` (all `pending`), `status: 'running'` |
| `progress` / `replan` | `plan` replaced, `replans + 1` |
| `progress` / `step_started` | step at `stepIndex` → `running`; if `plan` is null or the index is out of range, append a synthesized step from `event.step` |
| `progress` / `step_completed` | step → `completed`, `result` from `event.result.result` |
| `progress` / `step_failed` | step → `willRetry ? 'retrying' : 'failed'`, `error` |
| `progress` / `review` | push `{ reviewType, approved, feedback }` |
| `progress` / anything else | `iteration` only |
| `settled` | `status` from event; `answer` when `completed`; `error` otherwise (`{ code, message }`, defaulting to `{ message: status }`) |

Every branch also copies `event.iteration` into `iteration` when present.
Events for a job that is already terminal are ignored, which makes replayed
frames after a reconnect harmless. The reducer never throws on a malformed
event; unknown shapes fall through to the "iteration only" branch.

## Error handling summary

| condition | user sees | console |
|---|---|---|
| `POST /task` 400 / 429 / 503 | inline error in the card with server message, composer re-enabled | `console.error` with the response body |
| network failure on submit | inline error with the fetch message | `console.error` |
| SSE drops mid-run | nothing changes; browser reconnects with `Last-Event-ID` and missed events replay | `onerror` logged |
| job fails / budget exceeded | error card with status and `error.message` | full `settled` payload |
| Stop pressed | status `cancelling`, then `cancelled` card | `DELETE` result logged |
| host restarted mid-run | in-process backend re-queues or fails the job on restart; the reconnecting stream reflects whichever happens | as above |

## Host integration

`startHost` in `host/index.mjs`:

```
… existing startup through notifier and jobs …
const chatRoutes = config.modules.chat.enabled
  ? await buildChatRoutes({ chatConfig: config.modules.chat, hostName: config.name })
  : { chatPage: null, chatScript: null };
const routes = buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb: null, runLoopEnabled, chatRoutes });
```

The startup log line gains `, chat at /chat` when enabled. `resolveModules`
accepts a `chat` override so the builder's `.chat()` flows the same way as
`.dispatch()` and `.notify()`. Shutdown is unchanged; the chat routes hold no
resources.

## File tree

```
comm/
  interface.mjs                 MOD  document the text response form
  router.mjs                    MOD  writeNodeResponse handles { text }
host/
  config.mjs                    MOD  chat module, validation, CHAT_ENABLED
  index.mjs                     MOD  build chat routes, builder .chat(), log line
  routes.mjs                    MOD  accept chatRoutes
  chat/
    index.html                  NEW  page markup and styles, {{title}} placeholder
    app.mjs                     NEW  DOM glue: submit, EventSource, console log, render
    transcript.mjs              NEW  pure reducer
    routes.mjs                  NEW  buildChatRoutes
host.config.mjs                 MOD  chat: { enabled: true }
tests/
  helpers/comm-contract.mjs     MOD  text response case
  host-config.test.mjs          MOD  chat validation cases
  host-routes.test.mjs          MOD  chat routes present only when provided
  host-chat-routes.test.mjs     NEW  page and script bodies, title escaping, headers
  host-chat-transcript.test.mjs NEW  reducer against richEvent shapes
  host-chat-e2e.test.mjs        NEW  mock fleet, chat on, page + task + SSE to settled, no LLM
docs/
  chat-ui.md                    NEW  how to enable, what the page shows, console log, limits
  architecture.md, README.md    MOD  one paragraph and a config line each
package.json                    MOD  test:chat script; test:host gains nothing new
```

## Testing strategy

Unit (no Fleet, no token, all under `node --test`):

- **Config**: chat absent → `{ enabled: false, title: <name> }`; enabled with
  dispatch off → throws; enabled with SSE off → throws; `CHAT_ENABLED=false`
  overrides a file `true`; bad `title` throws.
- **Router**: `writeNodeResponse` with `{ text }` sets content type,
  content length, and writes the body once; `{ body }` behaviour unchanged.
- **Comm contract**: the new text case runs against express and raw-http.
- **Chat routes**: `buildChatRoutes` returns both routes with the right paths,
  `auth: false`, and content types; `{{title}}` is replaced and HTML-escaped
  (`<b>x</b>` arrives as `&lt;b&gt;x&lt;/b&gt;`); the script body contains no
  `import` or `export` statement; chat off returns nulls; `buildRoutes` mounts
  them only when given.
- **Transcript reducer**: drive `reduce` with events produced by the real
  `richEvent` in `host/tasks.mjs` (plan, step lifecycle, failure with retry,
  replan, review, settled in each terminal status), plus open-ended events with
  no plan and no `stepIndex`, plus a replayed duplicate after settle. Assert
  the resulting turn shape exactly.

Offline end to end (`tests/host-chat-e2e.test.mjs`): the existing acceptance
suite under `tests/acceptance/` runs against the real Fleet and a real LLM, so
the chat flow gets its own offline test instead. It follows
`tests/host-index.test.mjs`: `createMockFleetApi` with scripted
`promptResponses` that produce a plan block and a done block, a real
`WorkerDispatcher`, `startHost({ fleetApi, dispatcher, port: 0, runLoop:
{ strategy: 'plan-execute' }, dispatch: { store: { kind: 'memory' } }, chat:
{ enabled: true } })`. It asserts: `GET /chat` is 200 HTML containing the
title, `GET /chat/app.mjs` is 200 JavaScript, `POST /task` then `readSse` on
the events link yields `queued`, `started`, at least one `progress` with
`kind: 'plan'`, and `settled`; and feeding those same frames through the
reducer ends in `status: 'completed'` with an answer. This proves the page's
contract end to end without a browser, a token, or network access.

No new live acceptance test. The manual check before merge is: `npm run host`,
open `/chat` in a browser, send one message, confirm the checklist ticks and
the console group shows every event.

### npm scripts

```
"test:chat": "node --test tests/host-chat-routes.test.mjs tests/host-chat-transcript.test.mjs tests/host-chat-e2e.test.mjs"
```

`test:host` picks up the modified config, routes, and comm tests it already
lists. `tests/package-scripts.test.mjs` requires that every referenced file
exists, so the script is added in the same task that creates the last of the
three files.

## Documentation deliverables

- `docs/chat-ui.md`: enabling the module, the two routes, what each part of the
  card means, the console log format, cancellation, reconnect behaviour, and the
  out-of-scope list above.
- `docs/architecture.md`: chat listed alongside the other modules with the
  text-response addition to the comm contract.
- `README.md`: one line in the config example and a sentence pointing at
  `/chat`.
- Prose never uses phase numbers, per the existing docs rule.
