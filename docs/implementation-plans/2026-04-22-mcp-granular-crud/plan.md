# MCP Granular Element CRUD

**Goal:** Add 4 MCP tools that let agents add, update, delete, and reparent individual diagram elements without reconstructing the entire document.

**Approach:** Read-modify-write entirely in `mcp_server.py`. Each tool fetches the current minimal diagram via `GET /api/diagrams/<id>/export`, mutates the Python dict, validates with `Diagram.model_validate()`, writes back via `PUT /api/diagrams/<id>/import`, and broadcasts `diagram-updated`. No new Flask endpoints needed.

---

## Step 1 — Shared helpers + `add_element` tool

**What changes:** Extract two private helpers into `mcp_server.py`:
- `_fetch_minimal(diagram_id) → dict` — GET export, raise on 4xx/5xx
- `_save_minimal(diagram_id, diagram_dict) → bool` — validate with `Diagram.model_validate`, PUT import, broadcast `diagram-updated`, return `broadcast_delivered`

Add the `add_element` MCP tool:
- Inputs: `diagram_id: str`, `collection: Literal["nodes","containers","data_flows","data_items"]`, `element: dict`
- Body: fetch → append `element` to `diagram[collection]` → save
- Returns: `{guid: str, broadcast_delivered: bool}`
- Input schema note: `collection` should be an enum in the JSON Schema so the agent sees the valid values

**Files affected:** `server/mcp_server.py`

**Verification:** Agent can add a new process node to an existing diagram; browser reloads showing the new node. Existing `create_diagram`/`update_diagram` tools unchanged and passing.

---

## Step 2 — `update_element` tool

**What changes:** Add `update_element` MCP tool:
- Inputs: `diagram_id: str`, `guid: str`, `fields: dict`
- Body: fetch → find element across all 4 collections by guid → sparse-merge `fields` into `element["properties"]` → save
- For `data_items` (which have top-level fields, not a nested `properties` key), merge `fields` directly onto the element dict, excluding `guid`
- For `data_flows`, only `properties` are mergeable; `node1`/`node2` are read-only via this tool (change endpoints by delete + re-add)
- Returns: `{guid: str, broadcast_delivered: bool}`
- Raises descriptive error if guid not found

**Files affected:** `server/mcp_server.py`

**Verification:** Agent can rename a node, toggle `contains_pii` on a data store, change `authenticated` on a flow — all without touching other elements.

---

## Step 3 — `delete_element` tool (with cascade)

**What changes:** Add `delete_element` MCP tool:
- Inputs: `diagram_id: str`, `guid: str`
- Body: fetch → determine element type by scanning collections → cascade-delete → save
- Cascade rules:
  - **node deleted** → remove from `data_flows` where `node1` or `node2` matches; set `parent: null` on `data_items` whose `parent` matches; remove guid from any `container.children`
  - **container deleted** → children become top-level (remove guid from parent container's `children` if nested; do NOT delete the children themselves); remove guid from any parent container's `children`
  - **data_flow deleted** → no cascade
  - **data_item deleted** → scrub guid from all `node1_src_data_item_refs` and `node2_src_data_item_refs` in `data_flows`
- Returns: `{guid: str, deleted_collection: str, cascade_removed: list[str], broadcast_delivered: bool}`

**Files affected:** `server/mcp_server.py`

**Verification:** Deleting a node removes its flows and unparents its data_items. Deleting a container leaves its children intact at top level. Deleting a data_item scrubs refs from flows. Each cascade is visible in the returned `cascade_removed` list.

---

## Step 4 — `reparent_element` tool

**What changes:** Add `reparent_element` MCP tool:
- Inputs: `diagram_id: str`, `guid: str`, `new_parent_guid: str | None`
- Body: fetch → find and remove `guid` from whichever container's `children` currently holds it (if any) → if `new_parent_guid` is not null, append `guid` to that container's `children` → save
- Validates: `new_parent_guid` must exist in `containers` if provided; `guid` must exist in `nodes` or `containers`; a container cannot be reparented into one of its own descendants (cycle check)
- Returns: `{guid: str, old_parent_guid: str | None, new_parent_guid: str | None, broadcast_delivered: bool}`

**Files affected:** `server/mcp_server.py`

**Verification:** Agent can move a node into a trust boundary, move it out (new_parent_guid: null), and move a nested container to a different parent. Cycle reparent attempt returns a clear error.

---

## Definition of Done

- All 4 new tools are registered in the MCP server and appear in `get_diagram_schema` introspection (or at least `list_tools` if schema is separate)
- `Diagram.model_validate()` is called before every write — no raw dicts bypass validation
- Every mutating tool broadcasts `diagram-updated` and surfaces `broadcast_delivered`
- All 4 tools respect the existing `_stamp(ctx)` remote-control lifecycle (lock/release)
- Existing 7 tools and their tests are unaffected
- Manual end-to-end: add a node → add a flow → reparent the node into a trust boundary → update its name → delete the flow — all visible in the browser in real time
