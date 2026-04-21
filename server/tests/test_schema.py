"""Tests for the minimal DFD schema (pydantic v2 models in schema.py)."""

from uuid import UUID, uuid4

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
                "node1": node_guid,
                "node2": target_guid,
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


class TestDataFlow:
    """Tests for bidirectional Flow shape, canonical swap, and validation (AC1.1-AC1.8, AC7.3)."""

    # Fixed UUIDs for deterministic assertions
    _NODE_A = "11111111-1111-1111-1111-111111111111"
    _NODE_B = "22222222-2222-2222-2222-222222222222"
    _ITEM_1 = "33333333-3333-3333-3333-333333333333"
    _ITEM_2 = "44444444-4444-4444-4444-444444444444"
    _ITEM_3 = "55555555-5555-5555-5555-555555555555"
    _FLOW_GUID = "66666666-6666-6666-6666-666666666666"

    def _make_flow_doc(
        self,
        node1: str = _NODE_A,
        node2: str = _NODE_B,
        node1_refs: list[str] | None = None,
        node2_refs: list[str] | None = None,
    ) -> dict:
        """Build a minimal flow object with fixed node/ref UUIDs."""
        if node1_refs is None:
            node1_refs = []
        if node2_refs is None:
            node2_refs = []

        return {
            "guid": self._FLOW_GUID,
            "properties": {
                "name": "Test flow",
                "node1_src_data_item_refs": node1_refs,
                "node2_src_data_item_refs": node2_refs,
            },
            "node1": node1,
            "node2": node2,
        }

    def _make_diagram_with_flow(
        self,
        flow_doc: dict,
        include_data_items: bool = False,
    ) -> dict:
        """Build a complete diagram around a flow."""
        diagram: dict = {
            "nodes": [
                {
                    "type": "process",
                    "guid": self._NODE_A,
                    "properties": {"name": "Node A"},
                },
                {
                    "type": "external_entity",
                    "guid": self._NODE_B,
                    "properties": {"name": "Node B"},
                },
            ],
            "data_flows": [flow_doc],
        }

        if include_data_items:
            diagram["data_items"] = [
                {
                    "guid": self._ITEM_1,
                    "parent": self._NODE_A,
                    "identifier": "item-1",
                    "name": "Item 1",
                },
                {
                    "guid": self._ITEM_2,
                    "parent": self._NODE_A,
                    "identifier": "item-2",
                    "name": "Item 2",
                },
                {
                    "guid": self._ITEM_3,
                    "parent": self._NODE_B,
                    "identifier": "item-3",
                    "name": "Item 3",
                },
            ]

        return diagram

    def test_canonical_order_preserved(self):
        """AC1.1: node1 < node2, both ref arrays populated.
        After construction, endpoints and ref arrays unchanged."""
        flow_doc = self._make_flow_doc(
            node1=self._NODE_A,
            node2=self._NODE_B,
            node1_refs=[self._ITEM_1, self._ITEM_2],
            node2_refs=[self._ITEM_3],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc, include_data_items=True)
        diagram = Diagram.model_validate(diagram_dict)

        flow = diagram.data_flows[0]
        assert flow.node1 == UUID(self._NODE_A)
        assert flow.node2 == UUID(self._NODE_B)
        assert flow.properties.node1_src_data_item_refs == [
            UUID(self._ITEM_1),
            UUID(self._ITEM_2),
        ]
        assert flow.properties.node2_src_data_item_refs == [UUID(self._ITEM_3)]

    def test_canonical_order_swapped(self):
        """AC1.2: node1 > node2. After construction, endpoints are swapped
        AND the two ref arrays are swapped."""
        # Start with node1 > node2 (reversed)
        flow_doc = self._make_flow_doc(
            node1=self._NODE_B,  # Greater UUID
            node2=self._NODE_A,  # Lesser UUID
            node1_refs=[self._ITEM_1, self._ITEM_2],
            node2_refs=[self._ITEM_3],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc, include_data_items=True)
        diagram = Diagram.model_validate(diagram_dict)

        flow = diagram.data_flows[0]
        # After canonicalisation, node1 < node2
        assert flow.node1 == UUID(self._NODE_A)
        assert flow.node2 == UUID(self._NODE_B)
        # And ref arrays are swapped: what was node1_src becomes node2_src, vice versa
        assert flow.properties.node1_src_data_item_refs == [UUID(self._ITEM_3)]
        assert flow.properties.node2_src_data_item_refs == [
            UUID(self._ITEM_1),
            UUID(self._ITEM_2),
        ]

    def test_both_refs_empty_accepted(self):
        """AC1.3, AC2.4: both arrays []. Model constructs without error."""
        flow_doc = self._make_flow_doc(
            node1=self._NODE_A,
            node2=self._NODE_B,
            node1_refs=[],
            node2_refs=[],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc)
        diagram = Diagram.model_validate(diagram_dict)

        flow = diagram.data_flows[0]
        assert flow.properties.node1_src_data_item_refs == []
        assert flow.properties.node2_src_data_item_refs == []

    def test_only_node1_src_refs_populated(self):
        """AC1.4: only node1_src_data_item_refs populated, node2_src empty."""
        flow_doc = self._make_flow_doc(
            node1=self._NODE_A,
            node2=self._NODE_B,
            node1_refs=[self._ITEM_1, self._ITEM_2],
            node2_refs=[],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc, include_data_items=True)
        diagram = Diagram.model_validate(diagram_dict)

        flow = diagram.data_flows[0]
        assert flow.properties.node1_src_data_item_refs == [
            UUID(self._ITEM_1),
            UUID(self._ITEM_2),
        ]
        assert flow.properties.node2_src_data_item_refs == []

    def test_both_refs_populated(self):
        """AC1.5: both arrays have content. Model constructs."""
        flow_doc = self._make_flow_doc(
            node1=self._NODE_A,
            node2=self._NODE_B,
            node1_refs=[self._ITEM_1],
            node2_refs=[self._ITEM_2, self._ITEM_3],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc, include_data_items=True)
        diagram = Diagram.model_validate(diagram_dict)

        flow = diagram.data_flows[0]
        assert flow.properties.node1_src_data_item_refs == [UUID(self._ITEM_1)]
        assert flow.properties.node2_src_data_item_refs == [
            UUID(self._ITEM_2),
            UUID(self._ITEM_3),
        ]

    def test_self_loop_raises(self):
        """AC1.6: node1 == node2. Must raise ValidationError with 'self-loop'."""
        flow_doc = self._make_flow_doc(node1=self._NODE_A, node2=self._NODE_A)
        diagram_dict = self._make_diagram_with_flow(flow_doc)

        with pytest.raises(ValidationError, match="self-loop"):
            Diagram.model_validate(diagram_dict)

    def test_dangling_ref_in_node1_direction(self):
        """AC1.7: node1_src_data_item_refs contains unknown UUID.
        ValidationError message must contain 'node1_src_data_item_refs'."""
        dangling_uuid = "99999999-9999-9999-9999-999999999999"
        flow_doc = self._make_flow_doc(
            node1=self._NODE_A,
            node2=self._NODE_B,
            node1_refs=[dangling_uuid],
            node2_refs=[],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc, include_data_items=True)

        with pytest.raises(ValidationError, match="node1_src_data_item_refs"):
            Diagram.model_validate(diagram_dict)

    def test_dangling_ref_in_node2_direction(self):
        """AC1.7: node2_src_data_item_refs contains unknown UUID.
        ValidationError message must contain 'node2_src_data_item_refs'."""
        dangling_uuid = "99999999-9999-9999-9999-999999999999"
        flow_doc = self._make_flow_doc(
            node1=self._NODE_A,
            node2=self._NODE_B,
            node1_refs=[],
            node2_refs=[dangling_uuid],
        )
        diagram_dict = self._make_diagram_with_flow(flow_doc, include_data_items=True)

        with pytest.raises(ValidationError, match="node2_src_data_item_refs"):
            Diagram.model_validate(diagram_dict)

    def test_endpoint_not_in_nodes_raises(self):
        """AC1.8: node1/node2 refers to UUID absent from nodes.
        ValidationError must be raised."""
        fake_node = "88888888-8888-8888-8888-888888888888"
        flow_doc = self._make_flow_doc(node1=fake_node, node2=self._NODE_B)
        diagram_dict = self._make_diagram_with_flow(flow_doc)

        with pytest.raises(ValidationError):
            Diagram.model_validate(diagram_dict)

    def test_old_shape_payload_rejected(self):
        """AC7.3: old-shape payload with 'source', 'target', 'data_item_refs'
        must raise ValidationError (extra="forbid" on DataFlow)."""
        diagram_dict = {
            "nodes": [
                {
                    "type": "process",
                    "guid": self._NODE_A,
                    "properties": {"name": "Node A"},
                },
                {
                    "type": "external_entity",
                    "guid": self._NODE_B,
                    "properties": {"name": "Node B"},
                },
            ],
            "data_flows": [
                {
                    "guid": self._FLOW_GUID,
                    "properties": {
                        "name": "Old flow",
                        "data_item_refs": [self._ITEM_1],  # Old key
                    },
                    "source": self._NODE_A,  # Old key
                    "target": self._NODE_B,  # Old key
                }
            ],
        }

        with pytest.raises(ValidationError):
            Diagram.model_validate(diagram_dict)
