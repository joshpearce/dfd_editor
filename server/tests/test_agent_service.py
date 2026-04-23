"""Unit tests for agent_service orchestration with a captured-broadcast fake.

Covers:
  * Correct broadcast envelope emission per operation.
  * ``broadcast_delivered`` propagation from callback return value.
  * Error paths skip the broadcast step.
  * Persisted state matches the in-memory mutation (fetch-verify loop).
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

import agent_service
import core
import storage


_PROCESS_GUID = "11111111-0000-0000-0000-000000000001"
_STORE_GUID = "33333333-0000-0000-0000-000000000003"
_FLOW_GUID = "66666666-0000-0000-0000-000000000006"
_NEW_NODE_GUID = "aaaaaaaa-0000-0000-0000-000000000001"


_MINIMAL_DOC: dict[str, Any] = {
    "meta": {"name": "service test"},
    "nodes": [
        {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "P"}},
        {"type": "data_store", "guid": _STORE_GUID, "properties": {"name": "DS"}},
    ],
    "containers": [],
    "data_flows": [
        {
            "guid": _FLOW_GUID,
            "node1": _PROCESS_GUID,
            "node2": _STORE_GUID,
            "properties": {"name": "F"},
        }
    ],
    "data_items": [],
}


@pytest.fixture
def tmp_storage(tmp_path, monkeypatch):
    """Isolate storage.DATA_DIR into a per-test tmp_path."""
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    return tmp_path


class _Spy:
    """Captures broadcast envelopes and returns the delivery flag it's given."""

    def __init__(self, returns: bool = True) -> None:
        self.envelopes: list[dict] = []
        self._returns = returns

    def __call__(self, envelope: dict) -> bool:
        self.envelopes.append(envelope)
        return self._returns


class TestCreateDiagram:
    def test_persists_and_returns_minimal(self, tmp_storage):
        result = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        assert "id" in result and "diagram" in result
        assert (tmp_storage / f"{result['id']}.json").exists()

    def test_does_not_broadcast(self, tmp_storage):
        # create_diagram has no broadcast argument, so simply confirm it
        # completes without any Spy wiring — no broadcast is possible.
        result = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        assert result["diagram"]["meta"]["name"] == "service test"


class TestUpdateDiagram:
    def test_replaces_and_broadcasts(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        doc = copy.deepcopy(_MINIMAL_DOC)
        doc["meta"]["name"] = "Renamed"
        spy = _Spy()
        result = agent_service.update_diagram(created["id"], doc, spy)
        assert result["broadcast_delivered"] is True
        assert result["id"] == created["id"]
        assert result["diagram"]["meta"]["name"] == "Renamed"
        assert len(spy.envelopes) == 1
        assert spy.envelopes[0] == {
            "type": "diagram-updated",
            "payload": {"id": created["id"]},
        }

    def test_reports_broadcast_failure(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy(returns=False)
        result = agent_service.update_diagram(created["id"], copy.deepcopy(_MINIMAL_DOC), spy)
        assert result["broadcast_delivered"] is False


class TestDeleteDiagram:
    def test_removes_file_and_broadcasts(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        result = agent_service.delete_diagram(created["id"], spy)
        assert result == {"ok": True, "broadcast_delivered": True}
        assert not (tmp_storage / f"{created['id']}.json").exists()
        assert spy.envelopes == [{"type": "diagram-deleted", "payload": {"id": created["id"]}}]

    def test_missing_raises_and_does_not_broadcast(self, tmp_storage):
        spy = _Spy()
        with pytest.raises(storage.DiagramNotFoundError):
            agent_service.delete_diagram("no-such-id", spy)
        assert spy.envelopes == []


class TestDisplayDiagram:
    def test_existing_id_broadcasts_display(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        result = agent_service.display_diagram(created["id"], spy)
        assert result == {"ok": True, "broadcast_delivered": True}
        assert spy.envelopes == [{"type": "display", "payload": {"id": created["id"]}}]

    def test_missing_id_raises(self, tmp_storage):
        spy = _Spy()
        with pytest.raises(storage.DiagramNotFoundError):
            agent_service.display_diagram("no-such-id", spy)
        assert spy.envelopes == []


class TestAddElement:
    def test_appends_and_broadcasts(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        new_node = {
            "type": "external_entity",
            "guid": _NEW_NODE_GUID,
            "properties": {"name": "EE"},
        }
        result = agent_service.add_element(created["id"], "nodes", new_node, spy)
        assert result == {"guid": _NEW_NODE_GUID, "broadcast_delivered": True}
        fetched = agent_service.get_diagram(created["id"])
        assert any(n["guid"] == _NEW_NODE_GUID for n in fetched["nodes"])
        assert spy.envelopes[0]["type"] == "diagram-updated"

    def test_duplicate_guid_raises_and_does_not_broadcast(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        dup = {"type": "process", "guid": _PROCESS_GUID, "properties": {"name": "dup"}}
        with pytest.raises(core.DuplicateGuidError):
            agent_service.add_element(created["id"], "nodes", dup, spy)
        assert spy.envelopes == []

    def test_invalid_collection_raises_and_does_not_broadcast(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        with pytest.raises(core.InvalidCollectionError):
            agent_service.add_element(created["id"], "edges", {"guid": "x"}, spy)
        assert spy.envelopes == []


class TestUpdateElement:
    def test_updates_and_broadcasts(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        result = agent_service.update_element(
            created["id"], _PROCESS_GUID, {"name": "Renamed P"}, spy,
        )
        assert result["broadcast_delivered"] is True
        fetched = agent_service.get_diagram(created["id"])
        node = next(n for n in fetched["nodes"] if n["guid"] == _PROCESS_GUID)
        assert node["properties"]["name"] == "Renamed P"

    def test_unknown_guid_raises(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        with pytest.raises(core.ElementNotFoundError):
            agent_service.update_element(created["id"], "no-such", {"name": "x"}, spy)
        assert spy.envelopes == []


class TestDeleteElement:
    def test_cascade_flow_on_node_delete(self, tmp_storage):
        created = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        spy = _Spy()
        result = agent_service.delete_element(created["id"], _PROCESS_GUID, spy)
        assert result["deleted_collection"] == "nodes"
        assert _FLOW_GUID in result["cascade_removed"]
        assert result["broadcast_delivered"] is True


_RP_NODE = "aaaa0000-0000-0000-0000-000000000001"
_RP_A = "bbbb0000-0000-0000-0000-00000000000a"
_RP_B = "bbbb0000-0000-0000-0000-00000000000b"


class TestReparentElement:
    def _doc(self) -> dict:
        return {
            "meta": {"name": "rp"},
            "nodes": [
                {"type": "process", "guid": _RP_NODE, "properties": {"name": "N1"}},
            ],
            "containers": [
                {"type": "trust_boundary", "guid": _RP_A, "properties": {"name": "A"}, "children": [_RP_NODE]},
                {"type": "trust_boundary", "guid": _RP_B, "properties": {"name": "B"}, "children": []},
            ],
            "data_flows": [],
            "data_items": [],
        }

    def test_moves_and_broadcasts(self, tmp_storage):
        created = agent_service.create_diagram(self._doc())
        spy = _Spy()
        result = agent_service.reparent_element(created["id"], _RP_NODE, _RP_B, spy)
        assert result["old_parent_guid"] == _RP_A
        assert result["new_parent_guid"] == _RP_B
        fetched = agent_service.get_diagram(created["id"])
        by_guid = {c["guid"]: c for c in fetched["containers"]}
        assert _RP_NODE in by_guid[_RP_B]["children"]


class TestListDiagrams:
    def test_lists_created_diagrams(self, tmp_storage):
        a = agent_service.create_diagram(copy.deepcopy(_MINIMAL_DOC))
        b_doc = copy.deepcopy(_MINIMAL_DOC)
        b_doc["meta"]["name"] = "B"
        b = agent_service.create_diagram(b_doc)
        ids = {s["id"] for s in agent_service.list_diagrams()}
        assert a["id"] in ids
        assert b["id"] in ids


class TestGetSchema:
    def test_returns_diagram_json_schema(self, tmp_storage):
        schema = agent_service.get_schema()
        assert schema["title"] == "Diagram"
        assert "nodes" in schema["properties"]
