"""Tests for DELETE /api/diagrams/<id>, PUT /api/diagrams/<id>/import,
POST /api/internal/broadcast, and the /ws WebSocket endpoint."""

from __future__ import annotations

import copy
import json
import threading
import time
import urllib.request

import pytest
import simple_websocket
from werkzeug.serving import make_server

import storage
import ws as ws_module
from app import app
from ws import broadcast

# ---------------------------------------------------------------------------
# Minimal valid document (no layout key) for seeding and import tests
# ---------------------------------------------------------------------------

_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_DATA_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_FLOW_GUID = "66666666-0000-0000-0000-000000000006"

_MINIMAL_DOC = {
    "meta": {"name": "Extras test diagram"},
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
            "node1": _PROCESS_GUID,
            "node2": _DATA_STORE_GUID,
            "properties": {"name": "F"},
        }
    ],
    "data_items": [],
}

# ---------------------------------------------------------------------------
# Fixture: Flask test client with isolated tmp_path DATA_DIR
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# Fixture: live Werkzeug server for WebSocket tests (ephemeral port)
# ---------------------------------------------------------------------------


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    # threaded=True is required so the WS handler and subsequent HTTP calls
    # can be served concurrently — without it the server blocks on the WS loop
    # and cannot handle the broadcast POST.
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield app, port
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# Autouse fixture: drain _ws_clients after every test unconditionally (M3)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _drain_ws_clients():
    """Drain the module-level WS client set after each test regardless of outcome."""
    yield
    ws_module.clear()


# ---------------------------------------------------------------------------
# Helper: seed a file directly into the tmp DATA_DIR
# ---------------------------------------------------------------------------


def _seed_file(tmp_path, diagram_id: str, content: dict) -> None:
    (tmp_path / f"{diagram_id}.json").write_text(json.dumps(content, indent=4))


# ---------------------------------------------------------------------------
# DELETE /api/diagrams/<id>
# ---------------------------------------------------------------------------


class TestDeleteDiagram:
    def test_delete_existing_returns_204_and_removes_file(self, client, tmp_path):
        _seed_file(tmp_path, "abc", {"schema": "dfd_v1"})
        resp = client.delete("/api/diagrams/abc")
        assert resp.status_code == 204
        assert not (tmp_path / "abc.json").exists()

    def test_delete_missing_returns_404(self, client):
        resp = client.delete("/api/diagrams/does-not-exist")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PUT /api/diagrams/<id>/import
# ---------------------------------------------------------------------------


class TestPutImport:
    def test_put_import_missing_file_returns_404(self, client):
        resp = client.put(
            "/api/diagrams/no-such-id/import",
            data=json.dumps(_MINIMAL_DOC),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_put_import_happy_path_strips_layout(self, client, tmp_path):
        # Seed a native file that explicitly contains a `layout` key.
        # The assertion below verifies that PUT /import replaces the stored
        # file wholesale — any layout that existed before must be gone after.
        # If a future refactor merged payloads instead of replacing, this
        # test would fail loudly.
        native_with_layout = {
            "schema": "dfd_v1",
            "layout": {"some": "coords"},
            "objects": [],
        }
        _seed_file(tmp_path, "target", native_with_layout)

        resp = client.put(
            "/api/diagrams/target/import",
            data=json.dumps(_MINIMAL_DOC),
            content_type="application/json",
        )
        assert resp.status_code == 204

        stored = json.loads((tmp_path / "target.json").read_text())
        # layout must be absent — to_native never emits it; the whole file
        # is replaced, so the previously-stored layout key is gone.
        assert "layout" not in stored
        # file must contain re-imported content (schema key is the marker)
        assert stored.get("schema") == "dfd_v1"

    def test_put_import_validation_error_returns_400(self, client, tmp_path):
        _seed_file(tmp_path, "target2", {"schema": "dfd_v1"})

        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        # node1 refers to a UUID that is not in nodes — triggers AC1.8
        bad_doc["data_flows"][0]["node1"] = "ffffffff-ffff-ffff-ffff-ffffffffffff"

        resp = client.put(
            "/api/diagrams/target2/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "validation failed"
        assert "details" in body

    def test_put_import_duplicate_parent_returns_400(self, client, tmp_path):
        # Two containers both claim the same child GUID — triggers DuplicateParentError.
        _seed_file(tmp_path, "target3", {"schema": "dfd_v1"})
        child_guid = _PROCESS_GUID
        bad_doc = copy.deepcopy(_MINIMAL_DOC)
        bad_doc["containers"] = [
            {
                "type": "trust_boundary",
                "guid": "aaaaaaaa-0000-0000-0000-000000000001",
                "properties": {"name": "TB1"},
                "children": [child_guid],
            },
            {
                "type": "trust_boundary",
                "guid": "aaaaaaaa-0000-0000-0000-000000000002",
                "properties": {"name": "TB2"},
                "children": [child_guid],
            },
        ]
        resp = client.put(
            "/api/diagrams/target3/import",
            data=json.dumps(bad_doc),
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "duplicate parent"
        assert "detail" in body

    def test_put_import_non_json_body_returns_400(self, client, tmp_path):
        _seed_file(tmp_path, "target4", {"schema": "dfd_v1"})
        resp = client.put(
            "/api/diagrams/target4/import",
            data=b"not json",
            content_type="application/json",
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error"] == "request body must be valid JSON"


# ---------------------------------------------------------------------------
# POST /api/internal/broadcast
# ---------------------------------------------------------------------------


class TestInternalBroadcast:
    def test_loopback_accepted(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            json={"type": "display", "payload": {"id": "abc"}},
        )
        assert resp.status_code == 200
        assert resp.get_json() == {"ok": True}

    def test_non_loopback_rejected(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            environ_overrides={"REMOTE_ADDR": "10.0.0.1"},
            json={"type": "display", "payload": {"id": "abc"}},
        )
        assert resp.status_code == 403

    def test_missing_type_returns_400(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            json={"payload": {"id": "abc"}},
        )
        assert resp.status_code == 400

    def test_non_string_type_returns_400(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            json={"type": 42},
        )
        assert resp.status_code == 400

    def test_empty_string_type_returns_400(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            json={"type": ""},
        )
        assert resp.status_code == 400

    def test_non_dict_payload_returns_400(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            json={"type": "display", "payload": ["not", "a", "dict"]},
        )
        assert resp.status_code == 400

    def test_null_payload_accepted(self, client):
        # JSON null / absent payload is valid (payload is optional)
        resp = client.post(
            "/api/internal/broadcast",
            json={"type": "display", "payload": None},
        )
        assert resp.status_code == 200

    def test_absent_payload_accepted(self, client):
        resp = client.post(
            "/api/internal/broadcast",
            json={"type": "display"},
        )
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# broadcast() dead-socket cleanup (I2 — unit test, no live server needed)
# ---------------------------------------------------------------------------


class TestBroadcastDeadSocketPruning:
    def test_dead_socket_is_pruned_on_send_failure(self):
        """A socket whose .send() raises must be removed from _ws_clients."""

        class _FailingSocket:
            def send(self, _data):
                raise RuntimeError("boom")

        stub = _FailingSocket()
        ws_module.register(stub)

        broadcast({"type": "x"})

        assert stub not in ws_module._ws_clients


# ---------------------------------------------------------------------------
# WebSocket smoke test
# ---------------------------------------------------------------------------


class TestWebSocketBroadcast:
    def test_broadcast_reaches_ws_client(self, live_server):
        _, port = live_server

        ws = simple_websocket.Client(f"ws://127.0.0.1:{port}/ws")

        # Condition-based wait: poll by sending a sentinel and waiting for the
        # receive — this exercises the same invariant (socket is registered)
        # through an observable effect rather than private state (M4).
        sentinel = {"type": "_ping"}
        deadline = time.time() + 2.0
        received_sentinel = False
        while time.time() < deadline:
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/internal/broadcast",
                    data=json.dumps(sentinel).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req) as resp:
                    assert resp.status == 200
                msg = ws.receive(timeout=0.1)
                if msg is not None and json.loads(msg) == sentinel:
                    received_sentinel = True
                    break
            except Exception:
                time.sleep(0.01)

        assert received_sentinel, "ws client never received sentinel broadcast"

        # Trigger the real broadcast and assert delivery.
        envelope = {"type": "display", "payload": {"id": "xyz"}}
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/internal/broadcast",
            data=json.dumps(envelope).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200

        msg = ws.receive(timeout=2.0)
        assert json.loads(msg) == envelope

        ws.close()
