"""Tests for MCP server tools in mcp_server.py.

Architecture:
  - A real Flask app runs on an ephemeral port in a daemon thread (same
    pattern as test_crud_extras.py live_server fixture).
  - mcp_server._http is patched to point at that port so tool functions
    exercise the real HTTP stack without a separately-running Flask process.
  - Broadcast emissions are verified by draining a real WebSocket connection,
    exercising the full Flask WS → simple_websocket path.
  - The sweeper lifecycle test uses approach (a): _sweep_once() is driven
    synchronously after stamping / not-stamping sessions, avoiding any sleep.

Tool function access:
  @mcp.tool() registers functions by reference without wrapping them, so
  list_diagrams / get_diagram / etc. imported from mcp_server are directly
  callable as plain Python functions.  (Verified via dir() inspection.)

Tool enumeration:
  mcp._tool_manager._tools is a dict[str, Tool]; Tool.fn is the raw callable.
  mcp._tool_manager.list_tools() is a synchronous method returning list[Tool].
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any

import httpx
import pytest
import simple_websocket
from werkzeug.serving import make_server

import app as app_module
import mcp_server
from app import app
from mcp_server import (
    _sweep_once,
    create_diagram,
    delete_diagram,
    display_diagram,
    get_diagram,
    list_diagrams,
    mcp,
    update_diagram,
)
from schema import Diagram

# ---------------------------------------------------------------------------
# Minimal valid document reused across tests
# ---------------------------------------------------------------------------

_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_DATA_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_FLOW_GUID = "66666666-0000-0000-0000-000000000006"

_MINIMAL_DOC: dict[str, Any] = {
    "meta": {"name": "MCP test diagram"},
    "nodes": [
        {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P"}},
        {"type": "data_store", "guid": _DATA_STORE_GUID, "properties": {"name": "DS"}},
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
# Minimal fake Context (tools only call _session_id(ctx) → ctx.session)
# ---------------------------------------------------------------------------


class _FakeSession:
    def __init__(self, sid: str = "test-session") -> None:
        self.mcp_session_id = sid


class _FakeContext:
    def __init__(self, sid: str = "test-session") -> None:
        self.session = _FakeSession(sid)


def _ctx(sid: str = "test-session") -> _FakeContext:
    return _FakeContext(sid)


# ---------------------------------------------------------------------------
# Helpers: seed a file directly into tmp_path DATA_DIR
# ---------------------------------------------------------------------------


def _seed_file(tmp_path: Any, diagram_id: str, content: dict) -> None:
    (tmp_path / f"{diagram_id}.json").write_text(json.dumps(content, indent=4))


# ---------------------------------------------------------------------------
# Fixture: live Werkzeug server for end-to-end tests (ephemeral port)
# ---------------------------------------------------------------------------


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    """Spin up Flask on an ephemeral port, redirect mcp_server._http to it."""
    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    # Save the original _http client so we can restore it in teardown.
    original_http = mcp_server._http
    mcp_server._http = httpx.Client(
        base_url=f"http://127.0.0.1:{port}", timeout=5.0
    )

    try:
        yield tmp_path, port
    finally:
        mcp_server._http = original_http
        srv.shutdown()


# ---------------------------------------------------------------------------
# Autouse: drain _ws_clients after every test (mirrors test_crud_extras.py)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _drain_ws_clients():
    yield
    with app_module._ws_lock:
        app_module._ws_clients.clear()


# ---------------------------------------------------------------------------
# Autouse: reset mcp_server session-tracking state between tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_mcp_state():
    yield
    with mcp_server._last_seen_lock:
        mcp_server._last_seen.clear()
    mcp_server._was_active = False


# ---------------------------------------------------------------------------
# WS helper: open a client, wait until it's registered, return drain helper
# ---------------------------------------------------------------------------


def _open_ws_and_drain(port: int) -> tuple[simple_websocket.Client, list[dict]]:
    """Open a WS connection, wait until the server has registered it.

    Returns (ws_client, messages_list).  Messages are appended as they arrive
    in a background thread so the test can continue making HTTP calls.
    """
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

    # Condition-based wait: send a sentinel and wait for it to arrive to confirm
    # the WS registration is complete before the test starts asserting.
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

        # Wait for the ping to land in messages
        ping_deadline = time.time() + 1.0
        while time.time() < ping_deadline:
            if any(m.get("type") == "_ping" for m in messages):
                # Clear the sentinel so tests start with a clean slate
                messages.clear()
                return ws, messages
            time.sleep(0.01)
        break

    # If we get here the ping never arrived — return anyway; the test will fail
    # with a meaningful assertion.
    messages.clear()
    return ws, messages


def _wait_for_broadcast(messages: list[dict], msg_type: str, timeout: float = 2.0) -> list[dict]:
    """Wait until at least one message of the given type appears; return all matching."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        matching = [m for m in messages if m.get("type") == msg_type]
        if matching:
            return matching
        time.sleep(0.01)
    return []


# ---------------------------------------------------------------------------
# AC#1 — tools/list: all six tools are registered
# ---------------------------------------------------------------------------


class TestToolsEnumeration:
    """AC#1: mcp._tool_manager.list_tools() enumerates all six tools."""

    def test_all_six_tools_registered(self):
        # list_tools() is synchronous; _tools is a dict keyed by tool name.
        # We use list_tools() (the public API) rather than accessing _tools
        # directly to stay one level of abstraction above internals.
        tools = mcp._tool_manager.list_tools()
        names = {t.name for t in tools}
        assert names == {
            "list_diagrams",
            "get_diagram",
            "create_diagram",
            "update_diagram",
            "delete_diagram",
            "display_diagram",
        }


# ---------------------------------------------------------------------------
# AC#2 — create_diagram: writes file, no diagram-updated broadcast
# ---------------------------------------------------------------------------


class TestCreateDiagram:
    def test_create_writes_file_and_does_not_broadcast(self, live_server):
        tmp_path, port = live_server
        ws, messages = _open_ws_and_drain(port)

        diagram = Diagram.model_validate(_MINIMAL_DOC)
        result = create_diagram(diagram=diagram, ctx=_ctx())

        assert "id" in result
        diagram_id = result["id"]

        # File must exist under DATA_DIR
        assert (tmp_path / f"{diagram_id}.json").exists(), (
            f"Expected file {diagram_id}.json in {tmp_path}"
        )

        # No diagram-updated broadcast should have been emitted.
        # Wait a brief moment to give any spurious broadcast time to arrive.
        time.sleep(0.15)
        updated_msgs = [m for m in messages if m.get("type") == "diagram-updated"]
        assert updated_msgs == [], (
            f"create_diagram must not emit diagram-updated; got: {updated_msgs}"
        )

        ws.close()


# ---------------------------------------------------------------------------
# AC#3 — update_diagram: emits exactly one diagram-updated broadcast
# ---------------------------------------------------------------------------


class TestUpdateDiagram:
    def test_update_emits_diagram_updated_broadcast(self, live_server):
        tmp_path, port = live_server

        # Seed a diagram first via create_diagram
        diagram = Diagram.model_validate(_MINIMAL_DOC)
        create_result = create_diagram(diagram=diagram, ctx=_ctx())
        diagram_id = create_result["id"]

        ws, messages = _open_ws_and_drain(port)

        # Now update it
        updated_doc = dict(_MINIMAL_DOC)
        updated_doc["meta"] = {"name": "Updated Name"}
        update_diagram(
            id=diagram_id,
            diagram=Diagram.model_validate(updated_doc),
            ctx=_ctx(),
        )

        matching = _wait_for_broadcast(messages, "diagram-updated")
        assert len(matching) == 1, (
            f"Expected exactly one diagram-updated broadcast, got {len(matching)}: {matching}"
        )
        assert matching[0]["payload"]["id"] == diagram_id

        ws.close()


# ---------------------------------------------------------------------------
# AC#4 — delete_diagram: emits exactly one diagram-deleted broadcast, removes file
# ---------------------------------------------------------------------------


class TestDeleteDiagram:
    def test_delete_emits_broadcast_and_removes_file(self, live_server):
        tmp_path, port = live_server

        # Seed via create_diagram
        diagram = Diagram.model_validate(_MINIMAL_DOC)
        create_result = create_diagram(diagram=diagram, ctx=_ctx())
        diagram_id = create_result["id"]
        assert (tmp_path / f"{diagram_id}.json").exists()

        ws, messages = _open_ws_and_drain(port)

        result = delete_diagram(id=diagram_id, ctx=_ctx())
        assert result == {"ok": True}

        # File must be gone
        assert not (tmp_path / f"{diagram_id}.json").exists(), (
            f"File {diagram_id}.json should have been deleted"
        )

        # Exactly one diagram-deleted broadcast with correct id
        matching = _wait_for_broadcast(messages, "diagram-deleted")
        assert len(matching) == 1, (
            f"Expected exactly one diagram-deleted broadcast, got {len(matching)}"
        )
        assert matching[0]["payload"]["id"] == diagram_id

        ws.close()


# ---------------------------------------------------------------------------
# AC#5 — display_diagram: emits exactly one display broadcast, no filesystem change
# ---------------------------------------------------------------------------


class TestDisplayDiagram:
    def test_display_emits_broadcast_and_does_not_touch_fs(self, live_server):
        tmp_path, port = live_server

        # Seed a diagram
        diagram = Diagram.model_validate(_MINIMAL_DOC)
        create_result = create_diagram(diagram=diagram, ctx=_ctx())
        diagram_id = create_result["id"]

        files_before = set(tmp_path.iterdir())

        ws, messages = _open_ws_and_drain(port)

        result = display_diagram(id=diagram_id, ctx=_ctx())
        assert result == {"ok": True}

        # Exactly one display broadcast with correct id
        matching = _wait_for_broadcast(messages, "display")
        assert len(matching) == 1, (
            f"Expected exactly one display broadcast, got {len(matching)}"
        )
        assert matching[0]["payload"]["id"] == diagram_id

        # Filesystem must be unchanged
        files_after = set(tmp_path.iterdir())
        assert files_before == files_after, (
            f"display_diagram must not touch the filesystem; diff: {files_before ^ files_after}"
        )

        ws.close()


# ---------------------------------------------------------------------------
# AC#6 — get_diagram: returns minimal export shape for a seeded native file
# ---------------------------------------------------------------------------


class TestGetDiagram:
    def test_get_diagram_returns_minimal_export(self, live_server):
        tmp_path, port = live_server

        # Create via import endpoint to ensure a well-formed native file exists
        diagram = Diagram.model_validate(_MINIMAL_DOC)
        create_result = create_diagram(diagram=diagram, ctx=_ctx())
        diagram_id = create_result["id"]

        result = get_diagram(id=diagram_id, ctx=_ctx())

        # Required top-level keys for the minimal export shape.
        # Note: data_items is omitted from the export when the list is empty
        # (transform.to_minimal only writes it when non-empty), so we don't
        # require it here — but all other structural keys must be present.
        for key in ("meta", "nodes", "containers", "data_flows"):
            assert key in result, f"get_diagram result missing key: {key}"

        # data_items, when present, must be a list
        if "data_items" in result:
            assert isinstance(result["data_items"], list)

        # Spot-check: nodes should match what we imported (process + data_store)
        returned_guids = {n["guid"] for n in result["nodes"]}
        assert _PROCESS_GUID in returned_guids
        assert _DATA_STORE_GUID in returned_guids


# ---------------------------------------------------------------------------
# AC#7 — list_diagrams: returns a summary object for every file in DATA_DIR
# ---------------------------------------------------------------------------


class TestListDiagrams:
    def test_list_returns_all_diagrams(self, live_server):
        tmp_path, port = live_server

        # Create two diagrams
        d1 = Diagram.model_validate(_MINIMAL_DOC)
        d2_doc = dict(_MINIMAL_DOC)
        d2_doc["meta"] = {"name": "Second diagram"}
        d2 = Diagram.model_validate(d2_doc)

        r1 = create_diagram(diagram=d1, ctx=_ctx())
        r2 = create_diagram(diagram=d2, ctx=_ctx())

        result = list_diagrams(ctx=_ctx())

        assert isinstance(result, list)
        ids = {item["id"] for item in result}
        assert r1["id"] in ids, f"id {r1['id']} missing from list_diagrams result"
        assert r2["id"] in ids, f"id {r2['id']} missing from list_diagrams result"

        # Each summary object must carry id, name, and modified
        for item in result:
            for field in ("id", "name", "modified"):
                assert field in item, f"summary missing field {field!r}: {item}"

    def test_list_empty_when_no_diagrams(self, live_server):
        _tmp_path, _port = live_server
        result = list_diagrams(ctx=_ctx())
        assert result == []


# ---------------------------------------------------------------------------
# AC#8 — remote-control lifecycle: on/off transitions via _sweep_once()
# ---------------------------------------------------------------------------


class TestRemoteControlLifecycle:
    """Acceptance #8: opening a session emits remote-control:on, expiry emits :off.

    Strategy (a): drive _sweep_once() synchronously.
    - Stamp a fake session → _sweep_once() sees it as active → emits 'on'.
    - Wait past SESSION_EXPIRY_SECONDS using a fake 'now' value far in the
      future, don't re-stamp → _sweep_once() evicts the session → emits 'off'.
    This avoids any sleep and doesn't require the daemon thread to run.
    """

    def test_remote_control_on_when_session_stamps(self, live_server):
        _tmp_path, port = live_server
        ws, messages = _open_ws_and_drain(port)

        # Stamp a session so _last_seen is non-empty
        mcp_server._stamp(_ctx("rc-test-on"))

        # Sweep with now == just-stamped (session is fresh, not stale)
        _sweep_once(now=time.monotonic())

        matching = _wait_for_broadcast(messages, "remote-control")
        on_msgs = [m for m in matching if m.get("payload", {}).get("state") == "on"]
        assert len(on_msgs) == 1, (
            f"Expected exactly one remote-control:on broadcast, got: {matching}"
        )

        ws.close()

    def test_remote_control_off_when_session_expires(self, live_server):
        _tmp_path, port = live_server

        # Pre-stamp a session and drive it to active state
        mcp_server._stamp(_ctx("rc-test-off"))
        _sweep_once(now=time.monotonic())
        assert mcp_server._was_active is True

        ws, messages = _open_ws_and_drain(port)

        # Now sweep with a 'now' far enough in the future to evict the session
        far_future = time.monotonic() + mcp_server.SESSION_EXPIRY_SECONDS + 1
        _sweep_once(now=far_future)

        matching = _wait_for_broadcast(messages, "remote-control")
        off_msgs = [m for m in matching if m.get("payload", {}).get("state") == "off"]
        assert len(off_msgs) == 1, (
            f"Expected exactly one remote-control:off broadcast, got: {matching}"
        )
        assert mcp_server._was_active is False

        ws.close()

    def test_no_duplicate_on_if_already_active(self, live_server):
        """_sweep_once must not re-emit 'on' if _was_active is already True."""
        _tmp_path, port = live_server

        # Drive to active
        mcp_server._stamp(_ctx("rc-dedup"))
        _sweep_once(now=time.monotonic())
        assert mcp_server._was_active is True

        ws, messages = _open_ws_and_drain(port)

        # Sweep again — still active, should not emit another 'on'
        mcp_server._stamp(_ctx("rc-dedup"))
        _sweep_once(now=time.monotonic())
        time.sleep(0.1)  # allow any spurious broadcast to arrive

        on_msgs = [
            m for m in messages
            if m.get("type") == "remote-control" and m.get("payload", {}).get("state") == "on"
        ]
        assert on_msgs == [], f"Should not re-emit on when already active; got: {on_msgs}"

        ws.close()
