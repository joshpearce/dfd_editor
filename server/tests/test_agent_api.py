"""Endpoint tests for the agent_api Flask blueprint (/api/agent/*).

Focuses on REST concerns: URL routing, status codes, request-body shape,
and the mapping of core-layer exceptions to HTTP responses. Broadcast
semantics (envelope shape, delivery flag) are covered deeply in
test_agent_service.py; here we check each endpoint's broadcast is
emitted by verifying the ``broadcast_delivered`` field in the response.
"""

from __future__ import annotations

import copy
import json
import threading
import time
from typing import Any

import pytest
import simple_websocket
from werkzeug.serving import make_server

import storage
import ws as ws_module
from app import app


_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_FLOW_GUID = "66666666-0000-0000-0000-000000000006"
_CONTAINER_GUID = "44444444-0000-0000-0000-000000000004"
_DATA_ITEM_GUID = "55555555-0000-0000-0000-000000000005"
_NEW_NODE_GUID = "aaaaaaaa-0000-0000-0000-000000000001"
_NEW_CONTAINER_GUID = "bbbbbbbb-0000-0000-0000-000000000002"
_NEW_FLOW_GUID = "cccccccc-0000-0000-0000-000000000003"
_NEW_DATA_ITEM_GUID = "dddddddd-0000-0000-0000-000000000004"


_MINIMAL_DOC: dict[str, Any] = {
    "meta": {"name": "agent_api test"},
    "nodes": [
        {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P"}},
        {"type": "data_store", "guid": _STORE_GUID, "properties": {"name": "DS"}},
    ],
    "containers": [
        {
            "type": "trust_boundary",
            "guid": _CONTAINER_GUID,
            "properties": {"name": "TB"},
            "children": [],
        }
    ],
    "data_flows": [
        {
            "guid": _FLOW_GUID,
            "node1": _PROCESS_GUID,
            "node2": _STORE_GUID,
            "properties": {"name": "F"},
        }
    ],
    "data_items": [
        {
            "guid": _DATA_ITEM_GUID,
            "identifier": "DI-001",
            "name": "SomeData",
            "classification": "unclassified",
        }
    ],
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    """Spin up Flask on an ephemeral port for WS-broadcast tests."""
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield tmp_path, port
    finally:
        srv.shutdown()


@pytest.fixture(autouse=True)
def _drain_ws_clients():
    yield
    ws_module.clear()


def _create(client, doc=None) -> str:
    resp = client.post(
        "/api/agent/diagrams",
        data=json.dumps(doc if doc is not None else _MINIMAL_DOC),
        content_type="application/json",
    )
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()["id"]


# ---------------------------------------------------------------------------
# Read-only routes
# ---------------------------------------------------------------------------


class TestSchema:
    def test_returns_diagram_schema(self, client):
        resp = client.get("/api/agent/schema")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["title"] == "Diagram"
        assert "nodes" in body["properties"]


class TestListDiagrams:
    def test_lists_created(self, client):
        a = _create(client)
        b_doc = copy.deepcopy(_MINIMAL_DOC)
        b_doc["meta"]["name"] = "B"
        b = _create(client, b_doc)
        resp = client.get("/api/agent/diagrams")
        assert resp.status_code == 200
        ids = {row["id"] for row in resp.get_json()}
        assert a in ids and b in ids


class TestGetDiagram:
    def test_returns_minimal(self, client):
        diagram_id = _create(client)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}")
        assert resp.status_code == 200
        body = resp.get_json()
        assert {n["guid"] for n in body["nodes"]} == {_PROCESS_GUID, _STORE_GUID}

    def test_missing_returns_404(self, client):
        resp = client.get("/api/agent/diagrams/does-not-exist")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Create / update / delete / display
# ---------------------------------------------------------------------------


class TestCreateDiagram:
    def test_validates_and_persists(self, client):
        resp = client.post(
            "/api/agent/diagrams",
            data=json.dumps(_MINIMAL_DOC),
            content_type="application/json",
        )
        assert resp.status_code == 201
        body = resp.get_json()
        assert "id" in body and "diagram" in body

    def test_empty_body_returns_400(self, client):
        resp = client.post("/api/agent/diagrams", data=b"", content_type="application/json")
        assert resp.status_code == 400

    def test_schema_violation_returns_400(self, client):
        bad = copy.deepcopy(_MINIMAL_DOC)
        bad["nodes"][0]["type"] = "not-a-real-type"
        resp = client.post(
            "/api/agent/diagrams",
            data=json.dumps(bad),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert "details" in body


class TestUpdateDiagram:
    def test_replaces_and_reports_delivery(self, client):
        diagram_id = _create(client)
        updated = copy.deepcopy(_MINIMAL_DOC)
        updated["meta"]["name"] = "Renamed"
        resp = client.put(
            f"/api/agent/diagrams/{diagram_id}",
            data=json.dumps(updated),
            content_type="application/json",
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["diagram"]["meta"]["name"] == "Renamed"
        assert body["broadcast_delivered"] is True

    def test_missing_returns_404(self, client):
        resp = client.put(
            "/api/agent/diagrams/does-not-exist",
            data=json.dumps(_MINIMAL_DOC),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_schema_violation_returns_400(self, client):
        diagram_id = _create(client)
        bad = copy.deepcopy(_MINIMAL_DOC)
        bad["nodes"][0]["type"] = "nope"
        resp = client.put(
            f"/api/agent/diagrams/{diagram_id}",
            data=json.dumps(bad),
            content_type="application/json",
        )
        assert resp.status_code == 400


class TestDeleteDiagram:
    def test_removes_file(self, client, tmp_path):
        diagram_id = _create(client)
        assert (tmp_path / f"{diagram_id}.json").exists()
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}")
        assert resp.status_code == 200
        assert resp.get_json() == {"ok": True, "broadcast_delivered": True}
        assert not (tmp_path / f"{diagram_id}.json").exists()

    def test_missing_returns_404(self, client):
        resp = client.delete("/api/agent/diagrams/does-not-exist")
        assert resp.status_code == 404


class TestDisplayDiagram:
    def test_broadcasts_display(self, client):
        diagram_id = _create(client)
        resp = client.post(f"/api/agent/diagrams/{diagram_id}/display")
        assert resp.status_code == 200
        assert resp.get_json() == {"ok": True, "broadcast_delivered": True}

    def test_missing_returns_404(self, client):
        resp = client.post("/api/agent/diagrams/does-not-exist/display")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Per-collection typed element routes
# ---------------------------------------------------------------------------


class TestNodesEndpoints:
    def test_add_node(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/nodes",
            data=json.dumps(
                {"type": "external_entity", "guid": _NEW_NODE_GUID, "properties": {"name": "EE"}}
            ),
            content_type="application/json",
        )
        assert resp.status_code == 201
        assert resp.get_json()["guid"] == _NEW_NODE_GUID
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        assert _NEW_NODE_GUID in {n["guid"] for n in fetched["nodes"]}

    def test_add_duplicate_guid_returns_409(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/nodes",
            data=json.dumps(
                {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "dup"}}
            ),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_add_missing_body_returns_400(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/nodes",
            data=b"",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_add_missing_guid_returns_400(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/nodes",
            data=json.dumps({"type": "process", "properties": {"name": "No Guid"}}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_add_missing_diagram_returns_404(self, client):
        resp = client.post(
            "/api/agent/diagrams/does-not-exist/nodes",
            data=json.dumps(
                {"type": "process", "guid": _NEW_NODE_GUID, "properties": {"name": "N"}}
            ),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_update_node(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/nodes/{_PROCESS_GUID}",
            data=json.dumps({"name": "Renamed P"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        node = next(n for n in fetched["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["properties"]["name"] == "Renamed P"

    def test_update_wrong_collection_returns_400(self, client):
        # _FLOW_GUID belongs to data_flows; routing it through /nodes should be rejected
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/nodes/{_FLOW_GUID}",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "data_flows"

    def test_update_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/nodes/00000000-ffff-ffff-ffff-000000000000",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_update_schema_violation_returns_400(self, client):
        diagram_id = _create(client)
        # data_store has a contains_pii boolean field; pass a string to trigger validation failure
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/nodes/{_STORE_GUID}",
            data=json.dumps({"contains_pii": "yes_please"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_delete_node(self, client):
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/nodes/{_STORE_GUID}")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["guid"] == _STORE_GUID
        assert body["deleted_collection"] == "nodes"

    def test_delete_wrong_collection_returns_400(self, client):
        # _FLOW_GUID belongs to data_flows; routing through /nodes should be rejected
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/nodes/{_FLOW_GUID}")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "data_flows"

    def test_delete_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.delete(
            f"/api/agent/diagrams/{diagram_id}/nodes/00000000-dead-dead-dead-000000000000"
        )
        assert resp.status_code == 404

    def test_list_nodes(self, client):
        diagram_id = _create(client)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/nodes")
        assert resp.status_code == 200
        rows = resp.get_json()
        assert isinstance(rows, list)
        guids = {r["guid"] for r in rows}
        assert _PROCESS_GUID in guids and _STORE_GUID in guids
        # Projection: each row must have guid, name, type
        for row in rows:
            assert set(row.keys()) == {"guid", "name", "type"}

    def test_list_empty_returns_empty_array(self, client):
        empty_doc = {
            "meta": {"name": "empty"},
            "nodes": [],
            "containers": [],
            "data_flows": [],
            "data_items": [],
        }
        diagram_id = _create(client, empty_doc)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/nodes")
        assert resp.status_code == 200
        assert resp.get_json() == []

    def test_list_missing_diagram_returns_404(self, client):
        resp = client.get("/api/agent/diagrams/does-not-exist/nodes")
        assert resp.status_code == 404

    def test_delete_node_cascades_flows(self, client):
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/nodes/{_PROCESS_GUID}")
        assert resp.status_code == 200
        body = resp.get_json()
        assert _FLOW_GUID in body["cascade_removed"]
        # Verify the flow is gone from persisted state
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        assert all(f["guid"] != _FLOW_GUID for f in fetched["data_flows"])


class TestContainersEndpoints:
    def test_add_container(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/containers",
            data=json.dumps(
                {
                    "type": "trust_boundary",
                    "guid": _NEW_CONTAINER_GUID,
                    "properties": {"name": "TB2"},
                    "children": [],
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 201
        assert resp.get_json()["guid"] == _NEW_CONTAINER_GUID
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        assert _NEW_CONTAINER_GUID in {c["guid"] for c in fetched["containers"]}

    def test_add_duplicate_guid_returns_409(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/containers",
            data=json.dumps(
                {
                    "type": "trust_boundary",
                    "guid": _CONTAINER_GUID,
                    "properties": {"name": "dup"},
                    "children": [],
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_add_missing_diagram_returns_404(self, client):
        resp = client.post(
            "/api/agent/diagrams/does-not-exist/containers",
            data=json.dumps(
                {
                    "type": "trust_boundary",
                    "guid": _NEW_CONTAINER_GUID,
                    "properties": {"name": "TB"},
                    "children": [],
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_update_container(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/containers/{_CONTAINER_GUID}",
            data=json.dumps({"name": "Renamed TB"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        container = next(c for c in fetched["containers"] if c["guid"] == _CONTAINER_GUID)
        assert container["properties"]["name"] == "Renamed TB"

    def test_update_wrong_collection_returns_400(self, client):
        # _PROCESS_GUID is a node; routing through /containers should be rejected
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/containers/{_PROCESS_GUID}",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "nodes"

    def test_update_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/containers/00000000-ffff-ffff-ffff-000000000000",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_delete_container(self, client):
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/containers/{_CONTAINER_GUID}")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["guid"] == _CONTAINER_GUID
        assert body["deleted_collection"] == "containers"

    def test_delete_wrong_collection_returns_400(self, client):
        # _PROCESS_GUID is a node; routing through /containers should be rejected
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/containers/{_PROCESS_GUID}")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "nodes"

    def test_delete_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.delete(
            f"/api/agent/diagrams/{diagram_id}/containers/00000000-dead-dead-dead-000000000000"
        )
        assert resp.status_code == 404

    def test_list_containers(self, client):
        diagram_id = _create(client)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/containers")
        assert resp.status_code == 200
        rows = resp.get_json()
        assert isinstance(rows, list)
        assert any(r["guid"] == _CONTAINER_GUID for r in rows)
        for row in rows:
            assert set(row.keys()) == {"guid", "name", "type"}

    def test_list_empty_returns_empty_array(self, client):
        empty_doc = {
            "meta": {"name": "empty"},
            "nodes": [],
            "containers": [],
            "data_flows": [],
            "data_items": [],
        }
        diagram_id = _create(client, empty_doc)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/containers")
        assert resp.status_code == 200
        assert resp.get_json() == []


class TestFlowsEndpoints:
    def test_add_flow(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/data_flows",
            data=json.dumps(
                {
                    "guid": _NEW_FLOW_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _STORE_GUID,
                    "properties": {"name": "F2"},
                }
            ),
            content_type="application/json",
        )
        # A second flow with a fresh guid between the same endpoint pair is valid.
        assert resp.status_code == 201
        assert resp.get_json()["guid"] == _NEW_FLOW_GUID
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        assert _NEW_FLOW_GUID in {f["guid"] for f in fetched["data_flows"]}

    def test_add_duplicate_guid_returns_409(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/data_flows",
            data=json.dumps(
                {
                    "guid": _FLOW_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _STORE_GUID,
                    "properties": {"name": "dup"},
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_add_missing_diagram_returns_404(self, client):
        resp = client.post(
            "/api/agent/diagrams/does-not-exist/data_flows",
            data=json.dumps(
                {
                    "guid": _NEW_FLOW_GUID,
                    "node1": _PROCESS_GUID,
                    "node2": _STORE_GUID,
                    "properties": {"name": "F"},
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_update_flow(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/data_flows/{_FLOW_GUID}",
            data=json.dumps({"name": "Renamed F"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        flow = next(f for f in fetched["data_flows"] if f["guid"] == _FLOW_GUID)
        assert flow["properties"]["name"] == "Renamed F"

    def test_update_wrong_collection_returns_400(self, client):
        # _PROCESS_GUID is a node; routing through /data_flows should be rejected
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/data_flows/{_PROCESS_GUID}",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "nodes"

    def test_update_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/data_flows/00000000-ffff-ffff-ffff-000000000000",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_delete_flow(self, client):
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/data_flows/{_FLOW_GUID}")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["guid"] == _FLOW_GUID
        assert body["deleted_collection"] == "data_flows"

    def test_delete_wrong_collection_returns_400(self, client):
        # _PROCESS_GUID is a node; routing through /data_flows should be rejected
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/data_flows/{_PROCESS_GUID}")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "nodes"

    def test_delete_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.delete(
            f"/api/agent/diagrams/{diagram_id}/data_flows/00000000-dead-dead-dead-000000000000"
        )
        assert resp.status_code == 404

    def test_list_flows(self, client):
        diagram_id = _create(client)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/data_flows")
        assert resp.status_code == 200
        rows = resp.get_json()
        assert isinstance(rows, list)
        assert any(r["guid"] == _FLOW_GUID for r in rows)
        for row in rows:
            assert set(row.keys()) == {"guid", "name", "node1", "node2"}

    def test_list_empty_returns_empty_array(self, client):
        empty_doc = {
            "meta": {"name": "empty"},
            "nodes": [],
            "containers": [],
            "data_flows": [],
            "data_items": [],
        }
        diagram_id = _create(client, empty_doc)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/data_flows")
        assert resp.status_code == 200
        assert resp.get_json() == []


class TestDataItemsEndpoints:
    def test_add_data_item(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/data_items",
            data=json.dumps(
                {
                    "guid": _NEW_DATA_ITEM_GUID,
                    "identifier": "DI-002",
                    "name": "NewItem",
                    "classification": "secret",
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 201
        assert resp.get_json()["guid"] == _NEW_DATA_ITEM_GUID
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        assert _NEW_DATA_ITEM_GUID in {d["guid"] for d in fetched["data_items"]}

    def test_add_duplicate_guid_returns_409(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/data_items",
            data=json.dumps(
                {
                    "guid": _DATA_ITEM_GUID,
                    "identifier": "DI-001",
                    "name": "dup",
                    "classification": "unclassified",
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_add_missing_diagram_returns_404(self, client):
        resp = client.post(
            "/api/agent/diagrams/does-not-exist/data_items",
            data=json.dumps(
                {
                    "guid": _NEW_DATA_ITEM_GUID,
                    "identifier": "DI-002",
                    "name": "NewItem",
                    "classification": "unclassified",
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_update_data_item(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/data_items/{_DATA_ITEM_GUID}",
            data=json.dumps({"name": "Renamed Item"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        item = next(d for d in fetched["data_items"] if d["guid"] == _DATA_ITEM_GUID)
        assert item["name"] == "Renamed Item"

    def test_update_wrong_collection_returns_400(self, client):
        # _PROCESS_GUID is a node; routing through /data_items should be rejected
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/data_items/{_PROCESS_GUID}",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "nodes"

    def test_update_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/data_items/00000000-ffff-ffff-ffff-000000000000",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_delete_data_item(self, client):
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/data_items/{_DATA_ITEM_GUID}")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["guid"] == _DATA_ITEM_GUID
        assert body["deleted_collection"] == "data_items"

    def test_delete_wrong_collection_returns_400(self, client):
        # _FLOW_GUID is a data_flow; routing through /data_items should be rejected
        diagram_id = _create(client)
        resp = client.delete(f"/api/agent/diagrams/{diagram_id}/data_items/{_FLOW_GUID}")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["actual_collection"] == "data_flows"

    def test_delete_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.delete(
            f"/api/agent/diagrams/{diagram_id}/data_items/00000000-dead-dead-dead-000000000000"
        )
        assert resp.status_code == 404

    def test_list_data_items(self, client):
        diagram_id = _create(client)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/data_items")
        assert resp.status_code == 200
        rows = resp.get_json()
        assert isinstance(rows, list)
        assert any(r["guid"] == _DATA_ITEM_GUID for r in rows)
        for row in rows:
            assert set(row.keys()) == {"guid", "name", "classification"}

    def test_list_empty_returns_empty_array(self, client):
        empty_doc = {
            "meta": {"name": "empty"},
            "nodes": [],
            "containers": [],
            "data_flows": [],
            "data_items": [],
        }
        diagram_id = _create(client, empty_doc)
        resp = client.get(f"/api/agent/diagrams/{diagram_id}/data_items")
        assert resp.status_code == 200
        assert resp.get_json() == []


# ---------------------------------------------------------------------------
# Reparent endpoint
# ---------------------------------------------------------------------------


class TestReparent:
    def _doc_with_two_containers(self) -> tuple[dict, str, str, str]:
        node_a = "aaaa0000-0000-0000-0000-000000000001"
        cont_a = "bbbb0000-0000-0000-0000-00000000000a"
        cont_b = "bbbb0000-0000-0000-0000-00000000000b"
        doc = {
            "meta": {"name": "reparent"},
            "nodes": [
                {"type": "process", "guid": node_a, "properties": {"name": "N"}},
            ],
            "containers": [
                {
                    "type": "trust_boundary",
                    "guid": cont_a,
                    "properties": {"name": "A"},
                    "children": [node_a],
                },
                {
                    "type": "trust_boundary",
                    "guid": cont_b,
                    "properties": {"name": "B"},
                    "children": [],
                },
            ],
            "data_flows": [],
            "data_items": [],
        }
        return doc, node_a, cont_a, cont_b

    def test_moves_between_containers(self, client):
        doc, node, a, b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": node, "new_parent_guid": b}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["old_parent_guid"] == a
        assert body["new_parent_guid"] == b

    def test_move_to_top_level(self, client):
        doc, node, _a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": node, "new_parent_guid": None}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["new_parent_guid"] is None

    def test_cycle_returns_409(self, client):
        doc, _node, a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": a, "new_parent_guid": a}),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_unknown_target_returns_404(self, client):
        doc, node, _a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": node, "new_parent_guid": "00000000-dead-dead-dead-000000000000"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_missing_guid_returns_400(self, client):
        doc, _node, _a, b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"new_parent_guid": b}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_missing_new_parent_guid_returns_400(self, client):
        doc, node, _a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": node}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_missing_diagram_returns_404(self, client):
        resp = client.post(
            "/api/agent/diagrams/does-not-exist/reparent",
            data=json.dumps({"guid": "some-guid", "new_parent_guid": None}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_reparent_rejects_flow_guid(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": _FLOW_GUID, "new_parent_guid": None}),
            content_type="application/json",
        )
        assert resp.status_code == 404
        # Exception message names "nodes or containers" per core.reparent_element.
        assert "nodes or containers" in resp.get_json()["error"]

    def test_reparent_rejects_data_item_guid(self, client):
        # Need a diagram that has a data_item with a known guid.
        doc = copy.deepcopy(_MINIMAL_DOC)
        _EXTRA_DATA_ITEM_GUID = "77777777-0000-0000-0000-000000000007"
        doc["data_items"] = [{
            "guid": _EXTRA_DATA_ITEM_GUID,
            "identifier": "D1",
            "name": "Item",
            "classification": "unclassified",
        }]
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/reparent",
            data=json.dumps({"guid": _EXTRA_DATA_ITEM_GUID, "new_parent_guid": None}),
            content_type="application/json",
        )
        assert resp.status_code == 404
        assert "nodes or containers" in resp.get_json()["error"]


# ---------------------------------------------------------------------------
# End-to-end: agent API triggers WebSocket broadcast
# ---------------------------------------------------------------------------


class TestBroadcastEndToEnd:
    def _open_ws_and_drain(self, port: int):
        import urllib.request

        ws = simple_websocket.Client(f"ws://127.0.0.1:{port}/ws")
        messages: list[dict] = []

        def _reader():
            try:
                while True:
                    raw = ws.receive(timeout=2.0)
                    if raw is None:
                        break
                    messages.append(json.loads(raw))
            except Exception:
                pass

        threading.Thread(target=_reader, daemon=True).start()

        # Sentinel-ping until the socket is registered.
        deadline = time.time() + 3.0
        while time.time() < deadline:
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/internal/broadcast",
                    data=json.dumps({"type": "_ping"}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req) as resp:
                    assert resp.status == 200
            except Exception:
                time.sleep(0.01)
                continue
            ping_deadline = time.time() + 1.0
            while time.time() < ping_deadline:
                if any(m.get("type") == "_ping" for m in messages):
                    messages.clear()
                    return ws, messages
                time.sleep(0.01)
            break
        messages.clear()
        return ws, messages

    def test_add_element_broadcast_reaches_ws(self, live_server):
        _tmp, port = live_server
        import httpx

        http = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5.0)
        try:
            resp = http.post("/api/agent/diagrams", json=_MINIMAL_DOC)
            assert resp.status_code == 201
            diagram_id = resp.json()["id"]
            ws_client, messages = self._open_ws_and_drain(port)
            try:
                add_resp = http.post(
                    f"/api/agent/diagrams/{diagram_id}/nodes",
                    json={
                        "type": "external_entity",
                        "guid": _NEW_NODE_GUID,
                        "properties": {"name": "EE"},
                    },
                )
                assert add_resp.status_code == 201
                deadline = time.time() + 2.0
                while time.time() < deadline:
                    updated = [m for m in messages if m.get("type") == "diagram-updated"]
                    if updated:
                        assert updated[0]["payload"]["id"] == diagram_id
                        return
                    time.sleep(0.01)
                raise AssertionError(
                    f"timed out waiting for diagram-updated broadcast; messages={messages!r}"
                )
            finally:
                ws_client.close()
        finally:
            http.close()
