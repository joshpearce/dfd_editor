# MCP-driven diagram control — implementation plan

**Date:** 2026-04-22
**Scope:** Expose dfd_editor diagrams to an external AI agent via an HTTP MCP
server and let it drive the open browser session (render, update, swap
diagrams) in a read-only "remote-control" mode. Single-user, single-browser,
no auth — explicitly a v1 substrate for later multi-session work.

## Architecture at a glance

```
  agent (pydantic-ai client)
    │  streamable HTTP (MCP)
    ▼
  [mcp_server.py]  — FastMCP, port 5051, localhost only
    │  HTTP (REST + internal broadcast)
    ▼
  [Flask app.py]   — existing REST on 5050, + /ws (flask-sock) + /api/internal/broadcast
    │  WebSocket messages
    ▼
  [browser]        — DfdSocketClient.ts → dispatches to Application commands
```

Three processes: Vite (5173), Flask+WS (5050), MCP (5051). `npm run dev:all`
launches all three. Flask stays authoritative for `server/data/` I/O; MCP is
a thin adapter that translates tool calls to REST calls and lifecycle events
to broadcast messages.

## Data-model deltas

No changes to the minimal-format schema (`server/schema.py`) or the native
`dfd_v1` format — both already satisfy the contract. New wire shapes:

- **Broadcast envelope** (Flask→browser and MCP→Flask): `{ type: string,
  payload?: object }` where `type ∈ { "display", "diagram-updated",
  "diagram-deleted", "remote-control" }`.
- **Internal broadcast endpoint body** (localhost-only): same envelope.
- **MCP tool return shapes**: summaries (`list_diagrams`) or full minimal
  documents (`get_diagram`, echoed on `create/update`) — matches the ask that
  "agent always receives the full diagram data as the simple export format".

## Step 1 — Backend: fill CRUD gaps and add WebSocket infra

**What changes.** In `server/app.py`:

- `DELETE /api/diagrams/<id>` — unlink the file, 204 on success, 404 if
  missing.
- `PUT /api/diagrams/<id>/import` — accept minimal JSON, validate via
  `schema.Diagram`, run `to_native`, overwrite the existing file. 404 if the
  file does not exist (no upsert), 400 on validation error. **Drops any
  previously-stored `layout`** so the browser re-runs TALA on next open — the
  existing "no layout → auto-layout → PUT native back" flow handles this.
- `POST /api/internal/broadcast` — localhost-bound (reject non-127.0.0.1
  `request.remote_addr`); body is the envelope above; enqueues to all
  connected WS clients.
- `GET /ws` via `flask-sock`: each connection is added to a module-level
  thread-safe `set[Sock]`; handler loop waits on the socket and removes on
  disconnect. A small `broadcast(envelope)` helper iterates the set with a
  lock and drops dead sockets.
- `requirements.txt` gains `flask-sock>=0.7`.

**Tests.** Add `server/tests/test_crud_extras.py` covering DELETE (200, 404),
PUT-import (happy path, 404, schema-reject), broadcast endpoint
(127.0.0.1 accepted, non-loopback rejected). WS smoke test via
`simple-websocket`'s test client: connect, trigger broadcast via HTTP, assert
message received.

**Acceptance.** All new endpoints return the documented status codes. Hitting
`/api/internal/broadcast` from a non-loopback IP returns 403. Connected WS
client receives every broadcast envelope in order. Drift test
(`test_drift.py`) stays green.

## Step 2 — MCP server process

**What changes.** New file `server/mcp_server.py` using `FastMCP` from the
official `mcp` Python SDK with streamable HTTP transport bound to
`127.0.0.1:5051`. Exposes six tools, each of which calls Flask over localhost
via `httpx`:

```
list_diagrams()                     -> [{id, name, modified}]
get_diagram(id)                     -> MinimalDiagram        # GET /export
create_diagram(diagram)             -> {id, diagram}         # POST /import
update_diagram(id, diagram)         -> {id, diagram}         # PUT /<id>/import + broadcast diagram-updated
delete_diagram(id)                  -> {ok: true}            # DELETE + broadcast diagram-deleted
display_diagram(id)                 -> {ok: true}            # broadcast display
```

Pydantic models for the `diagram` parameter are imported directly from
`server/schema.py` so the MCP-surface and the Flask-surface stay drift-free.

**Remote-control lifecycle.** A module-level `_active_sessions: set[str]`
tracks live MCP sessions via FastMCP's session hooks (or, if hook surface is
awkward, a last-seen timer refreshed on every tool call with a 30s expiry
sweep). Transitions 0→1 and 1→0 POST
`{type:"remote-control", payload:{state:"on"|"off"}}` to
`/api/internal/broadcast`. This is the *only* source of remote-control
toggles; the browser never decides on its own.

Python deps: add `mcp>=1.0` and `httpx>=0.27` to `server/requirements.txt`.
New npm scripts: `dev:mcp` (runs `server/.venv/bin/python -m server.mcp_server`)
and `dev:all` updated to fan out to three processes via `concurrently`.

**Tests.** `server/tests/test_mcp_tools.py` spins up the Flask app under
`pytest` and invokes each tool via FastMCP's in-process test harness;
asserts the REST side-effects and broadcast emissions. No real WS client
needed — assert on a broadcast-endpoint mock.

**Acceptance.** `curl`-ing the MCP server's `/mcp` endpoint with a
`tools/list` request enumerates all six tools. Calling `create_diagram` with
a valid minimal doc produces a file under `server/data/` and a
`diagram-updated` broadcast is **not** emitted (create is silent until
`display_diagram` is called — matches decision 3(a)). Opening + closing an
MCP session emits exactly one `remote-control:on` and one
`remote-control:off`.

## Step 3 — Browser: WebSocket client and message dispatch

**What changes.** New file `src/assets/scripts/api/DfdSocketClient.ts` —
small class that opens `ws://localhost:5050/ws`, auto-reconnects with
exponential backoff capped at 5s, exposes a typed `on(type, handler)`
subscription surface. Imported once in `src/main.ts` (or an app-level
composable) and wired to dispatch:

- `display` → `await application.execute(prepareEditorFromServerFile(ctx, id))`
- `diagram-updated` → if `activeEditor.file.id === payload.id`, re-issue
  `prepareEditorFromServerFile` for that id (cheap: server-side file has
  already been overwritten).
- `diagram-deleted` → if it matches the active editor, dispatch the existing
  "return to splash" command (same code path `SplashMenu.vue` uses on app
  start with no active editor).
- `remote-control` → `application.execute(SetReadonlyMode(payload.state === "on"))`.

**Tests.** `DfdSocketClient.spec.ts` (Vitest + mock WebSocket) — reconnect
behavior, ordered delivery, handler fan-out. Dispatcher smoke test covering
each envelope type against a stub `Application`.

**Acceptance.** Manually: `npm run dev:all`, open the browser, hit the MCP
server with a curl-driven `display_diagram` against a seeded id — the
browser swaps to that diagram without user interaction. Killing the Flask
process and restarting it causes the browser to reconnect within 5s.

## Step 4 — Remote-control affects a loaded editor; docs

**What changes.** Extend
`src/assets/scripts/Application/Commands/ViewManagement/SetReadonlyMode.ts`
so that toggling the flag on a session with an already-loaded editor does
more than change the store flag: it installs or uninstalls
`RectangleSelectPlugin` and `PowerEditPlugin` on the live editor — today the
comment on this command explicitly disclaims this, and `LoadFile.ts` only
branches on the flag at load-time. Without this, the existing editor remains
interactive after the agent attaches.

Docs: update `server/CLAUDE.md` with the three-process topology, the new
endpoints, the MCP tool contract, and the broadcast envelope. Short
addendum in root `CLAUDE.md` pointing at it. No new top-level doc.

**Tests.** Unit test on the command: with a mounted editor, flipping to
read-only removes the two plugins; flipping back re-adds them. Coupled
end-to-end manual check: attach MCP session while a diagram is open; user
loses the ability to drag nodes; detach; editing returns.

**Acceptance.** Attaching an MCP session to a browser already displaying a
user-edited diagram immediately disables drag/select/context-menu without a
reload. Detaching restores them. No visible flicker beyond the plugin
teardown.

## Definition of done (plan-wide)

- All four steps' acceptance criteria met.
- `npm run test:unit`, `npm run type-check`, `npm run lint`, and
  `server/tests/` all pass.
- `npm run dev:all` cleanly starts and stops all three processes.
- One documented manual scenario works end-to-end: start `dev:all`, run a
  pydantic-ai agent script that calls `create_diagram` → `display_diagram` →
  `update_diagram`, and confirm the browser renders, auto-lays-out, and
  re-renders under remote-control lock throughout.
- No regressions in existing diagram open/save flows when the MCP server is
  *not* running — the browser's WS reconnect loop is non-fatal.

## Out of scope (explicit non-goals)

- Multi-user or multi-browser sessions. The single active browser assumption
  is encoded; a second tab will receive the same broadcasts and fight.
- Authentication on either MCP or broadcast endpoints beyond loopback
  binding. Don't expose ports outside localhost.
- Agent-side infrastructure (choosing models, prompt design, tool schemas
  beyond what MCP enforces). The agent is external.
- Partial-update semantics. `update_diagram` replaces the whole document;
  layout is re-run.
