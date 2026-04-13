import json
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["http://localhost:5173"])

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
