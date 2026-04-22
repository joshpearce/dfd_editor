import json
import subprocess
import threading
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from flask_sock import Sock
from pydantic import ValidationError

from transform import DuplicateParentError, InvalidNativeError, to_minimal, to_native

app = Flask(__name__)
CORS(app, origins=["http://localhost:5173"])
sock = Sock(app)

_ws_clients: set = set()
_ws_lock = threading.Lock()

# Tests override this via monkeypatch.setattr("app.DATA_DIR", ...).
# Any refactor that reads DATA_DIR from a different module must preserve
# this overridable seam.
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)


def _safe_ctx(ctx: dict) -> dict:
    """Preserve JSON-serializable context fields and stringify the rest.

    Pydantic ValidationError.ctx can contain non-JSON-serializable objects
    (e.g. type objects). This helper keeps the serializable entries and
    converts the rest to strings so error responses can be JSON-encoded.
    """
    result = {}
    for k, v in ctx.items():
        try:
            json.dumps(v)
            result[k] = v
        except TypeError:
            result[k] = str(v)
    return result


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


def _diagram_display_name(data: dict) -> str | None:
    """Find a human name in a stored diagram, tolerating either the
    frontend's top-level `name` convention or the native dfd_v1 shape
    where name lives under the canvas object's properties."""
    name = data.get("name")
    if name:
        return name
    for obj in data.get("objects", []):
        if obj.get("id") == "dfd":
            for entry in obj.get("properties", []):
                if isinstance(entry, list) and len(entry) == 2 and entry[0] == "name":
                    return entry[1] or None
            break
    return None


@app.route("/api/diagrams", methods=["GET"])
def list_diagrams():
    summaries = []
    for path in sorted(DATA_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        summaries.append({
            "id": path.stem,
            "name": _diagram_display_name(data) or path.stem,
            "modified": path.stat().st_mtime,
        })
    return jsonify(summaries)


@app.route("/api/diagrams", methods=["POST"])
def create_diagram():
    diagram_id = str(uuid.uuid4())
    scaffold = {"schema": "dfd_v1"}
    (DATA_DIR / f"{diagram_id}.json").write_text(json.dumps(scaffold, indent=4))
    return jsonify({"id": diagram_id}), 201


@app.route("/api/diagrams/<diagram_id>", methods=["GET"])
def get_diagram(diagram_id):
    path = DATA_DIR / f"{diagram_id}.json"
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    return Response(path.read_text(), mimetype="application/json")


@app.route("/api/diagrams/<diagram_id>", methods=["PUT"])
def update_diagram(diagram_id):
    path = DATA_DIR / f"{diagram_id}.json"
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    path.write_text(json.dumps(request.get_json(), indent=4))
    return "", 204


@app.route("/api/diagrams/import", methods=["POST"])
def import_diagram():
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "request body must be valid JSON"}), 400
    try:
        native = to_native(body)
    except ValidationError as e:
        # Preserve JSON-serializable fields in ctx and stringify the rest.
        errors = e.errors(include_url=False)
        cleaned_errors = [
            {**err, "ctx": _safe_ctx(err["ctx"])} if "ctx" in err else err
            for err in errors
        ]
        return jsonify({"error": "validation failed", "details": cleaned_errors}), 400
    except DuplicateParentError as e:
        return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
    diagram_id = str(uuid.uuid4())
    (DATA_DIR / f"{diagram_id}.json").write_text(json.dumps(native, indent=4))
    return jsonify({"id": diagram_id}), 201


@app.route("/api/diagrams/<diagram_id>/export", methods=["GET"])
def export_diagram(diagram_id):
    path = DATA_DIR / f"{diagram_id}.json"
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    native = json.loads(path.read_text())
    try:
        minimal = to_minimal(native)
    except InvalidNativeError as e:
        return jsonify({"error": "stored diagram is not a valid dfd_v1 document", "detail": str(e)}), 500
    except ValidationError as e:
        return jsonify({"error": "stored diagram is not a valid dfd_v1 document", "detail": str(e)}), 500
    return jsonify(minimal)


@app.route("/api/diagrams/<diagram_id>", methods=["DELETE"])
def delete_diagram(diagram_id):
    path = DATA_DIR / f"{diagram_id}.json"
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    path.unlink()
    return "", 204


@app.route("/api/diagrams/<diagram_id>/import", methods=["PUT"])
def import_diagram_update(diagram_id):
    path = DATA_DIR / f"{diagram_id}.json"
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "request body must be valid JSON"}), 400
    try:
        native = to_native(body)
    except ValidationError as e:
        errors = e.errors(include_url=False)
        cleaned_errors = [
            {**err, "ctx": _safe_ctx(err["ctx"])} if "ctx" in err else err
            for err in errors
        ]
        return jsonify({"error": "validation failed", "details": cleaned_errors}), 400
    except DuplicateParentError as e:
        return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
    native.pop("layout", None)
    path.write_text(json.dumps(native, indent=4))
    return "", 204


def broadcast(envelope: dict) -> None:
    with _ws_lock:
        snapshot = set(_ws_clients)
    dead = set()
    for ws in snapshot:
        try:
            ws.send(json.dumps(envelope))
        except Exception:
            app.logger.exception("broadcast: failed to send to ws client")
            dead.add(ws)
    if dead:
        with _ws_lock:
            _ws_clients.difference_update(dead)


@app.route("/api/internal/broadcast", methods=["POST"])
def internal_broadcast():
    if request.remote_addr != "127.0.0.1":
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "request body must be valid JSON"}), 400
    if not isinstance(body.get("type"), str):
        return jsonify({"error": "type must be a string"}), 400
    broadcast(body)
    return jsonify({"ok": True})


@sock.route("/ws")
def ws_handler(ws):
    with _ws_lock:
        _ws_clients.add(ws)
    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
    except Exception:
        pass
    finally:
        with _ws_lock:
            _ws_clients.discard(ws)


@app.route("/api/layout", methods=["POST"])
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
        result = subprocess.run(
            ["d2", "--layout=tala", "-", "-"],
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
        # Dump the raw TALA SVG and D2 source next to the saved diagrams so
        # they can be inspected / opened directly.  Overwrites on each call;
        # diagnostic artifact, not persisted per-diagram.
        (DATA_DIR / "latest-layout.svg").write_text(result.stdout)
        (DATA_DIR / "latest-layout.d2").write_text(source)
        return jsonify({"svg": result.stdout})
    error_msg = result.stderr.strip() or "d2 exited with non-zero status"
    return jsonify({"error": error_msg}), 502
