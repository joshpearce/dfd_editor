"""Pure-unit tests for ``core.py`` — no Flask, no filesystem, no WS."""

from __future__ import annotations

import copy

import pytest

import core


_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_FLOW_GUID = "66666666-0000-0000-0000-000000000006"
_CONTAINER_GUID = "44444444-0000-0000-0000-000000000004"
_INNER_CONTAINER_GUID = "44444444-0000-0000-0000-000000000005"
_DATA_ITEM_GUID = "bbbbbbbb-0000-0000-0000-000000000001"


def _base_doc() -> dict:
    return {
        "meta": {"name": "core tests"},
        "nodes": [
            {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P"}},
            {"type": "data_store", "guid": _STORE_GUID, "properties": {"name": "DS"}},
        ],
        "containers": [
            {
                "type": "trust_boundary",
                "guid": _CONTAINER_GUID,
                "properties": {"name": "TB"},
                "children": [_PROCESS_GUID, _INNER_CONTAINER_GUID],
            },
            {
                "type": "trust_boundary",
                "guid": _INNER_CONTAINER_GUID,
                "properties": {"name": "Inner"},
                "children": [],
            },
        ],
        "data_flows": [
            {
                "guid": _FLOW_GUID,
                "node1": _PROCESS_GUID,
                "node2": _STORE_GUID,
                "properties": {
                    "name": "F",
                    "node1_src_data_item_refs": [_DATA_ITEM_GUID],
                    "node2_src_data_item_refs": [],
                },
            }
        ],
        "data_items": [
            {
                "guid": _DATA_ITEM_GUID,
                "identifier": "D1",
                "name": "Item",
                "classification": "unclassified",
                "parent": _PROCESS_GUID,
            }
        ],
    }


class TestFindElement:
    def test_finds_node(self):
        doc = _base_doc()
        found = core.find_element(doc, _PROCESS_GUID)
        assert found is not None
        elem, collection = found
        assert elem["guid"] == _PROCESS_GUID
        assert collection == "nodes"

    def test_finds_flow(self):
        doc = _base_doc()
        _elem, collection = core.find_element(doc, _FLOW_GUID)
        assert collection == "data_flows"

    def test_finds_data_item(self):
        doc = _base_doc()
        _elem, collection = core.find_element(doc, _DATA_ITEM_GUID)
        assert collection == "data_items"

    def test_missing_returns_none(self):
        assert core.find_element(_base_doc(), "no-such-guid") is None


class TestAddElement:
    def test_appends_node(self):
        doc = _base_doc()
        new_guid = "aaaaaaaa-0000-0000-0000-000000000001"
        core.add_element(
            doc,
            "nodes",
            {"type": "external_entity", "guid": new_guid, "properties": {"name": "EE"}},
        )
        assert any(n["guid"] == new_guid for n in doc["nodes"])

    def test_invalid_collection_raises(self):
        with pytest.raises(core.InvalidCollectionError):
            core.add_element(_base_doc(), "edges", {"guid": "x"})

    def test_missing_guid_raises(self):
        with pytest.raises(core.MissingGuidError):
            core.add_element(_base_doc(), "nodes", {"type": "process"})

    def test_duplicate_guid_raises(self):
        with pytest.raises(core.DuplicateGuidError):
            core.add_element(
                _base_doc(),
                "nodes",
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "dup"}},
            )

    def test_creates_missing_collection_key(self):
        doc = {"meta": {"name": "sparse"}, "nodes": [], "containers": [], "data_flows": []}
        # data_items key is absent entirely — add should populate it.
        core.add_element(
            doc,
            "data_items",
            {"guid": "x", "identifier": "D", "name": "N", "classification": "unclassified"},
        )
        assert "data_items" in doc
        assert doc["data_items"][0]["guid"] == "x"


class TestUpdateElement:
    def test_merges_node_properties(self):
        doc = _base_doc()
        core.update_element(doc, _PROCESS_GUID, {"name": "Renamed"})
        node = next(n for n in doc["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["properties"]["name"] == "Renamed"

    def test_read_only_fields_skipped_for_nodes(self):
        doc = _base_doc()
        core.update_element(
            doc,
            _PROCESS_GUID,
            {"guid": "should-ignore", "type": "should-ignore", "name": "OK"},
        )
        node = next(n for n in doc["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["guid"] == _PROCESS_GUID
        assert node["type"] == "process"
        assert node["properties"]["name"] == "OK"

    def test_read_only_fields_skipped_for_flows(self):
        doc = _base_doc()
        core.update_element(
            doc,
            _FLOW_GUID,
            {
                "guid": "x",
                "node1": "x",
                "node2": "x",
                "name": "Flow OK",
            },
        )
        flow = next(f for f in doc["data_flows"] if f["guid"] == _FLOW_GUID)
        assert flow["node1"] == _PROCESS_GUID
        assert flow["node2"] == _STORE_GUID
        assert flow["properties"]["name"] == "Flow OK"

    def test_data_item_is_flat_update(self):
        doc = _base_doc()
        core.update_element(
            doc,
            _DATA_ITEM_GUID,
            {"guid": "ignore", "name": "Renamed", "classification": "pii"},
        )
        item = next(di for di in doc["data_items"] if di["guid"] == _DATA_ITEM_GUID)
        assert item["guid"] == _DATA_ITEM_GUID
        assert item["name"] == "Renamed"
        assert item["classification"] == "pii"

    def test_unknown_guid_raises(self):
        with pytest.raises(core.ElementNotFoundError):
            core.update_element(_base_doc(), "no-such-guid", {"name": "X"})


class TestDeleteElement:
    def test_delete_flow_has_no_cascade(self):
        doc = _base_doc()
        _, collection, cascade = core.delete_element(doc, _FLOW_GUID)
        assert collection == "data_flows"
        assert cascade == []
        assert not any(f["guid"] == _FLOW_GUID for f in doc["data_flows"])

    def test_delete_node_cascades_flows_unparents_items_strips_children(self):
        doc = _base_doc()
        _, collection, cascade = core.delete_element(doc, _PROCESS_GUID)
        assert collection == "nodes"
        assert _FLOW_GUID in cascade
        # Flow gone
        assert not any(f["guid"] == _FLOW_GUID for f in doc["data_flows"])
        # Data item unparented
        item = next(di for di in doc["data_items"] if di["guid"] == _DATA_ITEM_GUID)
        assert item["parent"] is None
        # Container no longer references the node
        outer = next(c for c in doc["containers"] if c["guid"] == _CONTAINER_GUID)
        assert _PROCESS_GUID not in outer["children"]

    def test_delete_node_cascades_flow_where_node_is_node2(self):
        doc = _base_doc()
        _, _, cascade = core.delete_element(doc, _STORE_GUID)
        assert _FLOW_GUID in cascade

    def test_delete_container_strips_from_parent_children(self):
        doc = _base_doc()
        _, collection, cascade = core.delete_element(doc, _INNER_CONTAINER_GUID)
        assert collection == "containers"
        assert cascade == []
        outer = next(c for c in doc["containers"] if c["guid"] == _CONTAINER_GUID)
        assert _INNER_CONTAINER_GUID not in outer["children"]

    def test_delete_container_preserves_grandchildren(self):
        """Deleting an outer container leaves its child nodes in place as top-level."""
        doc = _base_doc()
        core.delete_element(doc, _CONTAINER_GUID)
        node_guids = {n["guid"] for n in doc["nodes"]}
        assert _PROCESS_GUID in node_guids
        assert _STORE_GUID in node_guids

    def test_delete_data_item_scrubs_flow_refs_both_directions(self):
        doc = _base_doc()
        # Plant the item in the opposite direction too
        doc["data_flows"][0]["properties"]["node2_src_data_item_refs"] = [_DATA_ITEM_GUID]
        core.delete_element(doc, _DATA_ITEM_GUID)
        flow = doc["data_flows"][0]
        assert _DATA_ITEM_GUID not in flow["properties"]["node1_src_data_item_refs"]
        assert _DATA_ITEM_GUID not in flow["properties"]["node2_src_data_item_refs"]

    def test_unknown_guid_raises(self):
        with pytest.raises(core.ElementNotFoundError):
            core.delete_element(_base_doc(), "no-such-guid")


class TestReparentElement:
    def _doc(self) -> dict:
        """Two containers, two nodes — each node in a different container; C nested in A."""
        return {
            "meta": {"name": "reparent"},
            "nodes": [
                {"type": "process", "guid": "n1", "properties": {"name": "N1"}},
                {"type": "process", "guid": "n2", "properties": {"name": "N2"}},
            ],
            "containers": [
                {"type": "trust_boundary", "guid": "A", "properties": {"name": "A"}, "children": ["n1", "C"]},
                {"type": "trust_boundary", "guid": "B", "properties": {"name": "B"}, "children": ["n2"]},
                {"type": "trust_boundary", "guid": "C", "properties": {"name": "C"}, "children": []},
            ],
            "data_flows": [],
            "data_items": [],
        }

    def test_move_node_between_containers(self):
        doc = self._doc()
        _, old = core.reparent_element(doc, "n1", "B")
        assert old == "A"
        containers = {c["guid"]: c for c in doc["containers"]}
        assert "n1" not in containers["A"]["children"]
        assert "n1" in containers["B"]["children"]

    def test_move_to_top_level(self):
        doc = self._doc()
        _, old = core.reparent_element(doc, "n1", None)
        assert old == "A"
        containers = {c["guid"]: c for c in doc["containers"]}
        assert "n1" not in containers["A"]["children"]

    def test_top_level_into_container(self):
        doc = self._doc()
        core.reparent_element(doc, "n1", None)
        _, old = core.reparent_element(doc, "n1", "B")
        assert old is None
        containers = {c["guid"]: c for c in doc["containers"]}
        assert "n1" in containers["B"]["children"]

    def test_move_container_into_sibling(self):
        doc = self._doc()
        _, old = core.reparent_element(doc, "C", "B")
        assert old == "A"
        containers = {c["guid"]: c for c in doc["containers"]}
        assert "C" not in containers["A"]["children"]
        assert "C" in containers["B"]["children"]

    def test_cycle_descendant_raises(self):
        doc = self._doc()
        with pytest.raises(core.ContainerCycleError):
            core.reparent_element(doc, "A", "C")

    def test_cycle_self_raises(self):
        doc = self._doc()
        with pytest.raises(core.ContainerCycleError):
            core.reparent_element(doc, "A", "A")

    def test_unknown_element_raises(self):
        with pytest.raises(core.ElementNotFoundError):
            core.reparent_element(self._doc(), "missing", None)

    def test_unknown_target_raises(self):
        with pytest.raises(core.ContainerNotFoundError):
            core.reparent_element(self._doc(), "n1", "missing-container")
