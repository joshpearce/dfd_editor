"""Transformer: native dfd_v1 format ↔ minimal JSON format."""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any

from schema import DataItem, Diagram

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

# Property keys that are boolean in native format, per node type.
# These must be emitted as "true"/"false" strings (not JSON booleans).
_NATIVE_BOOL_PROPS: dict[str, tuple[str, ...]] = {
    "process": (),
    "external_entity": ("out_of_scope",),
    "data_store": ("contains_pii", "encryption_at_rest"),
}

# Ordered property keys per node type (must match DfdObjects.ts template order).
_NODE_PROP_ORDER: dict[str, tuple[str, ...]] = {
    "process": ("name", "description", "trust_level", "assumptions"),
    "external_entity": ("name", "description", "entity_type", "out_of_scope"),
    "data_store": ("name", "description", "storage_type", "contains_pii", "encryption_at_rest"),
}

# Ordered property keys per container type.
_CONTAINER_PROP_ORDER: dict[str, tuple[str, ...]] = {
    "trust_boundary": ("name", "description", "privilege_level"),
    "container": ("name", "description"),
}

# Ordered property keys for data flows.
_FLOW_PROP_ORDER: tuple[str, ...] = (
    "name",
    "protocol",
    "authenticated",
    "encrypted_in_transit",
    "node1_src_data_item_refs",
    "node2_src_data_item_refs",
)

# Ordered property keys for the canvas (dfd) object.
# Note: "data_items" is intentionally absent from this tuple. It is a
# ListProperty<DictionaryProperty> in OpenChart, so it serializes as a
# [[id, [[k,v],...]],...] list-of-pairs — a distinct shape from the simple
# [key, scalar] pairs handled by the table-driven loop. It is emitted
# separately in _build_canvas_props.
_CANVAS_PROP_ORDER: tuple[str, ...] = ("name", "description", "author", "created")

# Anchor angle → anchor type mapping (12 anchors at 30° steps).
_ANCHOR_TYPES: dict[int, str] = {
    0: "horizontal_anchor",
    30: "horizontal_anchor",
    60: "vertical_anchor",
    90: "vertical_anchor",
    120: "vertical_anchor",
    150: "horizontal_anchor",
    180: "horizontal_anchor",
    210: "horizontal_anchor",
    240: "vertical_anchor",
    270: "vertical_anchor",
    300: "vertical_anchor",
    330: "horizontal_anchor",
}


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

    # --- Step 8: extract data_items from canvas properties -------------------
    # data_items are stored inside the canvas object's properties list (key
    # "data_items") so they survive the OpenChart native round-trip.  When Step
    # 2 adds data_items as a ListProperty on the canvas, the engine serialises
    # it into the same canvas properties array automatically.
    data_items: list[dict] = _extract_canvas_data_items(canvas)

    # --- Step 9: wrap result ---------------------------------------------------
    result: dict[str, Any] = {
        "nodes": nodes,
        "containers": containers,
        "data_flows": data_flows,
    }
    if meta is not None:
        result["meta"] = meta
    if data_items:
        result["data_items"] = data_items

    # --- Step 10: validate via pydantic (construction-only; return original) ---
    Diagram.model_validate(result)

    return result


def to_native(minimal: dict) -> dict:
    """Transform a minimal JSON document into a native dfd_v1 document.

    Args:
        minimal: Parsed minimal format dict.

    Returns:
        Native dfd_v1 dict ready for persistence (no layout/camera/groupBounds).

    Raises:
        pydantic.ValidationError: The minimal doc fails schema validation.
        DuplicateParentError: A GUID appears in two containers' children lists.
    """
    # --- Step 1: validate via pydantic -----------------------------------------
    diagram = Diagram(**minimal)

    # --- Step 2: assert single-parent on minimal containers --------------------
    _assert_single_parent_minimal(diagram)

    # --- Step 3: compute top-level children ------------------------------------
    all_child_guids: set[str] = set()
    for c in diagram.containers:
        for child in c.children:
            all_child_guids.add(str(child))

    top_level_guids: list[str] = []
    # Containers first, then nodes, then data flows (deterministic order).
    # Data flows whose GUID isn't listed in any container's children must be
    # parented under the canvas; otherwise the engine treats them as extra
    # roots and refuses to load the file.
    for c in diagram.containers:
        if str(c.guid) not in all_child_guids:
            top_level_guids.append(str(c.guid))
    for n in diagram.nodes:
        if str(n.guid) not in all_child_guids:
            top_level_guids.append(str(n.guid))
    for f in diagram.data_flows:
        if str(f.guid) not in all_child_guids:
            top_level_guids.append(str(f.guid))

    objects: list[dict] = []

    # --- Step 4: canvas object -------------------------------------------------
    meta = diagram.meta
    canvas_props = _build_canvas_props(meta, diagram.data_items)
    canvas_instance = str(uuid.uuid4())
    objects.append(
        {
            "id": "dfd",
            "instance": canvas_instance,
            "properties": canvas_props,
            "objects": top_level_guids,
        }
    )

    # --- Step 5: container objects ---------------------------------------------
    for c in diagram.containers:
        container_props = _build_container_props(c)
        objects.append(
            {
                "id": str(c.type),
                "instance": str(c.guid),
                "properties": container_props,
                "objects": [str(child) for child in c.children],
            }
        )

    # angle_zero_anchors: block_guid → anchor object (mutable reference for latch attachment)
    angle_zero_anchors: dict[str, dict] = {}

    # --- Step 6: node objects + their 12 anchor objects ------------------------
    for n in diagram.nodes:
        block_guid = str(n.guid)
        node_type = str(n.type)

        # Mint 12 anchor instance UUIDs
        anchor_instances: dict[int, str] = {angle: str(uuid.uuid4()) for angle in _ANCHOR_TYPES}

        # Build anchor map (angle string → instance uuid)
        anchors_map: dict[str, str] = {str(angle): inst for angle, inst in anchor_instances.items()}

        node_props = _build_node_props(n)
        objects.append(
            {
                "id": node_type,
                "instance": block_guid,
                "properties": node_props,
                "anchors": anchors_map,
            }
        )

        # Emit 12 anchor objects; keep reference to angle-0 for latch attachment
        for angle, anchor_inst in anchor_instances.items():
            anchor_obj: dict = {
                "id": _ANCHOR_TYPES[angle],
                "instance": anchor_inst,
                "latches": [],
            }
            objects.append(anchor_obj)
            if angle == 0:
                angle_zero_anchors[block_guid] = anchor_obj

    # --- Step 7: data flow objects + latches + handles ------------------------
    for flow in diagram.data_flows:
        flow_guid = str(flow.guid)
        node1_block = str(flow.node1)
        node2_block = str(flow.node2)

        node1_latch_inst = str(uuid.uuid4())
        node2_latch_inst = str(uuid.uuid4())
        handle_inst = str(uuid.uuid4())

        # Attach latches to angle-0 anchors of node1/node2 blocks
        node1_anchor = angle_zero_anchors.get(node1_block)
        if node1_anchor is not None:
            node1_anchor["latches"].append(node1_latch_inst)

        node2_anchor = angle_zero_anchors.get(node2_block)
        if node2_anchor is not None:
            node2_anchor["latches"].append(node2_latch_inst)

        flow_props = _build_flow_props(flow)
        objects.append(
            {
                "id": "data_flow",
                "instance": flow_guid,
                "properties": flow_props,
                "node1": node1_latch_inst,
                "node2": node2_latch_inst,
                "handles": [handle_inst],
            }
        )
        objects.append({"id": "generic_latch", "instance": node1_latch_inst})
        objects.append({"id": "generic_latch", "instance": node2_latch_inst})
        objects.append({"id": "generic_handle", "instance": handle_inst})

    return {"schema": "dfd_v1", "theme": "dark_theme", "objects": objects}


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
                # Anchor instance referenced by this block is not present in
                # objects[] — this is a structural invariant violation.
                raise InvalidNativeError(
                    f"block {inst} references missing anchor {anchor_inst}"
                )
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

    raw_pairs = canvas.get("properties", [])
    try:
        raw_props = {pair[0]: pair[1] for pair in raw_pairs if len(pair) == 2}
        if any(len(pair) != 2 for pair in raw_pairs):
            raise InvalidNativeError("canvas properties malformed: expected [key, value] pairs")
    except TypeError:
        raise InvalidNativeError("canvas properties malformed: expected [key, value] pairs")

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


def _extract_canvas_data_items(canvas: dict | None) -> list[dict]:
    """Extract data_items from the canvas object's properties list.

    The on-disk shape for data_items is the OpenChart ListProperty<DictionaryProperty>
    serialization: [[itemId, [[k, v], ...]], ...] — a list of [id, sub-pairs] pairs.

    Returns an empty list when the canvas is absent or has no data_items entry.
    Raises InvalidNativeError if the stored value is present but malformed —
    structural violations surface here, not silently swallowed.
    """
    if canvas is None:
        return []
    raw_pairs = canvas.get("properties", [])
    try:
        raw_props = _props_to_dict(raw_pairs, drop_nulls=False)
    except InvalidNativeError as exc:
        raise InvalidNativeError("canvas properties malformed: expected [key, value] pairs") from exc

    raw_items = raw_props.get("data_items")
    if raw_items is None:
        return []
    if not isinstance(raw_items, list):
        raise InvalidNativeError(
            "canvas data_items is malformed: expected a list of [id, [[k,v],...]] pairs"
        )

    result: list[dict] = []
    for entry in raw_items:
        # Each entry must be [id_str, sub_pairs_list].
        if not isinstance(entry, list) or len(entry) != 2:
            raise InvalidNativeError(
                "canvas data_items entry is malformed: expected [id, [[k,v],...]]"
            )
        id_str, sub_pairs = entry[0], entry[1]
        if not isinstance(id_str, str):
            raise InvalidNativeError(
                "canvas data_items entry id must be a string"
            )
        if not isinstance(sub_pairs, list):
            raise InvalidNativeError(
                f"canvas data_items entry {id_str!r}: sub-pairs must be a list"
            )
        try:
            sub = _props_to_dict(sub_pairs, drop_nulls=True)
        except InvalidNativeError as exc:
            raise InvalidNativeError(
                f"canvas data_items entry {id_str!r}: {exc}"
            ) from exc

        # Guard: the outer id_str IS the guid; a nested "guid" key is
        # structurally wrong — _data_item_to_pairs never emits one, and
        # accepting it would silently shadow the outer id.
        if "guid" in sub:
            raise InvalidNativeError(
                f"canvas data_items entry {id_str!r}: sub-dict must not contain "
                "a 'guid' key — the outer list-entry id is the item guid"
            )

        item: dict = {"guid": id_str}
        item.update(sub)
        # Treat empty-string parent (frontend's "(unowned)" wire value) as absent.
        # The DataItem schema accepts parent=None; pydantic rejects an empty string
        # as an invalid UUID.
        if item.get("parent") == "":
            del item["parent"]
        result.append(item)

    return result


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

    Raises InvalidNativeError if any entry is not a length-2 sequence.
    """
    result: dict[str, Any] = {}
    for pair in properties:
        try:
            if len(pair) != 2:
                raise InvalidNativeError(
                    "canvas properties malformed: expected [key, value] pairs"
                )
        except TypeError:
            raise InvalidNativeError(
                "canvas properties malformed: expected [key, value] pairs"
            )
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

    node1_latch: str = obj.get("node1", "")
    node2_latch: str = obj.get("node2", "")

    node1_block = latch_to_block.get(node1_latch)
    if node1_block is None:
        raise InvalidNativeError(
            f"data_flow {instance!r}: node1 latch {node1_latch!r} is not attached to any block"
        )

    node2_block = latch_to_block.get(node2_latch)
    if node2_block is None:
        raise InvalidNativeError(
            f"data_flow {instance!r}: node2 latch {node2_latch!r} is not attached to any block"
        )

    raw_props = _props_to_dict(obj.get("properties", []), drop_nulls=True)

    # Build minimal properties dict.
    flow_props: dict[str, Any] = {}

    name = raw_props.get("name")
    if name is not None:
        flow_props["name"] = name

    protocol = raw_props.get("protocol")
    if protocol is not None:
        flow_props["protocol"] = protocol

    # authenticated — string bool → real bool; drop key if raw value is not
    # "true"/"false" (or absent), letting the Diagram default take effect.
    # Emit both True and explicit False values (AC2.3 requires round-trip preservation).
    authenticated_raw = raw_props.get("authenticated")
    if authenticated_raw is not None:
        converted = _convert_string_bool(authenticated_raw)
        if converted is not None:
            flow_props["authenticated"] = converted

    # encrypted_in_transit → encrypted; same defensiveness as authenticated.
    # Emit both True and explicit False values (AC2.3 requires round-trip preservation).
    encrypted_raw = raw_props.get("encrypted_in_transit")
    if encrypted_raw is not None:
        converted = _convert_string_bool(encrypted_raw)
        if converted is not None:
            flow_props["encrypted"] = converted

    # Recover node1_src_data_item_refs from native properties (AC2.4).
    # Native shape: [[syntheticKey, guidStr], ...] — a ListProperty wire format.
    # Only accept [[key, guidStr], ...]; plain strings are a hard error (no legacy tolerance).
    # AC2.4 requires both arrays to be emitted even when empty so empty-both-sides
    # flows survive the round-trip and appear in the exported output.
    node1_refs_raw = raw_props.get("node1_src_data_item_refs")
    node1_ref_guids = []
    if node1_refs_raw:
        for entry in node1_refs_raw:
            if not isinstance(entry, list) or len(entry) != 2:
                raise InvalidNativeError(
                    f"data_item_refs entry is not [key, guid]: {entry!r}"
                )
            guid_str = entry[1]
            if isinstance(guid_str, str):
                node1_ref_guids.append(uuid.UUID(guid_str))
            elif isinstance(guid_str, uuid.UUID):
                node1_ref_guids.append(guid_str)
    flow_props["node1_src_data_item_refs"] = node1_ref_guids

    # Recover node2_src_data_item_refs from native properties.
    node2_refs_raw = raw_props.get("node2_src_data_item_refs")
    node2_ref_guids = []
    if node2_refs_raw:
        for entry in node2_refs_raw:
            if not isinstance(entry, list) or len(entry) != 2:
                raise InvalidNativeError(
                    f"data_item_refs entry is not [key, guid]: {entry!r}"
                )
            guid_str = entry[1]
            if isinstance(guid_str, str):
                node2_ref_guids.append(uuid.UUID(guid_str))
            elif isinstance(guid_str, uuid.UUID):
                node2_ref_guids.append(guid_str)
    flow_props["node2_src_data_item_refs"] = node2_ref_guids

    return {
        "guid": instance,
        "node1": node1_block,
        "node2": node2_block,
        "properties": flow_props,
    }


def _assert_single_parent_minimal(diagram: Diagram) -> None:
    """Raise DuplicateParentError if any GUID appears in two containers' children."""
    seen: dict[str, str] = {}
    for c in diagram.containers:
        parent_guid = str(c.guid)
        for child in c.children:
            child_str = str(child)
            if child_str in seen:
                raise DuplicateParentError(
                    f"GUID {child_str!r} appears as a child of both {seen[child_str]!r} and {parent_guid!r}"
                )
            seen[child_str] = parent_guid


def _bool_to_native(value: bool) -> str:
    """Convert a Python bool to a native string-encoded boolean."""
    return "true" if value else "false"


def _data_item_to_pairs(item: DataItem) -> list[list]:
    """Emit data-item properties as pairs.

    `parent` is emitted only when set; `description` similarly.
    `classification` is always present (closed enum, required on `DataItem`).
    """
    pairs: list[list] = []
    if item.parent is not None:
        pairs.append(["parent", str(item.parent)])
    pairs.extend([
        ["identifier", item.identifier],
        ["name", item.name],
    ])
    if item.description is not None:
        pairs.append(["description", item.description])
    pairs.append(["classification", str(item.classification)])
    return pairs


def _build_canvas_props(meta: Any, data_items: list[DataItem] | None = None) -> list[list]:
    """Build the canvas (dfd) object's properties list from the meta model.

    data_items are stored inside the canvas object's properties list using the
    OpenChart ListProperty<DictionaryProperty> serialization shape:
        ["data_items", [[itemGuid, [[k, v], ...]], ...]]
    This allows OpenChart's generic property serializer to round-trip them
    without loss when Step 2 adds data_items as a ListProperty on the canvas.

    The item guid is used as the outer list-item key (it is stable and unique).
    """
    name = meta.name if meta else None
    description = meta.description if meta else None
    author = meta.author if meta else None
    created_dt = meta.created if meta else None

    created_val: Any = None
    if created_dt is not None:
        iso = created_dt.isoformat()
        # Determine zone name: prefer tzname() if it returns something useful,
        # otherwise fall back to "UTC".
        tz_name = created_dt.tzname() if created_dt.tzinfo is not None else None
        if not tz_name or tz_name in ("+00:00", "UTC", "UTC+00:00"):
            tz_name = "UTC"
        created_val = {"time": iso, "zone": tz_name}

    props: list[list] = [
        ["name", name],
        ["description", description],
        ["author", author],
        ["created", created_val],
    ]
    if data_items:
        # Emit as [[itemGuid, [[k,v],...]], ...] — the OpenChart
        # ListProperty<DictionaryProperty> wire shape.
        native_items = [
            [str(item.guid), _data_item_to_pairs(item)]
            for item in data_items
        ]
        props.append(["data_items", native_items])
    return props


def _build_container_props(container: Any) -> list[list]:
    """Build a container object's properties list in template declaration order."""
    container_type = str(container.type)
    prop_order = _CONTAINER_PROP_ORDER[container_type]
    props = container.properties
    result: list[list] = []
    for key in prop_order:
        val = getattr(props, key, None)
        if val is None:
            result.append([key, None])
        else:
            result.append([key, str(val)])
    return result


def _build_node_props(node: Any) -> list[list]:
    """Build a node object's properties list in template declaration order."""
    node_type = str(node.type)
    prop_order = _NODE_PROP_ORDER[node_type]
    bool_keys = _NATIVE_BOOL_PROPS[node_type]
    props = node.properties
    result: list[list] = []
    for key in prop_order:
        val = getattr(props, key, None)
        if key == "assumptions":
            # Convert list[str] → [[hash, str], ...]; use uuid hex as opaque hash.
            if val is None:
                result.append([key, []])
            else:
                native_assumptions = [
                    [hashlib.sha256(s.encode("utf-8")).hexdigest()[:32], s]
                    for s in val
                ]
                result.append([key, native_assumptions])
        elif key in bool_keys:
            # Always emit as string bool, defaulting to "false".
            bool_val = val if val is not None else False
            result.append([key, _bool_to_native(bool_val)])
        else:
            if val is None:
                result.append([key, None])
            else:
                result.append([key, str(val)])
    return result


def _build_flow_props(flow: Any) -> list[list]:
    """Build a data_flow object's properties list in template declaration order."""
    props = flow.properties
    result: list[list] = []
    for key in _FLOW_PROP_ORDER:
        if key == "encrypted_in_transit":
            # External field is "encrypted"; native is "encrypted_in_transit"
            val = props.encrypted
            result.append([key, _bool_to_native(val if val is not None else False)])
        elif key == "authenticated":
            val = props.authenticated
            result.append([key, _bool_to_native(val if val is not None else False)])
        elif key == "node1_src_data_item_refs":
            # Emit in the OpenChart ListProperty<StringProperty> wire shape:
            # [[syntheticKey, guidStr], ...].  This mirrors
            # CollectionProperty.toOrderedJson() so that DfdFilePreprocessor
            # can be pass-through and the frontend factory receives the shape it
            # expects without any normalization step.
            pairs = [
                [str(uuid.uuid4()), str(ref)]
                for ref in props.node1_src_data_item_refs
            ]
            result.append([key, pairs])
        elif key == "node2_src_data_item_refs":
            # Same wire shape as node1_src_data_item_refs.
            pairs = [
                [str(uuid.uuid4()), str(ref)]
                for ref in props.node2_src_data_item_refs
            ]
            result.append([key, pairs])
        else:
            val = getattr(props, key, None)
            if val is None:
                result.append([key, None])
            else:
                result.append([key, str(val)])
    return result
