import json
import subprocess
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from pydantic import ValidationError

from transform import DuplicateParentError, InvalidNativeError, to_minimal, to_native

app = Flask(__name__)
CORS(app, origins=["http://localhost:5173"])

# Tests override this via monkeypatch.setattr("app.DATA_DIR", ...).
# Any refactor that reads DATA_DIR from a different module must preserve
# this overridable seam.
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


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
            "name": data.get("name") or path.stem,
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
        return jsonify({"error": "validation failed", "details": e.errors(include_url=False)}), 400
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
