"""Pure diagram-mutation logic for the minimal-format document.

This module owns no I/O, no Flask, no HTTP, no WebSocket plumbing — just
functions over a ``diagram: dict`` (the minimal export shape defined by
``schema.Diagram``). Callers (``agent_service``, future batch tools) are
responsible for loading, validating, persisting, and broadcasting.

Typed exceptions let the HTTP layer translate to status codes without
parsing error strings.
"""

from __future__ import annotations


VALID_COLLECTIONS: frozenset[str] = frozenset(
    {"nodes", "containers", "data_flows", "data_items"}
)
NODE_READONLY: frozenset[str] = frozenset({"guid", "type"})
FLOW_READONLY: frozenset[str] = frozenset({"guid", "node1", "node2"})
DATA_ITEM_READONLY: frozenset[str] = frozenset({"guid"})


class ElementNotFoundError(ValueError):
    """Raised when a guid cannot be located in any collection."""


class DuplicateGuidError(ValueError):
    """Raised when ``add_element`` receives a guid already present in the diagram."""


class ContainerNotFoundError(ValueError):
    """Raised when reparenting targets a container guid that does not exist."""


class ContainerCycleError(ValueError):
    """Raised when reparenting would place a container inside its own descendant."""


class InvalidCollectionError(ValueError):
    """Raised when an unrecognised collection name is supplied."""


class MissingGuidError(ValueError):
    """Raised when ``add_element`` receives an element without a ``guid``."""


def find_element(diagram: dict, guid: str) -> tuple[dict, str] | None:
    """Locate an element by guid across all collections.

    Returns (element_dict, collection_name) or None.
    """
    for collection in VALID_COLLECTIONS:
        for elem in diagram.get(collection, []):
            if str(elem.get("guid")) == str(guid):
                return elem, collection
    return None


def container_descendants(diagram: dict, container_guid: str) -> set[str]:
    """Return the set of container guids reachable from container_guid (inclusive).

    Uses BFS so a cycle in the input data (which shouldn't exist after
    validation but can exist mid-edit) doesn't cause infinite recursion.
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


def add_element(diagram: dict, collection: str, element: dict) -> dict:
    """Append ``element`` to ``diagram[collection]``, mutating in place.

    Returns the mutated diagram for chaining. Enforces:
      * ``collection`` is one of VALID_COLLECTIONS.
      * ``element`` carries a ``guid`` field.
      * The guid does not collide with any existing element across all
        collections.

    Does not run schema validation — the caller is expected to follow up
    with ``Diagram.model_validate(diagram)`` before persisting.
    """
    if collection not in VALID_COLLECTIONS:
        raise InvalidCollectionError(
            f"invalid collection {collection!r}; must be one of: "
            + ", ".join(sorted(VALID_COLLECTIONS))
        )
    if "guid" not in element:
        raise MissingGuidError("element must contain a 'guid' field")

    diagram.setdefault(collection, [])
    incoming_guid = str(element["guid"])
    existing_guids = {
        str(item["guid"])
        for coll in VALID_COLLECTIONS
        for item in diagram.get(coll, [])
    }
    if incoming_guid in existing_guids:
        raise DuplicateGuidError(
            f"element guid {incoming_guid!r} already exists in the diagram"
        )
    diagram[collection].append(element)
    return diagram


def update_element(diagram: dict, guid: str, fields: dict) -> dict:
    """Sparse-merge ``fields`` into the element identified by ``guid``.

    - nodes/containers/data_flows: merged into ``element["properties"]``,
      filtered by the appropriate read-only set.
    - data_items: merged onto the flat element dict; only ``guid`` is
      read-only.

    Raises ``ElementNotFoundError`` if ``guid`` is absent.
    """
    found = find_element(diagram, guid)
    if found is None:
        raise ElementNotFoundError(f"element {guid!r} not found in diagram")
    elem, collection = found
    if collection in ("nodes", "containers"):
        safe = {k: v for k, v in fields.items() if k not in NODE_READONLY}
        elem["properties"].update(safe)
    elif collection == "data_flows":
        safe = {k: v for k, v in fields.items() if k not in FLOW_READONLY}
        elem["properties"].update(safe)
    else:  # data_items — flat dict
        safe = {k: v for k, v in fields.items() if k not in DATA_ITEM_READONLY}
        elem.update(safe)
    return diagram


def delete_element(diagram: dict, guid: str) -> tuple[dict, str, list[str]]:
    """Remove ``guid`` from its collection and cascade according to its type.

    Returns (diagram, deleted_collection, cascade_removed_guids).

    Cascade rules:
      * nodes: removes data_flows that reference this node as endpoint,
        unparents any data_item whose ``parent`` was this node, strips the
        guid from all container children lists.
      * containers: strips the guid from any parent container's children.
        The deleted container's own children survive (become top-level).
      * data_flows: no cascade.
      * data_items: strips the guid from every flow's
        ``node1_src_data_item_refs`` and ``node2_src_data_item_refs``.
    """
    found = find_element(diagram, guid)
    if found is None:
        raise ElementNotFoundError(f"element {guid!r} not found in diagram")
    _elem, collection = found

    diagram[collection] = [
        e for e in diagram.get(collection, [])
        if str(e.get("guid")) != str(guid)
    ]

    cascade_removed: list[str] = []

    if collection == "nodes":
        surviving_flows = []
        for flow in diagram.get("data_flows", []):
            if str(flow.get("node1")) == str(guid) or str(flow.get("node2")) == str(guid):
                cascade_removed.append(str(flow["guid"]))
            else:
                surviving_flows.append(flow)
        diagram["data_flows"] = surviving_flows

        for item in diagram.get("data_items", []):
            if str(item.get("parent")) == str(guid):
                item["parent"] = None

        for container in diagram.get("containers", []):
            container["children"] = [
                c for c in container.get("children", [])
                if str(c) != str(guid)
            ]

    elif collection == "containers":
        for container in diagram.get("containers", []):
            container["children"] = [
                c for c in container.get("children", [])
                if str(c) != str(guid)
            ]

    elif collection == "data_items":
        for flow in diagram.get("data_flows", []):
            props = flow.get("properties", {})
            for ref_key in ("node1_src_data_item_refs", "node2_src_data_item_refs"):
                if ref_key in props:
                    props[ref_key] = [
                        r for r in props[ref_key]
                        if str(r) != str(guid)
                    ]

    return diagram, collection, cascade_removed


def reparent_element(
    diagram: dict,
    guid: str,
    new_parent_guid: str | None,
) -> tuple[dict, str | None]:
    """Move a node or container to a new parent container (or to top-level).

    Returns (diagram, old_parent_guid). ``old_parent_guid`` is None if the
    element was already at top-level.

    Raises:
      * ElementNotFoundError — guid not present in nodes or containers.
      * ContainerNotFoundError — ``new_parent_guid`` does not identify a container.
      * ContainerCycleError — moving a container into one of its own descendants.
    """
    found_in_nodes = any(
        str(e.get("guid")) == str(guid) for e in diagram.get("nodes", [])
    )
    found_in_containers = any(
        str(e.get("guid")) == str(guid) for e in diagram.get("containers", [])
    )
    if not found_in_nodes and not found_in_containers:
        raise ElementNotFoundError(
            f"element {guid!r} not found in nodes or containers"
        )

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
            raise ContainerNotFoundError(
                f"target container {new_parent_guid!r} not found in containers"
            )
        if found_in_containers:
            descendants = container_descendants(diagram, guid)
            if str(new_parent_guid) in descendants:
                raise ContainerCycleError("reparenting would create a cycle")

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

    return diagram, old_parent_guid
