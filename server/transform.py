"""Transformer: native dfd_v1 format ↔ minimal JSON format.

Only to_minimal (native→minimal) is implemented in this module (Step 3).
The inverse (to_native, minimal→native) will be added in Step 4.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from schema import Diagram

# Template ids that represent diagram nodes (blocks).
_NODE_IDS: frozenset[str] = frozenset({"process", "external_entity", "data_store"})

# Template ids that represent containers (groups).
_CONTAINER_IDS: frozenset[str] = frozenset({"trust_boundary", "container"})

# Template ids that are layout/routing scaffolding — excluded from children lists.
_SCAFFOLDING_IDS: frozenset[str] = frozenset(
    {"horizontal_anchor", "vertical_anchor", "generic_latch", "generic_handle"}
)

# Node property keys whose native values are string-encoded booleans
# ("true"/"false") and must be converted to real booleans.
_BOOL_PROPS: dict[str, frozenset[str]] = {
    "process": frozenset(),
    "external_entity": frozenset({"out_of_scope"}),
    "data_store": frozenset({"contains_pii", "encryption_at_rest"}),
}

# Data-flow property keys that are string-encoded booleans in native format.
_FLOW_BOOL_PROPS: frozenset[str] = frozenset({"authenticated", "encrypted_in_transit"})


# ---------------------------------------------------------------------------
# Public exceptions
# ---------------------------------------------------------------------------


class DuplicateParentError(ValueError):
    """Raised when a GUID appears as a child of more than one container."""


class InvalidNativeError(ValueError):
    """Raised when the native document violates expected structural invariants."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def to_minimal(native: dict) -> dict:
    """Transform a native dfd_v1 document into the minimal JSON format.

    Args:
        native: Parsed native dfd_v1 JSON document.

    Returns:
        Minimal format dict, validated against the Diagram schema.

    Raises:
        DuplicateParentError: A GUID appears as a child of two distinct parents.
        InvalidNativeError: The native document violates structural invariants
            (e.g. a data_flow references a latch not attached to any block).
    """
    objects: list[dict] = native.get("objects", [])

    # --- Step 1: index by instance id -----------------------------------------
    by_instance: dict[str, dict] = {}
    for obj in objects:
        inst = obj.get("instance")
        if inst:
            by_instance[inst] = obj

    # --- Step 2: build latch→block map ----------------------------------------
    latch_to_block: dict[str, str] = _build_latch_to_block(by_instance)

    # --- Step 3: extract meta from canvas "dfd" object ------------------------
    canvas = _find_canvas(objects)
    meta = _extract_meta(canvas)

    # --- Step 4: assert single-parent invariant --------------------------------
    _assert_single_parent(objects, by_instance)

    # --- Step 5: emit nodes ----------------------------------------------------
    nodes: list[dict] = []
    for obj in objects:
        if obj.get("id") in _NODE_IDS:
            nodes.append(_emit_node(obj))

    # --- Step 6: emit containers -----------------------------------------------
    containers: list[dict] = []
    for obj in objects:
        if obj.get("id") in _CONTAINER_IDS:
            containers.append(_emit_container(obj, by_instance))

    # --- Step 7: emit data flows -----------------------------------------------
    data_flows: list[dict] = []
    for obj in objects:
        if obj.get("id") == "data_flow":
            data_flows.append(_emit_data_flow(obj, latch_to_block))

    # --- Step 8: wrap result ---------------------------------------------------
    result: dict[str, Any] = {
        "nodes": nodes,
        "containers": containers,
        "data_flows": data_flows,
    }
    if meta is not None:
        result["meta"] = meta

    # --- Step 9: validate via pydantic (construction-only; return original) ----
    Diagram(**result)

    return result


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_latch_to_block(by_instance: dict[str, dict]) -> dict[str, str]:
    """Walk each node's anchors to map latch instance → block instance."""
    latch_to_block: dict[str, str] = {}
    for inst, obj in by_instance.items():
        if obj.get("id") not in _NODE_IDS:
            continue
        anchors: dict[str, str] = obj.get("anchors", {})
        if not isinstance(anchors, dict):
            raise InvalidNativeError(
                f"node {inst!r} has malformed anchors (expected dict, got {type(anchors).__name__})"
            )
        for _angle, anchor_inst in anchors.items():
            anchor_obj = by_instance.get(anchor_inst)
            if anchor_obj is None:
                # Anchor instance not present in objects — tolerate silently
                # (layout data may have been stripped).
                continue
            for latch_inst in anchor_obj.get("latches", []):
                latch_to_block[latch_inst] = inst
    return latch_to_block


def _find_canvas(objects: list[dict]) -> dict | None:
    """Return the canvas ("dfd") object, or None if absent."""
    for obj in objects:
        if obj.get("id") == "dfd":
            return obj
    return None


def _extract_meta(canvas: dict | None) -> dict | None:
    """Extract meta fields from the canvas object's properties list.

    Returns a dict (possibly with some keys omitted) or None if all four
    fields are null/missing.
    """
    if canvas is None:
        return None

    raw_props = {k: v for [k, v] in canvas.get("properties", [])}

    name = raw_props.get("name")
    description = raw_props.get("description")
    author = raw_props.get("author")
    created_raw = raw_props.get("created")

    created: str | None = None
    if isinstance(created_raw, dict):
        time_val = created_raw.get("time")
        if time_val:
            try:
                dt = datetime.fromisoformat(time_val)
            except ValueError as exc:
                raise InvalidNativeError(
                    f"canvas created.time {time_val!r} is not valid ISO-8601: {exc}"
                ) from exc
            created = dt.isoformat()
    elif isinstance(created_raw, str):
        # Already an ISO-8601 string (shouldn't happen in native, but be robust).
        created = created_raw

    if all(v is None for v in (name, description, author, created)):
        return None

    meta: dict[str, Any] = {}
    if name is not None:
        meta["name"] = name
    if description is not None:
        meta["description"] = description
    if author is not None:
        meta["author"] = author
    if created is not None:
        meta["created"] = created
    return meta


def _assert_single_parent(objects: list[dict], by_instance: dict[str, dict]) -> None:
    """Raise DuplicateParentError if any node/container GUID appears in two parents."""
    seen: dict[str, str] = {}  # guid → parent instance that first claimed it

    for obj in objects:
        parent_inst = obj.get("instance", "<unknown>")
        child_guids: list[str] = obj.get("objects", [])

        for guid in child_guids:
            # Only enforce the invariant for node/container GUIDs; scaffolding
            # objects should not appear in objects[] lists, but guard anyway.
            child = by_instance.get(guid)
            if child is None:
                continue
            if child.get("id") in _SCAFFOLDING_IDS:
                continue

            if guid in seen:
                raise DuplicateParentError(
                    f"GUID {guid!r} appears as a child of both {seen[guid]!r} and {parent_inst!r}"
                )
            seen[guid] = parent_inst


def _props_to_dict(properties: list, drop_nulls: bool = True) -> dict[str, Any]:
    """Convert a [[k, v], ...] properties list to a plain dict.

    When drop_nulls is True (default), entries where v is None are omitted.
    """
    result: dict[str, Any] = {}
    for pair in properties:
        k, v = pair[0], pair[1]
        if drop_nulls and v is None:
            continue
        result[k] = v
    return result


def _convert_string_bool(value: Any) -> bool | None:
    """Convert a native string-encoded boolean to a real bool, or None."""
    if value == "true":
        return True
    if value == "false":
        return False
    return None


def _emit_node(obj: dict) -> dict:
    """Emit a minimal node dict from a native node object."""
    node_id: str = obj["id"]
    instance: str = obj["instance"]
    props = _props_to_dict(obj.get("properties", []), drop_nulls=True)

    bool_keys = _BOOL_PROPS.get(node_id, frozenset())
    for key in bool_keys:
        if key in props:
            converted = _convert_string_bool(props[key])
            if converted is None:
                del props[key]
            else:
                props[key] = converted

    # Flatten assumptions: [[hash, text], ...] → [text, ...]
    if "assumptions" in props:
        raw_assumptions = props["assumptions"]
        if isinstance(raw_assumptions, list):
            flattened = []
            for entry in raw_assumptions:
                if isinstance(entry, list) and len(entry) == 2:
                    flattened.append(entry[1])
                elif isinstance(entry, str):
                    flattened.append(entry)
            props["assumptions"] = flattened
        # Empty list: keep as-is (will be validated by pydantic).

    return {"type": node_id, "guid": instance, "properties": props}


def _emit_container(obj: dict, by_instance: dict[str, dict]) -> dict:
    """Emit a minimal container dict from a native group object."""
    container_id: str = obj["id"]
    instance: str = obj["instance"]
    props = _props_to_dict(obj.get("properties", []), drop_nulls=True)

    # Filter children: keep only node/container GUIDs, drop scaffolding.
    raw_children: list[str] = obj.get("objects", [])
    children = [
        guid
        for guid in raw_children
        if by_instance.get(guid, {}).get("id") not in _SCAFFOLDING_IDS
    ]

    return {
        "type": container_id,
        "guid": instance,
        "properties": props,
        "children": children,
    }


def _emit_data_flow(obj: dict, latch_to_block: dict[str, str]) -> dict:
    """Emit a minimal data_flow dict from a native data_flow object."""
    instance: str = obj["instance"]

    source_latch: str = obj.get("source", "")
    target_latch: str = obj.get("target", "")

    source_block = latch_to_block.get(source_latch)
    if source_block is None:
        raise InvalidNativeError(
            f"data_flow {instance!r}: source latch {source_latch!r} is not attached to any block"
        )

    target_block = latch_to_block.get(target_latch)
    if target_block is None:
        raise InvalidNativeError(
            f"data_flow {instance!r}: target latch {target_latch!r} is not attached to any block"
        )

    raw_props = _props_to_dict(obj.get("properties", []), drop_nulls=True)

    # Build minimal properties dict.
    flow_props: dict[str, Any] = {}

    name = raw_props.get("name")
    if name is not None:
        flow_props["name"] = name

    data_class = raw_props.get("data_classification")
    if data_class is not None:
        flow_props["data_classification"] = data_class

    protocol = raw_props.get("protocol")
    if protocol is not None:
        flow_props["protocol"] = protocol

    # authenticated — string bool → real bool (default False if absent).
    authenticated_raw = raw_props.get("authenticated", "false")
    flow_props["authenticated"] = _convert_string_bool(authenticated_raw) or False

    # encrypted_in_transit → encrypted.
    encrypted_raw = raw_props.get("encrypted_in_transit", "false")
    flow_props["encrypted"] = _convert_string_bool(encrypted_raw) or False

    return {
        "guid": instance,
        "source": source_block,
        "target": target_block,
        "properties": flow_props,
    }
