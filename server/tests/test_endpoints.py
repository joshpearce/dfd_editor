"""Integration tests for /api/diagrams/import and /api/diagrams/<id>/export."""

from __future__ import annotations

import copy
import json

import pytest

import app as app_module
from app import app

# ---------------------------------------------------------------------------
# Fixed UUIDs for test fixtures
# ---------------------------------------------------------------------------

_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_EXTERNAL_GUID = "22222222-0000-0000-0000-000000000002"
_DATA_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_TRUST_BOUNDARY_GUID = "44444444-0000-0000-0000-000000000004"
_FLOW_1_GUID = "66666666-0000-0000-0000-000000000006"
_DATA_ITEM_1_GUID = "bbbbbbbb-0000-0000-0000-000000000001"
_DATA_ITEM_2_GUID = "bbbbbbbb-0000-0000-0000-000000000002"

# ---------------------------------------------------------------------------
# Canonical minimal doc (node1 < node2, both ref arrays populated)
# ---------------------------------------------------------------------------

_MINIMAL_DOC: dict = {
    "meta": {
        "name": "Integration test diagram",
        "description": "End-to-end round-trip",
        "author": "Test Author",
        "created": "2026-01-15T12:00:00",
    },
    "nodes": [
        {
            "type": "process",
            "guid": _PROCESS_GUID,
            "properties": {
                "name": "My Process",
                "assumptions": [],
            },
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
    "containers": [
        {
            "type": "trust_boundary",
            "guid": _TRUST_BOUNDARY_GUID,
            "properties": {
                "name": "Trust Boundary",
            },
            "children": [_PROCESS_GUID, _DATA_STORE_GUID],
        },
    ],
    "data_flows": [
        {
            "guid": _FLOW_1_GUID,
            "node1": _PROCESS_GUID,
            "node2": _DATA_STORE_GUID,
            "properties": {
                "name": "Write Flow",
                "authenticated": True,
                "encrypted": True,
                "node1_src_data_item_refs": [_DATA_ITEM_1_GUID],
                "node2_src_data_item_refs": [_DATA_ITEM_2_GUID],
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
# Fixture: Flask test client with isolated tmp_path DATA_DIR
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# Canonicalization helper (sort for deterministic comparison)
# ---------------------------------------------------------------------------


def _canonicalize(doc: dict) -> dict:
    """Sort nodes, containers, data_flows, and data_items by guid for stable comparison."""
    result = copy.deepcopy(doc)

    def sort_key(item: dict) -> str:
        return str(item.get("guid", ""))

    for key in ("nodes", "containers", "data_flows", "data_items"):
        if key in result:
            result[key] = sorted(result[key], key=sort_key)

    for container in result.get("containers", []):
        if "children" in container:
            container["children"] = sorted(container["children"])

    return result


# ---------------------------------------------------------------------------
# TestImportThenExportRoundTrip
# ---------------------------------------------------------------------------


class TestImportThenExportRoundTrip:
    """Verify HTTP round-trip: POST /api/diagrams/import → GET /api/diagrams/<id>/export."""

    def test_round_trip_canonical_order(self, client):
        """POST minimal with node1 < node2 and both ref arrays populated.

        Verifies AC1.1: Flow with node1 < node2 is stored unchanged.
        """
        post_resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(_MINIMAL_DOC),
            content_type="application/json",
        )
        assert post_resp.status_code == 201
        diagram_id = post_resp.get_json()["id"]

        get_resp = client.get(f"/api/diagrams/{diagram_id}/export")
        assert get_resp.status_code == 200

        exported = get_resp.get_json()
        assert _canonicalize(exported) == _canonicalize(_MINIMAL_DOC)

    def test_round_trip_reversed_order_gets_canonicalised(self, client):
        """POST minimal with node1 > node2, assert endpoints and ref arrays are swapped.

        Verifies AC1.2: Flow with node1 > node2 is stored with endpoints swapped,
        and the ref arrays are swapped to preserve semantic direction.
        """
        # Create a doc where node1 > node2 (reversed from _MINIMAL_DOC)
        reversed_doc = copy.deepcopy(_MINIMAL_DOC)
        flow = reversed_doc["data_flows"][0]
        # Swap endpoints
        flow["node1"], flow["node2"] = flow["node2"], flow["node1"]
        # Swap ref arrays (to match the semantic direction when endpoints are swapped)
        flow["properties"]["node1_src_data_item_refs"], flow["properties"]["node2_src_data_item_refs"] = (
            flow["properties"]["node2_src_data_item_refs"],
            flow["properties"]["node1_src_data_item_refs"],
        )

        # Import the reversed doc
        post_resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(reversed_doc),
            content_type="application/json",
        )
        assert post_resp.status_code == 201
        diagram_id = post_resp.get_json()["id"]

        # Export and verify: endpoints should be swapped back to canonical order,
        # and ref arrays should also be swapped back
        get_resp = client.get(f"/api/diagrams/{diagram_id}/export")
        assert get_resp.status_code == 200

        exported = get_resp.get_json()

        # After canonicalisation, the exported flow should match _MINIMAL_DOC
        # (with canonical endpoint order and corresponding ref arrays)
        exported_flows = {f["guid"]: f for f in exported["data_flows"]}
        exported_flow = exported_flows[_FLOW_1_GUID]

        # Endpoints should be in canonical order (node1 < node2)
        assert str(exported_flow["node1"]) < str(exported_flow["node2"])

        # Ref arrays should match the original _MINIMAL_DOC
        expected_flow = _MINIMAL_DOC["data_flows"][0]
        assert exported_flow["properties"]["node1_src_data_item_refs"] == expected_flow["properties"]["node1_src_data_item_refs"]
        assert exported_flow["properties"]["node2_src_data_item_refs"] == expected_flow["properties"]["node2_src_data_item_refs"]

    def test_round_trip_both_refs_empty(self, client):
        """POST with both ref arrays empty (AC1.3 + AC2.4).

        Verifies:
        - AC1.3: Flow with both ref arrays empty is accepted and stored.
        - AC2.4: A flow with both ref arrays empty survives the round-trip.
        """
        empty_refs_doc = copy.deepcopy(_MINIMAL_DOC)
        empty_refs_doc["data_flows"][0]["properties"]["node1_src_data_item_refs"] = []
        empty_refs_doc["data_flows"][0]["properties"]["node2_src_data_item_refs"] = []

        post_resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(empty_refs_doc),
            content_type="application/json",
        )
        assert post_resp.status_code == 201
        diagram_id = post_resp.get_json()["id"]

        get_resp = client.get(f"/api/diagrams/{diagram_id}/export")
        assert get_resp.status_code == 200

        exported = get_resp.get_json()

        # Flow must still be present with empty ref arrays
        exported_flows = {f["guid"]: f for f in exported["data_flows"]}
        assert _FLOW_1_GUID in exported_flows
        flow = exported_flows[_FLOW_1_GUID]
        assert flow["properties"]["node1_src_data_item_refs"] == []
        assert flow["properties"]["node2_src_data_item_refs"] == []


# ---------------------------------------------------------------------------
# TestImportValidationErrors
# ---------------------------------------------------------------------------


class TestImportValidationErrors:
    """Verify validation errors are returned via /api/diagrams/import (400 responses)."""

    def test_self_loop_returns_400(self, client):
        """POST with node1 == node2 returns 400 with self-loop error.

        Verifies AC1.6: Flow with node1 == node2 returns 400 with a pydantic
        validation error referring to the self-loop constraint.
        """
        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        flow = bad_doc["data_flows"][0]
        flow["node1"] = flow["node2"]  # Create self-loop

        resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"
        details = body["details"]
        # Check that at least one error message contains "self-loop"
        msgs = [d.get("msg", "") for d in details]
        assert any("self-loop" in msg for msg in msgs), (
            f"Expected 'self-loop' in error messages, got: {msgs}"
        )

    def test_dangling_ref_node1_direction_returns_400(self, client):
        """POST with dangling ref in node1_src_data_item_refs returns 400.

        Verifies AC1.7: A UUID in node1_src_data_item_refs that does not resolve
        to a top-level data_item returns 400 with a validation error identifying
        the dangling ref and its direction.
        """
        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        bad_doc["data_flows"][0]["properties"]["node1_src_data_item_refs"] = [
            "ffffffff-ffff-ffff-ffff-ffffffffffff"  # Non-existent
        ]

        resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"
        details = body["details"]
        msgs = [d.get("msg", "") for d in details]
        # Error message must mention the direction key name
        assert any("node1_src_data_item_refs" in msg for msg in msgs), (
            f"Expected 'node1_src_data_item_refs' in error messages, got: {msgs}"
        )

    def test_dangling_ref_node2_direction_returns_400(self, client):
        """POST with dangling ref in node2_src_data_item_refs returns 400.

        Verifies AC1.7: Symmetric to node1 direction.
        """
        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        bad_doc["data_flows"][0]["properties"]["node2_src_data_item_refs"] = [
            "ffffffff-ffff-ffff-ffff-ffffffffffff"  # Non-existent
        ]

        resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"
        details = body["details"]
        msgs = [d.get("msg", "") for d in details]
        assert any("node2_src_data_item_refs" in msg for msg in msgs), (
            f"Expected 'node2_src_data_item_refs' in error messages, got: {msgs}"
        )

    def test_old_shape_payload_returns_400(self, client):
        """POST with old-shape keys (source/target/data_item_refs) returns 400.

        Verifies AC7.3: Old-shape payloads with source/target/data_item_refs
        are rejected with a structured 400 error.
        """
        old_shape_doc = {
            "meta": {"name": "Old style"},
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
                    "guid": _FLOW_1_GUID,
                    "source": _PROCESS_GUID,  # Old key name
                    "target": _DATA_STORE_GUID,  # Old key name
                    "properties": {
                        "data_item_refs": [_DATA_ITEM_1_GUID],  # Old field
                    },
                }
            ],
        }

        resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(old_shape_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"
        # Pydantic extra="forbid" should reject the unknown keys

    def test_endpoint_not_in_nodes_returns_400(self, client):
        """POST with node1/node2 referring to non-existent nodes returns 400.

        Verifies AC1.8: node1 or node2 referring to a non-existent canvas
        object returns 400.
        """
        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        bad_doc["data_flows"][0]["node1"] = "ffffffff-ffff-ffff-ffff-ffffffffffff"

        resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"


# ---------------------------------------------------------------------------
# TestImportInvalidNodeType
# ---------------------------------------------------------------------------


class TestImportInvalidNodeType:
    """Regression: unknown node types still return 400."""

    def test_invalid_type_returns_400(self, client):
        """POST with an unknown node type returns 400."""
        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        bad_doc["nodes"][0]["type"] = "database"  # not a valid NodeType

        resp = client.post(
            "/api/diagrams/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"
        details = body["details"]
        locs = [tuple(d["loc"]) for d in details]
        # At least one error should reference nodes[0]
        assert any(
            loc[:2] == ("nodes", 0) for loc in locs
        ), f"Expected an error at nodes[0], got locs: {locs}"


# ---------------------------------------------------------------------------
# TestImportMissingBody
# ---------------------------------------------------------------------------


class TestImportMissingBody:
    """Regression: non-JSON bodies still return 400."""

    def test_non_json_body_returns_400(self, client):
        """POST with a non-JSON body returns 400."""
        resp = client.post(
            "/api/diagrams/import",
            data="not json at all",
            content_type="text/plain",
        )
        assert resp.status_code == 400
        assert resp.get_json()["error"] == "request body must be valid JSON"


# ---------------------------------------------------------------------------
# TestExportMissingId
# ---------------------------------------------------------------------------


class TestExportMissingId:
    """Regression: missing diagram IDs still return 404."""

    def test_missing_diagram_returns_404(self, client):
        """GET /api/diagrams/does-not-exist/export returns 404."""
        resp = client.get("/api/diagrams/does-not-exist/export")
        assert resp.status_code == 404
        assert resp.get_json()["error"] == "not found"


# ---------------------------------------------------------------------------
# TestExistingGetPutStillWork
# ---------------------------------------------------------------------------


class TestExistingGetPutStillWork:
    """Regression: existing native GET/PUT endpoints still work."""

    def test_existing_contract_unchanged(self, client):
        """POST /api/diagrams (scaffold), PUT native payload, GET it back."""
        # Create via scaffold endpoint
        post_resp = client.post("/api/diagrams")
        assert post_resp.status_code == 201
        diagram_id = post_resp.get_json()["id"]

        # PUT a native payload
        native_payload = {
            "schema": "dfd_v1",
            "theme": "dark_theme",
            "objects": [
                {
                    "id": "dfd",
                    "instance": "aaaaaaaa-0000-0000-0000-000000000001",
                    "properties": [["name", "Test"], ["description", None], ["author", None], ["created", None]],
                    "objects": [],
                }
            ],
        }
        put_resp = client.put(
            f"/api/diagrams/{diagram_id}",
            data=json.dumps(native_payload),
            content_type="application/json",
        )
        assert put_resp.status_code == 204

        # GET it back — must equal what we PUT
        get_resp = client.get(f"/api/diagrams/{diagram_id}")
        assert get_resp.status_code == 200
        retrieved = get_resp.get_json()
        assert retrieved == native_payload
