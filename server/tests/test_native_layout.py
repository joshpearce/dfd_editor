"""Tests for POST /api/native-layout (scaffold contract)."""

from __future__ import annotations

import pytest

import storage
from app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


class TestNativeLayoutRoute:
    """Contract tests for POST /api/native-layout."""

    def test_valid_json_body_returns_200_and_empty_layout(self, client):
        resp = client.post("/api/native-layout", json={"nodes": [], "data_flows": []})
        assert resp.status_code == 200
        assert resp.get_json() == {"layout": {}}

    def test_empty_object_body_returns_200_and_empty_layout(self, client):
        resp = client.post("/api/native-layout", json={})
        assert resp.status_code == 200
        assert resp.get_json() == {"layout": {}}

    def test_non_json_body_returns_400_with_error_message(self, client):
        resp = client.post(
            "/api/native-layout",
            data="not json",
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert resp.get_json() == {"error": "request body must be valid JSON"}
