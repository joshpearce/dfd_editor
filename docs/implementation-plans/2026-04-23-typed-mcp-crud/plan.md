# Typed per-collection CRUD for MCP and HTTP agent surfaces

Date: 2026-04-23

## Goal

Replace the four generic element tools on both the MCP server and the
`/api/agent/*` HTTP surface with typed per-collection tools/endpoints —
four collections × {add, update, delete, list} = 16 operations, plus a
shared `reparent` covering the two collections that participate in the
container hierarchy.

Ports the MCP-side rewrite from `origin/clever-otter-bridge` commit
`5cadd5c refactor(mcp): split element tools into typed per-collection
surface` onto main's three-tier `core` / `storage` / `ws` /
`agent_service` / `{editor,agent}_api` / `mcp_server` architecture
(landed `285f133` on main), and extends the same typed shape to the HTTP
agent surface — which 5cadd5c did not touch, because
clever-otter-bridge was cut from before the agent_api split existed.

## Motivation

The generic `add_element(collection, element)` /
`update_element(guid, fields)` / `delete_element(guid)` tools make the
agent do the dispatch: guess the right collection, fetch
`get_diagram_schema` to figure out which properties go where, and
silently mis-target if it picks the wrong collection. Typed tools let
each wrapper advertise a per-collection docstring and input shape, so
the agent can work against the tool's declared contract without a
second round-trip. A wrong-collection guid is rejected at the call
site with a clear error rather than succeeding against an unrelated
element.

## Non-goals

- No change to the pydantic schema, HTTP contract for diagram-level
  endpoints, broadcast envelope, or session-lifecycle plumbing.
- `core.py` stays untouched — this is a surface-layer refactor.
- No per-field validation beyond what the schema already enforces; the
  typed tools route to the same `core.add/update/delete` paths.

## Changes

### 1. `server/agent_service.py`

- Add `list_summaries(diagram_id: str, collection: str, field_map:
  dict[str, str]) -> list[dict]`. Pure projection helper, no broadcast.
  `field_map` maps output key → source path; source is either a
  top-level key (`"guid"`, `"type"`, `"node1"`) or a
  `"properties.<key>"` dotted ref. Data items use top-level keys only.
- Add an optional `expected_collection: str | None = None` kwarg to
  `update_element` and `delete_element`. When set, raise
  `WrongCollectionError` (new typed exception in `core.py` or
  `agent_service.py`) if the guid resolves to a different collection.
  Default-None preserves the existing generic behavior for any caller
  that doesn't care.
- `reparent_element` stays as-is; only the MCP / HTTP wrapper names
  change.

### 2. `server/mcp_server.py`

- Drop the `@mcp.tool()` decorators on `add_element`,
  `update_element`, `delete_element`, `reparent_element` (delete the
  tool definitions entirely — nothing else imports them).
- Add 17 typed tool wrappers. Each wrapper stamps the heartbeat,
  delegates to `agent_service`, and returns the service result. The
  full list:

  | MCP tool | agent_service call |
  |---|---|
  | `add_node(diagram_id, node)` | `add_element(diagram_id, "nodes", node)` |
  | `update_node(diagram_id, guid, fields)` | `update_element(..., expected_collection="nodes")` |
  | `delete_node(diagram_id, guid)` | `delete_element(..., expected_collection="nodes")` |
  | `list_nodes(diagram_id)` | `list_summaries(..., "nodes", {guid, name, type})` |
  | `add_container` / `update_container` / `delete_container` / `list_containers` | same shape, `"containers"` |
  | `add_flow` / `update_flow` / `delete_flow` / `list_flows` | same shape, `"data_flows"` |
  | `add_data_item` / `update_data_item` / `delete_data_item` / `list_data_items` | same shape, `"data_items"` |
  | `reparent(diagram_id, guid, new_parent_guid)` | `reparent_element(...)` — rejects flows/data_items |

- Per-collection docstrings lifted from 5cadd5c (this is the
  ergonomics we're reaching for). Keep phrasing consistent with main's
  in-process architecture ("calls `agent_service.<op>` in-process"),
  not 5cadd5c's "calls Flask over loopback."
- Diagram-level seven tools (`list_diagrams`, `create_diagram`,
  `get_diagram`, `get_diagram_schema`, `update_diagram`,
  `delete_diagram`, `display_diagram`) unchanged.

Final MCP tool count: 7 diagram-level + 16 typed element + 1 shared
reparent = **24 tools** (was 11).

### 3. `server/agent_api.py`

Mirror the MCP typed surface on HTTP, minus the session-bound
lifecycle (HTTP has no session concept and no heartbeat).

**Remove:**

- `POST /api/agent/diagrams/<id>/elements`
- `PATCH /api/agent/diagrams/<id>/elements/<guid>`
- `DELETE /api/agent/diagrams/<id>/elements/<guid>`
- `POST /api/agent/diagrams/<id>/elements/<guid>/reparent`

**Add**, per collection × `{nodes, containers, data_flows, data_items}`:

| Method & Path | Body | Purpose |
|---|---|---|
| `POST   /api/agent/diagrams/<id>/<collection>` | element dict | add |
| `PATCH  /api/agent/diagrams/<id>/<collection>/<guid>` | `{fields}` | sparse-merge update |
| `DELETE /api/agent/diagrams/<id>/<collection>/<guid>` | — | delete with cascade |
| `GET    /api/agent/diagrams/<id>/<collection>` | — | list summaries |

**Shared:**

- `POST /api/agent/diagrams/<id>/reparent` — body
  `{guid, new_parent_guid}`. Rejects flows / data_items.

**URL collection segments**: `nodes`, `containers`, `data_flows`,
`data_items` — match the schema collection keys verbatim. Tradeoff
noted: MCP tool names use the shorter `add_flow` / `list_flows`; URLs
stay literal so the path mirrors the JSON body key. Worth the naming
asymmetry for HTTP debuggability (path-to-JSON-key is always
identity).

**Wrong-collection response**: maps `WrongCollectionError` to HTTP 400
with body `{"error": "...", "actual_collection": "data_flows"}` —
consistent with how duplicate-guid and missing-guid are already
reported.

**Diagram-level endpoints unchanged** — `/schema`,
`GET /diagrams`, `GET|POST|PUT|DELETE /diagrams/<id>`,
`POST /diagrams/<id>/display`.

### 4. Tests

- `server/tests/test_agent_service.py` — add coverage for
  `list_summaries` (projection shape for each collection) and for
  `expected_collection` rejection on `update_element` /
  `delete_element`.
- `server/tests/test_mcp_tools.py` — port 5cadd5c's test rewrite onto
  the new tool names. Adds a `TestList` suite for the four `list_*`
  tools. Replaces the existing generic-tool tests.
- `server/tests/test_agent_api.py` — add per-collection happy-path
  tests for all 4×4 endpoints + list-summary projection assertions +
  wrong-collection rejection. Drop tests for the four removed generic
  endpoints.

### 5. Docs

- `server/CLAUDE.md` — replace the "MCP tools" section. Adopt the
  two-tier table shape from 5cadd5c ("Diagram-level" / "Typed element
  CRUD" / "Shared"), but keep main's in-process phrasing. Update tool
  count 11 → 24. Add a parallel "Agent API" section table so the HTTP
  surface inventory stays in sync. Update the "Exposes" bullet list at
  the top to list the new endpoints.
- `server/examples/demo-prompt-java-webapp.md` — rewrite the tool
  calls to use typed names. Lift 5cadd5c's version and align it with
  main's in-process wording. The concrete library section (fixed
  GUIDs, data items, flows) does not change.

## Execution order

Single branch, stacked commits:

1. `feat(agent_service): add list_summaries + expected_collection enforcement`
   — plus service-level tests.
2. `refactor(mcp): split element tools into typed per-collection surface`
   — port of 5cadd5c's MCP wrappers + test rewrite, wired to
   agent_service.
3. `refactor(agent_api): mirror MCP typed surface on HTTP`
   — add typed endpoints + remove generic ones + test extension.
4. `docs(server): update MCP + agent_api inventory and demo prompt`.

Each commit keeps tests green. Steps 2 and 3 are independent once step
1 lands and could be swapped if convenient.

## Reference

`origin/clever-otter-bridge` commit `5cadd5c` is the canonical
reference for MCP tool docstrings, test expectations, and the
demo-prompt rewrite. Do not delete that ref — it is the source of
truth we're porting from, and the post-refactor PolyLine series is
stacked on top of it.
