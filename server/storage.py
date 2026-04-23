"""Filesystem persistence for minimal DFD documents.

Single source of truth for ``DATA_DIR``. Tests override this module's
``DATA_DIR`` attribute via monkeypatch; every I/O helper below reads the
current value at call time (``storage.DATA_DIR``, not a captured closure)
so the override takes effect without further indirection.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from schema import Diagram
from transform import (
    DuplicateParentError,
    InvalidNativeError,
    to_minimal,
    to_native,
)


DATA_DIR: Path = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)


class DiagramNotFoundError(LookupError):
    """Raised when a diagram id does not resolve to a stored file."""


def _path(diagram_id: str) -> Path:
    return DATA_DIR / f"{diagram_id}.json"


def diagram_exists(diagram_id: str) -> bool:
    return _path(diagram_id).exists()


def load_raw(diagram_id: str) -> dict:
    """Return the raw stored JSON document (native ``dfd_v1`` shape)."""
    path = _path(diagram_id)
    if not path.exists():
        raise DiagramNotFoundError(diagram_id)
    return json.loads(path.read_text())


def load_minimal(diagram_id: str) -> dict:
    """Return the stored document projected into minimal export shape."""
    native = load_raw(diagram_id)
    return to_minimal(native)


def save_minimal(diagram_id: str, minimal: dict) -> None:
    """Validate ``minimal`` and overwrite the stored native doc.

    Raises ``DiagramNotFoundError`` if no file exists for ``diagram_id``;
    ``pydantic.ValidationError`` on schema violations; ``DuplicateParentError``
    on container-hierarchy conflicts. Caller is responsible for translating
    exceptions into transport-appropriate errors.
    """
    if not diagram_exists(diagram_id):
        raise DiagramNotFoundError(diagram_id)
    validated = Diagram.model_validate(minimal)
    native = to_native(validated.model_dump(mode="json"))
    _path(diagram_id).write_text(json.dumps(native, indent=4))


def write_native(diagram_id: str, native: dict) -> None:
    """Write a pre-computed native document verbatim. Used by create paths."""
    _path(diagram_id).write_text(json.dumps(native, indent=4))


def create_from_minimal(minimal: dict) -> str:
    """Validate ``minimal`` and persist as a new diagram with a minted UUID.

    Returns the new diagram id. Raises the usual validation errors.
    """
    validated = Diagram.model_validate(minimal)
    native = to_native(validated.model_dump(mode="json"))
    diagram_id = str(uuid.uuid4())
    write_native(diagram_id, native)
    return diagram_id


def create_scaffold() -> str:
    """Mint a new diagram id and persist an empty ``dfd_v1`` scaffold."""
    diagram_id = str(uuid.uuid4())
    _path(diagram_id).write_text(json.dumps({"schema": "dfd_v1"}, indent=4))
    return diagram_id


def delete(diagram_id: str) -> bool:
    """Delete the stored file. Returns True on success, False if absent."""
    path = _path(diagram_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _display_name(data: dict) -> str | None:
    """Find a human-readable name in a stored diagram.

    Tolerates either the frontend's top-level ``name`` convention or the
    native ``dfd_v1`` shape where the name lives on the canvas object.
    """
    name = data.get("name")
    if name:
        return name
    for obj in data.get("objects", []):
        if obj.get("id") == "dfd":
            for entry in obj.get("properties", []):
                if (
                    isinstance(entry, list)
                    and len(entry) == 2
                    and entry[0] == "name"
                ):
                    return entry[1] or None
            break
    return None


def list_summaries() -> list[dict[str, Any]]:
    """Return ``[{id, name, modified}, ...]`` for every readable JSON file."""
    summaries: list[dict[str, Any]] = []
    for path in sorted(DATA_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        summaries.append(
            {
                "id": path.stem,
                "name": _display_name(data) or path.stem,
                "modified": path.stat().st_mtime,
            }
        )
    return summaries


__all__ = [
    "DATA_DIR",
    "DiagramNotFoundError",
    "DuplicateParentError",
    "InvalidNativeError",
    "ValidationError",
    "create_from_minimal",
    "create_scaffold",
    "delete",
    "diagram_exists",
    "list_summaries",
    "load_minimal",
    "load_raw",
    "save_minimal",
    "write_native",
]
