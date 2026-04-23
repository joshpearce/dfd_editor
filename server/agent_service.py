"""External-client use cases for diagram operations.

Shared by ``agent_api`` (REST blueprint) and ``mcp_server`` (MCP tool
bodies). Each function orchestrates:

    storage.load_minimal → core.<op> → Diagram.model_validate →
    storage.save_minimal → broadcast(envelope)

The broadcast strategy is injected as a callable so in-process Flask
callers can pass ``ws.broadcast`` and cross-process MCP callers can pass
``ws.post_broadcast_envelope``. Each mutation result carries
``broadcast_delivered: bool`` so agents can distinguish "persisted but
not notified" from full end-to-end success.
"""

from __future__ import annotations

from typing import Any, Callable

import core
import storage
from schema import Diagram


BroadcastFn = Callable[[dict], bool]


def _noop_broadcast(_envelope: dict) -> bool:
    """Sentinel used when the caller doesn't care about broadcast (e.g., create)."""
    return True


# ---------------------------------------------------------------------------
# Read operations
# ---------------------------------------------------------------------------


def list_diagrams() -> list[dict[str, Any]]:
    return storage.list_summaries()


def get_diagram(diagram_id: str) -> dict:
    if not storage.diagram_exists(diagram_id):
        raise storage.DiagramNotFoundError(diagram_id)
    return storage.load_minimal(diagram_id)


def get_schema() -> dict:
    return Diagram.model_json_schema()


# ---------------------------------------------------------------------------
# Diagram-level write operations
# ---------------------------------------------------------------------------


def create_diagram(doc: dict) -> dict:
    """Validate + persist ``doc`` as a new diagram. Does not broadcast.

    Returns ``{"id": <uuid>, "diagram": <minimal>}``.
    """
    diagram_id = storage.create_from_minimal(doc)
    return {"id": diagram_id, "diagram": storage.load_minimal(diagram_id)}


def update_diagram(
    diagram_id: str, doc: dict, broadcast: BroadcastFn,
) -> dict:
    """Replace the stored diagram with ``doc`` and broadcast ``diagram-updated``.

    Returns ``{"id", "diagram", "broadcast_delivered"}``.
    """
    storage.save_minimal(diagram_id, doc)
    delivered = broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {
        "id": diagram_id,
        "diagram": storage.load_minimal(diagram_id),
        "broadcast_delivered": delivered,
    }


def delete_diagram(diagram_id: str, broadcast: BroadcastFn) -> dict:
    """Delete the stored diagram and broadcast ``diagram-deleted``.

    Raises ``DiagramNotFoundError`` if the id is unknown.
    """
    if not storage.delete(diagram_id):
        raise storage.DiagramNotFoundError(diagram_id)
    delivered = broadcast({"type": "diagram-deleted", "payload": {"id": diagram_id}})
    return {"ok": True, "broadcast_delivered": delivered}


def display_diagram(diagram_id: str, broadcast: BroadcastFn) -> dict:
    """Broadcast a ``display`` envelope, pre-checking the id exists.

    Raises ``DiagramNotFoundError`` if the id is unknown so agents get a
    structured error instead of a silent broadcast the browser can't
    satisfy.
    """
    if not storage.diagram_exists(diagram_id):
        raise storage.DiagramNotFoundError(diagram_id)
    delivered = broadcast({"type": "display", "payload": {"id": diagram_id}})
    return {"ok": True, "broadcast_delivered": delivered}


# ---------------------------------------------------------------------------
# Granular element operations
# ---------------------------------------------------------------------------


def add_element(
    diagram_id: str,
    collection: str,
    element: dict,
    broadcast: BroadcastFn,
) -> dict:
    """Append ``element`` to ``diagram[collection]``, validate, persist, broadcast."""
    diagram = storage.load_minimal(diagram_id)
    core.add_element(diagram, collection, element)
    storage.save_minimal(diagram_id, diagram)
    delivered = broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {"guid": str(element["guid"]), "broadcast_delivered": delivered}


def update_element(
    diagram_id: str,
    guid: str,
    fields: dict,
    broadcast: BroadcastFn,
) -> dict:
    """Sparse-merge ``fields`` into the element, validate, persist, broadcast."""
    diagram = storage.load_minimal(diagram_id)
    core.update_element(diagram, guid, fields)
    storage.save_minimal(diagram_id, diagram)
    delivered = broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {"guid": guid, "broadcast_delivered": delivered}


def delete_element(
    diagram_id: str,
    guid: str,
    broadcast: BroadcastFn,
) -> dict:
    """Delete the element with cascade rules, validate, persist, broadcast."""
    diagram = storage.load_minimal(diagram_id)
    diagram, collection, cascade_removed = core.delete_element(diagram, guid)
    storage.save_minimal(diagram_id, diagram)
    delivered = broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {
        "guid": guid,
        "deleted_collection": collection,
        "cascade_removed": cascade_removed,
        "broadcast_delivered": delivered,
    }


def reparent_element(
    diagram_id: str,
    guid: str,
    new_parent_guid: str | None,
    broadcast: BroadcastFn,
) -> dict:
    """Move an element between containers, validate, persist, broadcast."""
    diagram = storage.load_minimal(diagram_id)
    diagram, old_parent_guid = core.reparent_element(diagram, guid, new_parent_guid)
    storage.save_minimal(diagram_id, diagram)
    delivered = broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {
        "guid": guid,
        "old_parent_guid": old_parent_guid,
        "new_parent_guid": new_parent_guid,
        "broadcast_delivered": delivered,
    }
