"""Flask blueprint mounted at ``/api/agent`` for external (non-MCP) agent clients.

Each route is a thin translator: parse the request, call the matching
``agent_service`` function with ``ws.broadcast`` as the in-process
broadcast strategy, map typed exceptions to HTTP status codes, return
JSON.

Error mapping:
  * ``DiagramNotFoundError``, ``ElementNotFoundError``,
    ``ContainerNotFoundError`` → 404
  * ``InvalidCollectionError``, ``MissingGuidError`` → 400
  * ``DuplicateGuidError``, ``ContainerCycleError`` → 409 (conflict with
    current state)
  * ``pydantic.ValidationError`` / ``DuplicateParentError`` → 400 with
    ``{"error", "details"}`` detail shape reused from the editor API.
"""

from __future__ import annotations

import json
from typing import Any

from flask import Blueprint, Response, jsonify, request
from pydantic import ValidationError

import agent_service
import core
import storage
import ws


agent_api = Blueprint("agent_api", __name__, url_prefix="/api/agent")


# ---------------------------------------------------------------------------
# Error helpers (shared with editor_api via duplication — error details are a
# pydantic/Flask-specific concern, not a core concern).
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


def _validation_error_response(e: ValidationError) -> tuple[Response, int]:
    errors = e.errors(include_url=False)
    cleaned = [
        {**err, "ctx": _safe_ctx(err["ctx"])} if "ctx" in err else err
        for err in errors
    ]
    return jsonify({"error": "validation failed", "details": cleaned}), 400


def _body_or_400() -> tuple[dict | None, tuple[Response, int] | None]:
    body = request.get_json(silent=True)
    if body is None:
        return None, (jsonify({"error": "request body must be valid JSON"}), 400)
    return body, None


# ---------------------------------------------------------------------------
# Read-only routes
# ---------------------------------------------------------------------------


@agent_api.get("/schema")
def get_schema():
    return jsonify(agent_service.get_schema())


@agent_api.get("/diagrams")
def list_diagrams():
    return jsonify(agent_service.list_diagrams())


@agent_api.get("/diagrams/<diagram_id>")
def get_diagram(diagram_id):
    try:
        return jsonify(agent_service.get_diagram(diagram_id))
    except storage.DiagramNotFoundError:
        return jsonify({"error": "not found"}), 404


# ---------------------------------------------------------------------------
# Diagram-level writes
# ---------------------------------------------------------------------------


@agent_api.post("/diagrams")
def create_diagram():
    body, err = _body_or_400()
    if err is not None:
        return err
    try:
        result = agent_service.create_diagram(body)
    except ValidationError as e:
        return _validation_error_response(e)
    except storage.DuplicateParentError as e:
        return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
    return jsonify(result), 201


@agent_api.put("/diagrams/<diagram_id>")
def update_diagram(diagram_id):
    body, err = _body_or_400()
    if err is not None:
        return err
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    try:
        result = agent_service.update_diagram(diagram_id, body, ws.broadcast)
    except ValidationError as e:
        return _validation_error_response(e)
    except storage.DuplicateParentError as e:
        return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
    return jsonify(result)


@agent_api.delete("/diagrams/<diagram_id>")
def delete_diagram(diagram_id):
    try:
        return jsonify(agent_service.delete_diagram(diagram_id, ws.broadcast))
    except storage.DiagramNotFoundError:
        return jsonify({"error": "not found"}), 404


@agent_api.post("/diagrams/<diagram_id>/display")
def display_diagram(diagram_id):
    try:
        return jsonify(agent_service.display_diagram(diagram_id, ws.broadcast))
    except storage.DiagramNotFoundError:
        return jsonify({"error": "not found"}), 404


# ---------------------------------------------------------------------------
# Granular element routes
# ---------------------------------------------------------------------------


def _map_core_error(e: Exception) -> tuple[Response, int] | None:
    """Translate a core-layer exception into (response, status). None if unhandled."""
    if isinstance(e, (core.ElementNotFoundError, core.ContainerNotFoundError)):
        return jsonify({"error": str(e)}), 404
    if isinstance(e, (core.InvalidCollectionError, core.MissingGuidError)):
        return jsonify({"error": str(e)}), 400
    if isinstance(e, (core.DuplicateGuidError, core.ContainerCycleError)):
        return jsonify({"error": str(e)}), 409
    return None


@agent_api.post("/diagrams/<diagram_id>/elements")
def add_element(diagram_id):
    body, err = _body_or_400()
    if err is not None:
        return err
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    collection = body.get("collection")
    element = body.get("element")
    if not isinstance(collection, str) or not isinstance(element, dict):
        return (
            jsonify(
                {"error": "body must contain 'collection' (string) and 'element' (object)"}
            ),
            400,
        )
    try:
        result = agent_service.add_element(diagram_id, collection, element, ws.broadcast)
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        if isinstance(e, ValidationError):
            return _validation_error_response(e)
        if isinstance(e, storage.DuplicateParentError):
            return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
        raise
    return jsonify(result), 201


@agent_api.patch("/diagrams/<diagram_id>/elements/<guid>")
def update_element(diagram_id, guid):
    body, err = _body_or_400()
    if err is not None:
        return err
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    if not isinstance(body, dict):
        return jsonify({"error": "body must be a JSON object of fields"}), 400
    try:
        result = agent_service.update_element(diagram_id, guid, body, ws.broadcast)
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        if isinstance(e, ValidationError):
            return _validation_error_response(e)
        if isinstance(e, storage.DuplicateParentError):
            return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
        raise
    return jsonify(result)


@agent_api.delete("/diagrams/<diagram_id>/elements/<guid>")
def delete_element(diagram_id, guid):
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    try:
        result = agent_service.delete_element(diagram_id, guid, ws.broadcast)
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        if isinstance(e, ValidationError):
            return _validation_error_response(e)
        if isinstance(e, storage.DuplicateParentError):
            return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
        raise
    return jsonify(result)


@agent_api.post("/diagrams/<diagram_id>/elements/<guid>/reparent")
def reparent_element(diagram_id, guid):
    body, err = _body_or_400()
    if err is not None:
        return err
    if not storage.diagram_exists(diagram_id):
        return jsonify({"error": "not found"}), 404
    if not isinstance(body, dict) or "new_parent_guid" not in body:
        return jsonify({"error": "body must contain 'new_parent_guid' (string or null)"}), 400
    new_parent_guid = body["new_parent_guid"]
    if new_parent_guid is not None and not isinstance(new_parent_guid, str):
        return jsonify({"error": "'new_parent_guid' must be string or null"}), 400
    try:
        result = agent_service.reparent_element(diagram_id, guid, new_parent_guid, ws.broadcast)
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        if isinstance(e, ValidationError):
            return _validation_error_response(e)
        if isinstance(e, storage.DuplicateParentError):
            return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
        raise
    return jsonify(result)
