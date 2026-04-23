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


class WrongCollectionError(ValueError):
    """Raised when a guid resolves to a different collection than the caller expected.

    ``actual_collection`` carries the collection the guid actually lives in
    so HTTP translators can surface it as a structured response field
    without having to re-scan the diagram or parse ``str(exc)``.
    """

    def __init__(self, message: str, *, actual_collection: str) -> None:
        super().__init__(message)
        self.actual_collection = actual_collection


def _require_collection(diagram: dict, guid: str, expected: str) -> None:
    """Verify the element at ``guid`` lives in ``expected``; else raise.

    Raises:
      * ``core.ElementNotFoundError`` — guid not present in any collection.
      * ``WrongCollectionError`` — guid present, but in a different collection.
    """
    found = core.find_element(diagram, guid)
    if found is None:
        raise core.ElementNotFoundError(f"element {guid!r} not found in diagram")
    _elem, actual = found
    if actual != expected:
        raise WrongCollectionError(
            f"element {guid!r} lives in {actual!r}, not {expected!r}",
            actual_collection=actual,
        )


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


def list_summaries(
    diagram_id: str,
    collection: str,
    field_map: dict[str, str],
) -> list[dict[str, Any]]:
    """Project each element of ``collection`` to a summary row.

    ``field_map`` maps output-key → source-path. A source-path is either
    a top-level key (``"guid"``, ``"type"``, ``"node1"``) or a
    ``properties.<key>`` dotted ref. Data items are flat — use top-level
    keys only.

    Raises ``storage.DiagramNotFoundError`` if the id is unknown.
    Raises ``core.InvalidCollectionError`` if ``collection`` is not valid.

    Returns a list of ``dict[str, Any]`` rows, one per element.
    """
    if not storage.diagram_exists(diagram_id):
        raise storage.DiagramNotFoundError(diagram_id)
    if collection not in core.VALID_COLLECTIONS:
        raise core.InvalidCollectionError(
            f"unknown collection {collection!r}; valid: {sorted(core.VALID_COLLECTIONS)}"
        )
    diagram = storage.load_minimal(diagram_id)
    rows: list[dict[str, Any]] = []
    for elem in diagram.get(collection, []):
        row: dict[str, Any] = {}
        for out_key, src in field_map.items():
            if src.startswith("properties."):
                prop_key = src.removeprefix("properties.")
                row[out_key] = elem.get("properties", {}).get(prop_key)
            else:
                row[out_key] = elem.get(src)
        rows.append(row)
    return rows


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
    *,
    expected_collection: str | None = None,
) -> dict:
    """Sparse-merge ``fields`` into the element, validate, persist, broadcast.

    If ``expected_collection`` is given, raises ``WrongCollectionError`` when
    the guid resolves to a different collection, and ``core.ElementNotFoundError``
    when the guid is absent.
    Raises ``WrongCollectionError`` when ``expected_collection`` is set and the guid is in a different collection.
    """
    diagram = storage.load_minimal(diagram_id)
    if expected_collection is not None:
        _require_collection(diagram, guid, expected_collection)
    core.update_element(diagram, guid, fields)
    storage.save_minimal(diagram_id, diagram)
    delivered = broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {"guid": guid, "broadcast_delivered": delivered}


def delete_element(
    diagram_id: str,
    guid: str,
    broadcast: BroadcastFn,
    *,
    expected_collection: str | None = None,
) -> dict:
    """Delete the element with cascade rules, validate, persist, broadcast.

    If ``expected_collection`` is given, raises ``WrongCollectionError`` when
    the guid resolves to a different collection, and ``core.ElementNotFoundError``
    when the guid is absent.
    Raises ``WrongCollectionError`` when ``expected_collection`` is set and the guid is in a different collection.
    """
    diagram = storage.load_minimal(diagram_id)
    if expected_collection is not None:
        _require_collection(diagram, guid, expected_collection)
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
