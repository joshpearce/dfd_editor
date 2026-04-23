"""MCP server for dfd_editor — exposes diagram-management tools via FastMCP
streamable-HTTP transport bound to 127.0.0.1:5051.

Each tool is a thin wrapper: it stamps the session heartbeat (so the
remote-control lifecycle envelope fires once on 0→≥1 and once on ≥1→0),
then delegates to the corresponding ``agent_service`` function. Broadcast
delivery crosses the process boundary via ``ws.post_broadcast_envelope``
(loopback POST to Flask's ``/api/internal/broadcast``).

Session lifecycle uses a last-seen heartbeat: ``_stamp`` records the
current time per session; a daemon thread sweeps every 2s and evicts
sessions older than 8s, firing ``remote-control`` on/off envelopes on
the transition edges. Session identity is a UUID keyed on the
``ServerSession`` object via a ``WeakKeyDictionary`` — this avoids
id()-address-reuse hazards when FastMCP recycles session memory.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import uuid
import weakref

# Allow both `python -m server.mcp_server` (from repo root) and
# `python -m mcp_server` (with cwd=server/).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from mcp.server.fastmcp import Context, FastMCP  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import agent_service  # noqa: E402
import ws  # noqa: E402
from schema import Diagram  # noqa: E402


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MCP_HOST = "127.0.0.1"
MCP_PORT = 5051
# Heartbeat fallback only. Kept short so a cleanly-disconnecting agent
# releases the browser's remote-control lock within ~a couple of seconds
# rather than forcing the user to wait out the timeout. Worst-case lock
# duration is SESSION_EXPIRY_SECONDS + SWEEP_INTERVAL_SECONDS.
SESSION_EXPIRY_SECONDS = 8
SWEEP_INTERVAL_SECONDS = 2


class DiagramSummary(BaseModel):
    """Short summary returned by ``list_diagrams``.

    Declared as a pydantic model so FastMCP advertises the schema to the
    agent; a bare ``list[dict]`` return annotation would leave the agent
    with an opaque structure.
    """

    id: str
    name: str
    modified: float


# ---------------------------------------------------------------------------
# Session-lifecycle tracking (heartbeat fallback)
# ---------------------------------------------------------------------------

_last_seen: dict[str, float] = {}
_last_seen_lock = threading.Lock()
_was_active = False

_session_uuids: "weakref.WeakKeyDictionary[object, str]" = weakref.WeakKeyDictionary()
_fallback_uuids: dict[int, str] = {}
_session_uuid_lock = threading.Lock()
_FALLBACK_UUIDS_MAX = 1024


def _session_id(ctx: Context) -> str:
    """Return a UUID stable for the lifetime of ``ctx.session``.

    Uses a WeakKeyDictionary so the UUID is released when FastMCP drops
    the session — avoiding the address-reuse hazard of ``id(ctx.session)``
    where garbage collection could recycle the memory address and mask a
    real 0→1 transition.
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
            # server/tests/test_mcp_tools.py clears this map between tests.
            key = id(session_obj)
            sid = _fallback_uuids.get(key)
            if sid is None:
                if len(_fallback_uuids) >= _FALLBACK_UUIDS_MAX:
                    _fallback_uuids.pop(next(iter(_fallback_uuids)))
                sid = str(uuid.uuid4())
                _fallback_uuids[key] = sid
            return sid


def _broadcast(envelope: dict) -> bool:
    """POST ``envelope`` to Flask's loopback broadcast endpoint.

    Tests monkeypatch this to observe/suppress broadcasts. The default
    implementation delegates to ``ws.post_broadcast_envelope``.
    """
    return ws.post_broadcast_envelope(envelope)


def _broadcaster(envelope: dict) -> bool:
    """Adapter used by ``agent_service`` calls so tests that patch
    ``mcp_server._broadcast`` still observe every outbound envelope."""
    return _broadcast(envelope)


def _mark_active(sid: str) -> None:
    """Record the session as seen and broadcast on 0→≥1 transition.

    Computes the transition under the lock, releases the lock, then
    broadcasts outside of it so the HTTP POST doesn't serialize all tool
    calls behind the broadcast RTT. If the broadcast fails, rolls
    ``_was_active`` back so the next tool call retries.
    """
    global _was_active
    with _last_seen_lock:
        _last_seen[sid] = time.monotonic()
        should_broadcast_on = not _was_active
        if should_broadcast_on:
            _was_active = True
    if should_broadcast_on:
        logger.info("remote-control: on (session count 0 → >0)")
        delivered = _broadcast({"type": "remote-control", "payload": {"state": "on"}})
        if not delivered:
            with _last_seen_lock:
                _was_active = False
            logger.warning("remote-control:on broadcast failed — will retry on next tool call")


def _stamp(ctx: Context) -> None:
    sid = _session_id(ctx)
    _mark_active(sid)


def _sweep_once(now: float | None = None) -> bool:
    """Run one sweep pass. Returns True iff a clean 1→0 off-broadcast fired.

    If the off-broadcast fails, rolls ``_was_active`` back to True so the
    next sweep retries — otherwise the browser could be stranded in
    read-only forever after a transient Flask outage.
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
            with _last_seen_lock:
                _was_active = True
            logger.warning("remote-control:off broadcast failed — will retry on next sweep")
            return False
    return broadcast_off


def _sweep() -> None:
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        _sweep_once()


def start_daemon() -> None:
    """Start the session-sweeper daemon thread.

    Called from ``__main__`` only so importing this module in tests does
    not spawn a background thread that races with test-driven
    ``_sweep_once()`` calls.
    """
    sweeper = threading.Thread(target=_sweep, daemon=True, name="mcp-session-sweeper")
    sweeper.start()
    logger.info("session-sweeper daemon started")


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "dfd-editor",
    host=MCP_HOST,
    port=MCP_PORT,
)


# ---------------------------------------------------------------------------
# Tools — each wraps agent_service with the heartbeat stamp.
# ---------------------------------------------------------------------------


@mcp.tool()
def get_diagram_schema() -> dict:
    """Return the full JSON Schema for the diagram format.

    Use this when ``create_diagram``'s docstring example isn't enough and
    you need the formal contract (all enums, required fields, validators,
    etc.). The schema describes the ``diagram`` parameter accepted by
    ``create_diagram`` and ``update_diagram``, and the document returned
    by ``get_diagram``.
    """
    return agent_service.get_schema()


@mcp.tool()
def list_diagrams(ctx: Context) -> list[DiagramSummary]:
    """List all diagrams stored on the server.

    Returns a list of summary objects, each with id, name, and modified
    (Unix timestamp of last file modification).
    """
    _stamp(ctx)
    return [DiagramSummary.model_validate(row) for row in agent_service.list_diagrams()]


@mcp.tool()
def get_diagram(diagram_id: str, ctx: Context) -> dict:
    """Fetch a single diagram in minimal export format.

    Returns the full diagram document (nodes, containers, data_flows,
    data_items, meta) for the given diagram_id. Raises an error if the
    diagram_id does not exist.
    """
    _stamp(ctx)
    return agent_service.get_diagram(diagram_id)


@mcp.tool()
def create_diagram(diagram: dict, ctx: Context) -> dict:
    """Create a new diagram from a minimal-format document.

    ``diagram`` accepts the same JSON shape that ``get_diagram`` returns —
    round-trip an existing diagram for the canonical example. Call
    ``get_diagram_schema`` for the full JSON Schema.

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
    No broadcast is emitted — call ``display_diagram`` to show it in the browser.
    """
    _stamp(ctx)
    return agent_service.create_diagram(diagram)


@mcp.tool()
def update_diagram(diagram_id: str, diagram: dict, ctx: Context) -> dict:
    """Replace an existing diagram with a new minimal-format document.

    ``diagram`` accepts the same JSON shape as ``create_diagram``. Returns
    ``{id, diagram, broadcast_delivered}``; the ``broadcast_delivered``
    flag indicates whether the diagram-updated notification reached Flask
    successfully. A write succeeds even if the broadcast fails — the
    persisted file is already correct.
    """
    _stamp(ctx)
    return agent_service.update_diagram(diagram_id, diagram, _broadcaster)


@mcp.tool()
def delete_diagram(diagram_id: str, ctx: Context) -> dict:
    """Delete a diagram permanently.

    Returns ``{ok: true, broadcast_delivered: bool}`` on success. Emits a
    diagram-deleted broadcast so any connected browser can react (e.g.
    return to the splash screen if the deleted diagram was open).
    """
    _stamp(ctx)
    return agent_service.delete_diagram(diagram_id, _broadcaster)


@mcp.tool()
def display_diagram(diagram_id: str, ctx: Context) -> dict:
    """Tell the connected browser to open and display a specific diagram.

    Broadcasts a display event containing the diagram_id. Returns
    ``{ok: true, broadcast_delivered: bool}``. Raises if the diagram_id
    does not exist on the server — this gives the agent a structured
    error instead of a silent browser-side 404.
    """
    _stamp(ctx)
    return agent_service.display_diagram(diagram_id, _broadcaster)


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
    Validates and persists via ``agent_service.add_element`` in-process.
    Emits ``diagram-updated``. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return agent_service.add_element(diagram_id, "nodes", node, _broadcaster)


@mcp.tool()
def update_node(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` into an existing node's ``properties``.

    Read-only keys (``guid``, ``type``) are silently skipped if present in
    ``fields``. Raises ``ValueError`` if ``guid`` is not found in the nodes
    collection — use the matching typed tool for containers / flows / data
    items. Validates and persists via ``agent_service.update_element`` in-process.
    Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return agent_service.update_element(
        diagram_id, guid, fields, _broadcaster,
        expected_collection="nodes",
    )


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
    Validates and persists via ``agent_service.delete_element`` in-process.
    Returns ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``.
    """
    _stamp(ctx)
    return agent_service.delete_element(
        diagram_id, guid, _broadcaster,
        expected_collection="nodes",
    )


@mcp.tool()
def list_nodes(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, type}`` summary row per node.

    Use ``get_diagram`` when you need full properties beyond the display
    name and type. Calls ``agent_service.list_summaries`` in-process.
    """
    _stamp(ctx)
    return agent_service.list_summaries(
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
    existing elements into the new container. Validates and persists via
    ``agent_service.add_element`` in-process. Emits ``diagram-updated``.
    Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return agent_service.add_element(diagram_id, "containers", container, _broadcaster)


@mcp.tool()
def update_container(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` into an existing container's ``properties``.

    Read-only keys (``guid``, ``type``) are silently skipped. Use
    ``reparent`` to move children in or out — don't edit ``children``
    through this tool. Raises ``ValueError`` if ``guid`` is not in the
    containers collection. Validates and persists via
    ``agent_service.update_element`` in-process.
    """
    _stamp(ctx)
    return agent_service.update_element(
        diagram_id, guid, fields, _broadcaster,
        expected_collection="containers",
    )


@mcp.tool()
def delete_container(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a container from a diagram.

    The container's own children (nodes / nested containers) are not
    deleted — they become implicitly top-level. The guid is removed from
    any parent container's ``children`` list. Raises ``ValueError`` if
    ``guid`` is not in the containers collection. Validates and persists
    via ``agent_service.delete_element`` in-process. Returns
    ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``
    (``cascade_removed`` is always empty for containers — orphaned children
    are retained).
    """
    _stamp(ctx)
    return agent_service.delete_element(
        diagram_id, guid, _broadcaster,
        expected_collection="containers",
    )


@mcp.tool()
def list_containers(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, type}`` summary row per container.

    Use ``get_diagram`` when you need the ``children`` list or other
    properties. Calls ``agent_service.list_summaries`` in-process.
    """
    _stamp(ctx)
    return agent_service.list_summaries(
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

    Validates and persists via ``agent_service.add_element`` in-process.
    Emits ``diagram-updated``. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return agent_service.add_element(diagram_id, "data_flows", flow, _broadcaster)


@mcp.tool()
def update_flow(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` into an existing data flow's ``properties``.

    Read-only keys (``guid``, ``node1``, ``node2``) are silently skipped —
    the endpoint pair is immutable through this tool; delete and re-add
    the flow to change endpoints. Raises ``ValueError`` if ``guid`` is not
    in the data_flows collection. Validates and persists via
    ``agent_service.update_element`` in-process.
    """
    _stamp(ctx)
    return agent_service.update_element(
        diagram_id, guid, fields, _broadcaster,
        expected_collection="data_flows",
    )


@mcp.tool()
def delete_flow(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a data flow from a diagram. No cascade.

    Raises ``ValueError`` if ``guid`` is not in the data_flows collection.
    Validates and persists via ``agent_service.delete_element`` in-process.
    Returns ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``
    (``cascade_removed`` is always empty for flows).
    """
    _stamp(ctx)
    return agent_service.delete_element(
        diagram_id, guid, _broadcaster,
        expected_collection="data_flows",
    )


@mcp.tool()
def list_flows(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, node1, node2}`` summary row per data flow.

    Endpoints are the canonicalized ``str(node1) < str(node2)`` pair as
    stored on the flow. Use ``get_diagram`` when you need the full
    properties (protocol, ref arrays, etc.). Calls
    ``agent_service.list_summaries`` in-process.
    """
    _stamp(ctx)
    return agent_service.list_summaries(
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

    Validates and persists via ``agent_service.add_element`` in-process.
    Emits ``diagram-updated``. Returns ``{guid, broadcast_delivered}``.
    """
    _stamp(ctx)
    return agent_service.add_element(diagram_id, "data_items", data_item, _broadcaster)


@mcp.tool()
def update_data_item(diagram_id: str, guid: str, fields: dict, ctx: Context) -> dict:
    """Sparse-merge ``fields`` directly onto a data item.

    Data items have no nested ``properties`` — fields merge onto the top-
    level dict. ``guid`` is read-only and silently skipped. To reparent a
    data item, include ``"parent": "<node_guid>"`` or ``"parent": null`` in
    ``fields``. Raises ``ValueError`` if ``guid`` is not in the data_items
    collection. Validates and persists via ``agent_service.update_element``
    in-process.
    """
    _stamp(ctx)
    return agent_service.update_element(
        diagram_id, guid, fields, _broadcaster,
        expected_collection="data_items",
    )


@mcp.tool()
def delete_data_item(diagram_id: str, guid: str, ctx: Context) -> dict:
    """Remove a data item, cascading ref-array cleanup on data flows.

    The guid is removed from every data flow's ``node1_src_data_item_refs``
    and ``node2_src_data_item_refs`` arrays. Raises ``ValueError`` if
    ``guid`` is not in the data_items collection. Validates and persists via
    ``agent_service.delete_element`` in-process. Returns
    ``{guid, deleted_collection, cascade_removed, broadcast_delivered}``
    (``cascade_removed`` is always empty — it tracks removed *elements*,
    and ref-array cleanup does not produce any).
    """
    _stamp(ctx)
    return agent_service.delete_element(
        diagram_id, guid, _broadcaster,
        expected_collection="data_items",
    )


@mcp.tool()
def list_data_items(diagram_id: str, ctx: Context) -> list[dict]:
    """Return a ``{guid, name, classification}`` summary row per data item.

    Use ``get_diagram`` when you need ``parent``, ``identifier``, or other
    fields. Calls ``agent_service.list_summaries`` in-process.
    """
    _stamp(ctx)
    return agent_service.list_summaries(
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
    the element, or ``None`` if it was already at top-level. Calls
    ``agent_service.reparent_element`` in-process.
    """
    _stamp(ctx)
    return agent_service.reparent_element(diagram_id, guid, new_parent_guid, _broadcaster)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    logger.info("starting MCP server on %s:%d", MCP_HOST, MCP_PORT)
    start_daemon()
    mcp.run(transport="streamable-http")
