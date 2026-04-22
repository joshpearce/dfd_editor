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

FastMCP dispatch test (I5):
  To exercise the pydantic coercion path that FastMCP uses when a tool is
  called through the actual dispatcher, we locate the create_diagram Tool via
  mcp._tool_manager.list_tools(), extract Tool.fn, and call it directly with a
  Diagram.model_validate(dict) argument.  This validates the pydantic
  coercion round-trip that the @mcp.tool() decorator relies on without
  requiring a full async HTTP MCP handshake.  If the SDK later exposes a
  synchronous call_tool() helper, this test can be upgraded.

Daemon thread guard (M3+M4):
  mcp_server.start_daemon() is now only called from __main__, so importing the
  module in tests does NOT start the sweeper thread.  Each test that drives
  lifecycle does so via direct _sweep_once() calls.
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
    _mark_active,
    _sweep_once,
    _stamp,
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
# Minimal fake Context (tools only call _session_id(ctx) → id(ctx.session))
# ---------------------------------------------------------------------------


class _FakeSession:
    def __init__(self, sid: str = "test-session") -> None:
        self._sid = sid  # stored for test readability; _session_id now uses id()


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
    # I6: use context-manager pattern to ensure the test client is closed.
    test_client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5.0)
    mcp_server._http = test_client

    try:
        yield tmp_path, port
    finally:
        test_client.close()  # I6: explicit close before restoring original
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


def _open_ws_and_drain(port: int) -> tuple[simple_websocket.Client, list[dict], list[Exception]]:
    """Open a WS connection, wait until the server has registered it.

    Returns (ws_client, messages_list, reader_errors).  Messages are appended
    as they arrive in a background thread so the test can continue making HTTP
    calls.  Any exceptions encountered by the reader thread are collected into
    reader_errors so tests can surface them on timeout.
    """
    ws = simple_websocket.Client(f"ws://127.0.0.1:{port}/ws")
    messages: list[dict] = []
    reader_errors: list[Exception] = []  # M8: sidecar for reader exceptions

    def _reader():
        try:
            while True:
                raw = ws.receive(timeout=2.0)
                if raw is None:
                    break
                messages.append(json.loads(raw))
        except Exception as exc:
            # M8: only collect non-trivial exceptions (not normal disconnect)
            if not isinstance(exc, (simple_websocket.ConnectionClosed,)):
                reader_errors.append(exc)

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
                return ws, messages, reader_errors
            time.sleep(0.01)
        break

    # If we get here the ping never arrived — return anyway; the test will fail
    # with a meaningful assertion.
    messages.clear()
    return ws, messages, reader_errors


def _wait_for_broadcast(
    messages: list[dict],
    msg_type: str,
    timeout: float = 2.0,
    reader_errors: list[Exception] | None = None,
) -> list[dict]:
    """Wait until at least one message of the given type appears; return all matching.

    M8: If timeout is reached and reader_errors is provided, surface any
    accumulated reader exceptions as part of the assertion message.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        matching = [m for m in messages if m.get("type") == msg_type]
        if matching:
            return matching
        time.sleep(0.01)
    if reader_errors:
        raise AssertionError(
            f"Timed out waiting for broadcast type {msg_type!r}. "
            f"Reader thread errors: {reader_errors}"
        )
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
# AC#2 — create_diagram: writes file, no broadcast at all
# ---------------------------------------------------------------------------


class TestCreateDiagram:
    def test_create_writes_file_and_does_not_broadcast(self, live_server):
        tmp_path, port = live_server

        # Pre-warm session state so the on-transition fires before we open WS.
        # This ensures the WS listener only sees diagram-operation broadcasts,
        # not the lifecycle remote-control:on event from _stamp's 0→1 detection.
        mcp_server._was_active = True

        ws, messages, reader_errors = _open_ws_and_drain(port)

        diagram = Diagram.model_validate(_MINIMAL_DOC)
        result = create_diagram(diagram=diagram, ctx=_ctx())

        assert "id" in result
        diagram_id = result["id"]

        # File must exist under DATA_DIR
        assert (tmp_path / f"{diagram_id}.json").exists(), (
            f"Expected file {diagram_id}.json in {tmp_path}"
        )

        # M7: No broadcast of any kind should have been emitted by create_diagram.
        # Wait a brief moment to give any spurious broadcast time to arrive.
        time.sleep(0.15)
        assert messages == [], (
            f"create_diagram must not emit any broadcast; got: {messages}"
        )

        ws.close()

    def test_real_fastmcp_dispatch_pydantic_coercion(self, live_server):
        """I5: Exercise the pydantic coercion round-trip via FastMCP's tool registry.

        Strategy: locate create_diagram's Tool object via list_tools(), extract
        Tool.fn, and call it with a Diagram.model_validate(dict).  This proves
        the @mcp.tool() decorator's pydantic coercion path works end-to-end.
        See module docstring for rationale.
        """
        _tmp_path, _port = live_server
        tools = {t.name: t for t in mcp._tool_manager.list_tools()}
        create_tool = tools["create_diagram"]
        fn = create_tool.fn

        diagram = Diagram.model_validate(_MINIMAL_DOC)
        result = fn(diagram=diagram, ctx=_ctx())

        assert "id" in result
        assert "diagram" in result
        # Verify pydantic round-trip: echoed diagram has the expected node guids
        returned_guids = {n["guid"] for n in result["diagram"]["nodes"]}
        assert _PROCESS_GUID in returned_guids
        assert _DATA_STORE_GUID in returned_guids


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

        ws, messages, reader_errors = _open_ws_and_drain(port)

        # Now update it
        updated_doc = dict(_MINIMAL_DOC)
        updated_doc["meta"] = {"name": "Updated Name"}
        update_diagram(
            diagram_id=diagram_id,
            diagram=Diagram.model_validate(updated_doc),
            ctx=_ctx(),
        )

        matching = _wait_for_broadcast(messages, "diagram-updated", reader_errors=reader_errors)
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

        ws, messages, reader_errors = _open_ws_and_drain(port)

        result = delete_diagram(diagram_id=diagram_id, ctx=_ctx())
        assert result == {"ok": True}

        # File must be gone
        assert not (tmp_path / f"{diagram_id}.json").exists(), (
            f"File {diagram_id}.json should have been deleted"
        )

        # Exactly one diagram-deleted broadcast with correct id
        matching = _wait_for_broadcast(messages, "diagram-deleted", reader_errors=reader_errors)
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

        ws, messages, reader_errors = _open_ws_and_drain(port)

        result = display_diagram(diagram_id=diagram_id, ctx=_ctx())
        assert result == {"ok": True}

        # Exactly one display broadcast with correct id
        matching = _wait_for_broadcast(messages, "display", reader_errors=reader_errors)
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

        result = get_diagram(diagram_id=diagram_id, ctx=_ctx())

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
# AC#8 — remote-control lifecycle: on/off transitions
# ---------------------------------------------------------------------------


class TestRemoteControlLifecycle:
    """Acceptance #8: opening a session emits remote-control:on, expiry emits :off.

    Strategy (a): drive _sweep_once() synchronously.
    - Stamp a fake session → _sweep_once() sees it as active → emits 'on'.
    - Wait past SESSION_EXPIRY_SECONDS using a fake 'now' value far in the
      future, don't re-stamp → _sweep_once() evicts the session → emits 'off'.
    This avoids any sleep and doesn't require the daemon thread to run.

    I3: _stamp now emits the on-transition synchronously (0→1 path handled in
    _mark_active), so test_remote_control_on_via_stamp verifies this directly
    without needing _sweep_once at all.
    """

    def test_remote_control_on_via_stamp(self, live_server):
        """I3: _stamp emits remote-control:on synchronously on the first session."""
        _tmp_path, port = live_server
        ws, messages, reader_errors = _open_ws_and_drain(port)

        # _stamp should detect 0→1 and broadcast on immediately
        _stamp(_ctx("rc-test-stamp"))

        matching = _wait_for_broadcast(messages, "remote-control", reader_errors=reader_errors)
        on_msgs = [m for m in matching if m.get("payload", {}).get("state") == "on"]
        assert len(on_msgs) == 1, (
            f"Expected exactly one remote-control:on broadcast from _stamp, got: {matching}"
        )

        ws.close()

    def test_remote_control_on_when_session_stamps(self, live_server):
        _tmp_path, port = live_server
        ws, messages, reader_errors = _open_ws_and_drain(port)

        # Stamp a session so _last_seen is non-empty — this emits 'on' via _stamp
        mcp_server._stamp(_ctx("rc-test-on"))

        matching = _wait_for_broadcast(messages, "remote-control", reader_errors=reader_errors)
        on_msgs = [m for m in matching if m.get("payload", {}).get("state") == "on"]
        assert len(on_msgs) == 1, (
            f"Expected exactly one remote-control:on broadcast, got: {matching}"
        )

        ws.close()

    def test_remote_control_off_when_session_expires(self, live_server):
        _tmp_path, port = live_server

        # Pre-stamp a session and verify active state (on emitted via _stamp)
        mcp_server._stamp(_ctx("rc-test-off"))
        assert mcp_server._was_active is True

        ws, messages, reader_errors = _open_ws_and_drain(port)

        # Sweep with a 'now' far enough in the future to evict the session
        far_future = time.monotonic() + mcp_server.SESSION_EXPIRY_SECONDS + 1
        envelope = _sweep_once(now=far_future)
        assert envelope is not None, "Expected _sweep_once to return off-envelope"
        mcp_server._broadcast(envelope)

        matching = _wait_for_broadcast(messages, "remote-control", reader_errors=reader_errors)
        off_msgs = [m for m in matching if m.get("payload", {}).get("state") == "off"]
        assert len(off_msgs) == 1, (
            f"Expected exactly one remote-control:off broadcast, got: {matching}"
        )
        assert mcp_server._was_active is False

        ws.close()

    def test_no_duplicate_on_if_already_active(self, live_server):
        """_stamp must not re-emit 'on' if _was_active is already True."""
        _tmp_path, port = live_server

        # Drive to active via first stamp (reuse the same ctx so id() is stable)
        ctx_dedup = _ctx("rc-dedup")
        mcp_server._stamp(ctx_dedup)
        assert mcp_server._was_active is True

        ws, messages, reader_errors = _open_ws_and_drain(port)

        # Stamp again (same ctx object / same session identity) — should not emit another 'on'
        mcp_server._stamp(ctx_dedup)
        time.sleep(0.1)  # allow any spurious broadcast to arrive

        on_msgs = [
            m for m in messages
            if m.get("type") == "remote-control" and m.get("payload", {}).get("state") == "on"
        ]
        assert on_msgs == [], f"Should not re-emit on when already active; got: {on_msgs}"

        ws.close()


# ---------------------------------------------------------------------------
# I5 — sad-path tests: nonexistent diagram ids raise, no broadcasts emitted
# ---------------------------------------------------------------------------


class TestSadPaths:
    """I5: Tools must raise on nonexistent ids and must not emit spurious broadcasts."""

    def _operation_broadcasts(self, messages: list[dict]) -> list[dict]:
        """Return only diagram-operation broadcasts, excluding lifecycle events.

        The remote-control:on lifecycle broadcast from _stamp's 0→1 detection
        is correct behavior and is not an "operation" broadcast.  Sad-path
        tests assert that no operation-specific broadcasts are emitted on error.
        """
        operation_types = {"diagram-updated", "diagram-deleted", "display"}
        return [m for m in messages if m.get("type") in operation_types]

    def test_get_diagram_nonexistent_raises(self, live_server):
        """get_diagram on a missing id raises an HTTP error; no operation broadcast emitted."""
        _tmp_path, port = live_server
        # Pre-warm so on-transition doesn't fire mid-test
        mcp_server._was_active = True
        ws, messages, _reader_errors = _open_ws_and_drain(port)

        with pytest.raises(httpx.HTTPStatusError):
            get_diagram(diagram_id="does-not-exist", ctx=_ctx())

        time.sleep(0.1)
        op_msgs = self._operation_broadcasts(messages)
        assert op_msgs == [], (
            f"get_diagram on missing id must not emit any operation broadcast; got: {op_msgs}"
        )

        ws.close()

    def test_update_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server):
        """update_diagram on a missing id raises; no diagram-updated emitted."""
        _tmp_path, port = live_server
        # Pre-warm so on-transition doesn't fire mid-test
        mcp_server._was_active = True
        ws, messages, _reader_errors = _open_ws_and_drain(port)

        diagram = Diagram.model_validate(_MINIMAL_DOC)
        with pytest.raises(httpx.HTTPStatusError):
            update_diagram(diagram_id="does-not-exist", diagram=diagram, ctx=_ctx())

        time.sleep(0.1)
        updated_msgs = [m for m in messages if m.get("type") == "diagram-updated"]
        assert updated_msgs == [], (
            f"update_diagram on missing id must not emit diagram-updated; got: {updated_msgs}"
        )

        ws.close()

    def test_delete_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server):
        """delete_diagram on a missing id raises; no diagram-deleted emitted."""
        _tmp_path, port = live_server
        # Pre-warm so on-transition doesn't fire mid-test
        mcp_server._was_active = True
        ws, messages, _reader_errors = _open_ws_and_drain(port)

        with pytest.raises(httpx.HTTPStatusError):
            delete_diagram(diagram_id="does-not-exist", ctx=_ctx())

        time.sleep(0.1)
        deleted_msgs = [m for m in messages if m.get("type") == "diagram-deleted"]
        assert deleted_msgs == [], (
            f"delete_diagram on missing id must not emit diagram-deleted; got: {deleted_msgs}"
        )

        ws.close()
