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
