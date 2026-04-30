"""WebSocket broadcast plumbing.

Owns the connected-client registry (used by Flask's ``/ws`` handler) and
provides two broadcast strategies:

- ``broadcast(envelope)`` — in-process fan-out to every registered client.
  Used by Flask route handlers (``/api/internal/broadcast``, the agent-API
  blueprint) running inside the Flask process.
- ``post_broadcast_envelope(envelope)`` — cross-process loopback POST to
  ``/api/internal/broadcast``. Used by the MCP server, which runs in a
  separate process and therefore has no direct access to the WS client
  set.

Both return ``bool`` so callers can distinguish "sent" from "nobody
received it".
"""

from __future__ import annotations

import http.client
import json
import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)


_ws_clients: set[Any] = set()
_ws_lock = threading.Lock()


def register(ws: Any) -> None:
    with _ws_lock:
        _ws_clients.add(ws)


def unregister(ws: Any) -> None:
    with _ws_lock:
        _ws_clients.discard(ws)


def clear() -> None:
    with _ws_lock:
        _ws_clients.clear()


def broadcast(envelope: dict) -> bool:
    """Fan ``envelope`` out to every connected WebSocket client.

    Returns True if the fan-out completed (even to an empty client set).
    Dead sockets (ones that raise while sending) are evicted. The return
    value is always True today — the signature keeps symmetry with
    ``post_broadcast_envelope`` so callers can treat the two strategies
    interchangeably.
    """
    with _ws_lock:
        snapshot = set(_ws_clients)
    dead = set()
    for ws in snapshot:
        try:
            ws.send(json.dumps(envelope))
        except Exception:
            logger.exception("broadcast: failed to send to ws client")
            dead.add(ws)
    if dead:
        with _ws_lock:
            _ws_clients.difference_update(dead)
    return True


def post_broadcast_envelope(envelope: dict) -> bool:
    """POST ``envelope`` to Flask's loopback-only broadcast endpoint.

    Returns True if Flask accepted (2xx), False on any transport or HTTP
    error. Used by the MCP server, which runs in a separate process from
    the Flask WebSocket endpoint.

    Uses stdlib http.client with a literal IP address so the call never
    touches the 'idna' codec (absent in some Python 3.14 builds).
    """
    try:
        body = json.dumps(envelope).encode()
        conn = http.client.HTTPConnection("127.0.0.1", 5050, timeout=5)
        conn.request(
            "POST",
            "/api/internal/broadcast",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp.status // 100 == 2
    except Exception:
        logger.exception("failed to post broadcast envelope: %s", envelope)
        return False
