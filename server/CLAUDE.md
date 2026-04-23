# Flask Backend

Last verified: 2026-04-21

## Purpose
Hosts DFD diagram files for the browser editor: "API creates diagram,
user edits, user saves." Runs as a separate process from the Vite dev
server. (Note: an upstream `?src=<url>` query-param path is not wired up
in this fork — this server's HTTP endpoints are the working persistence
surface.)

## Contracts
- **Exposes** — HTTP endpoints defined in `app.py`:
  - `GET  /api/health` — `{"status": "ok"}`
  - `GET  /api/diagrams` — array of `{id, name, modified}` summaries
    (`id` = filename stem; `name` falls back to stem; `modified` = mtime)
  - `POST /api/diagrams` — creates a new `{"schema": "dfd_v1"}` scaffold,
    returns `{"id": "<uuid>"}` with HTTP 201
  - `GET  /api/diagrams/<id>` — raw JSON document; 404 if missing
  - `PUT  /api/diagrams/<id>` — overwrites from `request.get_json()`; returns
    204; 404 if missing
  - `POST /api/diagrams/import` — body is a minimal JSON document (validated
    by `schema.py` `Diagram`); calls `transform.to_native`, mints a UUID, writes
    `server/data/<id>.json`, returns `{"id": "<uuid>"}` with HTTP 201. Returns
    400 on pydantic `ValidationError` (with structured `details` list) or on
    `DuplicateParentError` (a GUID appears in two containers' `children`).
  - `GET /api/diagrams/<id>/export` — reads the stored native `dfd_v1` document
    and projects it to minimal form via `transform.to_minimal`; returns the
    minimal doc as JSON. 404 if missing; 500 if the stored file is not a valid
    `dfd_v1` document.
  - `POST /api/layout` — accepts `{"source": "<d2 text>"}`, shells
    `d2` via stdin, returns `{"svg": ...}` on 200 or `{"error": ...}` on 400
    (bad input) / 502 (d2 absent or non-zero exit). The engine is selected
    via the `$D2_LAYOUT` env var (D2's own convention); `npm run dev:flask`
    sets `D2_LAYOUT=tala`. Override from the shell
    (`D2_LAYOUT=dagre npm run dev:flask`) to sweep engines without editing
    code.
- **Port** — 5050 (set by `npm run dev:flask` in root `package.json`, NOT in
  `app.py`). Flask's own default of 5000 is not used here.
- **CORS** — locked to `http://localhost:5173` (the Vite dev server). The
  frontend normally reaches the backend via Vite's `/api` proxy
  (`vite.config.ts`), so CORS only matters for direct calls.
- **Guarantees** — each diagram persists as one JSON file under
  `server/data/<id>.json`. Writes are pretty-printed (indent=4). IDs are UUIDs
  minted server-side on POST. The `/api/layout` route requires `d2` (with the
  TALA plugin) on `PATH`; its absence returns 502, not a startup failure.
- **Schema contract** — the minimal import/export format is codified by pydantic
  v2 models in `schema.py`; enum parity with `DfdObjects.ts` is enforced by
  `tests/test_drift.py`. `schema.py` is the single source of truth for what a
  valid minimal doc looks like. As of the bidirectional-flow phase:
  - `DataFlow` now uses `node1: UUID` / `node2: UUID` (renamed from `source`/`target`), with a per-flow `model_validator(mode="after")` that rejects self-loops (`node1 == node2`) and silently swaps endpoints + ref arrays into canonical (`str(node1) < str(node2)`) order.
  - `DataFlowProps` carries `node1_src_data_item_refs: list[UUID]` and `node2_src_data_item_refs: list[UUID]` (both `Field(default_factory=list)`).
  - `Diagram` has a diagram-level `model_validator(mode="after")` that rejects (a) flow endpoints referring to a non-existent canvas object and (b) dangling refs in either direction, reporting which direction key carried the bad ref.
  - `DataItem` is a top-level pydantic model. Required: `guid`, `identifier`, `name`, `classification` (closed enum, default `"unclassified"`). Optional: `parent` (nullable — `None` means unowned) and `description`.
  - `Diagram` has `data_items: list[DataItem]` (default `[]`).
  - `to_native` wires both ref arrays as `ListProperty<StringProperty>` wire shapes under the new keys, emitted unconditionally even when empty so AC2.4 holds (empty-both-sides flows survive round-trip).
  - `to_minimal` reads both keys back and always emits them on `DataFlowProps` (default `[]`).
  - `data_items` on `Diagram` continues to be a top-level `ListProperty<DictionaryProperty>` in canvas properties — unchanged by the bidirectional rework.
  - Old-shape payloads (`source` / `target` / `data_item_refs` on a flow) are rejected with HTTP 400 because `_Base` uses `ConfigDict(extra="forbid")`.
- **Expects** — PUT bodies must be valid JSON. Payload schema is owned by the
  frontend (`DfdFilePreprocessor` and friends); this server does not validate
  or interpret diagram contents beyond reading an optional top-level `name`.

## Dependencies
- **Uses** — `flask>=3.0`, `flask-cors>=4.0`, `pydantic>=2.0`,
  `flask-sock>=0.7` (WS transport on `/ws`; see `requirements.txt`). Stdlib
  only otherwise (`json`, `uuid`, `pathlib`, `subprocess` for shelling `d2`).
- **Used by**
  - `src/assets/scripts/api/DfdApiClient.ts` — the HTTP client; calls
    `/api/diagrams` via relative URLs (Vite proxies to `127.0.0.1:5050`).
  - `src/assets/scripts/Application/Commands/FileManagement/SaveDiagramFileToServer.ts`
    and siblings `BindEditorToServer.ts`, `LoadFile.ts`,
    `PrepareEditorWithFile.ts` — the command-layer consumers.
- **Boundary** — this process must not import from or read the frontend
  source tree. It only knows JSON over HTTP.

## Key Decisions
- Flask + flat-file JSON storage chosen for simplicity over a real DB — this
  is a local-dev companion, not a product backend.
- CORS narrowly scoped to `:5173` so a misconfigured browser can't reach the
  API from arbitrary origins.
- Port 5050 lives in the npm script, not in code, so `flask run` without the
  wrapper would bind to the wrong port — always use `npm run dev:flask`.
- `dev:mcp` is invoked as `cd server && .venv/bin/python -m mcp_server`. The
  module also carries a `sys.path` shim that inserts `server/` onto the path
  at import time, so `python -m server.mcp_server` from the repo root also
  works; the `cd server` in the npm script is purely for historical consistency
  with `dev:flask`. If you add another bare-name import from `server/` to
  `mcp_server.py`, the shim covers it.

## Invariants
- Each diagram file = exactly one JSON document at `server/data/<uuid>.json`.
- Filename stem IS the diagram id. Do not decouple them.
- CORS origin list stays narrow (localhost-only). Never widen without
  re-reviewing the auth model (there is none).
- The endpoint surface is consumed by `src/assets/scripts/api/DfdApiClient.ts`
  and the `FileManagement/` commands; breaking changes here require updating
  those files in the same change.

## Key Files
- `app.py` — the HTTP surface (8 routes, ~145 lines)
- `schema.py` — pydantic v2 models for the minimal DFD format; includes `DataItem`, `DataFlowProps.node1_src_data_item_refs`, `DataFlowProps.node2_src_data_item_refs`, and `Diagram.data_items`
- `transform.py` — native `dfd_v1` ↔ minimal format converter; `_build_canvas_props` now accepts `data_items`; `_data_item_to_pairs` serializes items; `_extract_canvas_data_items` reads them back
- `tests/` — pytest suites covering endpoints, schema, import/export, and enum-drift vs. `DfdObjects.ts`; `tests/test_data_items.py` covers data-item round-trip end-to-end
- `requirements.txt` — pinned floor versions of flask / flask-cors (plus `pydantic` for schema validation)
- `data/` — persistence directory; auto-created on startup. Contents are
  local-only and should not be committed.
- `.venv/` — expected virtual-env location; `npm run dev:flask` invokes
  `.venv/bin/flask` directly.

## MCP server & WebSocket

Three-process dev setup: Vite (5173), Flask (5050 REST + WS), MCP (5051).
`npm run dev:all` starts all three. The MCP process binds to 127.0.0.1:5051
only; Flask's broadcast endpoint rejects non-loopback callers with 403.

### New HTTP endpoints (Step 1)

- `DELETE /api/diagrams/<id>` — deletes `server/data/<id>.json`; 204 on
  success, 404 if missing.
- `PUT /api/diagrams/<id>/import` — replaces the stored doc with a
  minimal-format body (same validation as `POST /api/diagrams/import`);
  204 on success, 400 on validation error, 404 if missing.
- `POST /api/internal/broadcast` — accepts `{"type": ..., "payload": ...}`;
  fans the envelope out to all connected WebSocket clients; 200 on success,
  403 if caller is not 127.0.0.1.
- `GET /ws` — WebSocket upgrade endpoint (flask-sock). Clients receive
  broadcast envelopes as JSON strings.

### Broadcast envelope

```json
{"type": "display" | "diagram-updated" | "diagram-deleted" | "remote-control",
 "payload": <type-specific object or omitted>}
```

- `display` — payload `{"id": "<uuid>"}`: browser should navigate to that
  diagram.
- `diagram-updated` — payload `{"id": "<uuid>"}`: browser should reload the
  named diagram.
- `diagram-deleted` — payload `{"id": "<uuid>"}`: browser should close the
  named diagram if open.
- `remote-control` — payload `{"state": "on" | "off"}`: browser dispatches
  `SetReadonlyMode`; `"on"` locks the editor (installs read-only mode and
  uninstalls `RectangleSelectPlugin` / `PowerEditPlugin`); `"off"` restores
  interactive editing.

### MCP tools (Step 2)

Eleven tools exposed at `mcp_server.py` on port 5051 (streamable-HTTP transport
bound to 127.0.0.1:5051). Each tool calls Flask over loopback:

| Tool | Flask call | Emits |
|---|---|---|
| `list_diagrams` | `GET /api/diagrams` | — |
| `create_diagram` | `POST /api/diagrams/import` | — |
| `get_diagram` | `GET /api/diagrams/<id>/export` | — |
| `get_diagram_schema` | — (returns `Diagram.model_json_schema()`) | — |
| `update_diagram` | `PUT /api/diagrams/<id>/import` | `diagram-updated` |
| `delete_diagram` | `DELETE /api/diagrams/<id>` | `diagram-deleted` |
| `display_diagram` | `POST /api/internal/broadcast` with `type: "display"` | `display` |
| `add_element` | fetch → append → `PUT /api/diagrams/<id>/import` | `diagram-updated` |
| `update_element` | fetch → mutate → `PUT /api/diagrams/<id>/import` | `diagram-updated` |
| `delete_element` | fetch → cascade-delete → `PUT /api/diagrams/<id>/import` | `diagram-updated` |
| `reparent_element` | fetch → move between containers → `PUT /api/diagrams/<id>/import` | `diagram-updated` |

`create_diagram` and `update_diagram` take `diagram: dict` (not
`diagram: Diagram`) — validation happens inside the tool body via
`Diagram.model_validate(diagram)`. This keeps the advertised `inputSchema`
compact (no inlined pydantic `$defs`), which matters for MCP clients that
choke on large schemas. Agents that want the formal contract call
`get_diagram_schema`; agents that just need a working example round-trip the
output of `get_diagram` or follow the docstring example.

Tools that emit broadcasts (`update_diagram`, `delete_diagram`,
`display_diagram`) return a ``broadcast_delivered: bool`` flag so the agent
can distinguish "persisted but the browser wasn't notified" from "full
end-to-end success". A write succeeds even if the broadcast fails; the file
on disk is correct and the next successful broadcast will bring the browser
in sync.

### Remote-control lifecycle

The remote-control on/off broadcast is separate from the per-operation
broadcasts above. It is driven by a module-level last-seen heartbeat:

- Every tool call stamps the session's last-seen time (`_stamp` → `_mark_active`).
- A daemon thread sweeps every `SWEEP_INTERVAL_SECONDS` (2 s) and evicts
  sessions whose last-seen is older than `SESSION_EXPIRY_SECONDS` (8 s).
- The very first stamp in a 0→≥1-session transition emits
  `{type: "remote-control", payload: {state: "on"}}` before the tool runs.
  So `create_diagram` (or any tool) can be the first thing that locks the
  browser, as a side effect of the lifecycle — this is intentional. The
  per-operation "silent" semantic on `create_diagram` (no `diagram-updated`
  broadcast) is unchanged; only the remote-control lifecycle envelope
  participates.
- The last eviction in a ≥1→0 transition emits
  `{state: "off"}` so the browser re-enables editing.

Worst-case browser lock after a clean agent disconnect is
`SESSION_EXPIRY_SECONDS + SWEEP_INTERVAL_SECONDS` (≈10 s). Session identity
uses a UUID keyed on the `ServerSession` object via a `WeakKeyDictionary`,
so object-address reuse after GC cannot collide with a live session.

## Gotchas
- Not a production server. `flask --debug` is on by default via
  `npm run dev:flask`. Never expose this process to the network.
- POST returns only `{id}` — callers must issue a follow-up GET to read the
  scaffold, or a PUT to populate real content.
- PUT requires the file to already exist (404 otherwise); the only way to
  mint an id is POST. There is no upsert.
- No auth, no rate limiting, no concurrency control. Last write wins.
- Diagram JSON is gitignored via root `.gitignore` (`server/data/`); no
  per-directory ignore file here.
- **Broadcast delivery is best-effort.** The browser has no reconciliation
  path for broadcasts it missed during a WebSocket outage. If
  `diagram-updated` / `diagram-deleted` / `display` envelopes are dropped
  (Flask restart, /api/internal/broadcast unreachable, browser WS briefly
  disconnected), the browser's view can drift from `server/data/`. The MCP
  tool return shape surfaces `broadcast_delivered: bool` so the agent can
  at least know the notify step failed; the *lifecycle* `remote-control`
  broadcasts retry automatically (see `_mark_active` / `_sweep_once`
  rollback behavior). A full on-reconnect refresh protocol is out of scope
  for v1.
- **Flask is threaded=True dev-only.** Each connected browser holds a
  Werkzeug worker thread in the `/ws` receive loop (`flask-sock`
  `while True: ws.receive()`). Fine for single-user localhost; never front
  this with a reverse proxy that rewrites `REMOTE_ADDR` — the broadcast
  endpoint trusts `request.remote_addr == "127.0.0.1"` for access control.
