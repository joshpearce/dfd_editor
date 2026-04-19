"""Integration tests for /api/diagrams/import and /api/diagrams/<id>/export."""

from __future__ import annotations

import copy
import json

import pytest

import app as app_module
from app import app

# ---------------------------------------------------------------------------
# Fixture: reuse the same minimal doc shape used by test_import.py
# ---------------------------------------------------------------------------

_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_EXTERNAL_GUID = "22222222-0000-0000-0000-000000000002"
_DATA_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_TRUST_BOUNDARY_GUID = "44444444-0000-0000-0000-000000000004"
_CONTAINER_GUID = "55555555-0000-0000-0000-000000000005"
_FLOW_1_GUID = "66666666-0000-0000-0000-000000000006"

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
            "source": _PROCESS_GUID,
            "target": _DATA_STORE_GUID,
            "properties": {
                "name": "Write Flow",
                "authenticated": True,
                "encrypted": True,
            },
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
# Canonicalization helper (same approach as test_import.py)
# ---------------------------------------------------------------------------


def _canonicalize(doc: dict) -> dict:
    result = copy.deepcopy(doc)

    def sort_key(item: dict) -> str:
        return str(item.get("guid", ""))

    for key in ("nodes", "containers", "data_flows"):
        if key in result:
            result[key] = sorted(result[key], key=sort_key)

    for container in result.get("containers", []):
        if "children" in container:
            container["children"] = sorted(container["children"])

    return result


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestImportThenExportRoundTrip:
    def test_round_trip(self, client):
        """POST minimal doc → GET export → body equals posted input."""
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


class TestImportInvalidNodeType:
    def test_invalid_type_returns_400(self, client):
        """POST with an unknown node type returns 400 with a loc pointing at nodes[0].type."""
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
        # At least one error should reference nodes[0] (discriminator or type mismatch)
        locs = [tuple(d["loc"]) for d in details]
        assert any(
            loc[:2] == ("nodes", 0) for loc in locs
        ), f"Expected an error at nodes[0], got locs: {locs}"


class TestImportMissingBody:
    def test_non_json_body_returns_400(self, client):
        """POST with a non-JSON body returns 400."""
        resp = client.post(
            "/api/diagrams/import",
            data="not json at all",
            content_type="text/plain",
        )
        assert resp.status_code == 400
        assert resp.get_json()["error"] == "request body must be valid JSON"


class TestExportMissingId:
    def test_missing_diagram_returns_404(self, client):
        """GET /api/diagrams/does-not-exist/export returns 404."""
        resp = client.get("/api/diagrams/does-not-exist/export")
        assert resp.status_code == 404
        assert resp.get_json()["error"] == "not found"


class TestExistingGetPutStillWork:
    def test_existing_contract_unchanged(self, client):
        """POST /api/diagrams (scaffold), PUT native payload, GET it back — round-trip JSON equality."""
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
