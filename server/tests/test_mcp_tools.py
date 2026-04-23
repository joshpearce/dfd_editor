"""Tests for MCP server tools in mcp_server.py.

Architecture:
  - A real Flask app runs on an ephemeral port in a daemon thread so the
    WS endpoint and broadcast fanout are exercised end-to-end.
  - ``ws._loopback_http`` is swapped to target the ephemeral port so the
    MCP broadcast path (``ws.post_broadcast_envelope``) hits the test
    Flask rather than a separately-running process.
  - ``storage.DATA_DIR`` is monkeypatched to a per-test tmp_path; both
    the Flask app and ``agent_service`` (called in-process by MCP tools)
    read from the same directory.
  - Sweeper lifecycle is driven synchronously via ``_sweep_once()`` —
    no sleeps, no daemon thread.

Tool function access:
  ``@mcp.tool()`` registers functions by reference without wrapping, so
  the named imports below are directly callable as plain Python.

FastMCP dispatch test:
  ``create_diagram`` / ``update_diagram`` accept ``diagram: dict`` and
  validate via ``Diagram.model_validate`` inside the tool body. To
  exercise the full FastMCP dispatch path we locate the tool via
  ``mcp._tool_manager.list_tools()`` and call
  ``tool.fn_metadata.call_fn_with_arg_validation()`` with a raw dict —
  the same shape an agent sends over the wire.
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

import mcp_server
import storage
import ws as ws_module
from app import app
from mcp_server import (
    _mark_active,
    _sweep_once,
    _stamp,
    add_element,
    create_diagram,
    delete_diagram,
    delete_element,
    display_diagram,
    get_diagram,
    list_diagrams,
    mcp,
    reparent_element,
    update_diagram,
    update_element,
)

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
    """Spin up Flask on an ephemeral port, redirect the MCP broadcast loopback to it."""
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    srv = make_server("127.0.0.1", 0, app, threaded=True)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    # Swap the loopback HTTP client so MCP broadcasts hit the ephemeral
    # port. post_broadcast_envelope reads ws._loopback_http at call time,
    # so module-level rebinding is sufficient.
    original_http = ws_module._loopback_http
    test_client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5.0)
    ws_module._loopback_http = test_client

    try:
        yield tmp_path, port
    finally:
        test_client.close()
        ws_module._loopback_http = original_http
        srv.shutdown()


# ---------------------------------------------------------------------------
# Autouse: drain _ws_clients after every test (mirrors test_crud_extras.py)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _drain_ws_clients():
    yield
    ws_module.clear()


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
    """AC#1: mcp._tool_manager.list_tools() enumerates all registered tools."""

    def test_all_tools_registered(self):
        # list_tools() is synchronous; _tools is a dict keyed by tool name.
        # We use list_tools() (the public API) rather than accessing _tools
        # directly to stay one level of abstraction above internals.
        tools = mcp._tool_manager.list_tools()
        names = {t.name for t in tools}
        assert names == {
            "list_diagrams",
            "get_diagram",
            "get_diagram_schema",
            "create_diagram",
            "update_diagram",
            "delete_diagram",
            "display_diagram",
            "add_element",
            "update_element",
            "delete_element",
            "reparent_element",
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

        result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())

        assert "id" in result
        diagram_id = result["id"]
        assert (tmp_path / f"{diagram_id}.json").exists(), (
            f"Expected file {diagram_id}.json in {tmp_path}"
        )
        assert calls == [], (
            f"create_diagram must not invoke _broadcast; got: {calls}"
        )

    def test_real_fastmcp_dispatch_with_raw_dict(self, live_server):
        """Exercise FastMCP's real arg-validation + tool-invocation path with a raw dict.

        `create_diagram` now accepts `diagram: dict` so the tool body is the
        validation point (`Diagram.model_validate(diagram)` runs inside the
        tool). This test drives the full FastMCP dispatch path to prove the
        end-to-end handshake works with an agent-shaped argument payload.

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
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        ws, messages, reader_errors = _open_ws_and_drain(port)

        # Now update it
        updated_doc = copy.deepcopy(_MINIMAL_DOC)
        updated_doc["meta"] = {"name": "Updated Name"}
        update_result = update_diagram(
            diagram_id=diagram_id,
            diagram=updated_doc,
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
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
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
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
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
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
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
        d2_doc = copy.deepcopy(_MINIMAL_DOC)
        d2_doc["meta"] = {"name": "Second diagram"}

        r1 = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        r2 = create_diagram(diagram=d2_doc, ctx=_ctx())

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
# get_diagram_schema — returns the pydantic JSON schema for agents that want
# the formal contract beyond the create_diagram docstring example.
# ---------------------------------------------------------------------------


class TestGetDiagramSchema:
    def test_returns_diagram_json_schema(self):
        from mcp_server import get_diagram_schema

        schema = get_diagram_schema()

        assert isinstance(schema, dict)
        assert schema.get("title") == "Diagram"
        # Required top-level fields of the minimal document format.
        properties = schema.get("properties", {})
        for key in ("meta", "nodes", "containers", "data_flows", "data_items"):
            assert key in properties, f"schema missing top-level property: {key}"


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

        with pytest.raises(storage.DiagramNotFoundError):
            get_diagram(diagram_id="does-not-exist", ctx=_ctx())

        assert self._operation_types(calls) == [], (
            f"get_diagram on missing id must not call _broadcast; got: {calls}"
        )

    def test_update_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server, monkeypatch):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls = self._spy(monkeypatch)

        with pytest.raises(storage.DiagramNotFoundError):
            update_diagram(diagram_id="does-not-exist", diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())

        assert [c["type"] for c in calls if c.get("type") == "diagram-updated"] == [], (
            f"update_diagram on missing id must not broadcast; got: {calls}"
        )

    def test_delete_diagram_nonexistent_raises_and_does_not_broadcast(self, live_server, monkeypatch):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls = self._spy(monkeypatch)

        with pytest.raises(storage.DiagramNotFoundError):
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

        with pytest.raises(storage.DiagramNotFoundError):
            display_diagram(diagram_id="does-not-exist", ctx=_ctx())

        assert [c["type"] for c in calls if c.get("type") == "display"] == [], (
            f"display_diagram on missing id must not broadcast; got: {calls}"
        )


# ---------------------------------------------------------------------------
# add_element — granular element CRUD: append to a diagram collection
# ---------------------------------------------------------------------------

_NEW_NODE_GUID = "aaaaaaaa-0000-0000-0000-000000000001"
_NEW_CONTAINER_GUID = "bbbbbbbb-0000-0000-0000-000000000001"
_NEW_DATA_ITEM_GUID = "cccccccc-0000-0000-0000-000000000001"


class TestAddElement:
    def test_add_node_appends_and_broadcasts(self, live_server):
        tmp_path, port = live_server
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        ws, messages, reader_errors = _open_ws_and_drain(port)

        new_node = {
            "type": "external_entity",
            "guid": _NEW_NODE_GUID,
            "properties": {"name": "New EE"},
        }
        result = add_element(
            diagram_id=diagram_id,
            collection="nodes",
            element=new_node,
            ctx=_ctx(),
        )

        assert result["guid"] == _NEW_NODE_GUID
        assert result["broadcast_delivered"] is True

        # Verify node is present in the stored diagram
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        guids = {n["guid"] for n in fetched["nodes"]}
        assert _NEW_NODE_GUID in guids

        matching = _wait_for_broadcast(messages, "diagram-updated", reader_errors=reader_errors)
        assert len(matching) == 1
        assert matching[0]["payload"]["id"] == diagram_id

        ws.close()

    def test_add_container_appends(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        new_container = {
            "type": "trust_boundary",
            "guid": _NEW_CONTAINER_GUID,
            "properties": {"name": "VPC"},
            "children": [],
        }
        result = add_element(
            diagram_id=diagram_id,
            collection="containers",
            element=new_container,
            ctx=_ctx(),
        )

        assert result["guid"] == _NEW_CONTAINER_GUID
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        container_guids = {c["guid"] for c in fetched["containers"]}
        assert _NEW_CONTAINER_GUID in container_guids

    def test_add_data_item_appends(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        new_item = {
            "guid": _NEW_DATA_ITEM_GUID,
            "identifier": "D1",
            "name": "Customer PII",
            "classification": "pii",
        }
        result = add_element(
            diagram_id=diagram_id,
            collection="data_items",
            element=new_item,
            ctx=_ctx(),
        )

        assert result["guid"] == _NEW_DATA_ITEM_GUID
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        item_guids = {di["guid"] for di in fetched.get("data_items", [])}
        assert _NEW_DATA_ITEM_GUID in item_guids

    def test_invalid_collection_raises_value_error(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        with pytest.raises(ValueError, match="invalid collection"):
            add_element(
                diagram_id=diagram_id,
                collection="edges",
                element={"guid": "00000000-0000-0000-0000-000000000099"},
                ctx=_ctx(),
            )

    def test_missing_guid_raises_value_error(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        with pytest.raises(ValueError, match="guid"):
            add_element(
                diagram_id=diagram_id,
                collection="nodes",
                element={"type": "process", "properties": {"name": "No GUID"}},
                ctx=_ctx(),
            )

    def test_nonexistent_diagram_raises(self, live_server, monkeypatch):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        calls: list[dict] = []
        monkeypatch.setattr(
            mcp_server,
            "_broadcast",
            lambda envelope: (calls.append(envelope), True)[1],
        )

        with pytest.raises(Exception):
            add_element(
                diagram_id="does-not-exist",
                collection="nodes",
                element={"guid": _NEW_NODE_GUID, "type": "process", "properties": {"name": "X"}},
                ctx=_ctx(),
            )

        assert [c["type"] for c in calls if c.get("type") == "diagram-updated"] == [], (
            f"add_element on missing diagram must not broadcast; got: {calls}"
        )

    def test_schema_invalid_element_raises_validation_error(self, live_server):
        """_save_minimal runs Diagram.model_validate — invalid element fails."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        # A node with an unknown type should fail Diagram validation.
        bad_node = {
            "type": "not_a_real_type",
            "guid": _NEW_NODE_GUID,
            "properties": {"name": "Bad"},
        }
        with pytest.raises(Exception):
            add_element(
                diagram_id=diagram_id,
                collection="nodes",
                element=bad_node,
                ctx=_ctx(),
            )

        # Original diagram must be unchanged (no partial write)
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        guids = {n["guid"] for n in fetched["nodes"]}
        assert _NEW_NODE_GUID not in guids

    def test_duplicate_guid_raises_value_error(self, live_server):
        """add_element must reject an element whose guid already exists in the diagram."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        # _PROCESS_GUID is already in the diagram (from _MINIMAL_DOC)
        duplicate_node = {
            "type": "process",
            "guid": _PROCESS_GUID,
            "properties": {"name": "Duplicate"},
        }
        with pytest.raises(ValueError, match="already exists"):
            add_element(
                diagram_id=diagram_id,
                collection="nodes",
                element=duplicate_node,
                ctx=_ctx(),
            )

        # Diagram should be unchanged
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        assert sum(1 for n in fetched["nodes"] if n["guid"] == _PROCESS_GUID) == 1

    def test_add_element_schema_has_collection_enum(self):
        """FastMCP must advertise the collection parameter as an enum."""
        tools = {t.name: t for t in mcp._tool_manager.list_tools()}
        add_tool = tools["add_element"]
        schema = add_tool.parameters
        collection_schema = schema.get("properties", {}).get("collection", {})
        assert "enum" in collection_schema, (
            f"collection parameter schema missing 'enum'; got: {collection_schema}"
        )
        assert set(collection_schema["enum"]) == {
            "nodes", "containers", "data_flows", "data_items"
        }


# ---------------------------------------------------------------------------
# update_element — granular element CRUD: sparse-merge fields into an element
# ---------------------------------------------------------------------------

_UPDATE_DATA_ITEM_GUID = "dddddddd-0000-0000-0000-000000000001"


class TestUpdateElement:
    def test_update_node_name_and_broadcasts(self, live_server):
        tmp_path, port = live_server
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        ws, messages, reader_errors = _open_ws_and_drain(port)

        result = update_element(
            diagram_id=diagram_id,
            guid=_PROCESS_GUID,
            fields={"name": "Updated Process"},
            ctx=_ctx(),
        )

        assert result["guid"] == _PROCESS_GUID
        assert result["broadcast_delivered"] is True

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        node = next(n for n in fetched["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["properties"]["name"] == "Updated Process"

        matching = _wait_for_broadcast(messages, "diagram-updated", reader_errors=reader_errors)
        assert len(matching) == 1
        assert matching[0]["payload"]["id"] == diagram_id

        ws.close()

    def test_update_data_flow_name(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        result = update_element(
            diagram_id=diagram_id,
            guid=_FLOW_GUID,
            fields={"name": "Renamed Flow", "authenticated": True},
            ctx=_ctx(),
        )

        assert result["guid"] == _FLOW_GUID
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        flow = next(f for f in fetched["data_flows"] if f["guid"] == _FLOW_GUID)
        assert flow["properties"]["name"] == "Renamed Flow"
        assert flow["properties"]["authenticated"] is True

    def test_update_data_item_fields(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        add_element(
            diagram_id=diagram_id,
            collection="data_items",
            element={
                "guid": _UPDATE_DATA_ITEM_GUID,
                "identifier": "D1",
                "name": "Original Name",
                "classification": "unclassified",
            },
            ctx=_ctx(),
        )

        result = update_element(
            diagram_id=diagram_id,
            guid=_UPDATE_DATA_ITEM_GUID,
            fields={"name": "Renamed Item", "classification": "pii"},
            ctx=_ctx(),
        )

        assert result["guid"] == _UPDATE_DATA_ITEM_GUID
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        item = next(di for di in fetched["data_items"] if di["guid"] == _UPDATE_DATA_ITEM_GUID)
        assert item["name"] == "Renamed Item"
        assert item["classification"] == "pii"

    def test_readonly_keys_silently_skipped_for_nodes(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        update_element(
            diagram_id=diagram_id,
            guid=_PROCESS_GUID,
            fields={"guid": "should-be-ignored", "type": "data_store", "name": "OK"},
            ctx=_ctx(),
        )

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        node = next(n for n in fetched["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["guid"] == _PROCESS_GUID
        assert node["type"] == "process"
        assert node["properties"]["name"] == "OK"

    def test_readonly_keys_silently_skipped_for_data_flows(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        update_element(
            diagram_id=diagram_id,
            guid=_FLOW_GUID,
            fields={
                "guid": "should-be-ignored",
                "node1": "should-be-ignored",
                "node2": "should-be-ignored",
                "name": "Flow OK",
            },
            ctx=_ctx(),
        )

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        flow = next(f for f in fetched["data_flows"] if f["guid"] == _FLOW_GUID)
        assert flow["guid"] == _FLOW_GUID
        assert flow["node1"] == _PROCESS_GUID
        assert flow["node2"] == _DATA_STORE_GUID
        assert flow["properties"]["name"] == "Flow OK"

    def test_readonly_guid_skipped_for_data_items(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        add_element(
            diagram_id=diagram_id,
            collection="data_items",
            element={
                "guid": _UPDATE_DATA_ITEM_GUID,
                "identifier": "D1",
                "name": "Item",
                "classification": "unclassified",
            },
            ctx=_ctx(),
        )

        update_element(
            diagram_id=diagram_id,
            guid=_UPDATE_DATA_ITEM_GUID,
            fields={"guid": "should-be-ignored", "name": "Item Renamed"},
            ctx=_ctx(),
        )

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        item = next(di for di in fetched["data_items"] if di["guid"] == _UPDATE_DATA_ITEM_GUID)
        assert item["guid"] == _UPDATE_DATA_ITEM_GUID
        assert item["name"] == "Item Renamed"

    def test_nonexistent_guid_raises_value_error(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        with pytest.raises(ValueError, match="not found"):
            update_element(
                diagram_id=diagram_id,
                guid="00000000-ffff-ffff-ffff-000000000000",
                fields={"name": "X"},
                ctx=_ctx(),
            )

    def test_nonexistent_diagram_raises(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True

        with pytest.raises(Exception):
            update_element(
                diagram_id="does-not-exist",
                guid=_PROCESS_GUID,
                fields={"name": "X"},
                ctx=_ctx(),
            )

    def test_schema_invalid_field_raises(self, live_server):
        """_save_minimal validates — setting contains_pii to a string must fail."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        with pytest.raises(Exception):
            update_element(
                diagram_id=diagram_id,
                guid=_DATA_STORE_GUID,
                fields={"contains_pii": "yes_please"},
                ctx=_ctx(),
            )

        # Original diagram must be unchanged (no partial write)
        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        ds = next(n for n in fetched["nodes"] if n["guid"] == _DATA_STORE_GUID)
        assert ds["properties"].get("contains_pii") != "yes_please"


# ---------------------------------------------------------------------------
# delete_element — granular element CRUD: remove with cascade
# ---------------------------------------------------------------------------

_DEL_PROCESS_GUID = "eeeeeeee-0000-0000-0000-000000000001"
_DEL_STORE_GUID = "eeeeeeee-0000-0000-0000-000000000002"
_DEL_FLOW_GUID = "eeeeeeee-0000-0000-0000-000000000003"
_DEL_CONTAINER_GUID = "eeeeeeee-0000-0000-0000-000000000004"
_DEL_NESTED_CONTAINER_GUID = "eeeeeeee-0000-0000-0000-000000000005"
_DEL_DATA_ITEM_GUID = "eeeeeeee-0000-0000-0000-000000000006"


def _make_doc_for_delete() -> dict:
    """Build a diagram document with all cascade-relevant cross-references."""
    return {
        "meta": {"name": "delete_element test"},
        "nodes": [
            {"type": "process", "guid": _DEL_PROCESS_GUID, "properties": {"name": "P"}},
            {"type": "data_store", "guid": _DEL_STORE_GUID, "properties": {"name": "DS"}},
        ],
        "containers": [
            {
                "type": "trust_boundary",
                "guid": _DEL_CONTAINER_GUID,
                "properties": {"name": "TB"},
                "children": [_DEL_PROCESS_GUID, _DEL_NESTED_CONTAINER_GUID],
            },
            {
                "type": "trust_boundary",
                "guid": _DEL_NESTED_CONTAINER_GUID,
                "properties": {"name": "Inner TB"},
                "children": [],
            },
        ],
        "data_flows": [
            {
                "guid": _DEL_FLOW_GUID,
                "node1": _DEL_PROCESS_GUID,
                "node2": _DEL_STORE_GUID,
                "properties": {
                    "name": "F",
                    "node1_src_data_item_refs": [_DEL_DATA_ITEM_GUID],
                    "node2_src_data_item_refs": [],
                },
            }
        ],
        "data_items": [
            {
                "guid": _DEL_DATA_ITEM_GUID,
                "identifier": "D1",
                "name": "Item",
                "classification": "unclassified",
                "parent": _DEL_PROCESS_GUID,
            }
        ],
    }


class TestDeleteElement:
    def test_delete_data_flow_no_cascade(self, live_server):
        """Deleting a data_flow removes only that flow; no cascade_removed."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=_make_doc_for_delete(), ctx=_ctx())
        diagram_id = create_result["id"]

        result = delete_element(diagram_id=diagram_id, guid=_DEL_FLOW_GUID, ctx=_ctx())

        assert result["guid"] == _DEL_FLOW_GUID
        assert result["deleted_collection"] == "data_flows"
        assert result["cascade_removed"] == []
        assert result["broadcast_delivered"] is True

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        flow_guids = {f["guid"] for f in fetched.get("data_flows", [])}
        assert _DEL_FLOW_GUID not in flow_guids
        # Nodes and data_items must be untouched.
        node_guids = {n["guid"] for n in fetched["nodes"]}
        assert _DEL_PROCESS_GUID in node_guids
        assert _DEL_STORE_GUID in node_guids

    def test_delete_node_cascades_flows_and_unparents_data_items(self, live_server):
        """Deleting a node removes it, cascades connected flows, and unparents its data_items."""
        tmp_path, port = live_server
        ws, messages, reader_errors = _open_ws_and_drain(port)

        create_result = create_diagram(diagram=_make_doc_for_delete(), ctx=_ctx())
        diagram_id = create_result["id"]

        result = delete_element(diagram_id=diagram_id, guid=_DEL_PROCESS_GUID, ctx=_ctx())

        assert result["guid"] == _DEL_PROCESS_GUID
        assert result["deleted_collection"] == "nodes"
        assert _DEL_FLOW_GUID in result["cascade_removed"]
        assert result["broadcast_delivered"] is True

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())

        # Node gone.
        node_guids = {n["guid"] for n in fetched["nodes"]}
        assert _DEL_PROCESS_GUID not in node_guids

        # Flow cascaded away.
        flow_guids = {f["guid"] for f in fetched.get("data_flows", [])}
        assert _DEL_FLOW_GUID not in flow_guids

        # data_item unparented (parent=None), not removed.
        items = fetched.get("data_items", [])
        item_guids = {di["guid"] for di in items}
        assert _DEL_DATA_ITEM_GUID in item_guids
        item = next(di for di in items if di["guid"] == _DEL_DATA_ITEM_GUID)
        assert item.get("parent") is None

        # Node removed from container children.
        container = next(
            c for c in fetched["containers"] if c["guid"] == _DEL_CONTAINER_GUID
        )
        assert _DEL_PROCESS_GUID not in container["children"]

        matching = _wait_for_broadcast(messages, "diagram-updated", reader_errors=reader_errors)
        assert len(matching) == 1
        assert matching[0]["payload"]["id"] == diagram_id

        ws.close()

    def test_delete_node_not_in_container_children_removes_cleanly(self, live_server):
        """Deleting a node that is NOT in any container's children still works."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        # Use _MINIMAL_DOC which has no containers.
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        result = delete_element(diagram_id=diagram_id, guid=_PROCESS_GUID, ctx=_ctx())

        assert result["deleted_collection"] == "nodes"
        assert _FLOW_GUID in result["cascade_removed"]

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        node_guids = {n["guid"] for n in fetched["nodes"]}
        assert _PROCESS_GUID not in node_guids

    def test_delete_container_removes_from_parent_children(self, live_server):
        """Deleting a container removes it from its parent's children list, keeps inner elements."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=_make_doc_for_delete(), ctx=_ctx())
        diagram_id = create_result["id"]

        result = delete_element(
            diagram_id=diagram_id, guid=_DEL_NESTED_CONTAINER_GUID, ctx=_ctx()
        )

        assert result["deleted_collection"] == "containers"
        assert result["cascade_removed"] == []

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())

        # Nested container gone.
        container_guids = {c["guid"] for c in fetched["containers"]}
        assert _DEL_NESTED_CONTAINER_GUID not in container_guids

        # Outer container no longer references nested container in children.
        outer = next(c for c in fetched["containers"] if c["guid"] == _DEL_CONTAINER_GUID)
        assert _DEL_NESTED_CONTAINER_GUID not in outer["children"]

        # Nodes are untouched.
        node_guids = {n["guid"] for n in fetched["nodes"]}
        assert _DEL_PROCESS_GUID in node_guids

    def test_delete_data_item_removes_from_flow_refs(self, live_server):
        """Deleting a data_item removes its guid from all flow src_data_item_refs."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=_make_doc_for_delete(), ctx=_ctx())
        diagram_id = create_result["id"]

        result = delete_element(
            diagram_id=diagram_id, guid=_DEL_DATA_ITEM_GUID, ctx=_ctx()
        )

        assert result["deleted_collection"] == "data_items"
        assert result["cascade_removed"] == []

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())

        # data_item removed.
        item_guids = {di["guid"] for di in fetched.get("data_items", [])}
        assert _DEL_DATA_ITEM_GUID not in item_guids

        # Flow no longer references the data_item.
        flow = next(f for f in fetched["data_flows"] if f["guid"] == _DEL_FLOW_GUID)
        refs = flow["properties"].get("node1_src_data_item_refs", [])
        assert _DEL_DATA_ITEM_GUID not in refs

    def test_nonexistent_guid_raises_value_error(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        with pytest.raises(ValueError, match="not found"):
            delete_element(
                diagram_id=diagram_id,
                guid="00000000-ffff-ffff-ffff-000000000000",
                ctx=_ctx(),
            )

    def test_nonexistent_diagram_raises(self, live_server):
        _tmp_path, _port = live_server
        mcp_server._was_active = True

        with pytest.raises(Exception):
            delete_element(
                diagram_id="does-not-exist",
                guid=_PROCESS_GUID,
                ctx=_ctx(),
            )

    def test_broadcasts_diagram_updated(self, live_server):
        tmp_path, port = live_server
        create_result = create_diagram(diagram=copy.deepcopy(_MINIMAL_DOC), ctx=_ctx())
        diagram_id = create_result["id"]

        ws, messages, reader_errors = _open_ws_and_drain(port)

        delete_element(diagram_id=diagram_id, guid=_DATA_STORE_GUID, ctx=_ctx())

        matching = _wait_for_broadcast(messages, "diagram-updated", reader_errors=reader_errors)
        assert len(matching) == 1
        assert matching[0]["payload"]["id"] == diagram_id

        ws.close()

    def test_delete_node_cascades_flow_where_node_is_node2(self, live_server):
        """Deleting a node that appears as node2 in a flow also cascades that flow."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=_make_doc_for_delete(), ctx=_ctx())
        diagram_id = create_result["id"]

        # _DEL_STORE_GUID is node2 in _DEL_FLOW; deleting it must cascade the flow.
        result = delete_element(diagram_id=diagram_id, guid=_DEL_STORE_GUID, ctx=_ctx())

        assert result["deleted_collection"] == "nodes"
        assert _DEL_FLOW_GUID in result["cascade_removed"]

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        flow_guids = {f["guid"] for f in fetched.get("data_flows", [])}
        assert _DEL_FLOW_GUID not in flow_guids
        node_guids = {n["guid"] for n in fetched["nodes"]}
        assert _DEL_STORE_GUID not in node_guids

    def test_delete_data_item_removes_from_node2_src_refs(self, live_server):
        """Deleting a data_item also scrubs it from node2_src_data_item_refs."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        # Build a doc where the data_item appears in node2_src_data_item_refs.
        doc = _make_doc_for_delete()
        doc["data_flows"][0]["properties"]["node2_src_data_item_refs"] = [_DEL_DATA_ITEM_GUID]
        doc["data_flows"][0]["properties"]["node1_src_data_item_refs"] = []
        create_result = create_diagram(diagram=doc, ctx=_ctx())
        diagram_id = create_result["id"]

        delete_element(diagram_id=diagram_id, guid=_DEL_DATA_ITEM_GUID, ctx=_ctx())

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        flow = next(f for f in fetched["data_flows"] if f["guid"] == _DEL_FLOW_GUID)
        assert _DEL_DATA_ITEM_GUID not in flow["properties"].get("node2_src_data_item_refs", [])

    def test_delete_top_level_container_not_in_any_children(self, live_server):
        """Deleting a container that is not in any parent's children list works cleanly."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        create_result = create_diagram(diagram=_make_doc_for_delete(), ctx=_ctx())
        diagram_id = create_result["id"]

        # _DEL_CONTAINER_GUID is a top-level container — no parent holds it in children.
        result = delete_element(
            diagram_id=diagram_id, guid=_DEL_CONTAINER_GUID, ctx=_ctx()
        )

        assert result["deleted_collection"] == "containers"
        assert result["cascade_removed"] == []

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        container_guids = {c["guid"] for c in fetched["containers"]}
        assert _DEL_CONTAINER_GUID not in container_guids
        # Nodes that were children of the deleted container survive (become top-level).
        node_guids = {n["guid"] for n in fetched["nodes"]}
        assert _DEL_PROCESS_GUID in node_guids


# ---------------------------------------------------------------------------
# reparent_element — move element into a different container or to top-level
# ---------------------------------------------------------------------------

_RP_NODE_GUID = "aaaa0000-0000-0000-0000-000000000001"
_RP_NODE2_GUID = "aaaa0000-0000-0000-0000-000000000002"
_RP_CONTAINER_A_GUID = "bbbb0000-0000-0000-0000-000000000001"
_RP_CONTAINER_B_GUID = "bbbb0000-0000-0000-0000-000000000002"
_RP_CONTAINER_C_GUID = "bbbb0000-0000-0000-0000-000000000003"


def _make_reparent_diagram() -> dict:
    """Diagram fixture: two nodes, two containers.

    Layout:
      Container A  children: [_RP_NODE_GUID, _RP_CONTAINER_C_GUID]
        Container C  children: []
      Container B  children: [_RP_NODE2_GUID]
    """
    return {
        "meta": {"name": "reparent test"},
        "nodes": [
            {"type": "process", "guid": _RP_NODE_GUID, "properties": {"name": "N1"}},
            {"type": "process", "guid": _RP_NODE2_GUID, "properties": {"name": "N2"}},
        ],
        "containers": [
            {
                "type": "trust_boundary",
                "guid": _RP_CONTAINER_A_GUID,
                "properties": {"name": "A"},
                "children": [_RP_NODE_GUID, _RP_CONTAINER_C_GUID],
            },
            {
                "type": "trust_boundary",
                "guid": _RP_CONTAINER_B_GUID,
                "properties": {"name": "B"},
                "children": [_RP_NODE2_GUID],
            },
            {
                "type": "trust_boundary",
                "guid": _RP_CONTAINER_C_GUID,
                "properties": {"name": "C"},
                "children": [],
            },
        ],
        "data_flows": [],
        "data_items": [],
    }


class TestReparentElement:
    def _seed(self, live_server) -> str:
        """Seed the reparent fixture into the live server and return diagram_id."""
        _tmp_path, _port = live_server
        mcp_server._was_active = True
        result = create_diagram(diagram=_make_reparent_diagram(), ctx=_ctx())
        return result["id"]

    def test_move_node_between_containers(self, live_server):
        """Move a node from container A into container B."""
        diagram_id = self._seed(live_server)
        result = reparent_element(
            diagram_id=diagram_id,
            guid=_RP_NODE_GUID,
            new_parent_guid=_RP_CONTAINER_B_GUID,
            ctx=_ctx(),
        )

        assert result["guid"] == _RP_NODE_GUID
        assert result["old_parent_guid"] == _RP_CONTAINER_A_GUID
        assert result["new_parent_guid"] == _RP_CONTAINER_B_GUID
        assert "broadcast_delivered" in result

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        containers_by_guid = {c["guid"]: c for c in fetched["containers"]}
        assert _RP_NODE_GUID not in containers_by_guid[_RP_CONTAINER_A_GUID]["children"]
        assert _RP_NODE_GUID in containers_by_guid[_RP_CONTAINER_B_GUID]["children"]

    def test_move_node_to_top_level(self, live_server):
        """Move a node out of its container (new_parent_guid=None)."""
        diagram_id = self._seed(live_server)
        result = reparent_element(
            diagram_id=diagram_id,
            guid=_RP_NODE_GUID,
            new_parent_guid=None,
            ctx=_ctx(),
        )

        assert result["old_parent_guid"] == _RP_CONTAINER_A_GUID
        assert result["new_parent_guid"] is None

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        containers_by_guid = {c["guid"]: c for c in fetched["containers"]}
        assert _RP_NODE_GUID not in containers_by_guid[_RP_CONTAINER_A_GUID]["children"]

    def test_move_top_level_node_into_container(self, live_server):
        """Moving a node that is already top-level (old_parent=None) works."""
        # First move the node to top-level so it has no parent.
        diagram_id = self._seed(live_server)
        reparent_element(
            diagram_id=diagram_id,
            guid=_RP_NODE_GUID,
            new_parent_guid=None,
            ctx=_ctx(),
        )
        result = reparent_element(
            diagram_id=diagram_id,
            guid=_RP_NODE_GUID,
            new_parent_guid=_RP_CONTAINER_B_GUID,
            ctx=_ctx(),
        )

        assert result["old_parent_guid"] is None
        assert result["new_parent_guid"] == _RP_CONTAINER_B_GUID

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        containers_by_guid = {c["guid"]: c for c in fetched["containers"]}
        assert _RP_NODE_GUID in containers_by_guid[_RP_CONTAINER_B_GUID]["children"]

    def test_move_container_into_sibling(self, live_server):
        """Move container C (child of A) into container B."""
        diagram_id = self._seed(live_server)
        result = reparent_element(
            diagram_id=diagram_id,
            guid=_RP_CONTAINER_C_GUID,
            new_parent_guid=_RP_CONTAINER_B_GUID,
            ctx=_ctx(),
        )

        assert result["old_parent_guid"] == _RP_CONTAINER_A_GUID
        assert result["new_parent_guid"] == _RP_CONTAINER_B_GUID

        fetched = get_diagram(diagram_id=diagram_id, ctx=_ctx())
        containers_by_guid = {c["guid"]: c for c in fetched["containers"]}
        assert _RP_CONTAINER_C_GUID not in containers_by_guid[_RP_CONTAINER_A_GUID]["children"]
        assert _RP_CONTAINER_C_GUID in containers_by_guid[_RP_CONTAINER_B_GUID]["children"]

    def test_cycle_detection_raises(self, live_server):
        """Moving container A into its own descendant C raises ValueError."""
        diagram_id = self._seed(live_server)
        with pytest.raises(ValueError, match="cycle"):
            reparent_element(
                diagram_id=diagram_id,
                guid=_RP_CONTAINER_A_GUID,
                new_parent_guid=_RP_CONTAINER_C_GUID,
                ctx=_ctx(),
            )

    def test_cycle_detection_self_raises(self, live_server):
        """Moving a container into itself raises ValueError."""
        diagram_id = self._seed(live_server)
        with pytest.raises(ValueError, match="cycle"):
            reparent_element(
                diagram_id=diagram_id,
                guid=_RP_CONTAINER_A_GUID,
                new_parent_guid=_RP_CONTAINER_A_GUID,
                ctx=_ctx(),
            )

    def test_unknown_guid_raises(self, live_server):
        """An unknown element guid raises ValueError."""
        diagram_id = self._seed(live_server)
        with pytest.raises(ValueError, match="not found in nodes or containers"):
            reparent_element(
                diagram_id=diagram_id,
                guid="00000000-dead-dead-dead-000000000000",
                new_parent_guid=None,
                ctx=_ctx(),
            )

    def test_unknown_target_container_raises(self, live_server):
        """An unknown new_parent_guid raises ValueError."""
        diagram_id = self._seed(live_server)
        with pytest.raises(ValueError, match="not found in containers"):
            reparent_element(
                diagram_id=diagram_id,
                guid=_RP_NODE_GUID,
                new_parent_guid="00000000-dead-dead-dead-000000000000",
                ctx=_ctx(),
            )

    def test_broadcast_emitted(self, live_server):
        """reparent_element emits a diagram-updated broadcast."""
        tmp_path, port = live_server
        diagram_id = self._seed(live_server)

        ws = simple_websocket.Client(f"ws://127.0.0.1:{port}/ws")
        try:
            reparent_element(
                diagram_id=diagram_id,
                guid=_RP_NODE_GUID,
                new_parent_guid=None,
                ctx=_ctx(),
            )
            msg = json.loads(ws.receive(timeout=3))
            assert msg["type"] == "diagram-updated"
            assert msg["payload"]["id"] == diagram_id
        finally:
            ws.close()
