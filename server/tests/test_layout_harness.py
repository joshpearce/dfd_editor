"""Tests for POST /api/layout-harness (parity-harness route contract).

The route shells ``npx vitest run`` via subprocess — tests monkeypatch
``editor_api.subprocess.run`` so the suite is fast, deterministic, and
requires no JS toolchain.
"""

from __future__ import annotations

import json
import os
import subprocess
import types
from typing import Callable

import pytest

import editor_api
import storage
from app import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _make_fake_run(
    *,
    payload: dict | None = None,
    returncode: int = 0,
    stderr: str = "",
    stdout: str = "",
    raise_exc: BaseException | None = None,
) -> tuple[Callable, list]:
    """Return (fake_run, calls) where calls is appended to on each invocation."""
    calls: list[tuple] = []

    def fake_run(args, **kwargs):  # noqa: ANN001
        calls.append((args, kwargs))
        if raise_exc is not None:
            raise raise_exc
        out_path = kwargs["env"]["LAYOUT_HARNESS_OUT"]
        if payload is not None:
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
        return types.SimpleNamespace(returncode=returncode, stderr=stderr, stdout=stdout)

    return fake_run, calls


# ---------------------------------------------------------------------------
# 400 — input-validation cases (no subprocess needed)
# ---------------------------------------------------------------------------


class TestLayoutHarnessBadInput:

    def test_non_json_body_returns_400(self, client):
        resp = client.post(
            "/api/layout-harness",
            data="not json",
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert resp.get_json() == {"error": "request body must be valid JSON"}

    def test_json_array_body_returns_400(self, client):
        resp = client.post("/api/layout-harness", json=[{"diagram": {}}])
        assert resp.status_code == 400
        assert resp.get_json() == {"error": "request body must be valid JSON"}

    def test_missing_diagram_field_returns_400(self, client):
        resp = client.post("/api/layout-harness", json={"engine": "native"})
        assert resp.status_code == 400
        assert resp.get_json() == {"error": "missing required field: diagram"}

    def test_non_string_engine_returns_400(self, client):
        resp = client.post(
            "/api/layout-harness",
            json={"diagram": {"schema": "dfd_v1", "objects": []}, "engine": 123},
        )
        assert resp.status_code == 400
        assert resp.get_json() == {"error": "engine must be a string"}


# ---------------------------------------------------------------------------
# 200 — success path
# ---------------------------------------------------------------------------


class TestLayoutHarnessSuccess:

    def test_success_returns_harness_output(self, client, monkeypatch):
        harness_payload = {
            "engine": "native",
            "ms": 12.3,
            "document": {"schema": "dfd_v1", "objects": []},
        }
        diagram_body = {"schema": "dfd_v1", "objects": []}
        fake_run, calls = _make_fake_run(payload=harness_payload)
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        resp = client.post(
            "/api/layout-harness",
            json={"diagram": diagram_body, "engine": "native"},
        )

        assert resp.status_code == 200
        assert resp.get_json() == harness_payload

    def test_subprocess_called_with_fixed_argv(self, client, monkeypatch):
        """npx vitest run <entry> --reporter=dot with no shell=True."""
        harness_payload = {"engine": "native", "ms": 5.0, "document": {}}
        diagram_body = {"schema": "dfd_v1", "objects": []}
        fake_run, calls = _make_fake_run(payload=harness_payload)
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        client.post(
            "/api/layout-harness",
            json={"diagram": diagram_body, "engine": "native"},
        )

        assert len(calls) == 1
        args, kwargs = calls[0]
        assert args[:4] == ["npx", "vitest", "run", editor_api._HARNESS_ENTRY]
        assert kwargs.get("shell") is None or not kwargs.get("shell")

    def test_subprocess_env_carries_job_json(self, client, monkeypatch):
        """LAYOUT_HARNESS_JOB env var must be the JSON of {diagram, engine}."""
        harness_payload = {"engine": "native", "ms": 5.0, "document": {}}
        diagram_body = {"schema": "dfd_v1", "objects": []}
        fake_run, calls = _make_fake_run(payload=harness_payload)
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        client.post(
            "/api/layout-harness",
            json={"diagram": diagram_body, "engine": "native"},
        )

        _, kwargs = calls[0]
        env = kwargs["env"]
        job = json.loads(env["LAYOUT_HARNESS_JOB"])
        assert job == {"diagram": diagram_body, "engine": "native"}

    def test_default_engine_is_tala_when_omitted(self, client, monkeypatch):
        harness_payload = {"engine": "tala", "ms": 5.0, "document": {}}
        diagram_body = {"schema": "dfd_v1", "objects": []}
        fake_run, calls = _make_fake_run(payload=harness_payload)
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        client.post("/api/layout-harness", json={"diagram": diagram_body})

        _, kwargs = calls[0]
        job = json.loads(kwargs["env"]["LAYOUT_HARNESS_JOB"])
        assert job["engine"] == "tala"


# ---------------------------------------------------------------------------
# 502 — subprocess failure cases
# ---------------------------------------------------------------------------


class TestLayoutHarness502:

    def test_timeout_returns_502(self, client, monkeypatch):
        fake_run, _ = _make_fake_run(
            raise_exc=subprocess.TimeoutExpired(cmd="npx", timeout=120)
        )
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        resp = client.post(
            "/api/layout-harness",
            json={"diagram": {}, "engine": "tala"},
        )

        assert resp.status_code == 502
        assert resp.get_json() == {"error": "layout harness timed out"}

    def test_npx_missing_returns_502(self, client, monkeypatch):
        fake_run, _ = _make_fake_run(raise_exc=FileNotFoundError("npx"))
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        resp = client.post(
            "/api/layout-harness",
            json={"diagram": {}, "engine": "tala"},
        )

        assert resp.status_code == 502
        assert resp.get_json() == {"error": "npx not found on PATH"}

    def test_nonzero_exit_returns_502_with_stderr(self, client, monkeypatch):
        fake_run, _ = _make_fake_run(returncode=1, stderr="boom from vitest")
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        resp = client.post(
            "/api/layout-harness",
            json={"diagram": {}, "engine": "tala"},
        )

        assert resp.status_code == 502
        body = resp.get_json()
        assert "boom from vitest" in body["error"]

    def test_harness_error_payload_returns_502(self, client, monkeypatch):
        fake_run, _ = _make_fake_run(
            payload={"error": "pipeline blew up"},
            returncode=0,
        )
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        resp = client.post(
            "/api/layout-harness",
            json={"diagram": {}, "engine": "native"},
        )

        assert resp.status_code == 502
        assert resp.get_json() == {"error": "pipeline blew up"}


# ---------------------------------------------------------------------------
# DATA_DIR invariant — harness must never persist to storage.DATA_DIR
# ---------------------------------------------------------------------------


class TestLayoutHarnessNoStoragePersistence:

    def test_success_path_does_not_write_to_data_dir(self, client, monkeypatch, tmp_path):
        harness_payload = {"engine": "native", "ms": 5.0, "document": {}}
        fake_run, _ = _make_fake_run(payload=harness_payload)
        monkeypatch.setattr(editor_api.subprocess, "run", fake_run)

        before = sorted(os.listdir(storage.DATA_DIR))
        client.post(
            "/api/layout-harness",
            json={"diagram": {"schema": "dfd_v1", "objects": []}, "engine": "native"},
        )
        after = sorted(os.listdir(storage.DATA_DIR))

        assert before == after

    def test_400_path_does_not_write_to_data_dir(self, client):
        before = sorted(os.listdir(storage.DATA_DIR))
        client.post("/api/layout-harness", json={"engine": "native"})
        after = sorted(os.listdir(storage.DATA_DIR))

        assert before == after


# ---------------------------------------------------------------------------
# Integration smoke — default-SKIPPED; set RUN_HARNESS_INTEGRATION=1 to run
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    os.environ.get("RUN_HARNESS_INTEGRATION") != "1",
    reason="set RUN_HARNESS_INTEGRATION=1 with a live `npm run dev:all` stack + d2 on PATH",
)
class TestLayoutHarnessIntegration:
    """End-to-end round-trip through the real harness subprocess.

    Requires: Flask on :5050, Vite on :5173, d2 with TALA on PATH.
    Run ``npm run dev:all`` first, then:
      RUN_HARNESS_INTEGRATION=1 pytest tests/test_layout_harness.py::TestLayoutHarnessIntegration
    """

    _MINIMAL_DIAGRAM = {
        "schema": "dfd_v1",
        "objects": [],
    }

    def test_native_engine_returns_unchanged_geometry(self, client):
        resp = client.post(
            "/api/layout-harness",
            json={"diagram": self._MINIMAL_DIAGRAM, "engine": "native"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["engine"] == "native"
        assert "document" in body
        assert "ms" in body

    def test_tala_engine_returns_populated_layout(self, client):
        resp = client.post(
            "/api/layout-harness",
            json={"diagram": self._MINIMAL_DIAGRAM, "engine": "tala"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["engine"] == "tala"
        assert "document" in body
