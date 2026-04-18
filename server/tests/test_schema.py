"""Tests for the minimal DFD schema (pydantic v2 models in schema.py)."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from schema import (
    Diagram,
    DataClassification,
    DataFlow,
    DataFlowProps,
    ExternalEntityNode,
    ExternalEntityProps,
    Meta,
    NodeType,
    ProcessNode,
    ProcessProps,
    TrustBoundaryContainer,
    TrustBoundaryProps,
    TrustLevel,
)


def _make_minimal_diagram() -> dict:
    """Return a minimal valid diagram dict with one of each top-level object."""
    node_guid = str(uuid4())
    target_guid = str(uuid4())
    container_guid = str(uuid4())
    flow_guid = str(uuid4())

    return {
        "meta": {
            "name": "Test diagram",
            "description": "A test",
            "author": "Tester",
            "created": "2026-01-15T12:00:00Z",
        },
        "nodes": [
            {
                "type": "process",
                "guid": node_guid,
                "properties": {"name": "Auth Service", "trust_level": "system"},
            },
            {
                "type": "external_entity",
                "guid": target_guid,
                "properties": {"name": "Browser", "entity_type": "user"},
            },
        ],
        "containers": [
            {
                "type": "trust_boundary",
                "guid": container_guid,
                "properties": {"name": "DMZ", "privilege_level": "dmz"},
                "children": [node_guid],
            }
        ],
        "data_flows": [
            {
                "guid": flow_guid,
                "properties": {
                    "name": "Login request",
                    "data_classification": "confidential",
                    "authenticated": True,
                    "encrypted": True,
                },
                "source": node_guid,
                "target": target_guid,
            }
        ],
    }


class TestMinimalValidDoc:
    def test_parses_without_error(self):
        doc = _make_minimal_diagram()
        diagram = Diagram.model_validate(doc)
        assert len(diagram.nodes) == 2
        assert len(diagram.containers) == 1
        assert len(diagram.data_flows) == 1

    def test_meta_fields_populated(self):
        doc = _make_minimal_diagram()
        diagram = Diagram.model_validate(doc)
        assert diagram.meta is not None
        assert diagram.meta.name == "Test diagram"
        assert diagram.meta.author == "Tester"

    def test_process_node_trust_level(self):
        doc = _make_minimal_diagram()
        diagram = Diagram.model_validate(doc)
        process = diagram.nodes[0]
        assert process.properties.trust_level == TrustLevel.system  # type: ignore[union-attr]

    def test_container_children_are_uuids(self):
        doc = _make_minimal_diagram()
        diagram = Diagram.model_validate(doc)
        node_guid = doc["nodes"][0]["guid"]
        from uuid import UUID
        assert diagram.containers[0].children[0] == UUID(node_guid)  # type: ignore[index]

    def test_data_flow_booleans(self):
        doc = _make_minimal_diagram()
        diagram = Diagram.model_validate(doc)
        flow = diagram.data_flows[0]
        assert flow.properties.authenticated is True
        assert flow.properties.encrypted is True


class TestInvalidTrustLevel:
    def test_unknown_trust_level_rejected(self):
        doc = _make_minimal_diagram()
        doc["nodes"][0]["properties"]["trust_level"] = "super_admin"
        with pytest.raises(ValidationError) as exc_info:
            Diagram.model_validate(doc)
        errors = exc_info.value.errors()
        locs = [e["loc"] for e in errors]
        # At least one error must point at trust_level
        assert any(loc[-1] == "trust_level" for loc in locs), (
            f"Expected an error pointing at 'trust_level', got: {locs}"
        )


class TestMetaOptional:
    def test_missing_meta_validates(self):
        doc = _make_minimal_diagram()
        del doc["meta"]
        diagram = Diagram.model_validate(doc)
        assert diagram.meta is None

    def test_empty_diagram_validates(self):
        diagram = Diagram.model_validate({})
        assert diagram.meta is None
        assert diagram.nodes == []
        assert diagram.containers == []
        assert diagram.data_flows == []


class TestBooleanTypes:
    def test_boolean_true_validates(self):
        doc = _make_minimal_diagram()
        # authenticated=True (real bool) should validate
        diagram = Diagram.model_validate(doc)
        assert diagram.data_flows[0].properties.authenticated is True

    def test_boolean_string_true_rejected(self):
        doc = _make_minimal_diagram()
        doc["data_flows"][0]["properties"]["authenticated"] = "true"
        with pytest.raises(ValidationError) as exc_info:
            Diagram.model_validate(doc)
        errors = exc_info.value.errors()
        locs = [e["loc"] for e in errors]
        assert any(loc[-1] == "authenticated" for loc in locs), (
            f"Expected error on 'authenticated', got: {locs}"
        )

    def test_boolean_string_false_rejected(self):
        doc = _make_minimal_diagram()
        doc["data_flows"][0]["properties"]["encrypted"] = "false"
        with pytest.raises(ValidationError) as exc_info:
            Diagram.model_validate(doc)
        errors = exc_info.value.errors()
        locs = [e["loc"] for e in errors]
        assert any(loc[-1] == "encrypted" for loc in locs), (
            f"Expected error on 'encrypted', got: {locs}"
        )


class TestExtraFieldsRejected:
    def test_unknown_node_field_rejected(self):
        doc = _make_minimal_diagram()
        doc["nodes"][0]["properties"]["unknown_field"] = "oops"
        with pytest.raises(ValidationError):
            Diagram.model_validate(doc)

    def test_unknown_top_level_field_rejected(self):
        doc = _make_minimal_diagram()
        doc["extra_field"] = "not allowed"
        with pytest.raises(ValidationError):
            Diagram.model_validate(doc)
