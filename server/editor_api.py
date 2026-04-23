"""Flask blueprint for the existing editor-facing HTTP surface.

URLs are unchanged from the pre-refactor ``app.py`` so
``src/assets/scripts/api/DfdApiClient.ts`` and the browser editor
continue to work unmodified. This blueprint is the "editor API module"
in the two-module split; the parallel agent API lives in ``agent_api``.
"""

from __future__ import annotations

import json
import subprocess
import uuid
from typing import Any

from flask import Blueprint, Response, jsonify, request
from pydantic import ValidationError
from simple_websocket import ConnectionClosed

import storage
import ws
from transform import DuplicateParentError, InvalidNativeError, to_minimal, to_native


editor_api = Blueprint("editor_api", __name__)


# ---------------------------------------------------------------------------
# Validation helpers for import endpoints
# ---------------------------------------------------------------------------


def _safe_ctx(ctx: dict) -> dict:
    """Stringify non-JSON-serializable entries in a pydantic ValidationError.ctx."""
    result: dict[str, Any] = {}
    for k, v in ctx.items():
        try:
            json.dumps(v)
            result[k] = v
        except TypeError:
            result[k] = str(v)
    return result


def _to_native_or_error(body):
    """Parse and validate a minimal-format body.

    Returns (native_dict, None) on success or (None, (response, status)) on failure.
    """
    if body is None:
        return None, (jsonify({"error": "request body must be valid JSON"}), 400)
    try:
        native = to_native(body)
    except ValidationError as e:
        errors = e.errors(include_url=False)
        cleaned_errors = [
            {**err, "ctx": _safe_ctx(err["ctx"])} if "ctx" in err else err
            for err in errors
        ]
        return None, (jsonify({"error": "validation failed", "details": cleaned_errors}), 400)
    except DuplicateParentError as e:
        return None, (jsonify({"error": "duplicate parent", "detail": str(e)}), 400)
    return native, None


# ---------------------------------------------------------------------------
# Health / list / CRUD
# ---------------------------------------------------------------------------


@editor_api.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@editor_api.route("/api/diagrams", methods=["GET"])
def list_diagrams():
    return jsonify(storage.list_summaries())


@editor_api.route("/api/diagrams", methods=["POST"])
def create_diagram():
    diagram_id = storage.create_scaffold()
    return jsonify({"id": diagram_id}), 201


@editor_api.route("/api/diagrams/<diagram_id>", methods=["GET"])
def get_diagram(diagram_id):
    try:
        raw = storage.load_raw(diagram_id)
    except storage.DiagramNotFoundError:
        return jsonify({"error": "not found"}), 404
    return Response(json.dumps(raw, indent=4), mimetype="application/json")


@editor_api.route("/api/diagrams/<diagram_id>", methods=["PUT"])
def update_diagram(diagram_id):
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    storage.write_native(diagram_id, request.get_json())
    return "", 204


@editor_api.route("/api/diagrams/<diagram_id>", methods=["DELETE"])
def delete_diagram(diagram_id):
    if not storage.delete(diagram_id):
        return jsonify({"error": "not found"}), 404
    return "", 204


# ---------------------------------------------------------------------------
# Minimal-format import/export used by the editor's save/load path
# ---------------------------------------------------------------------------


@editor_api.route("/api/diagrams/import", methods=["POST"])
def import_diagram():
    native, err = _to_native_or_error(request.get_json(silent=True))
    if err is not None:
        return err
    diagram_id = str(uuid.uuid4())
    storage.write_native(diagram_id, native)
    return jsonify({"id": diagram_id}), 201


@editor_api.route("/api/diagrams/import-and-display", methods=["POST"])
def import_and_display():
    """Import a minimal doc, persist it, then broadcast a display event."""
    native, err = _to_native_or_error(request.get_json(silent=True))
    if err is not None:
        return err
    diagram_id = str(uuid.uuid4())
    storage.write_native(diagram_id, native)
    ws.broadcast({"type": "display", "payload": {"id": diagram_id}})
    return jsonify({"id": diagram_id, "broadcast_delivered": True}), 201


@editor_api.route("/api/diagrams/<diagram_id>/export", methods=["GET"])
def export_diagram(diagram_id):
    try:
        native = storage.load_raw(diagram_id)
    except storage.DiagramNotFoundError:
        return jsonify({"error": "not found"}), 404
    try:
        minimal = to_minimal(native)
    except InvalidNativeError as e:
        return (
            jsonify({"error": "stored diagram is not a valid dfd_v1 document", "detail": str(e)}),
            500,
        )
    except ValidationError as e:
        return (
            jsonify({"error": "stored diagram is not a valid dfd_v1 document", "detail": str(e)}),
            500,
        )
    return jsonify(minimal)


@editor_api.route("/api/diagrams/<diagram_id>/import", methods=["PUT"])
def import_diagram_update(diagram_id):
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    native, err = _to_native_or_error(request.get_json(silent=True))
    if err is not None:
        return err
    storage.write_native(diagram_id, native)
    return "", 204


# ---------------------------------------------------------------------------
# Broadcast endpoint (loopback-only) — used by MCP to notify WS clients
# ---------------------------------------------------------------------------


@editor_api.route("/api/internal/broadcast", methods=["POST"])
def internal_broadcast():
    if request.remote_addr != "127.0.0.1":
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "request body must be valid JSON"}), 400
    msg_type = body.get("type")
    if not isinstance(msg_type, str) or not msg_type:
        return jsonify({"error": "type must be a non-empty string"}), 400
    payload = body.get("payload")
    if payload is not None and not isinstance(payload, dict):
        return jsonify({"error": "payload must be an object"}), 400
    ws.broadcast(body)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# WebSocket handler — registered by app.py via register_ws(sock)
# ---------------------------------------------------------------------------


def register_ws(sock) -> None:
    @sock.route("/ws")
    def ws_handler(client):
        ws.register(client)
        try:
            while True:
                msg = client.receive()
                if msg is None:
                    break
        except ConnectionClosed:
            pass
        finally:
            ws.unregister(client)


# ---------------------------------------------------------------------------
# Layout (shells out to d2)
# ---------------------------------------------------------------------------


@editor_api.route("/api/layout", methods=["POST"])
def layout():
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "request body must be valid JSON"}), 400
    source = body.get("source")
    if source is None:
        return jsonify({"error": "missing required field: source"}), 400
    if not isinstance(source, str):
        return jsonify({"error": "source must be a string"}), 400
    try:
        # Engine selected via $D2_LAYOUT (D2's own convention); package.json's
        # dev:flask sets D2_LAYOUT=tala. Override from the shell to sweep
        # engines without editing this file.
        result = subprocess.run(
            ["d2", "-", "-"],
            input=source,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "layout timed out after 30s"}), 502
    except FileNotFoundError:
        return jsonify({"error": "d2 binary not found on PATH"}), 502
    if result.returncode == 0:
        (storage.DATA_DIR / "latest-layout.svg").write_text(result.stdout)
        (storage.DATA_DIR / "latest-layout.d2").write_text(source)
        return jsonify({"svg": result.stdout})
    error_msg = result.stderr.strip() or "d2 exited with non-zero status"
    return jsonify({"error": error_msg}), 502
