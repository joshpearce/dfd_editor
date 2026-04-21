"""Tests for the native→minimal export transformer."""

from __future__ import annotations

import pytest

from schema import Diagram
from transform import DuplicateParentError, InvalidNativeError, to_minimal


# ---------------------------------------------------------------------------
# 1. Synthetic round-trip
# ---------------------------------------------------------------------------


def test_to_minimal_synthetic_fixture():
    """Round-trip a synthetic native document with bidirectional flow shape."""
    # Fixed UUIDs for determinism
    process_guid = "11111111-0000-0000-0000-000000000001"
    external_guid = "22222222-0000-0000-0000-000000000002"
    flow_guid = "33333333-0000-0000-0000-000000000003"
    data_item_guid = "44444444-0000-0000-0000-000000000004"
    canvas_inst = "55555555-0000-0000-0000-000000000005"
    p_anchor_0 = "66666666-0000-0000-0000-000000000001"
    e_anchor_0 = "77777777-0000-0000-0000-000000000001"
    node1_latch = "88888888-0000-0000-0000-000000000008"
    node2_latch = "99999999-0000-0000-0000-000000000009"
    handle_inst = "aaaaaaaa-0000-0000-0000-000000000010"

    # Build complete anchor set (12 anchors per node)
    p_anchors = {str(angle): f"66666666-0000-{angle:04d}-0000-000000000001" for angle in range(0, 360, 30)}
    e_anchors = {str(angle): f"77777777-0000-{angle:04d}-0000-000000000001" for angle in range(0, 360, 30)}

    # Build anchor objects list
    anchor_objects = []
    for angle in range(0, 360, 30):
        is_horizontal = angle in (0, 30, 150, 180, 210, 330)
        anchor_objects.append({
            "id": "horizontal_anchor" if is_horizontal else "vertical_anchor",
            "instance": p_anchors[str(angle)],
            "latches": [node1_latch] if angle == 0 else [],
        })
    for angle in range(0, 360, 30):
        is_horizontal = angle in (0, 30, 150, 180, 210, 330)
        anchor_objects.append({
            "id": "horizontal_anchor" if is_horizontal else "vertical_anchor",
            "instance": e_anchors[str(angle)],
            "latches": [node2_latch] if angle == 0 else [],
        })

    native = {
        "schema": "dfd_v1",
        "theme": "dark_theme",
        "objects": [
            {
                "id": "dfd",
                "instance": canvas_inst,
                "properties": [
                    ["name", "Test"],
                    ["description", None],
                    ["author", None],
                    ["created", None],
                    ["data_items", [
                        [data_item_guid, [["identifier", "item1"], ["name", "Data Item 1"], ["parent", process_guid]]]
                    ]],
                ],
                "objects": [process_guid, external_guid, flow_guid],
            },
            {
                "id": "process",
                "instance": process_guid,
                "properties": [
                    ["name", "Process A"],
                    ["description", None],
                    ["trust_level", None],
                    ["assumptions", []],
                ],
                "anchors": p_anchors,
            },
            {
                "id": "external_entity",
                "instance": external_guid,
                "properties": [
                    ["name", "External B"],
                    ["description", None],
                    ["entity_type", None],
                    ["out_of_scope", "false"],
                ],
                "anchors": e_anchors,
            },
            {
                "id": "data_flow",
                "instance": flow_guid,
                "properties": [
                    ["name", "My Flow"],
                    ["data_classification", "confidential"],
                    ["protocol", "gRPC"],
                    ["authenticated", "true"],
                    ["encrypted_in_transit", "true"],
                    ["node1_src_data_item_refs", [["key1", data_item_guid]]],
                    ["node2_src_data_item_refs", []],
                ],
                "node1": node1_latch,
                "node2": node2_latch,
                "handles": [handle_inst],
            },
            {
                "id": "generic_latch",
                "instance": node1_latch,
            },
            {
                "id": "generic_latch",
                "instance": node2_latch,
            },
            {
                "id": "generic_handle",
                "instance": handle_inst,
            },
            *anchor_objects,
        ],
    }

    result = to_minimal(native)

    # Must parse as Diagram without error.
    diagram = Diagram(**result)

    # At least one node.
    assert len(diagram.nodes) >= 2

    # meta.name is preserved.
    assert diagram.meta is not None
    assert diagram.meta.name == "Test"

    # Every data_flow node1/node2 must be a guid present in nodes.
    node_guids = {str(n.guid) for n in diagram.nodes}
    for flow in diagram.data_flows:
        assert str(flow.node1) in node_guids, (
            f"data_flow {flow.guid}: node1 {flow.node1} not in nodes"
        )
        assert str(flow.node2) in node_guids, (
            f"data_flow {flow.guid}: node2 {flow.node2} not in nodes"
        )

    # Check that ref arrays are preserved
    flow = diagram.data_flows[0]
    assert len(flow.properties.node1_src_data_item_refs) == 1
    assert str(flow.properties.node1_src_data_item_refs[0]) == data_item_guid
    assert len(flow.properties.node2_src_data_item_refs) == 0


# ---------------------------------------------------------------------------
# 2. Duplicate-parent invariant
# ---------------------------------------------------------------------------


def _minimal_native_with_dup_parent() -> dict:
    """Craft a native dict where the same node GUID appears in two groups."""
    shared_block_guid = "aaaaaaaa-0000-0000-0000-000000000001"
    group1_guid = "bbbbbbbb-0000-0000-0000-000000000002"
    group2_guid = "cccccccc-0000-0000-0000-000000000003"

    return {
        "schema": "dfd_v1",
        "theme": "dark_theme",
        "objects": [
            {
                "id": "dfd",
                "instance": "dddddddd-0000-0000-0000-000000000004",
                "properties": [],
                "objects": [group1_guid, group2_guid],
            },
            {
                "id": "trust_boundary",
                "instance": group1_guid,
                "properties": [["name", "Group 1"], ["description", None], ["privilege_level", None]],
                "objects": [shared_block_guid],
            },
            {
                "id": "trust_boundary",
                "instance": group2_guid,
                "properties": [["name", "Group 2"], ["description", None], ["privilege_level", None]],
                "objects": [shared_block_guid],
            },
            {
                "id": "process",
                "instance": shared_block_guid,
                "properties": [
                    ["name", "Shared"],
                    ["description", None],
                    ["trust_level", None],
                    ["assumptions", []],
                ],
                "anchors": {str(a): f"eeeeeeee-0000-{a:04d}-0000-000000000000" for a in range(0, 360, 30)},
            },
            # Anchor objects for the shared block (required by I4 validation).
            *[
                {
                    "id": "horizontal_anchor" if a in (0, 30, 150, 180, 210, 330) else "vertical_anchor",
                    "instance": f"eeeeeeee-0000-{a:04d}-0000-000000000000",
                    "latches": [],
                }
                for a in range(0, 360, 30)
            ],
        ],
    }


def test_duplicate_parent_raises():
    native = _minimal_native_with_dup_parent()
    with pytest.raises(DuplicateParentError):
        to_minimal(native)


# ---------------------------------------------------------------------------
# 3. Unknown latch raises InvalidNativeError
# ---------------------------------------------------------------------------


def _native_with_orphan_latch() -> dict:
    """Craft a native dict where a data_flow's node1 latch isn't in any anchor."""
    block_guid = "aaaaaaaa-1111-0000-0000-000000000001"
    flow_guid = "aaaaaaaa-1111-0000-0000-000000000002"
    orphan_latch = "aaaaaaaa-1111-0000-0000-000000000003"
    real_latch = "aaaaaaaa-1111-0000-0000-000000000004"
    handle_guid = "aaaaaaaa-1111-0000-0000-000000000005"

    anchors = {str(a): f"eeeeeeee-1111-{a:04d}-0000-000000000000" for a in range(0, 360, 30)}
    anchor_objects = [
        {
            "id": "horizontal_anchor" if angle in (0, 30, 150, 180, 210, 330) else "vertical_anchor",
            "instance": anchors[str(angle)],
            "latches": [real_latch] if angle == 0 else [],
        }
        for angle in range(0, 360, 30)
    ]

    return {
        "schema": "dfd_v1",
        "theme": "dark_theme",
        "objects": [
            {
                "id": "dfd",
                "instance": "dddddddd-1111-0000-0000-000000000004",
                "properties": [],
                "objects": [block_guid, flow_guid],
            },
            {
                "id": "process",
                "instance": block_guid,
                "properties": [
                    ["name", "A"],
                    ["description", None],
                    ["trust_level", None],
                    ["assumptions", []],
                ],
                "anchors": anchors,
            },
            *anchor_objects,
            {
                "id": "generic_latch",
                "instance": real_latch,
            },
            {
                "id": "data_flow",
                "instance": flow_guid,
                "properties": [
                    ["name", None],
                    ["data_classification", None],
                    ["protocol", None],
                    ["authenticated", "false"],
                    ["encrypted_in_transit", "false"],
                    ["node1_src_data_item_refs", []],
                    ["node2_src_data_item_refs", []],
                ],
                "node1": orphan_latch,  # not attached to any anchor
                "node2": real_latch,
                "handles": [handle_guid],
            },
            {
                "id": "generic_handle",
                "instance": handle_guid,
            },
        ],
    }


def test_orphan_latch_raises():
    native = _native_with_orphan_latch()
    with pytest.raises(InvalidNativeError):
        to_minimal(native)
