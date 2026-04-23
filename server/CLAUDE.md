# Flask Backend

Last verified: 2026-04-23

## Purpose
Hosts DFD diagram files for the browser editor: "API creates diagram,
user edits, user saves." Runs as a separate process from the Vite dev
server. (Note: an upstream `?src=<url>` query-param path is not wired up
in this fork — this server's HTTP endpoints are the working persistence
surface.)

## Module layout

Three-tier split introduced 2026-04-23 so non-MCP agentic clients can
drive the same diagram operations over plain HTTP:

- `core.py` — pure diagram-mutation logic (cascade rules, cycle check,
  guid collision, read-only-field filtering). No I/O, no Flask, no WS.
  Raises typed exceptions (`ElementNotFoundError`, `DuplicateGuidError`,
  `ContainerCycleError`, etc.).
- `storage.py` — single source of truth for `DATA_DIR` and file I/O
  (`load_minimal`, `save_minimal`, `list_summaries`, `create_scaffold`,
  `delete`, `create_from_minimal`). Tests monkeypatch `storage.DATA_DIR`.
- `ws.py` — WebSocket client registry + two broadcast strategies.
  `broadcast(envelope)` fans out in-process to connected clients;
  `post_broadcast_envelope(envelope)` POSTs to
  `/api/internal/broadcast` (used by the out-of-process MCP server).
- `agent_service.py` — use-case layer. Each function:
  `storage.load_minimal → core.<op> → Diagram.model_validate →
  storage.save_minimal → broadcast`. Broadcast is injected as a callable
  so Flask (`ws.broadcast`) and MCP (`ws.post_broadcast_envelope`) each
  plug in their own delivery strategy.
- `editor_api.py` — Flask blueprint for the **editor-facing** HTTP
  surface. URLs unchanged from pre-split (`/api/health`,
  `/api/diagrams[/<id>]`, `/api/diagrams/import`,
  `/api/diagrams/<id>/export`, `/api/diagrams/<id>/import`,
  `/api/internal/broadcast`, `/api/layout`, `/ws`). Consumed by
  `DfdApiClient.ts` and the FileManagement commands.
- `agent_api.py` — Flask blueprint mounted at `/api/agent/*` for
  **external agentic clients** (scripts, tests, non-MCP agents). Thin
  translator over `agent_service`; MCP is one special case of this
  client class.
- `app.py` — wiring only (CORS, Sock, blueprint registration). Tiny.
- `mcp_server.py` — FastMCP tool wrappers. Each tool stamps the
  heartbeat and calls `agent_service.<op>` directly (in-process), passing
  `ws.post_broadcast_envelope` as the broadcast strategy.

## Contracts
- **Exposes** — HTTP endpoints defined in `editor_api.py` and `agent_api.py`:
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
  - **Agent API** at `/api/agent/*` (parallel surface for external
    non-MCP clients; see `agent_api.py`):
    - `GET  /api/agent/schema` — `Diagram.model_json_schema()`.
    - `GET  /api/agent/diagrams` — same summary list as the editor API.
    - `GET  /api/agent/diagrams/<id>` — minimal export; 404 if missing.
    - `POST /api/agent/diagrams` — validated create from minimal doc;
      returns `{id, diagram}` with 201. No broadcast.
    - `PUT  /api/agent/diagrams/<id>` — validated replace + broadcast
      `diagram-updated`; returns `{id, diagram, broadcast_delivered}`.
    - `DELETE /api/agent/diagrams/<id>` — delete + broadcast
      `diagram-deleted`.
    - `POST /api/agent/diagrams/<id>/display` — broadcast `display`;
      404 if id unknown (pre-check so browser never gets a bad
      envelope).
    - `POST   /api/agent/diagrams/<id>/<collection>` — append element;
      body is the element dict. Returns 201 with
      `{guid, broadcast_delivered}`. `<collection>` ∈ `{nodes, containers,
      data_flows, data_items}` (URL segments match JSON schema keys
      verbatim). 409 duplicate-guid, 400 missing-guid / invalid element,
      404 unknown diagram.
    - `PATCH  /api/agent/diagrams/<id>/<collection>/<guid>` — sparse-merge
      update. Body is a fields dict. The typed route passes the URL's
      collection as `expected_collection=`, so a guid that actually lives
      in another collection is rejected with HTTP 400 and
      `{"error", "actual_collection"}` — this lets the agent distinguish
      "wrong path" from "guid missing".
    - `DELETE /api/agent/diagrams/<id>/<collection>/<guid>` — delete with
      cascade rules. Same wrong-collection rejection shape as PATCH. Returns
      `{guid, deleted_collection, cascade_removed, broadcast_delivered}`.
    - `GET    /api/agent/diagrams/<id>/<collection>` — list summary rows
      for the collection (same projections as `list_*` MCP tools).
    - `POST   /api/agent/diagrams/<id>/reparent` — body
      `{guid, new_parent_guid}` (nullable). Returns
      `{guid, old_parent_guid, new_parent_guid, broadcast_delivered}`.
      409 on cycle, 404 on unknown target container, 404 if the guid is
      not in `nodes` or `containers` (flows and data items cannot be
      reparented).
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
- `app.py` — Flask app wiring only (CORS, Sock, blueprint registration).
- `editor_api.py` — editor-facing blueprint: unchanged `/api/*` URLs the Vue editor consumes.
- `agent_api.py` — external-client blueprint mounted at `/api/agent/*`.
- `agent_service.py` — use-case layer shared by `agent_api` and `mcp_server`; broadcast callback is injected.
- `core.py` — pure diagram-mutation functions (cascade, cycle, guid collision, read-only filtering). No I/O.
- `storage.py` — `DATA_DIR` + file I/O (load/save/list/delete). Tests patch `storage.DATA_DIR`.
- `ws.py` — WS client registry, in-process `broadcast`, and `post_broadcast_envelope` (HTTP loopback variant for MCP).
- `mcp_server.py` — FastMCP tool wrappers over `agent_service`.
- `schema.py` — pydantic v2 models for the minimal DFD format.
- `transform.py` — native `dfd_v1` ↔ minimal format converter.
- `tests/` — pytest suites: endpoints / schema / import-export / drift / data-items (existing) plus `test_core.py`, `test_agent_service.py`, `test_agent_api.py` (new, added with the 2026-04-23 split).
- `requirements.txt` — pinned floor versions of flask / flask-cors / pydantic / flask-sock.
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

### MCP tools

Twenty-four tools exposed at `mcp_server.py` on port 5051 (streamable-HTTP
transport bound to 127.0.0.1:5051). Each tool calls `agent_service.<op>`
**in-process** — only broadcasts still cross the process boundary via
`ws.post_broadcast_envelope` (the connected WS clients live in Flask's
process).

**Diagram-level** (7):

| Tool | agent_service call | Emits |
|---|---|---|
| `list_diagrams` | `list_diagrams` | — |
| `create_diagram` | `create_diagram` | — |
| `get_diagram` | `get_diagram` | — |
| `get_diagram_schema` | `get_schema` | — |
| `update_diagram` | `update_diagram` | `diagram-updated` |
| `delete_diagram` | `delete_diagram` | `diagram-deleted` |
| `display_diagram` | `display_diagram` | `display` |

**Typed element CRUD** (16) — one set per collection:

| Collection | add / update / delete / list tools | agent_service calls |
|---|---|---|
| nodes | `add_node` / `update_node` / `delete_node` / `list_nodes` | `add_element("nodes", …)` / `update_element(expected_collection="nodes", …)` / `delete_element(expected_collection="nodes", …)` / `list_summaries("nodes", …)` |
| containers | `add_container` / `update_container` / `delete_container` / `list_containers` | same, `"containers"` |
| data_flows | `add_flow` / `update_flow` / `delete_flow` / `list_flows` | same, `"data_flows"` |
| data_items | `add_data_item` / `update_data_item` / `delete_data_item` / `list_data_items` | same, `"data_items"` |

All add/update/delete tools emit `diagram-updated`. `list_*` tools do not
emit broadcasts.

Typed `update_*` / `delete_*` tools pass the target collection as
`expected_collection=` so a guid that lives in a different collection is
rejected at the service layer with a `WrongCollectionError` (`ValueError`
subclass with a structured `actual_collection` attribute). This lets the
agent work against each tool's declared contract without guessing
collection membership, and wrong-collection mistakes fail loudly rather
than silently mutating the wrong element.

`list_*` tools project each element to a small summary row so agents can
enumerate one collection without fetching the whole diagram:

- `list_nodes` / `list_containers` → `{guid, name, type}`
- `list_flows` → `{guid, name, node1, node2}`
- `list_data_items` → `{guid, name, classification}`

**Shared** (1):

| Tool | agent_service call | Emits |
|---|---|---|
| `reparent` | `reparent_element` | `diagram-updated` |

Accepts a guid in either `nodes` or `containers` (flows and data items
don't participate in the container hierarchy). `new_parent_guid=null`
moves the element to the top level. Raises on cycles and unknown target
containers.

`create_diagram` and `update_diagram` take `diagram: dict` (not
`diagram: Diagram`) — validation happens inside the service via
`Diagram.model_validate`. This keeps the advertised `inputSchema`
compact (no inlined pydantic `$defs`), which matters for MCP clients
that choke on large schemas. Agents that want the formal contract call
`get_diagram_schema`; agents that just need a working example round-trip
the output of `get_diagram` or follow the docstring example.

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
- **MCP now writes files directly.** Since the 2026-04-23 refactor the
  MCP process imports `agent_service` / `storage` in-process rather than
  PUTting to Flask. Both processes now contend for
  `server/data/<id>.json` as last-write-wins. Practical usage is
  single-user localhost so this is acceptable; if it ever matters the
  fix is a file lock inside `storage.save_minimal`.
