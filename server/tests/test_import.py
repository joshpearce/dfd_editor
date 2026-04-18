"""Tests for the minimal→native import transformer (to_native)."""

from __future__ import annotations

import copy

import pytest

from transform import DuplicateParentError, to_minimal, to_native


# ---------------------------------------------------------------------------
# Hand-crafted minimal document covering every template type
# ---------------------------------------------------------------------------

# Fixed UUIDs used across the fixture so the round-trip is deterministic.
_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_EXTERNAL_GUID = "22222222-0000-0000-0000-000000000002"
_DATA_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_TRUST_BOUNDARY_GUID = "44444444-0000-0000-0000-000000000004"
_CONTAINER_GUID = "55555555-0000-0000-0000-000000000005"
_FLOW_1_GUID = "66666666-0000-0000-0000-000000000006"
_FLOW_2_GUID = "77777777-0000-0000-0000-000000000007"

# The container nesting:
#   trust_boundary contains: [process, external_entity, container]
#   container contains:      [data_store]
#   top-level:               [trust_boundary, flow_1, flow_2] (flows are top-level in native via canvas objects[])
#
# Note: data_flows are children of the canvas objects[] in native, but in minimal
# format they are top-level lists, not children of any container.  The containers'
# children lists contain only node/container GUIDs.

_MINIMAL_DOC: dict = {
    "meta": {
        "name": "Round-trip test diagram",
        "description": "Test description",
        "author": "Test Author",
        "created": "2026-01-15T12:00:00",
    },
    "nodes": [
        {
            "type": "process",
            "guid": _PROCESS_GUID,
            "properties": {
                "name": "My Process",
                "number": "1",
                "trust_level": "admin",
                "assumptions": ["assumption A", "assumption B"],
            },
        },
        {
            "type": "external_entity",
            "guid": _EXTERNAL_GUID,
            "properties": {
                "name": "My External",
                "entity_type": "user",
                "out_of_scope": True,
            },
        },
        {
            "type": "data_store",
            "guid": _DATA_STORE_GUID,
            "properties": {
                "name": "My Store",
                "storage_type": "database",
                "contains_pii": True,
                "encryption_at_rest": True,
            },
        },
    ],
    "containers": [
        {
            "type": "trust_boundary",
            "guid": _TRUST_BOUNDARY_GUID,
            "properties": {
                "name": "Trust Boundary",
                "privilege_level": "restricted",
            },
            "children": [_PROCESS_GUID, _EXTERNAL_GUID, _CONTAINER_GUID],
        },
        {
            "type": "container",
            "guid": _CONTAINER_GUID,
            "properties": {
                "name": "Inner Container",
            },
            "children": [_DATA_STORE_GUID],
        },
    ],
    "data_flows": [
        {
            "guid": _FLOW_1_GUID,
            "source": _PROCESS_GUID,
            "target": _DATA_STORE_GUID,
            "properties": {
                "name": "Write Flow",
                "data_classification": "confidential",
                "protocol": "gRPC",
                "authenticated": True,
                "encrypted": True,
            },
        },
        {
            "guid": _FLOW_2_GUID,
            "source": _EXTERNAL_GUID,
            "target": _PROCESS_GUID,
            "properties": {
                "authenticated": False,
                "encrypted": False,
            },
        },
    ],
}


# ---------------------------------------------------------------------------
# Canonicalization helper for order-insensitive comparison
# ---------------------------------------------------------------------------


def _canonicalize(doc: dict) -> dict:
    """Return a copy of the minimal doc with all lists sorted by guid for comparison."""
    result = copy.deepcopy(doc)

    def sort_key(item: dict) -> str:
        return str(item.get("guid", ""))

    for key in ("nodes", "containers", "data_flows"):
        if key in result:
            result[key] = sorted(result[key], key=sort_key)

    # Sort children within each container by guid string
    for container in result.get("containers", []):
        if "children" in container:
            container["children"] = sorted(container["children"])

    # Normalize assumptions order within process nodes (to_native/to_minimal preserves
    # list order, so this is only needed if our fixture has a deterministic order already)

    return result


# ---------------------------------------------------------------------------
# Test 1: Round-trip to_minimal(to_native(m)) == m
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_round_trip_full_document(self):
        """to_minimal(to_native(m)) == m for a doc covering all template types."""
        native = to_native(_MINIMAL_DOC)
        back = to_minimal(native)

        assert _canonicalize(back) == _canonicalize(_MINIMAL_DOC)

    def test_round_trip_empty_document(self):
        """Empty diagram (no nodes/containers/flows) round-trips."""
        minimal = {"nodes": [], "containers": [], "data_flows": []}
        native = to_native(minimal)
        back = to_minimal(native)
        assert back == {"nodes": [], "containers": [], "data_flows": []}

    def test_round_trip_no_meta(self):
        """Document without meta round-trips (meta absent from both sides).

        Note: assumptions: None collapses to assumptions: [] on round-trip because
        the native template always stores an empty list for absent assumptions.
        We supply [] explicitly so the comparison holds.
        """
        doc = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P", "assumptions": []},
                }
            ],
            "containers": [],
            "data_flows": [],
        }
        native = to_native(doc)
        back = to_minimal(native)
        assert _canonicalize(back) == _canonicalize(doc)


# ---------------------------------------------------------------------------
# Test 2: DuplicateParentError raised before any transform
# ---------------------------------------------------------------------------


class TestDuplicateParentError:
    def test_guid_in_two_containers_raises(self):
        """A GUID listed in two containers' children raises DuplicateParentError."""
        doc = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                }
            ],
            "containers": [
                {
                    "type": "trust_boundary",
                    "guid": _TRUST_BOUNDARY_GUID,
                    "properties": {"name": "TB1"},
                    "children": [_PROCESS_GUID],
                },
                {
                    "type": "container",
                    "guid": _CONTAINER_GUID,
                    "properties": {"name": "C1"},
                    "children": [_PROCESS_GUID],  # duplicate!
                },
            ],
            "data_flows": [],
        }
        with pytest.raises(DuplicateParentError):
            to_native(doc)

    def test_no_partial_mutation_on_error(self):
        """The input dict is not mutated when DuplicateParentError is raised."""
        doc = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                }
            ],
            "containers": [
                {
                    "type": "trust_boundary",
                    "guid": _TRUST_BOUNDARY_GUID,
                    "properties": {"name": "TB1"},
                    "children": [_PROCESS_GUID],
                },
                {
                    "type": "container",
                    "guid": _CONTAINER_GUID,
                    "properties": {"name": "C1"},
                    "children": [_PROCESS_GUID],
                },
            ],
            "data_flows": [],
        }
        original = copy.deepcopy(doc)
        with pytest.raises(DuplicateParentError):
            to_native(doc)
        # Input must be unchanged
        assert doc == original


# ---------------------------------------------------------------------------
# Test 3: Shape checks on to_native output
# ---------------------------------------------------------------------------


class TestNativeShape:
    def _native_from_fixture(self) -> dict:
        return to_native(_MINIMAL_DOC)

    def test_schema_and_theme(self):
        native = self._native_from_fixture()
        assert native["schema"] == "dfd_v1"
        assert native["theme"] == "dark_theme"
        assert "objects" in native
        assert "layout" not in native
        assert "camera" not in native
        assert "groupBounds" not in native

    def test_canvas_object_present(self):
        native = self._native_from_fixture()
        canvas_objs = [o for o in native["objects"] if o.get("id") == "dfd"]
        assert len(canvas_objs) == 1
        canvas = canvas_objs[0]
        prop_keys = [p[0] for p in canvas["properties"]]
        assert prop_keys == ["name", "description", "author", "created"]

    def test_each_node_has_12_anchors(self):
        native = self._native_from_fixture()
        by_instance = {o["instance"]: o for o in native["objects"] if "instance" in o}
        node_objs = [o for o in native["objects"] if o.get("id") in ("process", "external_entity", "data_store")]
        assert len(node_objs) == 3  # fixture has 3 nodes
        for node_obj in node_objs:
            anchors = node_obj.get("anchors", {})
            assert len(anchors) == 12, f"node {node_obj['instance']} has {len(anchors)} anchors"
            # Every angle 0..330 step 30 present
            for angle in range(0, 360, 30):
                assert str(angle) in anchors, f"angle {angle} missing"
            # Anchor objects must exist in the object list
            for angle_str, anchor_inst in anchors.items():
                assert anchor_inst in by_instance, f"anchor instance {anchor_inst} not found"

    def test_flow_latches_in_source_block_angle_zero(self):
        """Each data_flow's source latch must appear in its source block's angle-0 anchor latches."""
        native = self._native_from_fixture()
        by_instance = {o["instance"]: o for o in native["objects"] if "instance" in o}

        # Find data flows
        flow_objs = [o for o in native["objects"] if o.get("id") == "data_flow"]
        assert len(flow_objs) == 2  # fixture has 2 flows

        for flow_obj in flow_objs:
            source_latch = flow_obj["source"]
            target_latch = flow_obj["target"]
            assert len(flow_obj["handles"]) == 1

            # The source latch must be in some block's angle-0 anchor's latches
            found_source = False
            found_target = False
            for node_obj in [o for o in native["objects"] if o.get("id") in ("process", "external_entity", "data_store")]:
                anchors = node_obj.get("anchors", {})
                angle_zero_inst = anchors.get("0")
                if angle_zero_inst:
                    anchor_obj = by_instance.get(angle_zero_inst)
                    if anchor_obj:
                        if source_latch in anchor_obj.get("latches", []):
                            found_source = True
                        if target_latch in anchor_obj.get("latches", []):
                            found_target = True
            assert found_source, f"flow {flow_obj['instance']}: source latch not in any angle-0 anchor"
            assert found_target, f"flow {flow_obj['instance']}: target latch not in any angle-0 anchor"

    def test_flow_latch_objects_present(self):
        """Each data_flow's source/target latches and handle must exist as objects."""
        native = self._native_from_fixture()
        by_instance = {o["instance"]: o for o in native["objects"] if "instance" in o}
        flow_objs = [o for o in native["objects"] if o.get("id") == "data_flow"]
        for flow_obj in flow_objs:
            src = flow_obj["source"]
            tgt = flow_obj["target"]
            handle = flow_obj["handles"][0]
            assert src in by_instance and by_instance[src]["id"] == "generic_latch"
            assert tgt in by_instance and by_instance[tgt]["id"] == "generic_latch"
            assert handle in by_instance and by_instance[handle]["id"] == "generic_handle"

    def test_container_objects_present(self):
        native = self._native_from_fixture()
        container_objs = [o for o in native["objects"] if o.get("id") in ("trust_boundary", "container")]
        assert len(container_objs) == 2

    def test_boolean_properties_are_strings(self):
        """Boolean properties in native must be string "true"/"false", not Python booleans."""
        native = self._native_from_fixture()
        by_instance = {o["instance"]: o for o in native["objects"] if "instance" in o}

        # Check external_entity.out_of_scope
        ext_obj = next(o for o in native["objects"] if o.get("id") == "external_entity")
        props = dict(ext_obj["properties"])
        assert props["out_of_scope"] == "true"

        # Check data_store.contains_pii and encryption_at_rest
        ds_obj = next(o for o in native["objects"] if o.get("id") == "data_store")
        ds_props = dict(ds_obj["properties"])
        assert ds_props["contains_pii"] == "true"
        assert ds_props["encryption_at_rest"] == "true"

        # Check flow booleans
        flow_obj = next(o for o in native["objects"] if o.get("id") == "data_flow"
                        and o["instance"] == _FLOW_1_GUID)
        flow_props = dict(flow_obj["properties"])
        assert flow_props["authenticated"] == "true"
        assert flow_props["encrypted_in_transit"] == "true"

    def test_assumptions_are_hash_pairs(self):
        """Assumptions in native must be [[hash, text], ...] pairs."""
        native = self._native_from_fixture()
        proc_obj = next(o for o in native["objects"] if o.get("id") == "process")
        props = dict(proc_obj["properties"])
        assumptions = props["assumptions"]
        assert len(assumptions) == 2
        for entry in assumptions:
            assert isinstance(entry, list) and len(entry) == 2
            # hash is a 32-char hex string
            assert isinstance(entry[0], str) and len(entry[0]) == 32
            assert isinstance(entry[1], str)
        # Text values preserved in order
        texts = [entry[1] for entry in assumptions]
        assert texts == ["assumption A", "assumption B"]

    def test_all_node_properties_in_order(self):
        """All template fields emitted in declaration order, including nulls."""
        native = self._native_from_fixture()
        proc_obj = next(o for o in native["objects"] if o.get("id") == "process")
        keys = [p[0] for p in proc_obj["properties"]]
        assert keys == ["name", "description", "number", "trust_level", "assumptions"]

        ext_obj = next(o for o in native["objects"] if o.get("id") == "external_entity")
        keys = [p[0] for p in ext_obj["properties"]]
        assert keys == ["name", "description", "entity_type", "out_of_scope"]

        ds_obj = next(o for o in native["objects"] if o.get("id") == "data_store")
        keys = [p[0] for p in ds_obj["properties"]]
        assert keys == ["name", "description", "storage_type", "contains_pii", "encryption_at_rest"]
