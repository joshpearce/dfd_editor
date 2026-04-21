# Phase 1 — Server schema, transform, and fixtures

**Goal:** Server accepts, stores, validates, and round-trips the new bidirectional `Flow` shape. Drift test passes against a parallel frontend-template placeholder edit. Hard cutover — old-shape payloads are rejected.

**Architecture:** Rename `source`/`target` → `node1`/`node2` and replace the single `data_item_refs` field with two per-direction arrays (`node1_src_data_item_refs`, `node2_src_data_item_refs`) across `schema.py`, `transform.py`, and every JSON fixture. A canonical-order validator silently swaps endpoints (and the two ref arrays) when clients post them reversed. A diagram-level dangling-ref validator reports per-direction errors.

**Tech Stack:** Python 3, pydantic v2, Flask, pytest. `.venv/bin/python -m pytest` from `server/`.

**Scope:** Phase 1 of 7 from design plan `docs/design-plans/2026-04-21-bidirectional-flow.md`.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### bidirectional-flow.AC1: Server accepts and canonicalises Flow objects

- **bidirectional-flow.AC1.1 Success:** `POST /api/diagrams/import` with a flow where `node1 < node2` succeeds (201) and stores the flow with endpoints unchanged.
- **bidirectional-flow.AC1.2 Success:** `POST /api/diagrams/import` with a flow where `node1 > node2` succeeds (201), stores the flow with `node1` and `node2` swapped, and swaps `node1_src_data_item_refs` with `node2_src_data_item_refs` so the semantic direction is preserved.
- **bidirectional-flow.AC1.3 Success:** Flow with both ref arrays empty is accepted and stored.
- **bidirectional-flow.AC1.4 Success:** Flow with only `node1_src_data_item_refs` populated is accepted and stored.
- **bidirectional-flow.AC1.5 Success:** Flow with both ref arrays populated is accepted and stored.
- **bidirectional-flow.AC1.6 Failure:** Flow with `node1 == node2` returns 400 with a pydantic validation error referring to the self-loop constraint.
- **bidirectional-flow.AC1.7 Failure:** A UUID in either ref array that does not resolve to a top-level data-item in the diagram returns 400 with a validation error identifying the dangling ref and its direction.
- **bidirectional-flow.AC1.8 Failure:** `node1` or `node2` referring to a non-existent canvas object returns 400.

### bidirectional-flow.AC2: Minimal ↔ native round-trip is lossless

- **bidirectional-flow.AC2.1 Success:** `to_native(to_minimal(X)) == X` (structural equality) for any canonical diagram `X` containing flows with all combinations of ref-array states.
- **bidirectional-flow.AC2.2 Success:** Both ref arrays survive a full `POST /api/diagrams/import` → `GET /api/diagrams/<id>/export` cycle with identical UUID lists in identical order.
- **bidirectional-flow.AC2.3 Success:** Shared flow properties (`name`, `data_classification`, `protocol`, `authenticated`, `encrypted`) survive the round-trip unchanged.
- **bidirectional-flow.AC2.4 Edge:** A flow with both ref arrays empty survives the round-trip and remains in the output (not filtered out).

### bidirectional-flow.AC7: Hard cutover — no legacy tolerance

- **bidirectional-flow.AC7.1 Success:** All JSON fixtures under `server/data/` and `server/temp/` are in the new bidirectional shape.
- **bidirectional-flow.AC7.2 Success:** No frontend test fixture or spec references `source` / `target` / `data_item_refs` (the old names) on a flow. *(Phase 1 handles server-side only; frontend coverage lands in later phases but any Phase-1 drift placeholder is consistent with this.)*
- **bidirectional-flow.AC7.3 Failure:** `POST /api/diagrams/import` with an old-shape payload (`source`, `target`, `data_item_refs`) returns 400 with a structured validation error.

---

## Context for the executor

**Codebase verification findings (2026-04-21):**

- ✓ `server/schema.py` (confirmed paths and line numbers):
  - `DataFlow` class at lines 180-184 — fields: `guid: UUID`, `properties: DataFlowProps`, `source: UUID`, `target: UUID`.
  - `DataFlowProps` class at lines 171-177 — fields: `name: str | None`, `data_classification: DataClassification | None`, `protocol: str | None`, `authenticated: StrictBool`, `encrypted: StrictBool`, `data_item_refs: list[UUID]`.
  - `Diagram` class at lines 217-222 — top-level `nodes`, `containers`, `data_flows`, `data_items`.
  - `_Base` (line 76) uses `ConfigDict(extra="forbid")` — unknown fields already rejected (AC7.3 is free if we rename fields).
  - Pydantic v2 syntax only (`ConfigDict`, not `Config` class). Use `field_validator` (v2) and `model_validator(mode="after")` when adding new validation.
  - No existing self-loop check; no existing dangling-ref check at schema level.
- ✓ `server/transform.py`:
  - `_FLOW_PROP_ORDER` tuple at lines 56-63: `("name", "data_classification", "protocol", "authenticated", "encrypted_in_transit", "data_item_refs")`. The TS/native key is `encrypted_in_transit` while the minimal/pydantic key is `encrypted`; the adapter lives at lines 631-636. Preserve that adapter — we are NOT renaming `encrypted`/`encrypted_in_transit`.
  - `to_minimal(native: dict) -> dict` at line 108.
  - `to_native(minimal: dict) -> dict` at line 183.
  - `_emit_data_flow(obj, latch_to_block)` at lines 587-667 — reads `data_item_refs` at line 645; legacy pre-I3 fallback at lines 642-660 (accepts both plain-string and `[key, guid]`-pair wire shapes). **Delete that fallback as part of the hard cutover.**
  - Native `data_item_refs` wire shape at lines 821-831: list of `[synthetic-uuid-string, guid-string]` pairs (`ListProperty<StringProperty>`). Both new arrays use the same shape — just two keys.
- ✓ `server/tests/`:
  - `test_schema.py` (181 lines, function + class grouping).
  - `test_import.py` (438 lines, `TestRoundTrip`, `TestNativeShape`).
  - `test_export.py` (184 lines) — references `server/data/bdf1c563-0a37-41fd-b0e6-d146d2cb49a7.json` which is NOT currently present in `server/data/`. Task 4 replaces that real-fixture test with a synthetic round-trip (or moves the fixture under version control).
  - `test_endpoints.py` (207 lines) — uses Flask `TestClient`, `monkeypatch` of `DATA_DIR` to `tmp_path`.
  - `test_drift.py` (276 lines) — **currently only checks enum parity** (`trust_level`, `entity_type`, `storage_type`, `privilege_level`, `data_classification`) and block/group template name parity (`NodeType`, `ContainerType`). It does NOT currently check flow property names. Task 7 extends it to assert that the `data_flow` template's property keys match `DataFlowProps`'s field names.
  - `test_data_items.py` (756 lines) — the most comprehensive data-item round-trip coverage. Must be rewritten for the two-array shape.
  - No `conftest.py`; fixtures are per-file.
- ✓ `server/data/` and `server/temp/` are both gitignored (root `.gitignore` lines 30-31: `server/data/`, `server/temp/`). These hold the user's local working fixtures. Phase 1 deletes stale `server/data/*.json` (they're user session artifacts incompatible with the new shape) and hand-rewrites `server/temp/*.json` so the user can continue to re-import them during development.
- ✓ `src/assets/configuration/DfdTemplates/DfdObjects.ts`:
  - `data_flow` template at lines 150-217.
  - `data_item_refs` property declared at lines 212-216 as `PropertyType.List`.
  - Phase 1 edit is the **placeholder** only: rename one key and add the second, still as `PropertyType.List`. Phase 3 upgrades both to `PropertyType.DataItemRefList`.
- ✓ `server/app.py`:
  - `POST /api/diagrams/import` at lines 84-97 — returns 201 `{"id": "<uuid>"}` on success; 400 `{"error": "validation failed", "details": [...]}` on pydantic `ValidationError`.
  - `GET /api/diagrams/<id>/export` at lines 100-112.

**Testing conventions** (mirror these in every new test):

- Python: pytest, function-style with class-based grouping (e.g., `class TestImportThenExportRoundTrip:` in `test_endpoints.py`). No mocking. `TestClient` via `app.test_client()` for endpoints; `monkeypatch.setattr(app_module, "DATA_DIR", tmp_path)` for isolation. No `conftest.py`; declare fixtures inline per file.
- Hand-crafted minimal docs with fixed UUIDs (see `_PROCESS_GUID = "11111111-..."` patterns in `test_data_items.py`) so assertions are deterministic.
- For round-trip tests, use the existing `_canonicalize` helper pattern: sort `nodes`, `containers`, `data_flows`, `data_items` by `guid` before equality compares so order drift doesn't fail the test.
- Run server tests with `.venv/bin/python -m pytest tests/ -x -q` from `server/` (per `.claude/settings.local.json`).

**Skills to activate before implementing:**

- `ed3d-house-style:coding-effectively` (always)
- `ed3d-house-style:writing-good-tests`
- `ed3d-house-style:howto-functional-vs-imperative` — `transform.py` is a pure functional core; keep it that way.
- `ed3d-house-style:property-based-testing` — the `to_native(to_minimal(X)) == X` round-trip is the canonical example. Consider hypothesis-style generators over ref-array states, but example-based coverage (one test per ref-array combination) is also acceptable and matches current codebase style.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Update `schema.py` — new Flow shape, canonical-order validator, dangling-ref validator

**Verifies:** bidirectional-flow.AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7, AC1.8, AC7.3

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/schema.py:171-184` (`DataFlowProps` and `DataFlow` class bodies)
- Modify: `/Users/josh/code/dfd_editor/server/schema.py:217-222` (`Diagram` class — add diagram-level `model_validator` for dangling-ref and endpoint-exists checks)

**Implementation:**

1. **`DataFlowProps`** (lines 171-177): remove `data_item_refs: list[UUID] = []`. Add two fields in its place, matching the new `_FLOW_PROP_ORDER`:
   ```python
   node1_src_data_item_refs: list[UUID] = []
   node2_src_data_item_refs: list[UUID] = []
   ```
   Leave `name`, `data_classification`, `protocol`, `authenticated`, `encrypted` unchanged. `extra="forbid"` (inherited from `_Base`) already guarantees that `data_item_refs` on a Flow payload will be rejected (AC7.3 old-shape validation) without any explicit work.

2. **`DataFlow`** (lines 180-184): rename `source: UUID` → `node1: UUID`, `target: UUID` → `node2: UUID`. Add a `model_validator(mode="after")` named `_canonicalize_and_self_loop` that runs two checks:
   - If `node1 == node2`, raise `ValueError("self-loop disallowed: node1 must differ from node2")` — pydantic will surface this as a 400 referencing the DataFlow's location (AC1.6).
   - If `node1 > node2` (UUID string comparison via `str(uuid)`), swap `node1 ↔ node2` AND `node1_src_data_item_refs ↔ node2_src_data_item_refs` in-place on `self.properties`. Return `self`. This guarantees canonical storage (AC1.2).
   - Uses pydantic v2's `model_validator(mode="after")` — see existing v2 usage at line 15.

3. **`Diagram`** (lines 217-222): add a `model_validator(mode="after")` named `_validate_flow_refs_and_endpoints` that runs **after** the per-flow canonicalisation:
   - Build `data_item_guids = {di.guid for di in self.data_items}`.
   - Build `node_guids = {n.guid for n in self.nodes}`. Containers (trust boundaries, containers) are NOT valid flow endpoints — flows always connect nodes. (Verified in `schema.py`: `Node` is a discriminated union of `ProcessNode | ExternalEntityNode | DataStoreNode` at lines 124-127; containers are separate at lines 160-163.)
   - For each flow in `self.data_flows`:
     - If `flow.node1` not in `node_guids` or `flow.node2` not in `node_guids`, raise `ValueError(f"flow {flow.guid}: node1/node2 must refer to an existing canvas object")` (AC1.8).
     - For each `ref` in `flow.properties.node1_src_data_item_refs`: if `ref` not in `data_item_guids`, raise `ValueError(f"flow {flow.guid}: node1_src_data_item_refs contains unknown data item {ref}")` (AC1.7, direction = "node1→node2").
     - For each `ref` in `flow.properties.node2_src_data_item_refs`: symmetric error referencing `node2_src_data_item_refs` (direction = "node2→node1").
   - Return `self`.

**Implementation notes:**
- Pydantic aggregates errors in `ValidationError.errors()`; the `loc` path automatically includes the flow index. The `msg` must contain the direction phrase `node1_src_data_item_refs` or `node2_src_data_item_refs` so `/api/diagrams/import`'s 400 response identifies which side is dangling (AC1.7 requires "identifying the dangling ref and its direction").
- Do NOT introduce `Optional` fields or `None` defaults on the ref arrays — `[]` is the correct default.

**Testing:** Covered by Task 2 and Task 5.

**Verification:** Cannot run tests until Task 2 lands; run `.venv/bin/python -m pytest tests/test_schema.py -x -q` from `server/` once Task 2 is complete.

**Commit:** `feat(schema): replace DataFlow source/target + data_item_refs with node1/node2 + per-direction ref arrays`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Rewrite `test_schema.py` for the new shape

**Verifies:** bidirectional-flow.AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7, AC1.8, AC7.3

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/tests/test_schema.py` (all 181 lines — this is a rewrite)

**Implementation:**

Preserve the existing `_Base`-extra-forbid and `StrictBool` coverage and the enum-validation test class. Add a new class `TestDataFlow` that exercises the new schema with one test per AC case:

Tests must cover (copy the AC text as the docstring so the mapping is explicit):

- `test_canonical_order_preserved` — node1 UUID < node2 UUID, both ref arrays populated. After model construction assert `flow.node1` / `flow.node2` unchanged and ref arrays unchanged. (AC1.1)
- `test_canonical_order_swapped` — node1 UUID > node2 UUID, node1_src_data_item_refs = [guid_a, guid_b], node2_src_data_item_refs = [guid_c]. After construction assert endpoints are swapped AND the two ref arrays are swapped. (AC1.2)
- `test_both_refs_empty_accepted` — both arrays `[]`. Model constructs without error. (AC1.3, AC2.4)
- `test_only_node1_src_refs_populated` — one array has content, the other empty. Model constructs. (AC1.4)
- `test_both_refs_populated` — both arrays have content. Model constructs. (AC1.5)
- `test_self_loop_raises` — node1 == node2. Must raise `ValidationError` with a message that contains the substring `self-loop`. (AC1.6)
- `test_dangling_ref_in_node1_direction` — use a `Diagram(...)` with one flow whose `node1_src_data_item_refs` contains a UUID not in `data_items`. Assert `ValidationError` with a message containing `node1_src_data_item_refs`. (AC1.7)
- `test_dangling_ref_in_node2_direction` — symmetric; message contains `node2_src_data_item_refs`. (AC1.7)
- `test_endpoint_not_in_nodes_raises` — node1 references a UUID absent from `nodes` (and containers, if applicable). Assert `ValidationError`. (AC1.8)
- `test_old_shape_payload_rejected` — pass `{"source": ..., "target": ..., "properties": {"data_item_refs": [...]}}` to `Diagram(**{...with flow...})`. Must raise `ValidationError` (extra-forbid handles this automatically). (AC7.3)

**Test style:** Function-style test methods inside `class TestDataFlow:`. Use fixed UUIDs (e.g., `_NODE_A = "11111111-1111-1111-1111-111111111111"`) so assertions are deterministic. Import `ValidationError` from `pydantic`. Use `pytest.raises(ValidationError, match=...)` with substrings that match the `msg` raised in Task 1.

**Verification:** `cd /Users/josh/code/dfd_editor/server && .venv/bin/python -m pytest tests/test_schema.py -x -q`
Expected: all tests pass.

**Commit:** `test(schema): cover bidirectional Flow shape, canonical swap, and dangling-ref validation`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Update `transform.py` — two ref arrays in `_FLOW_PROP_ORDER`, rename source/target → node1/node2, delete legacy pre-I3 branch

**Verifies:** bidirectional-flow.AC2.1, AC2.2, AC2.3, AC2.4

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/transform.py:56-63` (`_FLOW_PROP_ORDER`)
- Modify: `/Users/josh/code/dfd_editor/server/transform.py:183-319` (`to_native` — flow emission paths, including the `data_item_refs` ListProperty wire-shape build at lines 821-831 and the source/target key writes)
- Modify: `/Users/josh/code/dfd_editor/server/transform.py:108-180` (`to_minimal` — flow extraction paths)
- Modify: `/Users/josh/code/dfd_editor/server/transform.py:587-667` (`_emit_data_flow`)
- Delete: legacy pre-I3 fallback at lines 642-660 (accept only `[[key, guid], ...]`; plain-string entries become a hard error — surface an `InvalidNativeError` if encountered).

**Implementation:**

1. **`_FLOW_PROP_ORDER`**: replace `"data_item_refs"` with two entries in order:
   ```python
   _FLOW_PROP_ORDER: tuple[str, ...] = (
       "name",
       "data_classification",
       "protocol",
       "authenticated",
       "encrypted_in_transit",
       "node1_src_data_item_refs",
       "node2_src_data_item_refs",
   )
   ```
   Preserve the `encrypted_in_transit` / `encrypted` mismatch — that adapter stays intact.

2. **Source/target key rename in native output:** update the three concrete sites where the wire shape writes/reads `source`/`target` as Flow endpoint keys:
   - `transform.py:310-311` — `"source": source_latch_inst, "target": target_latch_inst,` → rename to `"node1"`, `"node2"`.
   - `transform.py:591-592` — `source_latch: str = obj.get("source", "")` / `target_latch: str = obj.get("target", "")` (inside `_emit_data_flow`) → rename the dict-key strings to `"node1"` / `"node2"` and the local variable names to `node1_latch` / `node2_latch` for readability.
   - `transform.py:664-665` — `"source": source_block, "target": target_block,` (the output flow dict in `_emit_data_flow`) → rename to `"node1"`, `"node2"`.
   Do NOT rename `source_latch_inst` / `target_latch_inst` or similar local variables in other functions unless the variable literally holds a Flow endpoint's block-identifier (the ones listed above do; anything elsewhere in `transform.py` — e.g., latch-to-block lookup tables — is separate). After editing, grep: `rg -n '"source"|"target"' server/transform.py` and confirm zero matches. Any surviving match is a bug.

3. **`_emit_data_flow`:** update to emit two ref arrays in the wire shape from lines 821-831 (one per direction). The wire shape is:
   ```python
   result.append([
       "node1_src_data_item_refs",
       [[str(uuid.uuid4()), str(ref)] for ref in props.node1_src_data_item_refs],
   ])
   result.append([
       "node2_src_data_item_refs",
       [[str(uuid.uuid4()), str(ref)] for ref in props.node2_src_data_item_refs],
   ])
   ```
   Empty input produces `["node1_src_data_item_refs", []]` — the property is still emitted (AC2.4 requires empty-both-sides flows to survive the round-trip).

4. **`to_minimal` flow extraction:** wherever native `data_item_refs` is currently read back to minimal, read both keys and emit both arrays on `DataFlowProps`. The minimal output for a flow must contain the two fields always (default `[]`) so downstream consumers don't branch on "key present vs absent".

5. **Delete legacy pre-I3 branch at lines 642-660.** Replace with a single assertion path that only accepts `[[key, guid], ...]`. If an entry isn't a 2-element list, raise `InvalidNativeError(f"data_item_refs entry is not [key, guid]: {entry!r}")`. This converts what was a silent fallback into a hard error consistent with DoD "no legacy tolerance".

**Verification:** Cannot run round-trip tests until Task 4 lands.

**Commit:** `refactor(transform): emit two ref arrays and node1/node2 keys; drop pre-I3 legacy shape`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Rewrite `test_import.py` and `test_export.py` round-trips

**Verifies:** bidirectional-flow.AC2.1, AC2.2, AC2.3, AC2.4

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/tests/test_import.py` (all 438 lines — rewrite round-trip bodies and native-shape assertions).
- Modify: `/Users/josh/code/dfd_editor/server/tests/test_export.py` (all 184 lines — see below for `_EXAMPLE_FILE`).

**Implementation:**

1. **`test_import.py`:**
   - `TestRoundTrip` class: cover all four ref-array states in separate methods:
     - `test_round_trip_both_empty` — `node1_src_data_item_refs=[]`, `node2_src_data_item_refs=[]`.
     - `test_round_trip_only_node1_src` — populated node1_src, empty node2_src.
     - `test_round_trip_only_node2_src` — empty node1_src, populated node2_src.
     - `test_round_trip_both_populated` — both arrays populated.
     Each method builds a minimal `Diagram`-equivalent dict with fixed UUIDs and associated top-level `data_items`, calls `to_native(minimal)`, then `to_minimal(native)`, and asserts the round-trip result structurally equals the input (use `_canonicalize` to sort lists by guid before comparison). Per-item assertion required: the UUID LIST ORDER inside each ref array must be preserved (AC2.2).
   - `TestRoundTrip` also covers `name`, `data_classification`, `protocol`, `authenticated`, `encrypted` — assert each survives the round-trip unchanged (AC2.3).
   - `TestNativeShape` class:
     - Update existing assertions that referenced `"source"` / `"target"` flow keys to `"node1"` / `"node2"`.
     - Add an assertion that both ref arrays appear as `[key, [[uuid, guid], ...]]` entries in the flow's properties list in the order defined by `_FLOW_PROP_ORDER`.
     - Add a test for canonical swap at the transform layer: build a minimal doc with `node1 > node2`, run `to_native`, assert the native output has the endpoints swapped AND the ref arrays swapped.

2. **`test_export.py`:** the existing `test_to_minimal_real_fixture` references `server/data/bdf1c563-0a37-41fd-b0e6-d146d2cb49a7.json`, a file that no longer exists in `server/data/` (the directory is gitignored and currently holds only recent user-session artifacts). Replace that test with `test_to_minimal_synthetic_fixture` that constructs a native dict in-memory (using the new bidirectional shape) and round-trips it. Preserve the `_native_with_orphan_latch` / `test_orphan_latch_raises` and `_minimal_native_with_dup_parent` / `test_duplicate_parent_raises` tests — update their `source`/`target` strings to `node1`/`node2` and update properties list to include both ref-array entries (empty lists are fine).

**Testing style:** match the existing `_canonicalize` helper in `test_endpoints.py` (copy it into these files if not already present) — sort `data_flows` by `guid`, `data_items` by `guid`, `nodes` by `guid` before structural equality compare.

**Verification:**
```
cd /Users/josh/code/dfd_editor/server
.venv/bin/python -m pytest tests/test_import.py tests/test_export.py -x -q
```
Expected: all tests pass.

**Commit:** `test(transform): round-trip coverage for bidirectional Flow ref arrays`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->

<!-- START_TASK_5 -->
### Task 5: Rewrite `test_endpoints.py` and `test_data_items.py` for the new shape

**Verifies:** bidirectional-flow.AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7, AC1.8, AC2.2, AC2.3, AC7.3

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/tests/test_endpoints.py` (all 207 lines — rewrite).
- Modify: `/Users/josh/code/dfd_editor/server/tests/test_data_items.py` (all 756 lines — rewrite).

**Implementation:**

1. **`test_endpoints.py`:**
   - Keep the existing `client` fixture (monkeypatch of `DATA_DIR`). Do NOT introduce mocking.
   - `TestImportThenExportRoundTrip` class:
     - `test_round_trip_canonical_order` — POST a minimal with `node1 < node2` and both ref arrays populated, assert 201, GET export, assert exported flow structurally equals posted flow.
     - `test_round_trip_reversed_order_gets_canonicalised` — POST with `node1 > node2` and specific refs, assert 201, GET export, assert endpoints are swapped AND ref arrays swapped (AC1.2 through the HTTP surface).
     - `test_round_trip_both_refs_empty` (AC1.3 + AC2.4 at endpoint layer).
   - `TestImportValidationErrors` class:
     - `test_self_loop_returns_400` — POST a minimal with `node1 == node2`, assert 400, assert `details[*].msg` contains `self-loop`. (AC1.6)
     - `test_dangling_ref_node1_direction_returns_400` — dangling UUID in `node1_src_data_item_refs`, assert 400 with message containing `node1_src_data_item_refs`. (AC1.7)
     - `test_dangling_ref_node2_direction_returns_400` — symmetric. (AC1.7)
     - `test_old_shape_payload_returns_400` — POST a minimal flow with `source` / `target` / `data_item_refs` keys, assert 400 with a structured `details` list. (AC7.3)
     - `test_endpoint_not_in_nodes_returns_400` (AC1.8).

2. **`test_data_items.py`:** rewrite the entire file around the two-array shape. Required coverage:
   - Round-trip with data items flowing node1→node2 only.
   - Round-trip with data items flowing node2→node1 only.
   - Round-trip with both directions populated (different items in each direction).
   - Round-trip with the same data item appearing in BOTH directions (valid and legal — bidirectional flow of the same logical datum).
   - Ordering preservation within each ref array (AC2.2 specifies "identical UUID lists in identical order").
   - Free-form classifications preserved (carry forward from the current suite).
   - Missing required fields still return 400 (carry forward).

**Test style:** function + class grouping (match `test_endpoints.py` existing style). Use `post_resp.get_json()["details"]` to inspect pydantic error structures; assert both the `loc` path includes the offending flow index and the `msg` contains the direction key name.

**Verification:**
```
cd /Users/josh/code/dfd_editor/server
.venv/bin/python -m pytest tests/test_endpoints.py tests/test_data_items.py -x -q
```
Expected: all tests pass.

**Commit:** `test(endpoints): cover canonical swap, self-loop rejection, per-direction dangling refs, and hard cutover`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 6) -->

<!-- START_TASK_6 -->
### Task 6: Rewrite `server/temp/` fixtures; purge stale `server/data/` session files

**Verifies:** bidirectional-flow.AC7.1

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp.json`
- Modify: `/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp-with-data-items.json`
- Modify: `/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp-with-reverse-flows.json` (hand-merge 14 forward + 14 reverse pairs → 14 bidirectional flows)
- Delete: `/Users/josh/code/dfd_editor/server/data/*.json` and `/Users/josh/code/dfd_editor/server/data/latest-layout.*` (all user session artifacts; `server/data/` is gitignored).

**Implementation:**

1. **`aws-ecs-webapp.json` and `aws-ecs-webapp-with-data-items.json`** (single-direction flows): mechanical rewrite per flow:
   - Rename `"source"` → `"node1"`, `"target"` → `"node2"`.
   - If `str(node1) > str(node2)` lexicographically, swap endpoints before writing (keeps the file in canonical order).
   - Inside `properties`: remove `"data_item_refs"` and add `"node1_src_data_item_refs"` populated with the current value (or the swapped destination if endpoints were flipped) and `"node2_src_data_item_refs": []`.

2. **`aws-ecs-webapp-with-reverse-flows.json`** (hand-merge):
   - Enumerate the 14 forward flows (GUIDs `60000000-...`) and 14 reverse flows (GUIDs `61000000-...`). Each pair shares the same two endpoints (one direction swapped).
   - For each pair, produce ONE bidirectional flow:
     - Use the forward flow's GUID.
     - Canonicalise endpoints: `node1 = min(forward.source, forward.target)`, `node2 = max(...)`.
     - If `forward.source == node1`: `node1_src_data_item_refs = forward.data_item_refs`, `node2_src_data_item_refs = reverse.data_item_refs`.
     - Otherwise (forward's source was the greater UUID, endpoints swap): the ref arrays swap accordingly.
     - Merge shared properties: pick `name` from the forward flow. Do NOT add `_comment` or other non-schema keys — pydantic `extra="forbid"` rejects them on re-import.
     - `protocol`, `authenticated`, `encrypted` must be identical between the two directions — if they diverge, STOP and surface the conflict to the user via AskUserQuestion. Do not silently pick one.
   - Resulting file has 14 bidirectional flows (not 28) with matching top-level `data_items` list untouched.

3. **`server/data/*.json`**: these 4 files are user session artifacts incompatible with the new schema. Delete them. The directory recreates itself on Flask startup (confirmed by `server/CLAUDE.md` "Data directory auto-created"). Also delete the three `latest-layout.*` diagnostic files. This gives the user a clean slate; any preserved work lives in `server/temp/`.

**Verification:**

Re-import each temp fixture through the running server to prove validity:
```
cd /Users/josh/code/dfd_editor/server
.venv/bin/python -m pytest tests/ -x -q   # full suite still green
# Then manually:
npm run dev:flask  # in one terminal
curl -X POST http://localhost:5050/api/diagrams/import \
    -H 'Content-Type: application/json' \
    -d @server/temp/aws-ecs-webapp.json
curl -X POST http://localhost:5050/api/diagrams/import \
    -H 'Content-Type: application/json' \
    -d @server/temp/aws-ecs-webapp-with-data-items.json
curl -X POST http://localhost:5050/api/diagrams/import \
    -H 'Content-Type: application/json' \
    -d @server/temp/aws-ecs-webapp-with-reverse-flows.json
```
Expected: three `{"id": "<uuid>"}` responses (HTTP 201) — no validation errors.

**Commit:** `fixtures: rewrite server/temp/ to new bidirectional shape; hand-merge reverse flows`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_D -->

<!-- START_SUBCOMPONENT_E (tasks 7-8) -->

<!-- START_TASK_7 -->
### Task 7: Extend `test_drift.py` to check flow property-name parity; placeholder edit to `DfdObjects.ts`

**Verifies:** bidirectional-flow.AC7.2 (partially — drift remains green as schema moves)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/server/tests/test_drift.py:225-234` (add a new parity test) and anywhere the TS parser lives (extend `_parse_ts` or add a sibling `_parse_data_flow_properties` helper).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdTemplates/DfdObjects.ts:212-216` (rename + add second property — placeholder only, stays as `PropertyType.List`).

**Implementation:**

1. **`DfdObjects.ts` placeholder edit:** in the `data_flow` template at lines 150-217:
   - Rename `data_item_refs` (lines 212-216) to `node1_src_data_item_refs` — keep the `PropertyType.List` form with `form: { type: PropertyType.String }` and `default: []`.
   - Add a sibling entry for `node2_src_data_item_refs` with the same shape.
   - Do NOT change `PropertyType` here. Phase 3 swaps both to `PropertyType.DataItemRefList`.

2. **`test_drift.py` extension:** add a module-scope fixture `ts_data_flow_props` that parses the `data_flow` template block out of `DfdObjects.ts` and returns the set of property keys declared inside. Pattern:
   - Locate the template block by scanning for `name: "data_flow"` within a top-level `{...}` (reuse `_extract_brace_block`).
   - Within that block, find the `properties: { ... }` sub-block and enumerate the identifier-before-colon tokens at the top level of that sub-block.
   - Return `set[str]` of property keys.

   Then add one new test:
   ```python
   def test_data_flow_props_parity(ts_data_flow_props: set[str]) -> None:
       expected = set(DataFlowProps.model_fields.keys())
       # The TS template uses `encrypted_in_transit` while pydantic uses `encrypted`;
       # apply the known adapter so the parity check compares apples-to-apples.
       expected = (expected - {"encrypted"}) | {"encrypted_in_transit"}
       _assert_parity_sets(ts_data_flow_props, expected, "data_flow template properties")
   ```
   Add a small `_assert_parity_sets` helper (or inline the set-diff pattern used by `_assert_parity`) for sets of strings rather than enum classes.

**Verification:**
```
cd /Users/josh/code/dfd_editor/server
.venv/bin/python -m pytest tests/test_drift.py -x -q
```
Expected: all drift tests pass (including the new one).

Also run: `npm run test:unit` from repo root. Expected: unchanged — frontend specs don't yet exercise the new template key names (Phase 3 handles that).

**Commit:** `test(drift): assert data_flow property name parity; placeholder rename in DfdObjects.ts`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Full-suite verification

**Verifies:** Phase 1 as a whole — every AC listed above.

**Files:** None modified.

**Implementation:** Run the full server suite and frontend suite to prove the phase is done:

```
cd /Users/josh/code/dfd_editor/server
.venv/bin/python -m pytest tests/ -x -q
```
Expected: every pytest passes, zero failures, zero errors.

```
cd /Users/josh/code/dfd_editor
npm run test:unit
```
Expected: unchanged from pre-phase (no frontend regressions).

```
cd /Users/josh/code/dfd_editor
npm run build
```
Expected: type-check + build succeed — the placeholder edit to `DfdObjects.ts` must still compile.

Manual endpoint round-trip:
```
npm run dev:flask  # in one terminal
# in another:
curl -s -X POST http://localhost:5050/api/diagrams/import \
    -H 'Content-Type: application/json' \
    -d '{"source": "11111111-1111-1111-1111-111111111111", "target": "22222222-2222-2222-2222-222222222222", ...}' \
    | jq .
```
Expected: HTTP 400 with `{"error": "validation failed", "details": [...]}` — the old shape is rejected (AC7.3).

**Verification of definition of done:**
- [ ] All Phase 1 ACs listed in this file pass corresponding tests.
- [ ] `.venv/bin/python -m pytest tests/` passes in full.
- [ ] `npm run test:unit` passes (unchanged from pre-phase).
- [ ] `npm run build` passes.
- [ ] `/api/diagrams/import` returns 400 for old-shape payloads.
- [ ] `/api/diagrams/import` → `/api/diagrams/<id>/export` round-trips a new-format doc losslessly.

**Commit:** (usually none — this task is verification only. If you touched anything, `chore(phase-1): full-suite verification`.)
<!-- END_TASK_8 -->

<!-- END_SUBCOMPONENT_E -->
