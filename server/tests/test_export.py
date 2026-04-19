"""Tests for the native→minimal export transformer."""

from __future__ import annotations

import json
import pathlib

import pytest

from schema import Diagram
from transform import DuplicateParentError, InvalidNativeError, to_minimal

_DATA_DIR = pathlib.Path(__file__).parent.parent / "data"
_EXAMPLE_FILE = _DATA_DIR / "bdf1c563-0a37-41fd-b0e6-d146d2cb49a7.json"


# ---------------------------------------------------------------------------
# 1. Real fixture round-trip
# ---------------------------------------------------------------------------


def test_to_minimal_real_fixture():
    native = json.loads(_EXAMPLE_FILE.read_text())
    result = to_minimal(native)

    # Must parse as Diagram without error.
    diagram = Diagram(**result)

    # At least one node.
    assert len(diagram.nodes) >= 1

    # meta.name is preserved.
    assert diagram.meta is not None
    assert diagram.meta.name == "TALA Layout Test"

    # Every data_flow source/target must be a guid present in nodes.
    node_guids = {str(n.guid) for n in diagram.nodes}
    for flow in diagram.data_flows:
        assert str(flow.source) in node_guids, (
            f"data_flow {flow.guid}: source {flow.source} not in nodes"
        )
        assert str(flow.target) in node_guids, (
            f"data_flow {flow.guid}: target {flow.target} not in nodes"
        )


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
    """Craft a native dict where a data_flow's source latch isn't in any anchor."""
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
                ],
                "source": orphan_latch,   # not attached to any anchor
                "target": real_latch,
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
