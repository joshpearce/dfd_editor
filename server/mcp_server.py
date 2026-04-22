"""MCP server for dfd_editor — exposes six diagram-management tools via FastMCP
streamable-HTTP transport bound to 127.0.0.1:5051.

Session lifecycle is tracked via a last-seen heartbeat: each tool call stamps
_last_seen[session_id]. A daemon thread sweeps stale sessions every 2 s and
emits remote-control on/off transitions to Flask's /api/internal/broadcast
when the active-session count crosses zero.

Session identity is a UUID keyed on the ServerSession object via a
WeakKeyDictionary — this avoids the id()-address-reuse hazard if FastMCP
ever recycles session memory (a stale _last_seen key would otherwise shadow
a fresh session at the same address).
"""

import atexit
import logging
import os
import sys
import threading
import time
import uuid
import weakref

# Allow `python -m server.mcp_server` (from repo root) as well as
# `python -m mcp_server` (from server/ cwd). `from schema import Diagram`
# below is a bare import that resolves against sys.path — when launched
# from the repo root, ensure `server/` is on the path so it still resolves.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import httpx  # noqa: E402  (placed after sys.path shim so server/ imports resolve)
from mcp.server.fastmcp import Context, FastMCP  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from schema import Diagram  # noqa: E402


class DiagramSummary(BaseModel):
    """Short summary returned by `list_diagrams`.

    Mirrors the shape emitted by Flask's `GET /api/diagrams`.
    Declared as a pydantic model so FastMCP advertises the schema to the
    agent; a bare `list[dict]` return annotation would leave the agent with
    an opaque structure.
    """
    id: str
    name: str
    modified: float

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FLASK_URL = "http://127.0.0.1:5050"
MCP_HOST = "127.0.0.1"
MCP_PORT = 5051
# Heartbeat fallback only. Kept short so a cleanly-disconnecting agent
# releases the browser's remote-control lock within ~a couple of seconds
# rather than forcing the user to wait out the timeout.  Worst-case lock
# duration is SESSION_EXPIRY_SECONDS + SWEEP_INTERVAL_SECONDS.
SESSION_EXPIRY_SECONDS = 8
SWEEP_INTERVAL_SECONDS = 2

# ---------------------------------------------------------------------------
# HTTP client (shared, sync) — shared across REST + broadcast calls to localhost Flask.
# ---------------------------------------------------------------------------

_http = httpx.Client(base_url=FLASK_URL, timeout=5.0)  # 5s matches realistic localhost upper bound
atexit.register(_http.close)

# ---------------------------------------------------------------------------
# Session-lifecycle tracking (heartbeat fallback)
# ---------------------------------------------------------------------------

_last_seen: dict[str, float] = {}
_last_seen_lock = threading.Lock()
_was_active = False  # last known state of _active_sessions being non-empty

# Maps ServerSession objects to stable UUID strings. WeakKeyDictionary so
# entries vanish automatically when FastMCP drops its last reference to the
# session, preventing stale UUIDs from building up. Falls back to an
# ordinary dict keyed on ctx's own id() when the session is not weakly
# referenceable (old SDK builds, test stubs); the fallback is size-capped
# so a long-running process can't accumulate entries unbounded.
_session_uuids: "weakref.WeakKeyDictionary[object, str]" = weakref.WeakKeyDictionary()
_fallback_uuids: dict[int, str] = {}
_session_uuid_lock = threading.Lock()
_FALLBACK_UUIDS_MAX = 1024


def _session_id(ctx: Context) -> str:
    """Identify the MCP session for lifecycle tracking.

    Returns a UUID that is stable for the lifetime of the ServerSession
    attached to ``ctx``. Uses a WeakKeyDictionary so the UUID is released
    when FastMCP drops the session — this avoids the address-reuse hazard
    of ``id(ctx.session)`` (garbage collection could otherwise recycle the
    memory address and mask a real 0→1 transition).
    """
    session_obj: object
    try:
        session_obj = ctx.session
    except Exception:
        session_obj = ctx
    with _session_uuid_lock:
        try:
            sid = _session_uuids.get(session_obj)
            if sid is None:
                sid = str(uuid.uuid4())
                _session_uuids[session_obj] = sid
            return sid
        except TypeError:
            # Not weakly referenceable (e.g. some test stubs). Fall back to
            # an id()-keyed dict; the `_reset_mcp_state` autouse fixture in
            # server/tests/test_mcp_tools.py clears this map between tests
            # so the id()-based keys don't collide across runs.
            key = id(session_obj)
            sid = _fallback_uuids.get(key)
            if sid is None:
                # Cap the fallback to prevent unbounded growth if a caller
                # keeps producing fresh non-weakly-referenceable sessions.
                # FIFO eviction is plenty — in practice this map should stay
                # empty in production (ServerSession supports weakref).
                if len(_fallback_uuids) >= _FALLBACK_UUIDS_MAX:
                    _fallback_uuids.pop(next(iter(_fallback_uuids)))
                sid = str(uuid.uuid4())
                _fallback_uuids[key] = sid
            return sid


def _mark_active(sid: str) -> None:
    """Record the session as seen and broadcast on-envelope if this is a 0→1 transition.

    Computes the transition under the lock, releases it, then broadcasts
    outside the lock so the HTTP POST does not serialize all tool calls
    behind the broadcast RTT.

    If the broadcast fails (Flask unreachable, 5xx, etc.), ``_was_active``
    is rolled back under the lock so the next tool call retries the on
    transition. Without this rollback a failed initial broadcast would
    leave the server believing the browser is locked while the browser
    never received the signal — the editor would stay interactive for the
    entire agent session, defeating Step 4's read-only guarantee.
    """
    global _was_active
    with _last_seen_lock:
        _last_seen[sid] = time.monotonic()
        # Broadcast is driven entirely by `_was_active`: if the server thinks
        # the browser is NOT locked, this stamp transitions it to locked and
        # fires the on-broadcast. `_was_active` is the single source of truth
        # for "does the browser believe an agent is attached?"; `_last_seen`
        # tracks session timeout independently. This decoupling matters for
        # the rollback path — a failed on-broadcast clears `_was_active` but
        # leaves the session in `_last_seen`, and the next stamp (even by the
        # same session) must retry the on-broadcast.
        should_broadcast_on = not _was_active
        if should_broadcast_on:
            _was_active = True
    if should_broadcast_on:
        logger.info("remote-control: on (session count 0 → >0)")
        delivered = _broadcast({"type": "remote-control", "payload": {"state": "on"}})
        if not delivered:
            # Roll back so the next _stamp retries the transition rather than
            # sitting in a "server thinks on, browser thinks off" split state.
            with _last_seen_lock:
                _was_active = False
            logger.warning("remote-control:on broadcast failed — will retry on next tool call")


def _stamp(ctx: Context) -> None:
    """Record the current time for the session so the sweeper knows it's alive."""
    sid = _session_id(ctx)
    _mark_active(sid)


def _broadcast(envelope: dict) -> bool:
    """POST an envelope to Flask's loopback-only broadcast endpoint.

    Returns True if Flask accepted the broadcast, False on any exception
    (connection refused, 5xx, etc.). Callers that care about end-to-end
    delivery should surface this in their tool return payload so the agent
    doesn't treat a write-without-notify as a success.
    """
    try:
        resp = _http.post("/api/internal/broadcast", json=envelope)
        resp.raise_for_status()
        return True
    except Exception:
        logger.exception("failed to post broadcast envelope: %s", envelope)
        return False


def _sweep_once(now: float | None = None) -> bool:
    """Run one sweep pass. Returns True if an 'off' transition was emitted
    AND its broadcast reached Flask.

    Computes the transition under the lock, releases it, then broadcasts
    outside the lock so the HTTP POST does not serialize tool calls.
    Exposed with a return value so tests can assert on the transition
    without sleeping for the daemon's 5-second interval.

    If the broadcast fails, ``_was_active`` is rolled back to True so the
    next sweep tick retries. Without this the browser could be stranded
    in read-only mode forever after a transient Flask outage.
    """
    global _was_active
    if now is None:
        now = time.monotonic()
    broadcast_off = False
    with _last_seen_lock:
        stale = [sid for sid, ts in _last_seen.items()
                 if now - ts > SESSION_EXPIRY_SECONDS]
        for sid in stale:
            del _last_seen[sid]
            logger.info("evicted stale session %s", sid)
        is_active = bool(_last_seen)
        if not is_active and _was_active:
            _was_active = False
            broadcast_off = True
    if broadcast_off:
        logger.info("remote-control: off (session count >0 → 0)")
        delivered = _broadcast({"type": "remote-control", "payload": {"state": "off"}})
        if not delivered:
            # Retry on the next sweep tick rather than stranding the browser
            # in read-only mode until a new session starts.
            with _last_seen_lock:
                _was_active = True
            logger.warning("remote-control:off broadcast failed — will retry on next sweep")
            return False
    return broadcast_off


def _sweep() -> None:
    """Daemon thread: calls _sweep_once every SWEEP_INTERVAL_SECONDS."""
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        _sweep_once()


def start_daemon() -> None:
    """Start the session-sweeper daemon thread.

    Called from __main__ only so that importing mcp_server in tests does not
    start a background thread that races with test-driven _sweep_once() calls.
    """
    sweeper = threading.Thread(target=_sweep, daemon=True, name="mcp-session-sweeper")
    sweeper.start()
    logger.info("session-sweeper daemon started")


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "dfd-editor",
    host=MCP_HOST,
    port=MCP_PORT,
)

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def list_diagrams(ctx: Context) -> list[DiagramSummary]:
    """List all diagrams stored on the server.

    Returns a list of summary objects, each with id, name, and modified
    (Unix timestamp of last file modification).
    """
    _stamp(ctx)
    resp = _http.get("/api/diagrams")
    resp.raise_for_status()
    return [DiagramSummary.model_validate(row) for row in resp.json()]


@mcp.tool()
def get_diagram(diagram_id: str, ctx: Context) -> dict:
    """Fetch a single diagram in minimal export format.

    Returns the full diagram document (nodes, containers, data_flows,
    data_items, meta) for the given diagram_id.  Raises an error if the
    diagram_id does not exist.
    """
    _stamp(ctx)
    resp = _http.get(f"/api/diagrams/{diagram_id}/export")
    resp.raise_for_status()
    return resp.json()


@mcp.tool()
def create_diagram(diagram: Diagram, ctx: Context) -> dict:
    """Create a new diagram from a minimal-format document.

    Accepts a full diagram object (nodes, containers, data_flows, data_items,
    meta) and persists it on the server under a freshly minted UUID.  Returns
    the assigned id and the stored diagram echoed back in minimal format.
    No broadcast is emitted — call display_diagram to make the browser show it.
    """
    _stamp(ctx)
    resp = _http.post("/api/diagrams/import", json=diagram.model_dump(mode="json"))
    resp.raise_for_status()
    diagram_id = resp.json()["id"]
    echo = _http.get(f"/api/diagrams/{diagram_id}/export")
    echo.raise_for_status()
    return {"id": diagram_id, "diagram": echo.json()}


@mcp.tool()
def update_diagram(diagram_id: str, diagram: Diagram, ctx: Context) -> dict:
    """Replace an existing diagram with a new minimal-format document.

    Overwrites the stored diagram for diagram_id with the provided document.
    The stored layout is dropped so the browser will re-run TALA on the
    next open.  Returns the diagram_id, the stored diagram echoed back, and
    a ``broadcast_delivered`` flag indicating whether the diagram-updated
    notification reached Flask successfully.  A write succeeds even if the
    broadcast fails — the persisted file is already correct; the browser
    will simply not know to reload until the user refreshes or the next
    successful broadcast reaches it.
    """
    _stamp(ctx)
    resp = _http.put(f"/api/diagrams/{diagram_id}/import", json=diagram.model_dump(mode="json"))
    resp.raise_for_status()
    # Broadcast fires on successful write; surface delivery status in the tool
    # return so the agent doesn't mistake "persisted but not notified" for
    # full end-to-end success.
    broadcast_delivered = _broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    echo = _http.get(f"/api/diagrams/{diagram_id}/export")
    echo.raise_for_status()
    return {
        "id": diagram_id,
        "diagram": echo.json(),
        "broadcast_delivered": broadcast_delivered,
    }


@mcp.tool()
def delete_diagram(diagram_id: str, ctx: Context) -> dict:
    """Delete a diagram permanently.

    Removes the stored file for the given diagram_id.  Returns
    ``{ok: true, broadcast_delivered: bool}`` on success.  Emits a
    diagram-deleted broadcast so any connected browser can react (e.g.
    return to the splash screen if the deleted diagram was open).
    """
    _stamp(ctx)
    resp = _http.delete(f"/api/diagrams/{diagram_id}")
    resp.raise_for_status()
    broadcast_delivered = _broadcast({"type": "diagram-deleted", "payload": {"id": diagram_id}})
    return {"ok": True, "broadcast_delivered": broadcast_delivered}


@mcp.tool()
def display_diagram(diagram_id: str, ctx: Context) -> dict:
    """Tell the connected browser to open and display a specific diagram.

    Broadcasts a display event containing the diagram_id.  The browser's
    WebSocket client will react by loading and rendering the diagram.
    Returns ``{ok: true, broadcast_delivered: bool}`` — ``broadcast_delivered``
    is False when Flask's broadcast endpoint is unreachable, which means
    the browser will not be notified.

    Raises an HTTP error if the diagram_id does not exist on the server —
    this gives the agent a structured error instead of letting a
    browser-side 404 fail silently over the WS channel.
    """
    _stamp(ctx)
    # Pre-check existence so the agent gets a real error on unknown ids,
    # instead of a broadcast the browser can't satisfy.
    check = _http.get(f"/api/diagrams/{diagram_id}")
    check.raise_for_status()
    broadcast_delivered = _broadcast({"type": "display", "payload": {"id": diagram_id}})
    return {"ok": True, "broadcast_delivered": broadcast_delivered}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)  # INFO so MCP SDK transport logs surface during `dev:mcp`
    logger.info("starting MCP server on %s:%d", MCP_HOST, MCP_PORT)
    start_daemon()
    mcp.run(transport="streamable-http")
