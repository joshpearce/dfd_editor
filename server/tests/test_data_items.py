"""Round-trip tests for DataItem schema fields and bidirectional Flow ref arrays.

Covers:
- POST /api/diagrams/import with data_items + two-array node1_src/node2_src refs
  → GET export preserves both arrays exactly in identical order (AC2.2).
- All four combinations of ref-array population:
  - Both empty
  - Only node1_src populated
  - Only node2_src populated
  - Both populated (possibly with the same item in both directions)
- classification is a closed enum; unknown values are rejected with HTTP 400.
- extra="forbid" rejects unknown keys on DataItem.
- Missing required fields on DataItem return 400.
- Ordering within each ref array is preserved (AC2.2).
"""

from __future__ import annotations

import json

import pytest

import app as app_module
from app import app
from transform import InvalidNativeError, _extract_canvas_data_items, to_minimal, to_native

# ---------------------------------------------------------------------------
# Fixed GUIDs
# ---------------------------------------------------------------------------

_PROCESS_GUID = "aaaaaaaa-0000-0000-0000-000000000001"
_DATA_STORE_GUID = "aaaaaaaa-0000-0000-0000-000000000002"
_FLOW_GUID = "aaaaaaaa-0000-0000-0000-000000000003"
_DATA_ITEM_1_GUID = "bbbbbbbb-0000-0000-0000-000000000001"
_DATA_ITEM_2_GUID = "bbbbbbbb-0000-0000-0000-000000000002"
_DATA_ITEM_3_GUID = "bbbbbbbb-0000-0000-0000-000000000003"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _import(client, payload: dict):
    """POST to /api/diagrams/import; return (diagram_id, response)."""
    resp = client.post(
        "/api/diagrams/import",
        data=json.dumps(payload),
        content_type="application/json",
    )
    return resp.get_json().get("id"), resp


def _export(client, diagram_id: str):
    """GET /api/diagrams/<id>/export; return parsed JSON body."""
    resp = client.get(f"/api/diagrams/{diagram_id}/export")
    assert resp.status_code == 200
    return resp.get_json()


# ---------------------------------------------------------------------------
# Base payload: nodes, containers, data_flows, data_items
# ---------------------------------------------------------------------------


def _base_payload(
    node1_refs: list[str] | None = None,
    node2_refs: list[str] | None = None,
    data_items: list[dict] | None = None,
) -> dict:
    """Construct a minimal payload with two-array ref structure.

    Args:
        node1_refs: list of data_item GUIDs for node1_src_data_item_refs (default [])
        node2_refs: list of data_item GUIDs for node2_src_data_item_refs (default [])
        data_items: list of data_item dicts (default includes _DATA_ITEM_1 and _DATA_ITEM_2)
    """
    if node1_refs is None:
        node1_refs = []
    if node2_refs is None:
        node2_refs = []
    if data_items is None:
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Item One",
            },
            {
                "guid": _DATA_ITEM_2_GUID,
                "parent": _DATA_STORE_GUID,
                "identifier": "D2",
                "name": "Item Two",
            },
        ]

    return {
        "nodes": [
            {
                "type": "process",
                "guid": _PROCESS_GUID,
                "properties": {"name": "Process", "assumptions": []},
            },
            {
                "type": "data_store",
                "guid": _DATA_STORE_GUID,
                "properties": {
                    "name": "Store",
                    "contains_pii": False,
                    "encryption_at_rest": False,
                },
            },
        ],
        "containers": [],
        "data_flows": [
            {
                "guid": _FLOW_GUID,
                "node1": _PROCESS_GUID,
                "node2": _DATA_STORE_GUID,
                "properties": {
                    "name": "Transfer Flow",
                    "node1_src_data_item_refs": node1_refs,
                    "node2_src_data_item_refs": node2_refs,
                },
            },
        ],
        "data_items": data_items,
    }


# ---------------------------------------------------------------------------
# Test 1: Round-trip with node1_src only (AC2.2, AC2.3)
# ---------------------------------------------------------------------------


class TestRoundTripNode1SrcOnly:
    """Round-trip with data items flowing node1→node2 only."""

    def test_node1_src_only_preserved(self, client):
        """POST with node1_src populated, node2_src empty; export preserves order."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID],
            node2_refs=[],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        flow = flows[_FLOW_GUID]

        # AC2.2: UUID lists in identical order
        assert flow["properties"]["node1_src_data_item_refs"] == [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID]
        assert flow["properties"]["node2_src_data_item_refs"] == []

    def test_node1_src_flow_properties_preserved(self, client):
        """Flow properties (name, authenticated, encrypted, etc.) survive round-trip."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[],
        )
        payload["data_flows"][0]["properties"].update({
            "protocol": "HTTP",
            "authenticated": True,
            "encrypted": True,  # Only True is emitted in minimal format (False is default)
        })

        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        props = flows[_FLOW_GUID]["properties"]

        # AC2.3: Shared properties survive unchanged
        assert props["name"] == "Transfer Flow"
        assert props["protocol"] == "HTTP"
        assert props["authenticated"] is True
        assert props["encrypted"] is True


# ---------------------------------------------------------------------------
# Test 2: Round-trip with node2_src only (AC2.2, AC2.3)
# ---------------------------------------------------------------------------


class TestRoundTripNode2SrcOnly:
    """Round-trip with data items flowing node2→node1 only."""

    def test_node2_src_only_preserved(self, client):
        """POST with node1_src empty, node2_src populated; export preserves order."""
        payload = _base_payload(
            node1_refs=[],
            node2_refs=[_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID],  # Reversed order
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        flow = flows[_FLOW_GUID]

        # AC2.2: UUID lists in identical order (including reversed order is preserved)
        assert flow["properties"]["node1_src_data_item_refs"] == []
        assert flow["properties"]["node2_src_data_item_refs"] == [_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID]


# ---------------------------------------------------------------------------
# Test 3: Round-trip with both directions populated, different items
# ---------------------------------------------------------------------------


class TestRoundTripBothDirectionsDifferentItems:
    """Round-trip with both arrays populated, containing different items per direction."""

    def test_both_directions_different_items(self, client):
        """POST with node1_src=[D1], node2_src=[D2]; export preserves both."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[_DATA_ITEM_2_GUID],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        flow = flows[_FLOW_GUID]

        assert flow["properties"]["node1_src_data_item_refs"] == [_DATA_ITEM_1_GUID]
        assert flow["properties"]["node2_src_data_item_refs"] == [_DATA_ITEM_2_GUID]

    def test_both_directions_multiple_items_each(self, client):
        """POST with node1_src=[D1, D2], node2_src=[D2, D1]; export preserves both."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID],
            node2_refs=[_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        flow = flows[_FLOW_GUID]

        # AC2.2: Order preserved within each array
        assert flow["properties"]["node1_src_data_item_refs"] == [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID]
        assert flow["properties"]["node2_src_data_item_refs"] == [_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID]


# ---------------------------------------------------------------------------
# Test 4: Round-trip with same item in both directions (bidirectional)
# ---------------------------------------------------------------------------


class TestRoundTripBidirectionalSameItem:
    """Round-trip with the same data item appearing in both directions."""

    def test_same_item_both_directions(self, client):
        """POST with the same item in both node1_src and node2_src; export preserves."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[_DATA_ITEM_1_GUID],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        flow = flows[_FLOW_GUID]

        # Both arrays should contain the same item — legal and valid
        assert flow["properties"]["node1_src_data_item_refs"] == [_DATA_ITEM_1_GUID]
        assert flow["properties"]["node2_src_data_item_refs"] == [_DATA_ITEM_1_GUID]

    def test_same_item_multiple_times_same_direction(self, client):
        """POST with same item appearing multiple times in node1_src; export preserves."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID, _DATA_ITEM_1_GUID],
            node2_refs=[],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        flow = flows[_FLOW_GUID]

        # Even duplicate references are preserved
        assert flow["properties"]["node1_src_data_item_refs"] == [_DATA_ITEM_1_GUID, _DATA_ITEM_1_GUID]
        assert flow["properties"]["node2_src_data_item_refs"] == []


# ---------------------------------------------------------------------------
# Test 5: Both ref arrays empty (AC1.3 + AC2.4)
# ---------------------------------------------------------------------------


class TestRoundTripBothRefArraysEmpty:
    """Round-trip with both ref arrays empty."""

    def test_both_empty_flow_survives(self, client):
        """POST with both arrays empty; export preserves the flow with empty arrays."""
        payload = _base_payload(
            node1_refs=[],
            node2_refs=[],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)

        # AC2.4: Flow must be present (not filtered out)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        assert _FLOW_GUID in flows

        flow = flows[_FLOW_GUID]
        assert flow["properties"]["node1_src_data_item_refs"] == []
        assert flow["properties"]["node2_src_data_item_refs"] == []


# ---------------------------------------------------------------------------
# Test 6: Data items round-trip unchanged (AC2.3)
# ---------------------------------------------------------------------------


class TestDataItemsRoundTrip:
    """Verify data_items list survives import → export unchanged."""

    def test_data_items_preserved_on_export(self, client):
        """POST with data_items; export returns them unchanged."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[_DATA_ITEM_2_GUID],
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)

        # data_items top-level list must be present
        assert "data_items" in exported
        assert len(exported["data_items"]) == 2

        items = {item["guid"]: item for item in exported["data_items"]}

        # Item 1
        assert _DATA_ITEM_1_GUID in items
        item1 = items[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Item One"

        # Item 2
        assert _DATA_ITEM_2_GUID in items
        item2 = items[_DATA_ITEM_2_GUID]
        assert item2["parent"] == _DATA_STORE_GUID
        assert item2["identifier"] == "D2"
        assert item2["name"] == "Item Two"


# ---------------------------------------------------------------------------
# Test 7: Classification enum — valid values round-trip; invalid rejected
# ---------------------------------------------------------------------------


class TestClassificationEnum:
    """classification is a closed enum; valid values round-trip; invalid values are rejected."""

    def test_valid_classification_round_trips(self, client):
        """A known classification value survives import → export unchanged."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Secret Item",
                "classification": "secret",
            },
        ]
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[],
            data_items=data_items,
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        items = {item["guid"]: item for item in exported["data_items"]}
        assert items[_DATA_ITEM_1_GUID]["classification"] == "secret"

    def test_absent_classification_defaults_to_unclassified(self, client):
        """An item with no classification field defaults to 'unclassified' on export."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "No Class Item",
            },
        ]
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[],
            data_items=data_items,
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        items = {item["guid"]: item for item in exported["data_items"]}
        assert items[_DATA_ITEM_1_GUID]["classification"] == "unclassified"

    def test_invalid_classification_rejected_with_400(self, client):
        """An import with a classification outside the enum is rejected with HTTP 400."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Bad Class Item",
                "classification": "top-secret",
            },
        ]
        payload = _base_payload(data_items=data_items)
        _id, resp = _import(client, payload)
        assert resp.status_code == 400

    def test_all_five_enum_values_accepted(self, client):
        """All five classification enum values are accepted and round-trip."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Unclassified",
                "classification": "unclassified",
            },
            {
                "guid": _DATA_ITEM_2_GUID,
                "parent": _DATA_STORE_GUID,
                "identifier": "D2",
                "name": "PII",
                "classification": "pii",
            },
            {
                "guid": _DATA_ITEM_3_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D3",
                "name": "Secret",
                "classification": "secret",
            },
        ]
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID],
            node2_refs=[_DATA_ITEM_3_GUID],
            data_items=data_items,
        )
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        items = {item["guid"]: item for item in exported["data_items"]}
        assert items[_DATA_ITEM_1_GUID]["classification"] == "unclassified"
        assert items[_DATA_ITEM_2_GUID]["classification"] == "pii"
        assert items[_DATA_ITEM_3_GUID]["classification"] == "secret"


# ---------------------------------------------------------------------------
# Test 8: Validation — missing required fields return 400
# ---------------------------------------------------------------------------


class TestDataItemValidation:
    """Missing required fields or extra keys return 400."""

    def test_extra_key_rejected(self, client):
        """A DataItem with an unrecognised key is rejected with 400."""
        bad_data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "PII Data",
                "color": "red",  # bogus key
            }
        ]
        payload = _base_payload(data_items=bad_data_items)
        _id, resp = _import(client, payload)
        assert resp.status_code == 400

    def test_missing_required_field_rejected(self, client):
        """A DataItem missing a required field is rejected with 400."""
        bad_data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                # "identifier" deliberately omitted
                "name": "PII Data",
            }
        ]
        payload = _base_payload(data_items=bad_data_items)
        _id, resp = _import(client, payload)
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Test 9: Native shape — list-of-pairs wire format for ref arrays
# ---------------------------------------------------------------------------


class TestNativeRefArrayShape:
    """Verify the native wire shape for both ref arrays."""

    def test_to_native_node1_src_list_of_pairs_shape(self):
        """to_native emits node1_src_data_item_refs as [[key, guidStr], ...]."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID],
            node2_refs=[],
        )
        native = to_native(payload)

        # Find flow object
        flow_obj = next(
            (o for o in native["objects"] if o.get("id") == "data_flow"),
            None,
        )
        assert flow_obj is not None

        # Locate node1_src_data_item_refs pair
        node1_refs_pair = next(
            (pair for pair in flow_obj["properties"] if pair[0] == "node1_src_data_item_refs"),
            None,
        )
        assert node1_refs_pair is not None
        node1_refs_value = node1_refs_pair[1]

        # Must be a list of [key, guidStr] pairs
        assert isinstance(node1_refs_value, list)
        assert len(node1_refs_value) == 2
        for entry in node1_refs_value:
            assert isinstance(entry, list) and len(entry) == 2
            key, guid_str = entry
            assert isinstance(key, str) and len(key) > 0
            assert isinstance(guid_str, str)

        # Values must be the original GUIDs in order
        assert [entry[1] for entry in node1_refs_value] == [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID]

    def test_to_native_node2_src_list_of_pairs_shape(self):
        """to_native emits node2_src_data_item_refs as [[key, guidStr], ...]."""
        payload = _base_payload(
            node1_refs=[],
            node2_refs=[_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID],
        )
        native = to_native(payload)

        flow_obj = next(
            (o for o in native["objects"] if o.get("id") == "data_flow"),
            None,
        )
        assert flow_obj is not None

        node2_refs_pair = next(
            (pair for pair in flow_obj["properties"] if pair[0] == "node2_src_data_item_refs"),
            None,
        )
        assert node2_refs_pair is not None
        node2_refs_value = node2_refs_pair[1]

        assert isinstance(node2_refs_value, list)
        assert len(node2_refs_value) == 2
        assert [entry[1] for entry in node2_refs_value] == [_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID]

    def test_to_native_both_arrays_in_properties(self):
        """to_native emits both ref arrays in flow properties (empty arrays included)."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[],
        )
        native = to_native(payload)

        flow_obj = next(
            (o for o in native["objects"] if o.get("id") == "data_flow"),
            None,
        )
        assert flow_obj is not None

        keys = [pair[0] for pair in flow_obj["properties"]]

        # Both arrays must be present
        assert "node1_src_data_item_refs" in keys
        assert "node2_src_data_item_refs" in keys

    def test_to_minimal_recovers_both_ref_arrays(self):
        """native → to_minimal recovers both ref arrays correctly."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID],
            node2_refs=[_DATA_ITEM_2_GUID],
        )
        native = to_native(payload)
        recovered = to_minimal(native)

        flows = {f["guid"]: f for f in recovered["data_flows"]}
        flow = flows[_FLOW_GUID]

        # to_minimal returns UUID objects; stringify for comparison
        node1_refs = [str(r) for r in flow["properties"]["node1_src_data_item_refs"]]
        node2_refs = [str(r) for r in flow["properties"]["node2_src_data_item_refs"]]

        assert node1_refs == [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID]
        assert node2_refs == [_DATA_ITEM_2_GUID]

    def test_native_round_trip_preserves_both_arrays(self):
        """native → minimal → native round-trip preserves both arrays in wire shape."""
        payload = _base_payload(
            node1_refs=[_DATA_ITEM_1_GUID],
            node2_refs=[_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID],
        )
        native = to_native(payload)
        recovered_minimal = to_minimal(native)
        recovered_native = to_native(recovered_minimal)

        # Find flow in recovered native
        flow_obj = next(
            (o for o in recovered_native["objects"] if o.get("id") == "data_flow"),
            None,
        )
        assert flow_obj is not None

        node1_pair = next(
            (p for p in flow_obj["properties"] if p[0] == "node1_src_data_item_refs"),
            None,
        )
        node2_pair = next(
            (p for p in flow_obj["properties"] if p[0] == "node2_src_data_item_refs"),
            None,
        )

        assert node1_pair is not None
        assert node2_pair is not None

        # Extract values
        node1_values = [entry[1] for entry in node1_pair[1]]
        node2_values = [entry[1] for entry in node2_pair[1]]

        assert node1_values == [_DATA_ITEM_1_GUID]
        assert node2_values == [_DATA_ITEM_2_GUID, _DATA_ITEM_1_GUID]


# ---------------------------------------------------------------------------
# Test 10: Canvas data_items property (existing test structure)
# ---------------------------------------------------------------------------


class TestDataItemsCanvasShape:
    """Guards against silent shape drift in the canvas data_items property."""

    def _find_canvas(self, native: dict) -> dict:
        for obj in native["objects"]:
            if obj.get("id") == "dfd":
                return obj
        raise AssertionError("No canvas object found in native doc")

    def _find_data_items_pair(self, canvas: dict) -> list | None:
        for pair in canvas["properties"]:
            if pair[0] == "data_items":
                return pair[1]
        return None

    def test_to_native_produces_list_of_pairs_shape(self):
        """to_native emits data_items as [[itemGuid, [[k,v],...]],...] in canvas props."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Full Item",
                "description": "A description",
                "classification": "secret",
            },
            {
                "guid": _DATA_ITEM_2_GUID,
                "parent": _DATA_STORE_GUID,
                "identifier": "D2",
                "name": "Minimal Item",
            },
        ]
        payload = _base_payload(
            node1_refs=[],
            node2_refs=[],
            data_items=data_items,
        )
        native = to_native(payload)
        canvas = self._find_canvas(native)
        native_items = self._find_data_items_pair(canvas)

        assert native_items is not None
        assert len(native_items) == 2

        items_by_guid = {}
        for entry in native_items:
            assert isinstance(entry, list) and len(entry) == 2
            item_id, sub_pairs = entry
            items_by_guid[item_id] = {k: v for k, v in sub_pairs}

        # Item 1: all fields
        item1 = items_by_guid[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Full Item"
        assert item1["description"] == "A description"
        assert item1["classification"] == "secret"
        assert "guid" not in item1

        # Item 2: no explicit classification — defaults to "unclassified"
        item2 = items_by_guid[_DATA_ITEM_2_GUID]
        assert item2["parent"] == _DATA_STORE_GUID
        assert item2["identifier"] == "D2"
        assert item2["name"] == "Minimal Item"
        assert "description" not in item2
        assert item2["classification"] == "unclassified"

    def test_to_native_field_emission_order(self):
        """Sub-pairs are emitted in declaration order: parent, identifier, name, [description], classification."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Full Item",
                "description": "A description",
                "classification": "secret",
            },
        ]
        payload = _base_payload(data_items=data_items)
        native = to_native(payload)
        canvas = self._find_canvas(native)
        native_items = self._find_data_items_pair(canvas)

        items_by_guid = {entry[0]: entry[1] for entry in native_items}
        keys1 = [pair[0] for pair in items_by_guid[_DATA_ITEM_1_GUID]]
        assert keys1 == ["parent", "identifier", "name", "description", "classification"]

    def test_native_round_trip_preserves_data_items(self):
        """native → minimal → native round-trip preserves data_items."""
        data_items = [
            {
                "guid": _DATA_ITEM_1_GUID,
                "parent": _PROCESS_GUID,
                "identifier": "D1",
                "name": "Full Item",
                "description": "A description",
                "classification": "secret",
            },
            {
                "guid": _DATA_ITEM_2_GUID,
                "parent": _DATA_STORE_GUID,
                "identifier": "D2",
                "name": "Minimal Item",
            },
        ]
        payload = _base_payload(data_items=data_items)
        native = to_native(payload)
        recovered_minimal = to_minimal(native)

        assert "data_items" in recovered_minimal
        recovered_items = {item["guid"]: item for item in recovered_minimal["data_items"]}

        item1 = recovered_items[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Full Item"
        assert item1["description"] == "A description"
        assert item1["classification"] == "secret"

        item2 = recovered_items[_DATA_ITEM_2_GUID]
        assert item2["parent"] == _DATA_STORE_GUID
        assert item2["identifier"] == "D2"
        assert item2["name"] == "Minimal Item"
        assert "description" not in item2
        assert item2["classification"] == "unclassified"

    def test_malformed_data_items_not_list_raises(self):
        """A data_items value that is not a list raises InvalidNativeError."""
        canvas = {
            "id": "dfd",
            "instance": "some-uuid",
            "properties": [["data_items", "not-a-list"]],
        }
        with pytest.raises(InvalidNativeError, match="data_items"):
            _extract_canvas_data_items(canvas)

    def test_malformed_data_items_entry_not_pair_raises(self):
        """An entry in data_items that is not a [id, sub_pairs] pair raises InvalidNativeError."""
        canvas = {
            "id": "dfd",
            "instance": "some-uuid",
            "properties": [["data_items", [{"guid": "x", "name": "flat-dict"}]]],
        }
        with pytest.raises(InvalidNativeError, match="data_items entry"):
            _extract_canvas_data_items(canvas)

    def test_malformed_data_items_sub_pairs_not_list_raises(self):
        """A data_items entry where sub-pairs is not a list raises InvalidNativeError."""
        canvas = {
            "id": "dfd",
            "instance": "some-uuid",
            "properties": [["data_items", [["some-guid", "not-a-list"]]]],
        }
        with pytest.raises(InvalidNativeError, match="sub-pairs"):
            _extract_canvas_data_items(canvas)

    def test_nested_guid_key_raises(self):
        """A sub-dict containing a 'guid' key is structurally wrong and raises InvalidNativeError."""
        canvas = {
            "id": "dfd",
            "instance": "some-uuid",
            "properties": [
                [
                    "data_items",
                    [
                        [
                            "outer-id-guid",
                            [["guid", "inner-guid"], ["identifier", "D1"], ["name", "N"]],
                        ]
                    ],
                ]
            ],
        }
        with pytest.raises(InvalidNativeError, match="must not contain"):
            _extract_canvas_data_items(canvas)
