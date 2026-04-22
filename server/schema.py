"""Pydantic v2 models for the minimal DFD import/export format.

This file is the schema contract for the minimal JSON format. It mirrors
the enums defined in DfdTemplates/DfdObjects.ts; see server/tests/test_drift.py
for enum-parity enforcement.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class NodeType(StrEnum):
    process = "process"
    external_entity = "external_entity"
    data_store = "data_store"


class ContainerType(StrEnum):
    trust_boundary = "trust_boundary"
    container = "container"


class TrustLevel(StrEnum):
    public = "public"
    authenticated = "authenticated"
    admin = "admin"
    system = "system"


class EntityType(StrEnum):
    user = "user"
    service = "service"
    system = "system"
    device = "device"


class StorageType(StrEnum):
    database = "database"
    cache = "cache"
    file = "file"
    queue = "queue"
    bucket = "bucket"


class PrivilegeLevel(StrEnum):
    internet = "internet"
    dmz = "dmz"
    corporate = "corporate"
    restricted = "restricted"


class DataItemClassification(StrEnum):
    unclassified = "unclassified"
    pii = "pii"
    secret = "secret"
    public = "public"
    internal = "internal"


# ---------------------------------------------------------------------------
# Node property models
# ---------------------------------------------------------------------------


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProcessProps(_Base):
    name: str
    description: str | None = None
    trust_level: TrustLevel | None = None
    assumptions: list[str] | None = None


class ExternalEntityProps(_Base):
    name: str
    description: str | None = None
    entity_type: EntityType | None = None
    out_of_scope: StrictBool = False


class DataStoreProps(_Base):
    name: str
    description: str | None = None
    storage_type: StorageType | None = None
    contains_pii: StrictBool = False
    encryption_at_rest: StrictBool = False


# ---------------------------------------------------------------------------
# Node models (discriminated union on `type`)
# ---------------------------------------------------------------------------


class ProcessNode(_Base):
    type: Literal[NodeType.process]
    guid: UUID
    properties: ProcessProps


class ExternalEntityNode(_Base):
    type: Literal[NodeType.external_entity]
    guid: UUID
    properties: ExternalEntityProps


class DataStoreNode(_Base):
    type: Literal[NodeType.data_store]
    guid: UUID
    properties: DataStoreProps


Node = Annotated[
    ProcessNode | ExternalEntityNode | DataStoreNode,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Container models (discriminated union on `type`)
# ---------------------------------------------------------------------------


class TrustBoundaryProps(_Base):
    name: str
    description: str | None = None
    privilege_level: PrivilegeLevel | None = None


class ContainerProps(_Base):
    name: str
    description: str | None = None


class TrustBoundaryContainer(_Base):
    type: Literal[ContainerType.trust_boundary]
    guid: UUID
    properties: TrustBoundaryProps
    children: list[UUID] = []


class ContainerContainer(_Base):
    type: Literal[ContainerType.container]
    guid: UUID
    properties: ContainerProps
    children: list[UUID] = []


Container = Annotated[
    TrustBoundaryContainer | ContainerContainer,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Data flow model
# ---------------------------------------------------------------------------


class DataFlowProps(_Base):
    name: str | None = None
    protocol: str | None = None
    authenticated: StrictBool = False
    encrypted: StrictBool = False
    node1_src_data_item_refs: list[UUID] = Field(default_factory=list)
    node2_src_data_item_refs: list[UUID] = Field(default_factory=list)


class DataFlow(_Base):
    guid: UUID
    properties: DataFlowProps
    node1: UUID
    node2: UUID

    @model_validator(mode="after")
    def _canonicalize_and_self_loop(self) -> "DataFlow":
        """Enforce canonical order and reject self-loops.

        If node1 == node2, raise ValueError (AC1.6).
        If node1 > node2 (UUID string comparison), swap both endpoint
        and the two ref arrays to achieve canonical storage (AC1.2).
        """
        if self.node1 == self.node2:
            raise ValueError("self-loop disallowed: node1 must differ from node2")

        # Canonicalize: ensure node1 < node2 by UUID string comparison
        if str(self.node1) > str(self.node2):
            # Swap endpoints
            self.node1, self.node2 = self.node2, self.node1
            # Swap ref arrays to preserve semantic direction
            (
                self.properties.node1_src_data_item_refs,
                self.properties.node2_src_data_item_refs,
            ) = (
                self.properties.node2_src_data_item_refs,
                self.properties.node1_src_data_item_refs,
            )

        return self


# ---------------------------------------------------------------------------
# Data item model
# ---------------------------------------------------------------------------


class DataItem(_Base):
    guid: UUID
    parent: UUID | None = None
    identifier: str
    name: str
    description: str | None = None
    classification: DataItemClassification = DataItemClassification.unclassified


# ---------------------------------------------------------------------------
# Top-level document
# ---------------------------------------------------------------------------


class Meta(_Base):
    name: str | None = None
    description: str | None = None
    author: str | None = None
    created: datetime | None = None


class Diagram(_Base):
    meta: Meta | None = None
    nodes: list[Node] = []
    containers: list[Container] = []
    data_flows: list[DataFlow] = []
    data_items: list[DataItem] = []

    @model_validator(mode="after")
    def _validate_flow_refs_and_endpoints(self) -> "Diagram":
        """Validate that flows reference valid nodes and data items.

        After per-flow canonicalisation:
        - Check that node1 and node2 refer to existing nodes (AC1.8).
        - Check that data_item_refs in both directions exist (AC1.7).
        """
        data_item_guids = {di.guid for di in self.data_items}
        node_guids = {n.guid for n in self.nodes}

        for flow in self.data_flows:
            # AC1.8: endpoints must exist
            if flow.node1 not in node_guids or flow.node2 not in node_guids:
                raise ValueError(
                    f"flow {flow.guid}: node1/node2 must refer to an existing canvas object"
                )

            # AC1.7: node1_src_data_item_refs direction
            for ref in flow.properties.node1_src_data_item_refs:
                if ref not in data_item_guids:
                    raise ValueError(
                        f"flow {flow.guid}: node1_src_data_item_refs contains unknown data item {ref}"
                    )

            # AC1.7: node2_src_data_item_refs direction
            for ref in flow.properties.node2_src_data_item_refs:
                if ref not in data_item_guids:
                    raise ValueError(
                        f"flow {flow.guid}: node2_src_data_item_refs contains unknown data item {ref}"
                    )

        return self
