"""Round-trip tests for DataItem schema fields and flow data_item_refs.

Covers:
- POST /api/diagrams/import with data_items + data_item_refs → GET export
  preserves both fields exactly.
- Legacy payloads (no data_items, no data_item_refs) import and GET without
  error; both fields default to empty list / absent.
"""

from __future__ import annotations

import json

import pytest

import app as app_module
from app import app

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
        exported_items = {item["guid"]: item for item in exported["data_items"]}

        assert _DATA_ITEM_1_GUID in exported_items
        item1 = exported_items[_DATA_ITEM_1_GUID]
        assert item1["parent"] == _PROCESS_GUID
        assert item1["identifier"] == "D1"
        assert item1["name"] == "Customer PII"
        assert item1["classification"] == "pii"
        # description was not set; must not appear or be None
        assert item1.get("description") is None

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

    def test_legacy_export_has_empty_or_absent_data_items(self, client):
        """Legacy diagram export has no data_items (or empty list)."""
        diagram_id, _ = _import(client, _LEGACY_PAYLOAD)

        exported = _export(client, diagram_id)

        # data_items may be absent or an empty list — both are acceptable.
        data_items = exported.get("data_items", [])
        assert data_items == []

    def test_legacy_flow_has_empty_or_absent_data_item_refs(self, client):
        """Legacy flow export has no data_item_refs (or empty list)."""
        diagram_id, _ = _import(client, _LEGACY_PAYLOAD)

        exported = _export(client, diagram_id)

        flows = {f["guid"]: f for f in exported["data_flows"]}
        assert _FLOW_GUID in flows
        refs = flows[_FLOW_GUID]["properties"].get("data_item_refs", [])
        assert refs == []
