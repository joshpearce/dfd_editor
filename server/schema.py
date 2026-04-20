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

from pydantic import BaseModel, ConfigDict, Field, StrictBool


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


class DataClassification(StrEnum):
    public = "public"
    internal = "internal"
    confidential = "confidential"
    secret = "secret"


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
    data_classification: DataClassification | None = None
    protocol: str | None = None
    authenticated: StrictBool = False
    encrypted: StrictBool = False
    data_item_refs: list[UUID] = []


class DataFlow(_Base):
    guid: UUID
    properties: DataFlowProps
    source: UUID
    target: UUID


# ---------------------------------------------------------------------------
# Data item model
# ---------------------------------------------------------------------------


class DataItem(_Base):
    guid: UUID
    parent: UUID
    identifier: str
    name: str
    description: str | None = None
    classification: str | None = None


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
