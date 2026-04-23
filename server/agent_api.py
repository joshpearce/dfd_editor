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
  * ``agent_service.WrongCollectionError`` → 400 with
    ``{"error", "actual_collection"}`` body detail shape.
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
# Error helpers
# Validation-error formatting is intentionally duplicated with editor_api
# so pydantic error shaping stays a blueprint-local concern (and neither
# blueprint imports from the other).
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


def _map_core_error(e: Exception) -> tuple[Response, int] | None:
    """Translate a core-layer or service-layer exception into (response, status).

    Returns None if the exception is not handled here (caller should re-raise
    or handle itself).
    """
    if isinstance(e, storage.DiagramNotFoundError):
        return jsonify({"error": "not found"}), 404
    if isinstance(e, agent_service.WrongCollectionError):
        return (
            jsonify({"error": str(e), "actual_collection": e.actual_collection}),
            400,
        )
    if isinstance(e, (core.ElementNotFoundError, core.ContainerNotFoundError)):
        return jsonify({"error": str(e)}), 404
    if isinstance(e, (core.InvalidCollectionError, core.MissingGuidError)):
        return jsonify({"error": str(e)}), 400
    if isinstance(e, (core.DuplicateGuidError, core.ContainerCycleError)):
        return jsonify({"error": str(e)}), 409
    return None


def _map_element_error(e: Exception) -> tuple[Response, int] | None:
    """Translate any element-operation exception (core + service + pydantic).

    Returns None when the exception is unhandled so the caller can re-raise.
    """
    mapped = _map_core_error(e)
    if mapped is not None:
        return mapped
    if isinstance(e, ValidationError):
        return _validation_error_response(e)
    if isinstance(e, storage.DuplicateParentError):
        return jsonify({"error": "duplicate parent", "detail": str(e)}), 400
    return None


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
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        raise


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
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        raise


@agent_api.post("/diagrams/<diagram_id>/display")
def display_diagram(diagram_id):
    try:
        return jsonify(agent_service.display_diagram(diagram_id, ws.broadcast))
    except Exception as e:
        mapped = _map_core_error(e)
        if mapped is not None:
            return mapped
        raise


# ---------------------------------------------------------------------------
# Typed per-collection element routes
#
# Instead of 16 near-identical handler functions, we generate them at module
# import time via _register_collection_routes(). Each call registers four
# Flask endpoints (POST/PATCH/DELETE/GET) for one collection segment. The
# collection name is captured in a default argument so each closure is
# independent.
# ---------------------------------------------------------------------------

_PROPERTIED_SUMMARY_MAP: dict[str, str] = {
    "guid": "guid",
    "name": "properties.name",
    "type": "type",
}

_COLLECTIONS: list[tuple[str, dict[str, str]]] = [
    ("nodes", _PROPERTIED_SUMMARY_MAP),
    ("containers", _PROPERTIED_SUMMARY_MAP),
    (
        "data_flows",
        {"guid": "guid", "name": "properties.name", "node1": "node1", "node2": "node2"},
    ),
    (
        "data_items",
        {"guid": "guid", "name": "name", "classification": "classification"},
    ),
]


def _register_collection_routes(collection: str, field_map: dict[str, str]) -> None:
    """Register POST/PATCH/DELETE/GET at /diagrams/<id>/<collection>[/<guid>].

    ``collection`` is the URL segment (also passed to agent_service as
    ``expected_collection`` on update / delete). ``field_map`` is the GET
    projection — a mapping of output key → source path (top-level key or
    ``properties.<key>``), evaluated by agent_service.list_summaries.
    """

    # POST /diagrams/<diagram_id>/<collection>
    def add_handler(diagram_id, _col=collection):
        body, err = _body_or_400()
        if err is not None:
            return err
        if not isinstance(body, dict):
            return jsonify({"error": "body must be a JSON object"}), 400
        try:
            result = agent_service.add_element(diagram_id, _col, body, ws.broadcast)
        except Exception as e:
            mapped = _map_element_error(e)
            if mapped is not None:
                return mapped
            raise
        return jsonify(result), 201

    add_handler.__name__ = f"add_{collection}"

    # PATCH /diagrams/<diagram_id>/<collection>/<guid>
    def update_handler(diagram_id, guid, _col=collection):
        body, err = _body_or_400()
        if err is not None:
            return err
        if not isinstance(body, dict):
            return jsonify({"error": "body must be a JSON object of fields"}), 400
        try:
            result = agent_service.update_element(
                diagram_id, guid, body, ws.broadcast, expected_collection=_col
            )
        except Exception as e:
            mapped = _map_element_error(e)
            if mapped is not None:
                return mapped
            raise
        return jsonify(result)

    update_handler.__name__ = f"update_{collection}"

    # DELETE /diagrams/<diagram_id>/<collection>/<guid>
    def delete_handler(diagram_id, guid, _col=collection):
        try:
            result = agent_service.delete_element(
                diagram_id, guid, ws.broadcast, expected_collection=_col
            )
        except Exception as e:
            mapped = _map_element_error(e)
            if mapped is not None:
                return mapped
            raise
        return jsonify(result)

    delete_handler.__name__ = f"delete_{collection}"

    # GET /diagrams/<diagram_id>/<collection>
    def list_handler(diagram_id, _col=collection, _field_map=field_map):
        try:
            return jsonify(agent_service.list_summaries(diagram_id, _col, _field_map))
        except Exception as e:
            mapped = _map_core_error(e)
            if mapped is not None:
                return mapped
            raise

    list_handler.__name__ = f"list_{collection}"

    # Register all four routes on the blueprint.
    base = f"/diagrams/<diagram_id>/{collection}"
    routes = (
        ("", ["POST"], f"add_{collection}", add_handler),
        ("/<guid>", ["PATCH"], f"update_{collection}", update_handler),
        ("/<guid>", ["DELETE"], f"delete_{collection}", delete_handler),
        ("", ["GET"], f"list_{collection}", list_handler),
    )
    for suffix, methods, endpoint, view in routes:
        agent_api.add_url_rule(base + suffix, endpoint=endpoint, view_func=view, methods=methods)


for _collection, _field_map in _COLLECTIONS:
    _register_collection_routes(_collection, _field_map)


# ---------------------------------------------------------------------------
# Shared reparent endpoint
# ---------------------------------------------------------------------------


@agent_api.post("/diagrams/<diagram_id>/reparent")
def reparent_element(diagram_id):
    body, err = _body_or_400()
    if err is not None:
        return err
    if not isinstance(body, dict):
        return jsonify({"error": "body must be a JSON object"}), 400
    if not isinstance(body.get("guid"), str):
        return jsonify({"error": "body must contain 'guid' (string)"}), 400
    if "new_parent_guid" not in body:
        return jsonify({"error": "body must contain 'new_parent_guid' (string or null)"}), 400
    new_parent_guid = body["new_parent_guid"]
    if new_parent_guid is not None and not isinstance(new_parent_guid, str):
        return jsonify({"error": "'new_parent_guid' must be string or null"}), 400
    try:
        result = agent_service.reparent_element(
            diagram_id, body["guid"], new_parent_guid, ws.broadcast
        )
    except Exception as e:
        mapped = _map_element_error(e)
        if mapped is not None:
            return mapped
        raise
    return jsonify(result)
