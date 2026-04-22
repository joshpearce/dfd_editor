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
    `d2 --layout=tala` via stdin, returns `{"svg": ...}` on 200 or
    `{"error": ...}` on 400 (bad input) / 502 (d2 absent or non-zero exit)
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
- `dev:mcp` is invoked as `cd server && .venv/bin/python -m mcp_server` (not
  `python -m server.mcp_server` from the repo root). The `cd server` is
  necessary because `mcp_server.py` does `from schema import Diagram` — Python
  resolves bare `schema` against the cwd, so the cwd must be `server/`.

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
