"""MCP server for dfd_editor — exposes six diagram-management tools via FastMCP
streamable-HTTP transport bound to 127.0.0.1:5051.

Session lifecycle is tracked via a last-seen heartbeat: each tool call stamps
_last_seen[session_id]. A daemon thread sweeps stale sessions every 5 s and
emits remote-control on/off transitions to Flask's /api/internal/broadcast
when the active-session count crosses zero.
"""

import atexit
import logging
import threading
import time

import httpx
from mcp.server.fastmcp import Context, FastMCP

from schema import Diagram

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FLASK_URL = "http://127.0.0.1:5050"
MCP_HOST = "127.0.0.1"
MCP_PORT = 5051
SESSION_EXPIRY_SECONDS = 30  # heartbeat fallback only

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


def _session_id(ctx: Context) -> str:
    """Identify the MCP session for lifecycle tracking.

    FastMCP creates one ServerSession per client connection, so object
    identity uniquely tags the session for the connection's lifetime.
    """
    try:
        return str(id(ctx.session))
    except Exception:
        return str(id(ctx))


def _mark_active(sid: str) -> None:
    """Record the session as seen and broadcast on-envelope if this is a 0→1 transition.

    Computes the transition under the lock, releases it, then broadcasts
    outside the lock so the HTTP POST does not serialize all tool calls
    behind the broadcast RTT.
    """
    global _was_active
    with _last_seen_lock:
        prev_has_sessions = bool(_last_seen)
        _last_seen[sid] = time.monotonic()
        should_broadcast_on = not prev_has_sessions and not _was_active
        if should_broadcast_on:
            _was_active = True
    if should_broadcast_on:
        logger.info("remote-control: on (session count 0 → >0)")
        _broadcast({"type": "remote-control", "payload": {"state": "on"}})


def _stamp(ctx: Context) -> None:
    """Record the current time for the session so the sweeper knows it's alive."""
    sid = _session_id(ctx)
    _mark_active(sid)


def _broadcast(envelope: dict) -> None:
    """POST an envelope to Flask's loopback-only broadcast endpoint."""
    try:
        resp = _http.post("/api/internal/broadcast", json=envelope)
        resp.raise_for_status()
    except Exception:
        logger.exception("failed to post broadcast envelope: %s", envelope)


def _sweep_once(now: float | None = None) -> bool:
    """Run one sweep pass. Returns True if an 'off' transition was emitted.

    Computes the transition under the lock, releases it, then broadcasts
    outside the lock so the HTTP POST does not serialize tool calls.
    Exposed with a return value so tests can assert on the transition
    without sleeping for the daemon's 5-second interval.
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
        _broadcast({"type": "remote-control", "payload": {"state": "off"}})
    return broadcast_off


def _sweep() -> None:
    """Daemon thread: calls _sweep_once every 5 seconds."""
    while True:
        time.sleep(5)
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
def list_diagrams(ctx: Context) -> list[dict]:
    """List all diagrams stored on the server.

    Returns a list of summary objects, each with id, name, and modified
    (Unix timestamp of last file modification).
    """
    _stamp(ctx)
    resp = _http.get("/api/diagrams")
    resp.raise_for_status()
    return resp.json()


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
    next open.  Returns the diagram_id and the stored diagram echoed back.
    Emits a diagram-updated broadcast so any connected browser reloads.
    """
    _stamp(ctx)
    resp = _http.put(f"/api/diagrams/{diagram_id}/import", json=diagram.model_dump(mode="json"))
    resp.raise_for_status()
    echo = _http.get(f"/api/diagrams/{diagram_id}/export")
    echo.raise_for_status()
    _broadcast({"type": "diagram-updated", "payload": {"id": diagram_id}})
    return {"id": diagram_id, "diagram": echo.json()}


@mcp.tool()
def delete_diagram(diagram_id: str, ctx: Context) -> dict:
    """Delete a diagram permanently.

    Removes the stored file for the given diagram_id.  Returns {ok: true} on
    success.  Emits a diagram-deleted broadcast so any connected browser
    can react (e.g. return to the splash screen if the deleted diagram
    was open).
    """
    _stamp(ctx)
    resp = _http.delete(f"/api/diagrams/{diagram_id}")
    resp.raise_for_status()
    _broadcast({"type": "diagram-deleted", "payload": {"id": diagram_id}})
    return {"ok": True}


@mcp.tool()
def display_diagram(diagram_id: str, ctx: Context) -> dict:
    """Tell the connected browser to open and display a specific diagram.

    Broadcasts a display event containing the diagram_id.  The browser's
    WebSocket client will react by loading and rendering the diagram.
    Returns {ok: true} once the broadcast has been delivered to Flask.
    """
    _stamp(ctx)
    _broadcast({"type": "display", "payload": {"id": diagram_id}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)  # INFO so MCP SDK transport logs surface during `dev:mcp`
    logger.info("starting MCP server on %s:%d", MCP_HOST, MCP_PORT)
    start_daemon()
    mcp.run(transport="streamable-http")
