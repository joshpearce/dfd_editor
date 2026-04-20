"""Round-trip tests for DataItem schema fields and flow data_item_refs.

Covers:
- POST /api/diagrams/import with data_items + data_item_refs → GET export
  preserves both fields exactly.
- Legacy payloads (no data_items, no data_item_refs) import and GET without
  error; both fields default to empty list / absent.
- Arbitrary classification strings (free-form, not enum-restricted) survive
  the round-trip unchanged.
- extra="forbid" rejects unknown keys on DataItem.
- Missing required fields on DataItem return 400.
- Multiple data_item_refs on one flow round-trip with ordering preserved.
- Exported data_items list length matches imported length exactly.
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
# Payload with data_items and data_item_refs
# ---------------------------------------------------------------------------

_PAYLOAD_WITH_DATA_ITEMS: dict = {
    "nodes": [
        {
            "type": "process",
            "guid": _PROCESS_GUID,
            "properties": {"name": "My Process", "assumptions": []},
        },
        {
            "type": "data_store",
            "guid": _DATA_STORE_GUID,
            "properties": {
                "name": "My Store",
                "contains_pii": False,
                "encryption_at_rest": False,
            },
        },
    ],
    "containers": [],
    "data_flows": [
        {
            "guid": _FLOW_GUID,
            "source": _PROCESS_GUID,
            "target": _DATA_STORE_GUID,
            "properties": {
                "name": "Transfer Flow",
                "data_item_refs": [_DATA_ITEM_1_GUID],
            },
        },
    ],
    "data_items": [
        {
            "guid": _DATA_ITEM_1_GUID,
            "parent": _PROCESS_GUID,
            "identifier": "D1",
            "name": "Customer PII",
            "classification": "pii",
        },
        {
            "guid": _DATA_ITEM_2_GUID,
            "parent": _DATA_STORE_GUID,
            "identifier": "D2",
            "name": "Session Token",
            "description": "Short-lived auth token",
            "classification": "secret",
        },
    ],
}


# ---------------------------------------------------------------------------
# Test 1: data_items and data_item_refs survive import → export round-trip
# ---------------------------------------------------------------------------


class TestDataItemsRoundTrip:
    def test_data_items_preserved_on_export(self, client):
        """POST with data_items + flow data_item_refs; export returns them unchanged."""
        diagram_id, resp = _import(client, _PAYLOAD_WITH_DATA_ITEMS)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)

        # data_items top-level list must be present and match
        assert "data_items" in exported
        # Outer ListProperty order must be preserved
        assert [i["guid"] for i in exported["data_items"]] == [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID]
        exported_items = {item["guid"]: item for item in exported["data_items"]}

        assert _DATA_ITEM_1_GUID in exported_items
        item1 = exported_items[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Customer PII"
        assert item1["classification"] == "pii"
        # description was not set; key must be absent (not just None)
        assert "description" not in item1

        assert _DATA_ITEM_2_GUID in exported_items
        item2 = exported_items[_DATA_ITEM_2_GUID]
        assert item2["parent"] == _DATA_STORE_GUID
        assert item2["identifier"] == "D2"
        assert item2["name"] == "Session Token"
        assert item2["description"] == "Short-lived auth token"
        assert item2["classification"] == "secret"

    def test_flow_data_item_refs_preserved_on_export(self, client):
        """The flow's data_item_refs list survives the import → export round-trip."""
        diagram_id, resp = _import(client, _PAYLOAD_WITH_DATA_ITEMS)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)

        flows = {f["guid"]: f for f in exported["data_flows"]}
        assert _FLOW_GUID in flows
        flow_props = flows[_FLOW_GUID]["properties"]
        assert "data_item_refs" in flow_props
        assert flow_props["data_item_refs"] == [_DATA_ITEM_1_GUID]


# ---------------------------------------------------------------------------
# Test 2: legacy payload (no data_items, no data_item_refs) is accepted
# ---------------------------------------------------------------------------


_LEGACY_PAYLOAD: dict = {
    "nodes": [
        {
            "type": "process",
            "guid": _PROCESS_GUID,
            "properties": {"name": "Legacy Process", "assumptions": []},
        },
        {
            "type": "data_store",
            "guid": _DATA_STORE_GUID,
            "properties": {
                "name": "Legacy Store",
                "contains_pii": False,
                "encryption_at_rest": False,
            },
        },
    ],
    "containers": [],
    "data_flows": [
        {
            "guid": _FLOW_GUID,
            "source": _PROCESS_GUID,
            "target": _DATA_STORE_GUID,
            "properties": {},
        },
    ],
    # No "data_items" field at all.
}


class TestLegacyPayloadCompatibility:
    def test_legacy_import_succeeds(self, client):
        """A legacy payload without data_items imports without error."""
        _id, resp = _import(client, _LEGACY_PAYLOAD)
        assert resp.status_code == 201

    def test_legacy_export_has_absent_data_items(self, client):
        """Legacy diagram export omits the data_items key entirely (not even an empty list).

        _build_canvas_props only emits the data_items pair when there are items to
        store, so a legacy diagram has no data_items property in the canvas object.
        _extract_canvas_data_items returns [] and to_minimal omits the key from the
        result dict when the list is empty.
        """
        diagram_id, _ = _import(client, _LEGACY_PAYLOAD)

        exported = _export(client, diagram_id)

        assert "data_items" not in exported

    def test_legacy_flow_has_absent_data_item_refs(self, client):
        """Legacy flow export omits data_item_refs entirely.

        _build_flow_props always emits data_item_refs (as an empty list) in native,
        but _emit_data_flow only adds the key to the minimal flow properties dict
        when refs is non-empty — so a flow with no refs produces no data_item_refs
        key in the exported minimal doc.
        """
        diagram_id, _ = _import(client, _LEGACY_PAYLOAD)

        exported = _export(client, diagram_id)

        flows = {f["guid"]: f for f in exported["data_flows"]}
        assert _FLOW_GUID in flows
        assert "data_item_refs" not in flows[_FLOW_GUID]["properties"]


# ---------------------------------------------------------------------------
# Additional GUIDs for multi-ref tests
# ---------------------------------------------------------------------------

_DATA_ITEM_3_GUID = "bbbbbbbb-0000-0000-0000-000000000003"


# ---------------------------------------------------------------------------
# Test 3: arbitrary classification string round-trips unchanged
# ---------------------------------------------------------------------------


class TestArbitraryClassification:
    def test_free_form_classification_preserved(self, client):
        """An arbitrary classification string (not in any enum) survives round-trip."""
        payload = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                },
                {
                    "type": "data_store",
                    "guid": _DATA_STORE_GUID,
                    "properties": {"name": "DS"},
                },
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_GUID,
                    "source": _PROCESS_GUID,
                    "target": _DATA_STORE_GUID,
                    "properties": {"data_item_refs": [_DATA_ITEM_1_GUID]},
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "D1",
                    "name": "Personal Info",
                    "classification": "pii",
                }
            ],
        }
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        items = {item["guid"]: item for item in exported["data_items"]}
        assert items[_DATA_ITEM_1_GUID]["classification"] == "pii"


# ---------------------------------------------------------------------------
# Test 4: extra="forbid" rejects unknown keys on DataItem
# ---------------------------------------------------------------------------


class TestDataItemValidation:
    def test_extra_key_rejected(self, client):
        """A DataItem with an unrecognised key is rejected with 400."""
        payload = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                },
                {
                    "type": "data_store",
                    "guid": _DATA_STORE_GUID,
                    "properties": {"name": "DS"},
                },
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_GUID,
                    "source": _PROCESS_GUID,
                    "target": _DATA_STORE_GUID,
                    "properties": {},
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "D1",
                    "name": "PII Data",
                    "color": "red",  # bogus key
                }
            ],
        }
        _id, resp = _import(client, payload)
        assert resp.status_code == 400

    def test_missing_required_field_rejected(self, client):
        """A DataItem missing `identifier` is rejected with 400."""
        payload = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                },
                {
                    "type": "data_store",
                    "guid": _DATA_STORE_GUID,
                    "properties": {"name": "DS"},
                },
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_GUID,
                    "source": _PROCESS_GUID,
                    "target": _DATA_STORE_GUID,
                    "properties": {},
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    # "identifier" deliberately omitted
                    "name": "PII Data",
                }
            ],
        }
        _id, resp = _import(client, payload)
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Test 5: multiple data_item_refs on one flow preserve ordering
# ---------------------------------------------------------------------------


class TestMultipleDataItemRefs:
    def test_multiple_refs_ordering_preserved(self, client):
        """Two data_item_refs on one flow round-trip with ordering preserved."""
        payload = {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                },
                {
                    "type": "data_store",
                    "guid": _DATA_STORE_GUID,
                    "properties": {"name": "DS"},
                },
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_GUID,
                    "source": _PROCESS_GUID,
                    "target": _DATA_STORE_GUID,
                    "properties": {
                        "data_item_refs": [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID],
                    },
                }
            ],
            "data_items": [
                {
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "D1",
                    "name": "Item One",
                },
                {
                    "guid": _DATA_ITEM_2_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "D2",
                    "name": "Item Two",
                },
            ],
        }
        diagram_id, resp = _import(client, payload)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        flows = {f["guid"]: f for f in exported["data_flows"]}
        refs = flows[_FLOW_GUID]["properties"]["data_item_refs"]
        assert refs == [_DATA_ITEM_1_GUID, _DATA_ITEM_2_GUID]


# ---------------------------------------------------------------------------
# Test 6: exported data_items list length matches imported length exactly
# ---------------------------------------------------------------------------


class TestDataItemsListLength:
    def test_exported_length_matches_imported(self, client):
        """Exported data_items list length equals imported list length exactly."""
        diagram_id, resp = _import(client, _PAYLOAD_WITH_DATA_ITEMS)
        assert resp.status_code == 201

        exported = _export(client, diagram_id)
        imported_items = _PAYLOAD_WITH_DATA_ITEMS["data_items"]
        exported_items = exported.get("data_items", [])
        assert len(exported_items) == len(imported_items)


# ---------------------------------------------------------------------------
# Test 7: native shape lock-in — ListProperty<DictionaryProperty> wire format
# ---------------------------------------------------------------------------


class TestNativeShape:
    """Guards against silent shape drift in the canvas data_items property.

    OpenChart serializes a ListProperty<DictionaryProperty> as:
        [[itemId, [[k, v], ...]], ...]
    The canvas "data_items" property must use exactly this shape so that
    OpenChart can round-trip it without loss.
    """

    def _build_minimal_two_items(self) -> dict:
        """Return a minimal diagram with two data_items (one full, one required-only)."""
        return {
            "nodes": [
                {
                    "type": "process",
                    "guid": _PROCESS_GUID,
                    "properties": {"name": "P"},
                },
                {
                    "type": "data_store",
                    "guid": _DATA_STORE_GUID,
                    "properties": {"name": "DS"},
                },
            ],
            "containers": [],
            "data_flows": [
                {
                    "guid": _FLOW_GUID,
                    "source": _PROCESS_GUID,
                    "target": _DATA_STORE_GUID,
                    "properties": {},
                }
            ],
            "data_items": [
                {
                    # All fields present
                    "guid": _DATA_ITEM_1_GUID,
                    "parent": _PROCESS_GUID,
                    "identifier": "D1",
                    "name": "Full Item",
                    "description": "A description",
                    "classification": "secret",
                },
                {
                    # Only required fields (no description, no classification)
                    "guid": _DATA_ITEM_2_GUID,
                    "parent": _DATA_STORE_GUID,
                    "identifier": "D2",
                    "name": "Minimal Item",
                },
            ],
        }

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
        minimal = self._build_minimal_two_items()
        native = to_native(minimal)
        canvas = self._find_canvas(native)
        native_items = self._find_data_items_pair(canvas)

        assert native_items is not None, "data_items pair missing from canvas properties"
        assert len(native_items) == 2

        # Build lookup: itemGuid → sub-pairs
        items_by_guid = {}
        for entry in native_items:
            assert isinstance(entry, list) and len(entry) == 2, (
                f"Expected [id, sub_pairs], got {entry!r}"
            )
            item_id, sub_pairs = entry
            assert isinstance(item_id, str)
            assert isinstance(sub_pairs, list)
            items_by_guid[item_id] = {k: v for k, v in sub_pairs}

        # Item 1: all fields
        assert _DATA_ITEM_1_GUID in items_by_guid
        item1 = items_by_guid[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Full Item"
        assert item1["description"] == "A description"
        assert item1["classification"] == "secret"
        # guid must NOT be in sub-pairs — it is the outer list key
        assert "guid" not in item1

        # Item 2: required fields only — optional fields omitted entirely
        assert _DATA_ITEM_2_GUID in items_by_guid
        item2 = items_by_guid[_DATA_ITEM_2_GUID]
        assert item2["parent"] == _DATA_STORE_GUID
        assert item2["identifier"] == "D2"
        assert item2["name"] == "Minimal Item"
        assert "description" not in item2
        assert "classification" not in item2

    def test_to_native_field_emission_order(self):
        """Sub-pairs are emitted in declaration order: parent, identifier, name, [description], [classification]."""
        minimal = self._build_minimal_two_items()
        native = to_native(minimal)
        canvas = self._find_canvas(native)
        native_items = self._find_data_items_pair(canvas)

        items_by_guid = {entry[0]: entry[1] for entry in native_items}

        # Full item: all 5 fields in order
        keys1 = [pair[0] for pair in items_by_guid[_DATA_ITEM_1_GUID]]
        assert keys1 == ["parent", "identifier", "name", "description", "classification"]

        # Minimal item: 3 required fields in order
        keys2 = [pair[0] for pair in items_by_guid[_DATA_ITEM_2_GUID]]
        assert keys2 == ["parent", "identifier", "name"]

    def test_native_round_trip_preserves_data_items(self):
        """native → minimal → native round-trip preserves data_items list-of-pairs shape."""
        minimal = self._build_minimal_two_items()
        native = to_native(minimal)

        # Pass native back through to_minimal
        recovered_minimal = to_minimal(native)

        assert "data_items" in recovered_minimal
        recovered_items = {item["guid"]: item for item in recovered_minimal["data_items"]}

        assert _DATA_ITEM_1_GUID in recovered_items
        item1 = recovered_items[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Full Item"
        assert item1["description"] == "A description"
        assert item1["classification"] == "secret"

        assert _DATA_ITEM_2_GUID in recovered_items
        item2 = recovered_items[_DATA_ITEM_2_GUID]
        assert item2["parent"] == _DATA_STORE_GUID
        assert item2["identifier"] == "D2"
        assert item2["name"] == "Minimal Item"
        assert "description" not in item2
        assert "classification" not in item2

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
