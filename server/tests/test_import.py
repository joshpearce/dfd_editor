"""Tests for the minimal→native import transformer (to_native)."""

from __future__ import annotations

import copy
import uuid

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
_DATA_ITEM_1_GUID = "88888888-0000-0000-0000-000000000008"
_DATA_ITEM_2_GUID = "99999999-0000-0000-0000-000000000009"

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
            "node1": _PROCESS_GUID,
            "node2": _DATA_STORE_GUID,
            "properties": {
                "name": "Write Flow",
                "protocol": "gRPC",
                "authenticated": True,
                "encrypted": True,
                "node1_src_data_item_refs": [_DATA_ITEM_1_GUID],
                "node2_src_data_item_refs": [_DATA_ITEM_2_GUID],
            },
        },
        {
            "guid": _FLOW_2_GUID,
            "node1": _PROCESS_GUID,
            "node2": _EXTERNAL_GUID,
            "properties": {
                "authenticated": False,
                "encrypted": False,
                "node1_src_data_item_refs": [],
                "node2_src_data_item_refs": [],
            },
        },
    ],
    "data_items": [
        {
            "guid": _DATA_ITEM_1_GUID,
            "parent": _PROCESS_GUID,
            "identifier": "item1",
            "name": "Data Item 1",
            "classification": "pii",
        },
        {
            "guid": _DATA_ITEM_2_GUID,
            "parent": _DATA_STORE_GUID,
            "identifier": "item2",
            "name": "Data Item 2",
            "classification": "secret",
        },
    ],
}


# ---------------------------------------------------------------------------
# Canonicalization helper for order-insensitive comparison
# ---------------------------------------------------------------------------


def _canonicalize(doc: dict) -> dict:
    """Return a copy of the minimal doc with all lists sorted by guid for comparison.

    Also normalizes UUID objects to strings in ref arrays to handle round-trip comparisons.
    """
    result = copy.deepcopy(doc)

    def sort_key(item: dict) -> str:
        return str(item.get("guid", ""))

    for key in ("nodes", "containers", "data_flows", "data_items"):
        if key in result:
            result[key] = sorted(result[key], key=sort_key)

    # Sort children within each container by guid string
    for container in result.get("containers", []):
        if "children" in container:
            container["children"] = sorted(container["children"])

    # Normalize UUID objects to strings in flow properties
    for flow in result.get("data_flows", []):
        props = flow.get("properties", {})
        for ref_key in ("node1_src_data_item_refs", "node2_src_data_item_refs"):
            if ref_key in props:
                props[ref_key] = [str(ref) for ref in props[ref_key]]

    return result


# ---------------------------------------------------------------------------
# Test 1: Round-trip to_minimal(to_native(m)) == m with four ref-array states
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_round_trip_both_empty(self):
        """Both ref arrays empty: node1_src_data_item_refs=[], node2_src_data_item_refs=[]."""
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _EXTERNAL_GUID,
                    "properties": {
                        "name": "Flow",
                        "authenticated": False,
                        "encrypted": False,
                        "node1_src_data_item_refs": [],
                        "node2_src_data_item_refs": [],
                    },
                }
            ],
        }
        native = to_native(doc)
        back = to_minimal(native)
        assert _canonicalize(back) == _canonicalize(doc)

    def test_round_trip_only_node1_src(self):
        """Only node1_src_data_item_refs populated."""
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _EXTERNAL_GUID,
                    "properties": {
                        "name": "Flow",
                        "authenticated": False,
                        "encrypted": False,
                        "node1_src_data_item_refs": [_DATA_ITEM_1_GUID],
                        "node2_src_data_item_refs": [],
                    },
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "item1",
                    "name": "Item 1",
                }
            ],
        }
        native = to_native(doc)
        back = to_minimal(native)
        assert _canonicalize(back) == _canonicalize(doc)

    def test_round_trip_only_node2_src(self):
        """Only node2_src_data_item_refs populated."""
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _EXTERNAL_GUID,
                    "properties": {
                        "name": "Flow",
                        "authenticated": False,
                        "encrypted": False,
                        "node1_src_data_item_refs": [],
                        "node2_src_data_item_refs": [_DATA_ITEM_2_GUID],
                    },
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_2_GUID,
                    "parent": _EXTERNAL_GUID,
                    "identifier": "item2",
                    "name": "Item 2",
                }
            ],
        }
        native = to_native(doc)
        back = to_minimal(native)
        assert _canonicalize(back) == _canonicalize(doc)

    def test_round_trip_both_populated(self):
        """Both ref arrays populated with different items."""
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _EXTERNAL_GUID,
                    "properties": {
                        "name": "Flow",
                        "authenticated": False,
                        "encrypted": False,
                        "node1_src_data_item_refs": [_DATA_ITEM_1_GUID],
                        "node2_src_data_item_refs": [_DATA_ITEM_2_GUID],
                    },
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "item1",
                    "name": "Item 1",
                },
                {
                    "guid": _DATA_ITEM_2_GUID,
                    "parent": _EXTERNAL_GUID,
                    "identifier": "item2",
                    "name": "Item 2",
                },
            ],
        }
        native = to_native(doc)
        back = to_minimal(native)
        assert _canonicalize(back) == _canonicalize(doc)

    def test_round_trip_shared_property_preservation(self):
        """Shared flow properties (name, protocol, authenticated, encrypted) survive round-trip."""
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _EXTERNAL_GUID,
                    "properties": {
                        "name": "My Flow",
                        "protocol": "gRPC",
                        "authenticated": True,
                        "encrypted": True,
                        "node1_src_data_item_refs": [],
                        "node2_src_data_item_refs": [],
                    },
                }
            ],
        }
        native = to_native(doc)
        back = to_minimal(native)
        result_flow = back["data_flows"][0]
        assert result_flow["properties"]["name"] == "My Flow"
        assert result_flow["properties"]["protocol"] == "gRPC"
        assert result_flow["properties"]["authenticated"] is True
        assert result_flow["properties"]["encrypted"] is True

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

    def test_round_trip_explicit_false_booleans(self):
        """Explicit False values for authenticated and encrypted must round-trip (AC2.3).

        Previously, False values were dropped during to_minimal, but AC2.3 requires
        all shared flow properties to survive the round-trip unchanged.
        """
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _EXTERNAL_GUID,
                    "properties": {
                        "name": "Flow",
                        "authenticated": False,
                        "encrypted": False,
                        "node1_src_data_item_refs": [],
                        "node2_src_data_item_refs": [],
                    },
                }
            ],
        }
        native = to_native(doc)
        back = to_minimal(native)
        assert _canonicalize(back) == _canonicalize(doc)
        # Explicitly check that both booleans come back as False, not absent
        flow = back["data_flows"][0]
        assert flow["properties"]["authenticated"] is False
        assert flow["properties"]["encrypted"] is False


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
        # Canvas props include meta fields + data_items if present
        expected_base = ["name", "description", "author", "created"]
        # Since _MINIMAL_DOC has data_items, they should appear in canvas properties
        expected = expected_base + ["data_items"]
        assert prop_keys == expected

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

    def test_flow_latches_in_node_block_angle_zero(self):
        """Each data_flow's node1 latch must appear in its node1 block's angle-0 anchor latches."""
        native = self._native_from_fixture()
        by_instance = {o["instance"]: o for o in native["objects"] if "instance" in o}

        # Find data flows
        flow_objs = [o for o in native["objects"] if o.get("id") == "data_flow"]
        assert len(flow_objs) == 2  # fixture has 2 flows

        for flow_obj in flow_objs:
            node1_latch = flow_obj["node1"]
            node2_latch = flow_obj["node2"]
            assert len(flow_obj["handles"]) == 1

            # The node1 latch must be in some block's angle-0 anchor's latches
            found_node1 = False
            found_node2 = False
            for node_obj in [o for o in native["objects"] if o.get("id") in ("process", "external_entity", "data_store")]:
                anchors = node_obj.get("anchors", {})
                angle_zero_inst = anchors.get("0")
                if angle_zero_inst:
                    anchor_obj = by_instance.get(angle_zero_inst)
                    if anchor_obj:
                        if node1_latch in anchor_obj.get("latches", []):
                            found_node1 = True
                        if node2_latch in anchor_obj.get("latches", []):
                            found_node2 = True
            assert found_node1, f"flow {flow_obj['instance']}: node1 latch not in any angle-0 anchor"
            assert found_node2, f"flow {flow_obj['instance']}: node2 latch not in any angle-0 anchor"

    def test_flow_latch_objects_present(self):
        """Each data_flow's node1/node2 latches and handle must exist as objects."""
        native = self._native_from_fixture()
        by_instance = {o["instance"]: o for o in native["objects"] if "instance" in o}
        flow_objs = [o for o in native["objects"] if o.get("id") == "data_flow"]
        for flow_obj in flow_objs:
            node1 = flow_obj["node1"]
            node2 = flow_obj["node2"]
            handle = flow_obj["handles"][0]
            assert node1 in by_instance and by_instance[node1]["id"] == "generic_latch"
            assert node2 in by_instance and by_instance[node2]["id"] == "generic_latch"
            assert handle in by_instance and by_instance[handle]["id"] == "generic_handle"

    def test_single_root_object(self):
        """The native doc must parse as a tree with exactly one root (the
        canvas), or the engine refuses to load it with 'multiple root
        objects'. Top-level data_flows must be parented under the canvas."""
        native = self._native_from_fixture()
        all_instances = {o["instance"] for o in native["objects"] if "instance" in o}
        referenced: set[str] = set()
        for o in native["objects"]:
            if o.get("id") == "dfd" or o.get("id") in ("trust_boundary", "container"):
                referenced.update(o.get("objects", []))
            if isinstance(o.get("anchors"), dict):
                referenced.update(o["anchors"].values())
            referenced.update(o.get("latches", []))
            referenced.update(o.get("handles", []))
            if "node1" in o:
                referenced.add(o["node1"])
            if "node2" in o:
                referenced.add(o["node2"])
        roots = all_instances - referenced
        assert len(roots) == 1, f"expected single root, got {len(roots)}: {roots}"
        root_obj = next(o for o in native["objects"] if o["instance"] in roots)
        assert root_obj["id"] == "dfd"

    def test_top_level_flow_in_canvas_objects(self):
        """A data_flow whose GUID isn't listed in any container.children must
        appear in the canvas object's objects[] so it has a parent."""
        native = self._native_from_fixture()
        canvas = next(o for o in native["objects"] if o.get("id") == "dfd")
        # Both flows in _MINIMAL_DOC are top-level (not in any container's children)
        assert _FLOW_1_GUID in canvas["objects"]
        assert _FLOW_2_GUID in canvas["objects"]

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
        assert keys == ["name", "description", "trust_level", "assumptions"]

        ext_obj = next(o for o in native["objects"] if o.get("id") == "external_entity")
        keys = [p[0] for p in ext_obj["properties"]]
        assert keys == ["name", "description", "entity_type", "out_of_scope"]

        ds_obj = next(o for o in native["objects"] if o.get("id") == "data_store")
        keys = [p[0] for p in ds_obj["properties"]]
        assert keys == ["name", "description", "storage_type", "contains_pii", "encryption_at_rest"]

    def test_all_container_properties_in_order(self):
        """Container template fields emitted in declaration order, including nulls."""
        native = self._native_from_fixture()
        tb_obj = next(o for o in native["objects"] if o.get("id") == "trust_boundary")
        keys = [p[0] for p in tb_obj["properties"]]
        assert keys == ["name", "description", "privilege_level"]

        c_obj = next(o for o in native["objects"] if o.get("id") == "container")
        keys = [p[0] for p in c_obj["properties"]]
        assert keys == ["name", "description"]

    def test_all_flow_properties_in_order(self):
        """Flow properties emitted in _FLOW_PROP_ORDER with both ref arrays."""
        native = self._native_from_fixture()
        flow_obj = next(o for o in native["objects"] if o.get("id") == "data_flow")
        keys = [p[0] for p in flow_obj["properties"]]
        expected = [
            "name",
            "protocol",
            "authenticated",
            "encrypted_in_transit",
            "node1_src_data_item_refs",
            "node2_src_data_item_refs",
        ]
        assert keys == expected

    def test_ref_arrays_in_wire_format(self):
        """Both ref arrays appear as [key, [[uuid, guid], ...]] in properties list."""
        native = self._native_from_fixture()
        flow_obj = next(o for o in native["objects"] if o.get("id") == "data_flow"
                        and o["instance"] == _FLOW_1_GUID)
        props_dict = {p[0]: p[1] for p in flow_obj["properties"]}

        # Both keys must be present
        assert "node1_src_data_item_refs" in props_dict
        assert "node2_src_data_item_refs" in props_dict

        # Both should be lists of [key, guid] pairs
        node1_refs = props_dict["node1_src_data_item_refs"]
        node2_refs = props_dict["node2_src_data_item_refs"]

        assert isinstance(node1_refs, list)
        assert isinstance(node2_refs, list)

        # The fixture has data items in both directions
        assert len(node1_refs) == 1
        assert len(node2_refs) == 1

        # Check structure: each entry is [key, guid_str]
        for entry in node1_refs:
            assert isinstance(entry, list) and len(entry) == 2
            assert isinstance(entry[0], str)  # synthetic key
            assert isinstance(entry[1], str)  # guid string

        for entry in node2_refs:
            assert isinstance(entry, list) and len(entry) == 2
            assert isinstance(entry[0], str)  # synthetic key
            assert isinstance(entry[1], str)  # guid string

    def test_canonical_swap_at_transform_layer(self):
        """Canonical swap happens at transform layer: node1 > node2 gets swapped."""
        # Build minimal with node1 > node2 (reversed order)
        doc = {
            "nodes": [
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P1", "assumptions": []}},
                {"type": "process", "guid": _EXTERNAL_GUID, "properties": {"name": "P2", "assumptions": []}},
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_1_GUID,
                    "node1": _EXTERNAL_GUID,  # Greater UUID
                    "node2": _PROCESS_GUID,   # Lesser UUID
                    "properties": {
                        "name": "Flow",
                        "node1_src_data_item_refs": [_DATA_ITEM_1_GUID],
                        "node2_src_data_item_refs": [_DATA_ITEM_2_GUID],
                    },
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _EXTERNAL_GUID,
                    "identifier": "item1",
                    "name": "Item 1",
                },
                {
                    "guid": _DATA_ITEM_2_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "item2",
                    "name": "Item 2",
                },
            ],
        }

        # to_native should canonicalize: swap endpoints AND swap ref arrays
        native = to_native(doc)
        back = to_minimal(native)

        # Result should have endpoints swapped
        result_flow = back["data_flows"][0]
        assert str(result_flow["node1"]) == _PROCESS_GUID  # Lesser UUID first
        assert str(result_flow["node2"]) == _EXTERNAL_GUID  # Greater UUID second

        # Ref arrays should also be swapped: what was node1_src is now node2_src
        assert [str(ref) for ref in result_flow["properties"]["node1_src_data_item_refs"]] == [_DATA_ITEM_2_GUID]
        assert [str(ref) for ref in result_flow["properties"]["node2_src_data_item_refs"]] == [_DATA_ITEM_1_GUID]
