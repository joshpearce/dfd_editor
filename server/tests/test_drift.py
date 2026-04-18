"""Enum parity test: pydantic enums in schema.py must match the TS source.

Parses src/assets/configuration/DfdTemplates/DfdObjects.ts with a regex and
asserts that each pydantic enum's members equal the corresponding TS enum
options (the first string of each ["value", "Label"] tuple).

Also verifies NodeType and ContainerType against the template `name:` entries
grouped by DiagramObjectType.Block and DiagramObjectType.Group respectively.
"""

import re
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from schema import (
    ContainerType,
    DataClassification,
    EntityType,
    NodeType,
    PrivilegeLevel,
    StorageType,
    TrustLevel,
)

# ---------------------------------------------------------------------------
# Path to the TS ground-truth file (resolved relative to this file)
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent.parent
_TS_FILE = _REPO_ROOT / "src" / "assets" / "configuration" / "DfdTemplates" / "DfdObjects.ts"


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _extract_brace_block(text: str, start: int) -> str:
    """Return the contents of the ``{...}`` block whose opening ``{`` is at *start*.

    Raises ``ValueError`` if ``text[start]`` is not ``{``.
    """
    if text[start] != '{':
        raise ValueError(f"expected '{{' at position {start}, got {text[start]!r}")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise ValueError("unclosed brace block")


def _parse_ts(text: str) -> dict[str, set[str]]:
    """Return a mapping of field_name → set-of-enum-values parsed from *text*.

    For each property field whose value block contains ``PropertyType.Enum``,
    extracts the first string of every ``["value", "Label"]`` tuple found in
    the block.  Boolean-disguised enums (whose only values are "true"/"false")
    are skipped because they don't correspond to pydantic StrEnums.

    Strategy: scan for ``PropertyType.Enum`` occurrences, walk backwards to
    find the containing property field name, then capture the full brace block
    for that field and extract default tuple values.
    """
    tuple_value_pattern = re.compile(r'\[\s*"([^"]+)"\s*,\s*"[^"]*"\s*\]')
    # Pattern to identify the field name just before its opening brace.
    field_name_pattern = re.compile(r'(\w+)\s*:\s*\{', re.DOTALL)

    result: dict[str, set[str]] = {}

    for enum_match in re.finditer(r'PropertyType\.Enum', text):
        enum_pos = enum_match.start()

        # Walk backwards from the PropertyType.Enum occurrence to find the
        # opening ``{`` of the enclosing field block, then the field name.
        # The structure is:  <field_name>: {\n    type: PropertyType.Enum, ...
        # We scan backwards past whitespace and ``type:`` to reach the ``{``
        # and then the field name before it.
        before = text[:enum_pos]
        brace_pos = before.rfind('{')
        if brace_pos == -1:
            continue

        # The field name+colon precede the ``{``; find the last identifier
        # before the ``{`` in the text before the brace.
        preceding = before[:brace_pos].rstrip()
        m = re.search(r'(\w+)\s*:\s*$', preceding)
        if not m:
            continue
        field_name = m.group(1)

        # Extract the full block for this field and look for default tuples.
        block = _extract_brace_block(text, brace_pos)
        values = set(tuple_value_pattern.findall(block))
        if not values:
            continue
        # Skip boolean-disguised enums.
        if values == {"true", "false"}:
            continue
        result[field_name] = values

    return result


def _parse_block_names(text: str, object_type: str) -> set[str]:
    """Return the set of template ``name:`` values for a given DiagramObjectType.

    Scans for top-level template objects whose ``type:`` field equals
    ``DiagramObjectType.<object_type>`` and collects each template's ``name:``.
    """
    # Each template starts with a ``{`` at the array-element level.
    # Strategy: split on the array-element boundaries by finding top-level
    # ``{...}`` blocks within the DfdObjects array, then inspect each for the
    # required type and extract the name.
    #
    # Simple approach: find all ``name: "<x>"`` + ``type: DiagramObjectType.<T>``
    # co-occurrences within the same brace-delimited block.

    # Extract individual template objects from the top-level array.
    # We rely on the fact that template objects don't nest further objects at
    # the top level (properties is a nested object, but anchors is a reference).
    # Use a depth-tracking scan instead of a greedy regex.

    names: set[str] = set()
    depth = 0
    block_start = -1
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                block_start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and block_start != -1:
                block = text[block_start:i + 1]
                # Check if this block has the requested DiagramObjectType.
                if f'DiagramObjectType.{object_type}' in block:
                    m = re.search(r'name:\s*"([^"]+)"', block)
                    if m:
                        names.add(m.group(1))
                block_start = -1
    return names


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def ts_text() -> str:
    assert _TS_FILE.exists(), f"TS file not found: {_TS_FILE}"
    return _TS_FILE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def ts_enums(ts_text: str) -> dict[str, set[str]]:
    return _parse_ts(ts_text)


# ---------------------------------------------------------------------------
# Helper: assert parity and produce an informative failure message
# ---------------------------------------------------------------------------


def _assert_parity(enum_class, ts_values: set[str], label: str) -> None:
    py_values = set(enum_class._value2member_map_.keys())
    if py_values == ts_values:
        return
    missing_in_ts = py_values - ts_values
    extra_in_ts = ts_values - py_values
    lines = [f"Enum drift detected for '{label}':"]
    if missing_in_ts:
        lines.append(f"  in Python but not in TS: {sorted(missing_in_ts)}")
    if extra_in_ts:
        lines.append(f"  in TS but not in Python: {sorted(extra_in_ts)}")
    pytest.fail("\n".join(lines))


# ---------------------------------------------------------------------------
# Tests against the real TS file
# ---------------------------------------------------------------------------


def test_trust_level_parity(ts_enums: dict[str, set[str]]) -> None:
    assert "trust_level" in ts_enums, "trust_level enum not found in DfdObjects.ts"
    _assert_parity(TrustLevel, ts_enums["trust_level"], "TrustLevel / trust_level")


def test_entity_type_parity(ts_enums: dict[str, set[str]]) -> None:
    assert "entity_type" in ts_enums, "entity_type enum not found in DfdObjects.ts"
    _assert_parity(EntityType, ts_enums["entity_type"], "EntityType / entity_type")


def test_storage_type_parity(ts_enums: dict[str, set[str]]) -> None:
    assert "storage_type" in ts_enums, "storage_type enum not found in DfdObjects.ts"
    _assert_parity(StorageType, ts_enums["storage_type"], "StorageType / storage_type")


def test_privilege_level_parity(ts_enums: dict[str, set[str]]) -> None:
    assert "privilege_level" in ts_enums, "privilege_level enum not found in DfdObjects.ts"
    _assert_parity(
        PrivilegeLevel, ts_enums["privilege_level"], "PrivilegeLevel / privilege_level"
    )


def test_data_classification_parity(ts_enums: dict[str, set[str]]) -> None:
    assert "data_classification" in ts_enums, (
        "data_classification enum not found in DfdObjects.ts"
    )
    _assert_parity(
        DataClassification,
        ts_enums["data_classification"],
        "DataClassification / data_classification",
    )


def test_node_type_parity(ts_text: str) -> None:
    ts_block_names = _parse_block_names(ts_text, "Block")
    _assert_parity(NodeType, ts_block_names, "NodeType / DiagramObjectType.Block names")


def test_container_type_parity(ts_text: str) -> None:
    ts_group_names = _parse_block_names(ts_text, "Group")
    _assert_parity(
        ContainerType, ts_group_names, "ContainerType / DiagramObjectType.Group names"
    )


# ---------------------------------------------------------------------------
# Self-test: parser catches drift on synthetic input
# ---------------------------------------------------------------------------


_SYNTHETIC_TS = """
export const DfdObjects = [
    {
        name: "process",
        type: DiagramObjectType.Block,
        properties: {
            trust_level: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["public", "Public"],
                        ["authenticated", "Authenticated"],
                        ["admin", "Admin"],
                        ["system", "System"],
                        ["super_admin", "Super Admin"]
                    ]
                }
            }
        }
    }
];
"""


def test_parser_detects_added_value() -> None:
    """The parity check must fail when the synthetic TS has an extra enum value."""
    enums = _parse_ts(_SYNTHETIC_TS)
    assert "trust_level" in enums
    assert "super_admin" in enums["trust_level"], (
        "parser should have found the synthetic 'super_admin' value"
    )
    with pytest.raises(pytest.fail.Exception, match="super_admin"):
        _assert_parity(TrustLevel, enums["trust_level"], "TrustLevel / trust_level")
