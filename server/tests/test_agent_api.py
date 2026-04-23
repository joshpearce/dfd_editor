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
_NEW_NODE_GUID = "aaaaaaaa-0000-0000-0000-000000000001"


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
    "data_items": [],
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
# Granular element routes
# ---------------------------------------------------------------------------


class TestAddElement:
    def test_appends_node(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements",
            data=json.dumps(
                {
                    "collection": "nodes",
                    "element": {
                        "type": "external_entity",
                        "guid": _NEW_NODE_GUID,
                        "properties": {"name": "EE"},
                    },
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 201
        body = resp.get_json()
        assert body["guid"] == _NEW_NODE_GUID
        # Verify persistence via export
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        assert _NEW_NODE_GUID in {n["guid"] for n in fetched["nodes"]}

    def test_duplicate_guid_returns_409(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements",
            data=json.dumps(
                {
                    "collection": "nodes",
                    "element": {
                        "type": "process",
                        "guid": _PROCESS_GUID,
                        "properties": {"name": "dup"},
                    },
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_invalid_collection_returns_400(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements",
            data=json.dumps(
                {
                    "collection": "edges",
                    "element": {"guid": "00000000-0000-0000-0000-000000000099"},
                }
            ),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_missing_diagram_returns_404(self, client):
        resp = client.post(
            "/api/agent/diagrams/does-not-exist/elements",
            data=json.dumps({"collection": "nodes", "element": {"guid": "x"}}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_malformed_body_returns_400(self, client):
        diagram_id = _create(client)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements",
            data=json.dumps({"foo": "bar"}),
            content_type="application/json",
        )
        assert resp.status_code == 400


class TestUpdateElement:
    def test_updates_node_name(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/elements/{_PROCESS_GUID}",
            data=json.dumps({"name": "Renamed P"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        fetched = client.get(f"/api/agent/diagrams/{diagram_id}").get_json()
        node = next(n for n in fetched["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["properties"]["name"] == "Renamed P"

    def test_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/elements/00000000-ffff-ffff-ffff-000000000000",
            data=json.dumps({"name": "X"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_schema_violation_returns_400(self, client):
        diagram_id = _create(client)
        resp = client.patch(
            f"/api/agent/diagrams/{diagram_id}/elements/{_STORE_GUID}",
            data=json.dumps({"contains_pii": "yes_please"}),
            content_type="application/json",
        )
        assert resp.status_code == 400


class TestDeleteElement:
    def test_cascade_flow_on_node_delete(self, client):
        diagram_id = _create(client)
        resp = client.delete(
            f"/api/agent/diagrams/{diagram_id}/elements/{_PROCESS_GUID}"
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["deleted_collection"] == "nodes"
        assert _FLOW_GUID in body["cascade_removed"]

    def test_missing_element_returns_404(self, client):
        diagram_id = _create(client)
        resp = client.delete(
            f"/api/agent/diagrams/{diagram_id}/elements/00000000-dead-dead-dead-000000000000"
        )
        assert resp.status_code == 404


class TestReparentElement:
    def _doc_with_two_containers(self) -> dict:
        node_a = "aaaa0000-0000-0000-0000-000000000001"
        cont_a = "bbbb0000-0000-0000-0000-00000000000a"
        cont_b = "bbbb0000-0000-0000-0000-00000000000b"
        return {
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
        }, node_a, cont_a, cont_b

    def test_moves_between_containers(self, client):
        doc, node, a, b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements/{node}/reparent",
            data=json.dumps({"new_parent_guid": b}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["old_parent_guid"] == a
        assert body["new_parent_guid"] == b

    def test_cycle_returns_409(self, client):
        doc, _node, a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements/{a}/reparent",
            data=json.dumps({"new_parent_guid": a}),
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_unknown_target_returns_404(self, client):
        doc, node, _a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements/{node}/reparent",
            data=json.dumps({"new_parent_guid": "00000000-dead-dead-dead-000000000000"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_missing_new_parent_guid_returns_400(self, client):
        doc, node, _a, _b = self._doc_with_two_containers()
        diagram_id = _create(client, doc)
        resp = client.post(
            f"/api/agent/diagrams/{diagram_id}/elements/{node}/reparent",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 400


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
                    f"/api/agent/diagrams/{diagram_id}/elements",
                    json={
                        "collection": "nodes",
                        "element": {
                            "type": "external_entity",
                            "guid": _NEW_NODE_GUID,
                            "properties": {"name": "EE"},
                        },
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
