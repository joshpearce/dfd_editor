"""MCP server for dfd_editor — exposes typed diagram-management tools via
FastMCP streamable-HTTP transport bound to 127.0.0.1:5051.

Tool surface is two-tier: seven diagram-level tools (list / create / get /
update / delete / display / get_diagram_schema) plus typed per-collection
CRUD+list tools for nodes, containers, flows, and data items (add_*,
update_*, delete_*, list_*), plus a shared ``reparent`` covering nodes and
containers.

Session lifecycle is tracked via a last-seen heartbeat: each tool call stamps
_last_seen[session_id]. A daemon thread sweeps stale sessions every 2 s and
emits remote-control on/off transitions to Flask's /api/internal/broadcast
when the active-session count crosses zero.

Session identity is a UUID keyed on the ServerSession object via a
WeakKeyDictionary — this avoids the id()-address-reuse hazard if FastMCP
ever recycles session memory (a stale _last_seen key would otherwise shadow
a fresh session at the same address).
"""

import atexit
import logging
import os
import sys
import threading
import time
import uuid
import weakref

# Allow `python -m server.mcp_server` (from repo root) as well as
# `python -m mcp_server` (from server/ cwd). `from schema import Diagram`
# below is a bare import that resolves against sys.path — when launched
# from the repo root, ensure `server/` is on the path so it still resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import httpx  # noqa: E402  (placed after sys.path shim so server/ imports resolve)
from mcp.server.fastmcp import Context, FastMCP  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from schema import Diagram  # noqa: E402


class DiagramSummary(BaseModel):
    """Short summary returned by `list_diagrams`.

    Mirrors the shape emitted by Flask's `GET /api/diagrams`.
    Declared as a pydantic model so FastMCP advertises the schema to the
    agent; a bare `list[dict]` return annotation would leave the agent with
    an opaque structure.
    """
    id: str
    name: str
    modified: float

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FLASK_URL = "http://127.0.0.1:5050"
MCP_HOST = "127.0.0.1"
MCP_PORT = 5051
# Heartbeat fallback only. Kept short so a cleanly-disconnecting agent
# releases the browser's remote-control lock within ~a couple of seconds
# rather than forcing the user to wait out the timeout.  Worst-case lock
# duration is SESSION_EXPIRY_SECONDS + SWEEP_INTERVAL_SECONDS.
SESSION_EXPIRY_SECONDS = 8
SWEEP_INTERVAL_SECONDS = 2

# ---------------------------------------------------------------------------
# HTTP client (shared, sync) — shared across REST + broadcast calls to localhost Flask.
# ---------------------------------------------------------------------------

_http = httpx.Client(base_url=FLASK_URL, timeout=5.0)  # 5s matches realistic localhost upper bound
atexit.register(_http.close)

# ---------------------------------------------------------------------------
# Session-lifecycle tracking (heartbeat fallback)
# ---------------------------------------------------------------------------

_last_seen: dict[str, float] = {}
_last_seen_lock = threading.Lock()
_was_active = False  # last known state of _active_sessions being non-empty

# Maps ServerSession objects to stable UUID strings. WeakKeyDictionary so
# entries vanish automatically when FastMCP drops its last reference to the
# session, preventing stale UUIDs from building up. Falls back to an
# ordinary dict keyed on ctx's own id() when the session is not weakly
# referenceable (old SDK builds, test stubs); the fallback is size-capped
# so a long-running process can't accumulate entries unbounded.
_session_uuids: "weakref.WeakKeyDictionary[object, str]" = weakref.WeakKeyDictionary()
_fallback_uuids: dict[int, str] = {}
_session_uuid_lock = threading.Lock()
_FALLBACK_UUIDS_MAX = 1024


def _session_id(ctx: Context) -> str:
    """Identify the MCP session for lifecycle tracking.

    Returns a UUID that is stable for the lifetime of the ServerSession
    attached to ``ctx``. Uses a WeakKeyDictionary so the UUID is released
    when FastMCP drops the session — this avoids the address-reuse hazard
    of ``id(ctx.session)`` (garbage collection could otherwise recycle the
    memory address and mask a real 0→1 transition).
    """
    session_obj: object
    try:
        session_obj = ctx.session
    except Exception:
        session_obj = ctx
    with _session_uuid_lock:
        try:
            sid = _session_uuids.get(session_obj)
            if sid is None:
                sid = str(uuid.uuid4())
                _session_uuids[session_obj] = sid
            return sid
        except TypeError:
            # Not weakly referenceable (e.g. some test stubs). Fall back to
            # an id()-keyed dict; the `_reset_mcp_state` autouse fixture in
            # server/tests/test_mcp_tools.py clears this map between tests
            # so the id()-based keys don't collide across runs.
            key = id(session_obj)
            sid = _fallback_uuids.get(key)
            if sid is None:
                # Cap the fallback to prevent unbounded growth if a caller
                # keeps producing fresh non-weakly-referenceable sessions.
                # FIFO eviction is plenty — in practice this map should stay
                # empty in production (ServerSession supports weakref).
                if len(_fallback_uuids) >= _FALLBACK_UUIDS_MAX:
                    _fallback_uuids.pop(next(iter(_fallback_uuids)))
                sid = str(uuid.uuid4())
                _fallback_uuids[key] = sid
            return sid


def _mark_active(sid: str) -> None:
    """Record the session as seen and broadcast on-envelope if this is a 0→1 transition.

    Computes the transition under the lock, releases it, then broadcasts
    outside the lock so the HTTP POST does not serialize all tool calls
    behind the broadcast RTT.

    If the broadcast fails (Flask unreachable, 5xx, etc.), ``_was_active``
    is rolled back under the lock so the next tool call retries the on
    transition. Without this rollback a failed initial broadcast would
    leave the server believing the browser is locked while the browser
    never received the signal — the editor would stay interactive for the
    entire agent session, defeating Step 4's read-only guarantee.
    """
    global _was_active
    with _last_seen_lock:
        _last_seen[sid] = time.monotonic()
        # Broadcast is driven entirely by `_was_active`: if the server thinks
        # the browser is NOT locked, this stamp transitions it to locked and
        # fires the on-broadcast. `_was_active` is the single source of truth
        # for "does the browser believe an agent is attached?"; `_last_seen`
        # tracks session timeout independently. This decoupling matters for
        # the rollback path — a failed on-broadcast clears `_was_active` but
        # leaves the session in `_last_seen`, and the next stamp (even by the
        # same session) must retry the on-broadcast.
        should_broadcast_on = not _was_active
        if should_broadcast_on:
            _was_active = True
    if should_broadcast_on:
        logger.info("remote-control: on (session count 0 → >0)")
        delivered = _broadcast({"type": "remote-control", "payload": {"state": "on"}})
        if not delivered:
            # Roll back so the next _stamp retries the transition rather than
            # sitting in a "server thinks on, browser thinks off" split state.
            with _last_seen_lock:
                _was_active = False
            logger.warning("remote-control:on broadcast failed — will retry on next tool call")


def _stamp(ctx: Context) -> None:
    """Record the current time for the session so the sweeper knows it's alive."""
    sid = _session_id(ctx)
    _mark_active(sid)


def _broadcast(envelope: dict) -> bool:
    """POST an envelope to Flask's loopback-only broadcast endpoint.

    Returns True if Flask accepted the broadcast, False on any exception
    (connection refused, 5xx, etc.). Callers that care about end-to-end
    delivery should surface this in their tool return payload so the agent
    doesn't treat a write-without-notify as a success.
    """
    try:
        resp = _http.post("/api/internal/broadcast", json=envelope)
        resp.raise_for_status()
        return True
    except Exception:
        logger.exception("failed to post broadcast envelope: %s", envelope)
        return False


def _sweep_once(now: float | None = None) -> bool:
    """Run one sweep pass. Returns True if an 'off' transition was emitted
    AND its broadcast reached Flask.

    Computes the transition under the lock, releases it, then broadcasts
    outside the lock so the HTTP POST does not serialize tool calls.
    Exposed with a return value so tests can assert on the transition
    without sleeping for the daemon's 5-second interval.

    If the broadcast fails, ``_was_active`` is rolled back to True so the
    next sweep tick retries. Without this the browser could be stranded
    in read-only mode forever after a transient Flask outage.
    """
    global _was_active
    if now is None:
        now = time.monotonic()
    broadcast_off = False
    with _last_seen_lock:
        stale = [sid for sid, ts in _last_seen.items()
                 if now - ts > SESSION_EXPIRY_SECONDS]
        for sid in stale:
            del _last_seen[sid]
            logger.info("evicted stale session %s", sid)
        is_active = bool(_last_seen)
        if not is_active and _was_active:
            _was_active = False
            broadcast_off = True
    if broadcast_off:
        logger.info("remote-control: off (session count >0 → 0)")
        delivered = _broadcast({"type": "remote-control", "payload": {"state": "off"}})
        if not delivered:
            # Retry on the next sweep tick rather than stranding the browser
            # in read-only mode until a new session starts.
            with _last_seen_lock:
                _was_active = True
            logger.warning("remote-control:off broadcast failed — will retry on next sweep")
            return False
    return broadcast_off


def _sweep() -> None:
    """Daemon thread: calls _sweep_once every SWEEP_INTERVAL_SECONDS."""
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        _sweep_once()


def start_daemon() -> None:
    """Start the session-sweeper daemon thread.

    Called from __main__ only so that importing mcp_server in tests does not
    start a background thread that races with test-driven _sweep_once() calls.
    """
    sweeper = threading.Thread(target=_sweep, daemon=True, name="mcp-session-sweeper")
    sweeper.start()
    logger.info("session-sweeper daemon started")


# ---------------------------------------------------------------------------
# Diagram fetch / save helpers (used by granular element tools)
# ---------------------------------------------------------------------------


def _fetch_minimal(diagram_id: str) -> dict:
    """Fetch a diagram in minimal export format. No validation — just fetch."""
    resp = _http.get(f"/api/diagrams/{diagram_id}/export")
    resp.raise_for_status()
    return resp.json()


def _save_minimal(diagram_id: str, diagram_dict: dict) -> bool:
    """Validate diagram_dict and PUT it back as the stored minimal doc.

    Validates with ``Diagram.model_validate`` — raises on invalid input.
    PUTs the validated doc to the import endpoint and broadcasts
    ``diagram-updated``. Returns the ``broadcast_delivered`` bool.
    """
    validated = Diagram.model_validate(diagram_dict)
    resp = _http.put(
        f"/api/diagrams/{diagram_id}/import",
        json=validated.model_dump(mode="json"),
    )
    resp.raise_for_status()
    return _broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "dfd-editor",
    host=MCP_HOST,
    port=MCP_PORT,
)

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def get_diagram_schema() -> dict:
    """Return the full JSON Schema for the diagram format.

    Use this when `create_diagram`'s docstring example isn't enough and you
    need the formal contract (all enums, required fields, validators, etc.).
    The schema describes the `diagram` parameter accepted by `create_diagram`
    and `update_diagram`, and the document returned by `get_diagram`.
    """
    return Diagram.model_json_schema()


@mcp.tool()
def list_diagrams(ctx: Context) -> list[DiagramSummary]:
    """List all diagrams stored on the server.

    Returns a list of summary objects, each with id, name, and modified
    (Unix timestamp of last file modification).
    """
    _stamp(ctx)
    resp = _http.get("/api/diagrams")
    resp.raise_for_status()
    return [DiagramSummary.model_validate(row) for row in resp.json()]


@mcp.tool()
def get_diagram(diagram_id: str, ctx: Context) -> dict:
    """Fetch a single diagram in minimal export format.

    Returns the full diagram document (nodes, containers, data_flows,
    data_items, meta) for the given diagram_id.  Raises an error if the
    diagram_id does not exist.
    """
    _stamp(ctx)
    resp = _http.get(f"/api/diagrams/{diagram_id}/export")
    resp.raise_for_status()
    return resp.json()


@mcp.tool()
def create_diagram(diagram: dict, ctx: Context) -> dict:
    """Create a new diagram from a minimal-format document.

    `diagram` accepts the same JSON shape that `get_diagram` returns —
    round-trip an existing diagram for the canonical example. Call
    `get_diagram_schema` for the full JSON Schema.

    Minimal shape:

        {
          "meta": {"name": "My DFD"},
          "nodes": [
            {"type": "process", "guid": "<uuid>",
             "properties": {"name": "API", "assumptions": []}},
            {"type": "data_store", "guid": "<uuid>",
             "properties": {"name": "DB", "contains_pii": false,
                            "encryption_at_rest": true}}
          ],
          "containers": [
            {"type": "trust_boundary", "guid": "<uuid>",
             "properties": {"name": "VPC"},
             "children": ["<node_guid>", ...]}
          ],
          "data_flows": [
            {"guid": "<uuid>", "node1": "<guid>", "node2": "<guid>",
             "properties": {"name": "Write", "authenticated": true,
                            "encrypted": true,
                            "node1_src_data_item_refs": ["<data_item_guid>"],
                            "node2_src_data_item_refs": []}}
          ],
          "data_items": [
            {"guid": "<uuid>", "parent": "<node_guid>",
             "identifier": "D1", "name": "Customer PII",
             "classification": "pii"}
          ]
        }

    Enums: node type ∈ {process, external_entity, data_store};
    container type ∈ {trust_boundary, container};
    classification ∈ {unclassified, internal, pii, secret}.

    Persists under a freshly minted UUID. Returns {id, diagram}.
    No broadcast is emitted — call `display_diagram` to show it in the browser.
    """
    _stamp(ctx)
    validated = Diagram.model_validate(diagram)
    resp = _http.post("/api/diagrams/import", json=validated.model_dump(mode="json"))
    resp.raise_for_status()
    diagram_id = resp.json()["id"]
    echo = _http.get(f"/api/diagrams/{diagram_id}/export")
    echo.raise_for_status()
    return {"id": diagram_id, "diagram": echo.json()}


@mcp.tool()
def update_diagram(diagram_id: str, diagram: dict, ctx: Context) -> dict:
    """Replace an existing diagram with a new minimal-format document.

    `diagram` accepts the same JSON shape as `create_diagram` — see that
    tool's docstring for the minimal example, or call `get_diagram_schema`
    for the full schema.

    Overwrites the stored diagram for diagram_id with the provided document.
    The stored layout is dropped so the browser will re-run TALA on the
    next open. Returns {id, diagram, broadcast_delivered}; the
    ``broadcast_delivered`` flag indicates whether the diagram-updated
    notification reached Flask successfully. A write succeeds even if the
    broadcast fails — the persisted file is already correct; the browser
    will simply not know to reload until the user refreshes or the next
    successful broadcast reaches it.
    """
    _stamp(ctx)
    validated = Diagram.model_validate(diagram)
    resp = _http.put(f"/api/diagrams/{diagram_id}/import", json=validated.model_dump(mode="json"))
    resp.raise_for_status()
    # Broadcast fires on successful write; surface delivery status in the tool
    # return so the agent doesn't mistake "persisted but not notified" for
    # full end-to-end success.
    broadcast_delivered = _broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    echo = _http.get(f"/api/diagrams/{diagram_id}/export")
    echo.raise_for_status()
    return {
        "id": diagram_id,
        "diagram": echo.json(),
        "broadcast_delivered": broadcast_delivered,
    }


@mcp.tool()
def delete_diagram(diagram_id: str, ctx: Context) -> dict:
    """Delete a diagram permanently.

    Removes the stored file for the given diagram_id.  Returns
    ``{ok: true, broadcast_delivered: bool}`` on success.  Emits a
    diagram-deleted broadcast so any connected browser can react (e.g.
    return to the splash screen if the deleted diagram was open).
    """
    _stamp(ctx)
    resp = _http.delete(f"/api/diagrams/{diagram_id}")
    resp.raise_for_status()
    broadcast_delivered = _broadcast({"type": "diagram-deleted", "payload": {"id": diagram_id}})
    return {"ok": True, "broadcast_delivered": broadcast_delivered}


@mcp.tool()
def display_diagram(diagram_id: str, ctx: Context) -> dict:
    """Tell the connected browser to open and display a specific diagram.

    Broadcasts a display event containing the diagram_id.  The browser's
    WebSocket client will react by loading and rendering the diagram.
    Returns ``{ok: true, broadcast_delivered: bool}`` — ``broadcast_delivered``
    is False when Flask's broadcast endpoint is unreachable, which means
    the browser will not be notified.

    Raises an HTTP error if the diagram_id does not exist on the server —
    this gives the agent a structured error instead of letting a
    browser-side 404 fail silently over the WS channel.
    """
    _stamp(ctx)
    # Pre-check existence so the agent gets a real error on unknown ids,
    # instead of a broadcast the browser can't satisfy.
    check = _http.get(f"/api/diagrams/{diagram_id}")
    check.raise_for_status()
    broadcast_delivered = _broadcast({"type": "display", "payload": {"id": diagram_id}})
    return {"ok": True, "broadcast_delivered": broadcast_delivered}


_VALID_COLLECTIONS = {"nodes", "containers", "data_flows", "data_items"}


def _find_element(diagram: dict, guid: str) -> tuple[dict, str] | None:
    for collection in _VALID_COLLECTIONS:
        for elem in diagram.get(collection, []):
            if str(elem.get("guid")) == str(guid):
                return elem, collection
    return None


def _container_descendants(diagram: dict, container_guid: str) -> set[str]:
    """Return the set of container guids reachable from container_guid (inclusive).

    Uses BFS over container children so that a cycle in the input data
    (which should not exist after validation but is possible in partially-
    constructed state) does not cause infinite recursion.
    """
    visited: set[str] = set()
    queue = [str(container_guid)]
    while queue:
        cg = queue.pop()
        if cg in visited:
            continue
        for c in diagram.get("containers", []):
            if str(c["guid"]) == cg:
                visited.add(cg)
                for child in c.get("children", []):
                    queue.append(str(child))
    return visited


# ---------------------------------------------------------------------------
# Per-collection dispatch helpers (shared by the typed MCP tools below)
# ---------------------------------------------------------------------------


def _add_to_collection(diagram_id: str, collection: str, element: dict) -> dict:
    """Append ``element`` to the named collection with full-diagram revalidation.

    Enforces GUID uniqueness across every collection in the diagram (not just
    the target one) — the schema treats GUIDs as diagram-global, so a
    collision in any collection must be rejected at the add site before we
    round-trip through pydantic.
    """
    diagram = _fetch_minimal(diagram_id)
    if collection not in diagram:
        diagram[collection] = []
    if "guid" not in element:
        raise ValueError("element must contain a 'guid' field")
    incoming_guid = str(element["guid"])
    existing_guids = {
        str(item["guid"])
        for coll in _VALID_COLLECTIONS
        for item in diagram.get(coll, [])
    }
    if incoming_guid in existing_guids:
        raise ValueError(
            f"element guid {incoming_guid!r} already exists in the diagram"
        )
    diagram[collection].append(element)
    broadcast_delivered = _save_minimal(diagram_id, diagram)
    return {"guid": incoming_guid, "broadcast_delivered": broadcast_delivered}


def _update_by_guid(
    diagram_id: str, guid: str, fields: dict, expected_collection: str,
) -> dict:
    """Sparse-merge ``fields`` into the element at ``guid``.

    Rejects the call if ``guid`` does not live in ``expected_collection`` —
    this is what lets the typed MCP wrappers (``update_node`` etc.) advertise
    per-type contracts without leaking dispatch back to the agent.
    """
    diagram = _fetch_minimal(diagram_id)
    found = _find_element(diagram, guid)
    if found is None:
        raise ValueError(f"element {guid!r} not found in diagram {diagram_id!r}")
    elem, collection = found
    if collection != expected_collection:
        raise ValueError(
            f"element {guid!r} lives in {collection!r}, not {expected_collection!r}"
        )
    if collection in ("nodes", "containers"):
        readonly = {"guid", "type"}
        safe_fields = {k: v for k, v in fields.items() if k not in readonly}
        elem["properties"].update(safe_fields)
    elif collection == "data_flows":
        readonly = {"guid", "node1", "node2"}
        safe_fields = {k: v for k, v in fields.items() if k not in readonly}
        elem["properties"].update(safe_fields)
    else:  # data_items — flat dict
        safe_fields = {k: v for k, v in fields.items() if k != "guid"}
        elem.update(safe_fields)
    broadcast_delivered = _save_minimal(diagram_id, diagram)
    return {"guid": guid, "broadcast_delivered": broadcast_delivered}


def _delete_by_guid(
    diagram_id: str, guid: str, expected_collection: str,
) -> dict:
    """Remove the element at ``guid`` and apply per-collection cascade rules.

    Rejects the call if ``guid`` does not live in ``expected_collection``
    (mirroring ``_update_by_guid``). Cascade branch is picked off the
    collection: nodes → drop related flows + unparent items + strip from
    container children; containers → strip from parent's children
    (children survive); data_items → scrub from flow ref arrays; flows →
    no cascade.
    """
    diagram = _fetch_minimal(diagram_id)
    found = _find_element(diagram, guid)
    if found is None:
        raise ValueError(f"element {guid!r} not found in diagram {diagram_id!r}")
    _elem, collection = found
    if collection != expected_collection:
        raise ValueError(
            f"element {guid!r} lives in {collection!r}, not {expected_collection!r}"
        )

    diagram[collection] = [
        e for e in diagram.get(collection, [])
        if str(e.get("guid")) != str(guid)
    ]

    cascade_removed: list[str] = []

    if collection == "nodes":
        # Cascade 1: remove data_flows that reference this node.
        surviving_flows = []
        for flow in diagram.get("data_flows", []):
            if str(flow.get("node1")) == str(guid) or str(flow.get("node2")) == str(guid):
                cascade_removed.append(str(flow["guid"]))
            else:
                surviving_flows.append(flow)
        diagram["data_flows"] = surviving_flows

        # Cascade 2: unparent data_items whose parent was this node.
        for item in diagram.get("data_items", []):
            if str(item.get("parent")) == str(guid):
                item["parent"] = None

        # Cascade 3: remove guid from any container's children list.
        for container in diagram.get("containers", []):
            container["children"] = [
                c for c in container.get("children", [])
                if str(c) != str(guid)
            ]

    elif collection == "containers":
        # Remove guid from any parent container's children list.
        for container in diagram.get("containers", []):
            container["children"] = [
                c for c in container.get("children", [])
                if str(c) != str(guid)
            ]
        # The container's own children are not deleted — they become top-level.

    elif collection == "data_items":
        # Remove this data_item guid from all flow src_data_item_refs lists.
        for flow in diagram.get("data_flows", []):
            props = flow.get("properties", {})
            for ref_key in ("node1_src_data_item_refs", "node2_src_data_item_refs"):
                if ref_key in props:
                    props[ref_key] = [
                        r for r in props[ref_key]
                        if str(r) != str(guid)
                    ]

    # collection == "data_flows" requires no cascade.

    broadcast_delivered = _save_minimal(diagram_id, diagram)
    return {
        "guid": guid,
        "deleted_collection": collection,
        "cascade_removed": cascade_removed,
        "broadcast_delivered": broadcast_delivered,
    }


def _list_summaries(
    diagram_id: str, collection: str, field_map: dict[str, str],
) -> list[dict]:
    """Project each element of ``collection`` to a summary row.

    ``field_map`` maps output-key → source-path. A source-path is either a
    top-level key (``"guid"``, ``"type"``, ``"node1"``) or a
    ``properties.<key>`` dotted ref (``"properties.name"``). Data items are
    flat — use top-level keys only.
    """
    diagram = _fetch_minimal(diagram_id)
    out: list[dict] = []
    for elem in diagram.get(collection, []):
        row: dict = {}
        for out_key, src in field_map.items():
            if src.startswith("properties."):
                row[out_key] = elem.get("properties", {}).get(src.removeprefix("properties."))
            else:
                row[out_key] = elem.get(src)
        out.append(row)
    return out


def _reparent_shared(
    diagram_id: str, guid: str, new_parent_guid: str | None,
) -> dict:
    """Core reparent logic shared by the ``reparent`` MCP tool.

    Accepts a guid that lives in either ``nodes`` or ``containers``; flows
    and data items don't participate in the container hierarchy. When the
    moved element is itself a container, rejects moves that would create a
    containment cycle.
    """
    diagram = _fetch_minimal(diagram_id)

    found_in_nodes = any(
        str(e.get("guid")) == str(guid) for e in diagram.get("nodes", [])
    )
    found_in_containers = any(
        str(e.get("guid")) == str(guid) for e in diagram.get("containers", [])
    )
    if not found_in_nodes and not found_in_containers:
        raise ValueError(f"element {guid!r} not found in nodes or containers")

    old_parent_guid: str | None = None
    for container in diagram.get("containers", []):
        if any(str(child) == str(guid) for child in container.get("children", [])):
            old_parent_guid = str(container["guid"])
            break

    if new_parent_guid is not None:
        target_exists = any(
            str(c.get("guid")) == str(new_parent_guid)
            for c in diagram.get("containers", [])
        )
        if not target_exists:
            raise ValueError(
                f"target container {new_parent_guid!r} not found in containers"
            )
        if found_in_containers:
            descendants = _container_descendants(diagram, guid)
            if str(new_parent_guid) in descendants:
                raise ValueError("reparenting would create a cycle")

    if old_parent_guid is not None:
        for container in diagram.get("containers", []):
            if str(container["guid"]) == old_parent_guid:
                container["children"] = [
                    c for c in container.get("children", [])
                    if str(c) != str(guid)
                ]
                break

    if new_parent_guid is not None:
        for container in diagram.get("containers", []):
            if str(container["guid"]) == str(new_parent_guid):
                container.setdefault("children", []).append(str(guid))
                break

    broadcast_delivered = _save_minimal(diagram_id, diagram)
    return {
        "guid": guid,
        "old_parent_guid": old_parent_guid,
        "new_parent_guid": new_parent_guid,
        "broadcast_delivered": broadcast_delivered,
    }


# ---------------------------------------------------------------------------
# Node tools
# ---------------------------------------------------------------------------


@mcp.tool()
def add_node(diagram_id: str, node: dict, ctx: Context) -> dict:
    """Append a node (process / data_store / external_entity) to a diagram.

    Required node shape:

    - ``guid``: string UUID, unique across every collection in the diagram
    - ``type``: one of ``"process"``, ``"data_store"``, ``"external_entity"``
    - ``properties``: type-specific props, always including ``name``

    Example process node::

        {"guid": "<uuid>", "type": "process",
         "properties": {"name": "API", "assumptions": []}}

    Call ``get_diagram_schema`` for the full per-type properties contract.
    Emits ``diagram-updated``. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return _add_to_collection(diagram_id, "nodes", node)


@mcp.tool()
def update_node(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` into an existing node's ``properties``.

    Read-only keys (``guid``, ``type``) are silently skipped if present in
    ``fields``. Raises ``ValueError`` if ``guid`` is not found in the nodes
    collection — use the matching typed tool for containers / flows / data
    items. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return _update_by_guid(diagram_id, guid, fields, "nodes")


@mcp.tool()
def delete_node(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a node from a diagram, cascading related refs.

    Cascade rules:

    - any data_flow with ``node1`` or ``node2`` equal to ``guid`` is removed
      (its guid is returned in ``cascade_removed``);
    - any data_item whose ``parent`` equals ``guid`` is unparented in place
      (``parent`` set to ``None``) — not deleted;
    - the guid is removed from every container's ``children`` list.

    Raises ``ValueError`` if ``guid`` is not in the nodes collection.
    Returns ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``.
    """
    _stamp(ctx)
    return _delete_by_guid(diagram_id, guid, "nodes")


@mcp.tool()
def list_nodes(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, type}`` summary row per node.

    Use ``get_diagram`` when you need full properties beyond the display
    name and type.
    """
    _stamp(ctx)
    return _list_summaries(
        diagram_id,
        "nodes",
        {"guid": "guid", "name": "properties.name", "type": "type"},
    )


# ---------------------------------------------------------------------------
# Container tools (trust_boundary + container)
# ---------------------------------------------------------------------------


@mcp.tool()
def add_container(diagram_id: str, container: dict, ctx: Context) -> dict:
    """Append a container (trust_boundary / container) to a diagram.

    Required container shape:

    - ``guid``: string UUID, unique across every collection
    - ``type``: one of ``"trust_boundary"``, ``"container"``
    - ``properties``: includes ``name`` (and, for trust_boundary, an optional
      ``trust_level``)
    - ``children``: list of node / nested-container guids (default ``[]``)

    Prefer ``reparent`` over populating ``children`` post-hoc when moving
    existing elements into the new container. Emits ``diagram-updated``.
    Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return _add_to_collection(diagram_id, "containers", container)


@mcp.tool()
def update_container(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` into an existing container's ``properties``.

    Read-only keys (``guid``, ``type``) are silently skipped. Use
    ``reparent`` to move children in or out — don't edit ``children``
    through this tool. Raises ``ValueError`` if ``guid`` is not in the
    containers collection.
    """
    _stamp(ctx)
    return _update_by_guid(diagram_id, guid, fields, "containers")


@mcp.tool()
def delete_container(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a container from a diagram.

    The container's own children (nodes / nested containers) are not
    deleted — they become implicitly top-level. The guid is removed from
    any parent container's ``children`` list. Raises ``ValueError`` if
    ``guid`` is not in the containers collection. Returns
    ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``
    (``cascade_removed`` is always empty for containers — orphaned children
    are retained).
    """
    _stamp(ctx)
    return _delete_by_guid(diagram_id, guid, "containers")


@mcp.tool()
def list_containers(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, type}`` summary row per container.

    Use ``get_diagram`` when you need the ``children`` list or other
    properties.
    """
    _stamp(ctx)
    return _list_summaries(
        diagram_id,
        "containers",
        {"guid": "guid", "name": "properties.name", "type": "type"},
    )


# ---------------------------------------------------------------------------
# Flow tools
# ---------------------------------------------------------------------------


@mcp.tool()
def add_flow(diagram_id: str, flow: dict, ctx: Context) -> dict:
    """Append a data flow to a diagram.

    Required flow shape:

    - ``guid``: string UUID, unique across every collection
    - ``node1``, ``node2``: guids of existing nodes; self-loops are
      rejected. Endpoints are canonicalized into ``str(node1) < str(node2)``
      order server-side with the two ref arrays swapped in sync.
    - ``properties``: includes ``name``, ``authenticated: bool``,
      ``encrypted: bool``, optional ``protocol``, and the two ref arrays
      ``node1_src_data_item_refs`` and ``node2_src_data_item_refs``
      (guids of data items the corresponding endpoint originates).

    Emits ``diagram-updated``. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return _add_to_collection(diagram_id, "data_flows", flow)


@mcp.tool()
def update_flow(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` into an existing data flow's ``properties``.

    Read-only keys (``guid``, ``node1``, ``node2``) are silently skipped —
    the endpoint pair is immutable through this tool; delete and re-add
    the flow to change endpoints. Raises ``ValueError`` if ``guid`` is not
    in the data_flows collection.
    """
    _stamp(ctx)
    return _update_by_guid(diagram_id, guid, fields, "data_flows")


@mcp.tool()
def delete_flow(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a data flow from a diagram. No cascade.

    Raises ``ValueError`` if ``guid`` is not in the data_flows collection.
    Returns ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``
    (``cascade_removed`` is always empty for flows).
    """
    _stamp(ctx)
    return _delete_by_guid(diagram_id, guid, "data_flows")


@mcp.tool()
def list_flows(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, node1, node2}`` summary row per data flow.

    Endpoints are the canonicalized ``str(node1) < str(node2)`` pair as
    stored on the flow. Use ``get_diagram`` when you need the full
    properties (protocol, ref arrays, etc.).
    """
    _stamp(ctx)
    return _list_summaries(
        diagram_id,
        "data_flows",
        {
            "guid": "guid",
            "name": "properties.name",
            "node1": "node1",
            "node2": "node2",
        },
    )


# ---------------------------------------------------------------------------
# Data-item tools
# ---------------------------------------------------------------------------


@mcp.tool()
def add_data_item(diagram_id: str, data_item: dict, ctx: Context) -> dict:
    """Append a data item to a diagram.

    Data items are flat (no nested ``properties``). Shape:

    - ``guid``: string UUID, unique across every collection
    - ``identifier``: short code (e.g. ``"D1"``)
    - ``name``: display name
    - ``classification``: one of ``"unclassified"``, ``"internal"``,
      ``"pii"``, ``"secret"`` (default ``"unclassified"``)
    - ``parent``: owning node guid, or ``null`` for unowned
    - ``description``: optional free text

    Emits ``diagram-updated``. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return _add_to_collection(diagram_id, "data_items", data_item)


@mcp.tool()
def update_data_item(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` directly onto a data item.

    Data items have no nested ``properties`` — fields merge onto the top-
    level dict. ``guid`` is read-only and silently skipped. To reparent a
    data item, include ``"parent": "<node_guid>"`` or ``"parent": null`` in
    ``fields``. Raises ``ValueError`` if ``guid`` is not in the data_items
    collection.
    """
    _stamp(ctx)
    return _update_by_guid(diagram_id, guid, fields, "data_items")


@mcp.tool()
def delete_data_item(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a data item, cascading ref-array cleanup on data flows.

    The guid is removed from every data flow's ``node1_src_data_item_refs``
    and ``node2_src_data_item_refs`` arrays. Raises ``ValueError`` if
    ``guid`` is not in the data_items collection. Returns
    ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``
    (``cascade_removed`` is always empty — it tracks removed *elements*,
    and ref-array cleanup does not produce any).
    """
    _stamp(ctx)
    return _delete_by_guid(diagram_id, guid, "data_items")


@mcp.tool()
def list_data_items(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, classification}`` summary row per data item.

    Use ``get_diagram`` when you need ``parent``, ``identifier``, or other
    fields.
    """
    _stamp(ctx)
    return _list_summaries(
        diagram_id,
        "data_items",
        {
            "guid": "guid",
            "name": "name",
            "classification": "classification",
        },
    )


# ---------------------------------------------------------------------------
# Shared reparent (nodes + containers)
# ---------------------------------------------------------------------------


@mcp.tool()
def reparent(
    diagram_id: str,
    guid: str,
    new_parent_guid: str | None,
    ctx: Context,
) -> dict:
    """Move a node or container into a different container (or to top-level).

    Only nodes and containers participate in the container hierarchy.
    Flows' endpoints are immutable through this API; data items' parent
    node is edited via ``update_data_item``.

    ``new_parent_guid=null`` removes the element from its current container
    and leaves it at the top level (not inside any container).

    If ``new_parent_guid`` is provided it must identify an existing
    container. When the element being moved is itself a container, a cycle
    check is run first: the new parent must not be a descendant of the
    element being moved (including the element itself). Moving a container
    into one of its own descendants would create a containment cycle that
    violates the schema invariant — ``ValueError("reparenting would create
    a cycle")`` is raised in that case.

    Returns ``{guid, old_parent_guid, new_parent_guid, broadcast_delivered}``.
    ``old_parent_guid`` is the guid of the container that previously held
    the element, or ``None`` if it was already at top-level.
    """
    _stamp(ctx)
    return _reparent_shared(diagram_id, guid, new_parent_guid)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)  # INFO so MCP SDK transport logs surface during `dev:mcp`
    logger.info("starting MCP server on %s:%d", MCP_HOST, MCP_PORT)
    start_daemon()
    mcp.run(transport="streamable-http")
