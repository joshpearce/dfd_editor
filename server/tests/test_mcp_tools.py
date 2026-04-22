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

import copy
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
# Minimal fake Context
# ---------------------------------------------------------------------------
#
# _session_id(ctx) reads `ctx.session` and uses it as the key into a
# WeakKeyDictionary. All we need from the stub is a regular Python object
# that is weakly referenceable and hashable — a plain class instance
# satisfies both. The real FastMCP Context.session is a ServerSession; our
# stub exercises the same code path (attribute access + identity-keyed
# lookup) without requiring an actual MCP handshake.
#
# The `_reset_mcp_state` autouse fixture clears both the WeakKey map and
# the id()-keyed fallback between tests so stale ids can't collide.


class _FakeSession:
    """Stand-in for FastMCP's ServerSession — only needs to be hashable and
    weakly referenceable."""
    def __init__(self) -> None:
        pass


class _FakeContext:
    """Stand-in for FastMCP's Context — only `.session` is accessed by the
    module under test."""
    def __init__(self) -> None:
        self.session = _FakeSession()


def _ctx() -> _FakeContext:
    return _FakeContext()


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
    # Clear per-session UUID tables so object-address reuse across tests
    # can't produce stale-UUID collisions.
    with mcp_server._session_uuid_lock:
        mcp_server._session_uuids.clear()
        mcp_server._fallback_uuids.clear()


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
            if not isinstance(exc, simple_websocket.ConnectionClosed):
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
    *,
    timeout: float = 2.0,
    grace_ms: int = 50,
    reader_errors: list[Exception] | None = None,
) -> list[dict]:
    """Wait until at least one message of the given type appears; then wait a
    grace period and return *all* matching messages collected up to that point.

    The grace period lets any duplicate broadcasts arrive before the caller
    asserts ``len(matching) == 1``, making exactly-one semantics detectable.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        matches = [m for m in messages if m.get("type") == msg_type]
        if matches:
            # Grace period: allow any duplicate broadcasts to arrive.
            time.sleep(grace_ms / 1000)
            return [m for m in messages if m.get("type") == msg_type]
        time.sleep(0.01)
    error_context = f"; reader errors: {reader_errors}" if reader_errors else ""
    raise AssertionError(
        f"timed out waiting for {msg_type!r}; got {messages!r}{error_context}"
    )


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
    def test_create_writes_file_and_does_not_broadcast(self, live_server, monkeypatch):
        tmp_path, _port = live_server

        # Pre-warm session state so the 0→1 lifecycle transition doesn't fire
        # during the test and mask the create-specific assertion.
        mcp_server._was_active = True

        # M14: spy on _broadcast to turn "prove a negative" into a deterministic
        # assertion — no sleeps, no WS plumbing required.
        calls: list[dict] = []
        real_broadcast = mcp_server._broadcast

        def spy_broadcast(envelope: dict) -> bool:
            calls.append(envelope)
            return real_broadcast(envelope)

        monkeypatch.setattr(mcp_server, "_broadcast", spy_broadcast)

        diagram = Diagram.model_validate(_MINIMAL_DOC)
        result = create_diagram(diagram=diagram, ctx=_ctx())

        assert "id" in result
        diagram_id = result["id"]
        assert (tmp_path / f"{diagram_id}.json").exists(), (
            f"Expected file {diagram_id}.json in {tmp_path}"
        )
        assert calls == [], (
            f"create_diagram must not invoke _broadcast; got: {calls}"
        )

    def test_real_fastmcp_dispatch_pydantic_coercion(self, live_server):
        """I2: Exercise FastMCP's real arg-validation/coercion path with a raw dict.

        Strategy (option a): locate the create_diagram Tool via list_tools(),
        then call tool.fn_metadata.call_fn_with_arg_validation() passing a raw
        dict for 'diagram'.  This exercises the actual pydantic coercion that
        FastMCP performs before invoking the tool function — a pre-validated
        Diagram instance would bypass it entirely.

        SDK attributes used: Tool.fn_metadata (FuncMetadata),
        FuncMetadata.call_fn_with_arg_validation (async).
        """
        import asyncio

        _tmp_path, _port = live_server
        # Pre-warm session state so the on-transition doesn't interfere.
        mcp_server._was_active = True

        tools = {t.name: t for t in mcp._tool_manager.list_tools()}
        create_tool = tools["create_diagram"]

        # Pass a raw dict — FastMCP's arg validator must coerce it to Diagram.
        result = asyncio.run(
            create_tool.fn_metadata.call_fn_with_arg_validation(
                create_tool.fn,
                fn_is_async=False,
                arguments_to_validate={"diagram": copy.deepcopy(_MINIMAL_DOC)},
                arguments_to_pass_directly={"ctx": _ctx()},
            )
        )

        assert "id" in result, f"Expected 'id' in result; got {result!r}"
        assert "diagram" in result, f"Expected 'diagram' in result; got {result!r}"
        # The echoed diagram must contain the nodes we passed in the raw dict.
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
        updated_doc = copy.deepcopy(_MINIMAL_DOC)
        updated_doc["meta"] = {"name": "Updated Name"}
        update_result = update_diagram(
            diagram_id=diagram_id,
            diagram=Diagram.model_validate(updated_doc),
            ctx=_ctx(),
        )

        # M2/M3: update tool now reports broadcast delivery status alongside id+diagram.
        assert update_result["broadcast_delivered"] is True
        assert update_result["id"] == diagram_id
        assert "diagram" in update_result

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
        # M2/M3: delete tool now reports broadcast delivery status.
        assert result == {"ok": True, "broadcast_delivered": True}

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
        # M2/M3: display tool now reports broadcast delivery status.
        assert result == {"ok": True, "broadcast_delivered": True}

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
        d2_doc = copy.deepcopy(_MINIMAL_DOC)
        d2_doc["meta"] = {"name": "Second diagram"}
        d2 = Diagram.model_validate(d2_doc)

        r1 = create_diagram(diagram=d1, ctx=_ctx())
        r2 = create_diagram(diagram=d2, ctx=_ctx())

        result = list_diagrams(ctx=_ctx())

        assert isinstance(result, list)
        # Result rows are now DiagramSummary pydantic models (M13).
        ids = {item.id for item in result}
        assert r1["id"] in ids, f"id {r1['id']} missing from list_diagrams result"
        assert r2["id"] in ids, f"id {r2['id']} missing from list_diagrams result"

        # Each summary object must carry id, name, and modified
        for item in result:
            assert item.id
            assert item.name
            assert isinstance(item.modified, float)

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
        _stamp(_ctx())

        matching = _wait_for_broadcast(messages, "remote-control", reader_errors=reader_errors)
        on_msgs = [m for m in matching if m.get("payload", {}).get("state") == "on"]
        assert len(on_msgs) == 1, (
            f"Expected exactly one remote-control:on broadcast from _stamp, got: {matching}"
        )

        ws.close()

    def test_remote_control_off_when_session_expires(self, live_server):
        _tmp_path, port = live_server

        # Pre-stamp a session and verify active state (on emitted via _stamp)
        mcp_server._stamp(_ctx())
        assert mcp_server._was_active is True

        ws, messages, reader_errors = _open_ws_and_drain(port)

        # Sweep with a 'now' far enough in the future to evict the session.
        # _sweep_once broadcasts the off-envelope internally and returns True
        # on an off-transition so the test can assert without inspecting
        # envelope shape.
        far_future = time.monotonic() + mcp_server.SESSION_EXPIRY_SECONDS + 1
        assert _sweep_once(now=far_future) is True, "Expected _sweep_once to return True (off-transition emitted)"

        matching = _wait_for_broadcast(messages, "remote-control", reader_errors=reader_errors)
        off_msgs = [m for m in matching if m.get("payload", {}).get("state") == "off"]
        assert len(off_msgs) == 1, (
            f"Expected exactly one remote-control:off broadcast, got: {matching}"
        )
        assert mcp_server._was_active is False

        ws.close()

    def test_session_id_is_stable_uuid_per_session(self, live_server):
        """I2: _session_id returns a stable UUID per ctx.session (not id()-based)."""
        _tmp_path, _port = live_server
        ctx_a = _ctx()
        ctx_b = _ctx()

        # Same ctx → same id across calls (UUID cached in WeakKeyDictionary)
        assert mcp_server._session_id(ctx_a) == mcp_server._session_id(ctx_a)
        # Distinct sessions → distinct ids
        assert mcp_server._session_id(ctx_a) != mcp_server._session_id(ctx_b)
        # Must be a UUID, not an int-string (address-reuse hardening)
        sid = mcp_server._session_id(ctx_a)
        assert len(sid) == 36, f"Expected UUID-length session id, got {sid!r}"
        assert "-" in sid, f"Expected UUID-formatted session id, got {sid!r}"

    def test_no_duplicate_on_if_already_active(self, live_server, monkeypatch):
        """_stamp must not re-emit 'on' if _was_active is already True.

        M14: uses a _broadcast spy instead of WS wait — deterministic, no sleep.
        """
        _tmp_path, _port = live_server

        ctx_dedup = _ctx()
        mcp_server._stamp(ctx_dedup)
        assert mcp_server._was_active is True

        # After the first stamp, patch _broadcast so subsequent calls get
        # captured. The first on-broadcast already fired through the real
        # _broadcast above.
        calls: list[dict] = []
        monkeypatch.setattr(
            mcp_server,
            "_broadcast",
            lambda envelope: (calls.append(envelope), True)[1],
        )

        # Stamp again with the same session — must NOT call _broadcast again.
        mcp_server._stamp(ctx_dedup)
        assert calls == [], (
            f"Second stamp on same session must not re-broadcast; got: {calls}"
        )

    def test_on_broadcast_failure_is_rolled_back(self, live_server, monkeypatch):
        """Broadcast failure on the 0→1 transition must roll _was_active back
        so the next tool call retries — otherwise the browser stays interactive
        while the MCP server thinks it's locked.
        """
        _tmp_path, _port = live_server

        # Make _broadcast fail exactly once, succeed on the retry.
        call_count = {"n": 0}
        real_broadcast = mcp_server._broadcast

        def flaky_broadcast(envelope):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return False  # simulate Flask unreachable
            return real_broadcast(envelope)

        monkeypatch.setattr(mcp_server, "_broadcast", flaky_broadcast)

        ctx = _ctx()
        mcp_server._stamp(ctx)
        # First attempt failed → state must have rolled back
        assert mcp_server._was_active is False, (
            "Expected _was_active to roll back after failed broadcast"
        )

        # Second stamp succeeds → state flips to True
        mcp_server._stamp(ctx)
        assert mcp_server._was_active is True
        assert call_count["n"] == 2, "Expected two broadcast attempts"

    def test_off_broadcast_failure_is_rolled_back(self, live_server, monkeypatch):
        """Broadcast failure on the 1→0 transition must restore _was_active
        so the next sweep retries — otherwise the browser stays in read-only
        forever after a transient Flask outage.
        """
        _tmp_path, _port = live_server

        # Pre-stamp a session so we're in the active state.
        ctx = _ctx()
        mcp_server._stamp(ctx)
        assert mcp_server._was_active is True

        # Make _broadcast fail once (this is the off-transition), succeed on retry.
        call_count = {"n": 0}
        real_broadcast = mcp_server._broadcast

        def flaky_broadcast(envelope):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return False
            return real_broadcast(envelope)

        monkeypatch.setattr(mcp_server, "_broadcast", flaky_broadcast)

        # First sweep expires the session, broadcast fails, state rolls back.
        far_future = time.monotonic() + mcp_server.SESSION_EXPIRY_SECONDS + 1
        result = _sweep_once(now=far_future)
        assert result is False, "Expected rollback to report False"
        assert mcp_server._was_active is True, (
            "Expected _was_active to roll back on failed off-broadcast"
        )
        # _last_seen was already cleared during the sweep — re-stamp wouldn't
        # be a 1→0, so we simulate another sweep tick: the next sweep retries.
        result2 = _sweep_once(now=far_future + 1)
        assert result2 is True, "Expected successful retry on next sweep"
        assert mcp_server._was_active is False
        assert call_count["n"] == 2


# ---------------------------------------------------------------------------
# I5 — sad-path tests: nonexistent diagram ids raise, no broadcasts emitted
# ---------------------------------------------------------------------------


class TestSadPaths:
    """I5 / M14: Tools must raise on nonexistent ids and must not call _broadcast.

    Uses a _broadcast spy (monkeypatch) instead of WS message-wait timeouts —
    deterministic, no sleep-based "prove a negative" flakiness.
    """

    def _spy(self, monkeypatch):
        """Install a _broadcast spy that records invocations and returns success."""
        calls: list[dict] = []

        def spy_broadcast(envelope: dict) -> bool:
            calls.append(envelope)
            return True

        monkeypatch.setattr(mcp_server, "_broadcast", spy_broadcast)
        return calls

    def _operation_types(self, calls: list[dict]) -> list[str]:
        op = {"diagram-updated", "diagram-deleted", "display"}
        return [c["type"] for c in calls if c.get("type") in op]

    def test_get_diagram_nonexistent_raises(self, live_server, monkeypatch):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls = self._spy(monkeypatch)

        with pytest.raises(httpx.HTTPStatusError):
            get_diagram(diagram_id="does-not-exist", ctx=_ctx())

        assert self._operation_types(calls) == [], (
            f"get_diagram on missing id must not call _broadcast; got: {calls}"
        )

    def test_update_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server, monkeypatch):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls = self._spy(monkeypatch)

        diagram = Diagram.model_validate(_MINIMAL_DOC)
        with pytest.raises(httpx.HTTPStatusError):
            update_diagram(diagram_id="does-not-exist", diagram=diagram, ctx=_ctx())

        assert [c["type"] for c in calls if c.get("type") == "diagram-updated"] == [], (
            f"update_diagram on missing id must not broadcast; got: {calls}"
        )

    def test_delete_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server, monkeypatch):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls = self._spy(monkeypatch)

        with pytest.raises(httpx.HTTPStatusError):
            delete_diagram(diagram_id="does-not-exist", ctx=_ctx())

        assert [c["type"] for c in calls if c.get("type") == "diagram-deleted"] == [], (
            f"delete_diagram on missing id must not broadcast; got: {calls}"
        )

    def test_display_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server, monkeypatch):
        """display_diagram pre-checks the id and raises on missing, so the
        browser is never told to load something that can't exist."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls = self._spy(monkeypatch)

        with pytest.raises(httpx.HTTPStatusError):
            display_diagram(diagram_id="does-not-exist", ctx=_ctx())

        assert [c["type"] for c in calls if c.get("type") == "display"] == [], (
            f"display_diagram on missing id must not broadcast; got: {calls}"
        )
