# Test Requirements — Bidirectional Flow

**Design plan:** docs/design-plans/2026-04-21-bidirectional-flow.md
**Implementation plan:** docs/implementation-plans/2026-04-21-bidirectional-flow/
**Generated:** 2026-04-21

---

## Automated Test Coverage

### bidirectional-flow.AC1 — Server accepts and canonicalises Flow objects

- **AC1.1 Success — canonical `node1 < node2` stored unchanged:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_canonical_order_preserved` (schema) and `TestImportThenExportRoundTrip::test_round_trip_canonical_order` (endpoint)
  - **Phase:** Phase 1, Task 2 and Task 5

- **AC1.2 Success — reversed order canonicalised, ref arrays swap:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_canonical_order_swapped` (schema) and `TestImportThenExportRoundTrip::test_round_trip_reversed_order_gets_canonicalised` (endpoint). Task 4 adds a transform-layer variant in `test_import.py` under `TestNativeShape` asserting canonical swap at the `to_native` layer.
  - **Phase:** Phase 1, Task 2, Task 4, and Task 5

- **AC1.3 Success — both ref arrays empty accepted:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_both_refs_empty_accepted` (schema) and `TestImportThenExportRoundTrip::test_round_trip_both_refs_empty` (endpoint)
  - **Phase:** Phase 1, Task 2 and Task 5

- **AC1.4 Success — only `node1_src_data_item_refs` populated:**
  - **Test type:** unit (schema)
  - **File:** `server/tests/test_schema.py`
  - **Case:** `TestDataFlow::test_only_node1_src_refs_populated`
  - **Phase:** Phase 1, Task 2

- **AC1.5 Success — both ref arrays populated:**
  - **Test type:** unit (schema)
  - **File:** `server/tests/test_schema.py`
  - **Case:** `TestDataFlow::test_both_refs_populated`
  - **Phase:** Phase 1, Task 2

- **AC1.6 Failure — `node1 == node2` returns 400 with self-loop message:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_self_loop_raises` (schema, asserts `ValidationError` with substring `self-loop`) and `TestImportValidationErrors::test_self_loop_returns_400` (endpoint, asserts HTTP 400 with `details[*].msg` containing `self-loop`)
  - **Phase:** Phase 1, Task 2 and Task 5

- **AC1.7 Failure — dangling ref rejected with direction:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_dangling_ref_in_node1_direction` and `TestDataFlow::test_dangling_ref_in_node2_direction` (schema); `TestImportValidationErrors::test_dangling_ref_node1_direction_returns_400` and `TestImportValidationErrors::test_dangling_ref_node2_direction_returns_400` (endpoint). All four assert the error message contains the direction key (`node1_src_data_item_refs` or `node2_src_data_item_refs`).
  - **Phase:** Phase 1, Task 2 and Task 5

- **AC1.8 Failure — non-existent endpoint rejected:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_endpoint_not_in_nodes_raises` (schema) and `TestImportValidationErrors::test_endpoint_not_in_nodes_returns_400` (endpoint)
  - **Phase:** Phase 1, Task 2 and Task 5

---

### bidirectional-flow.AC2 — Minimal ↔ native round-trip is lossless

- **AC2.1 Success — `to_native(to_minimal(X)) == X` for all ref-array combinations:**
  - **Test type:** unit (pure transform round-trip)
  - **File:** `server/tests/test_import.py`
  - **Case:** `TestRoundTrip::test_round_trip_both_empty`, `test_round_trip_only_node1_src`, `test_round_trip_only_node2_src`, `test_round_trip_both_populated` — each builds a canonical dict and asserts structural equality after `to_native` ∘ `to_minimal`.
  - **Phase:** Phase 1, Task 4

- **AC2.2 Success — HTTP round-trip preserves ref arrays with identical UUIDs and order:**
  - **Test type:** integration (HTTP endpoint)
  - **File:** `server/tests/test_endpoints.py` and `server/tests/test_data_items.py`
  - **Case:** `TestImportThenExportRoundTrip::test_round_trip_canonical_order` (endpoint-level) plus `test_data_items.py`'s rewritten order-preservation cases ("Round-trip with data items flowing node1→node2 only" / "node2→node1 only" / "both directions populated" / "same data item in both directions" / "ordering preservation within each ref array")
  - **Phase:** Phase 1, Task 4 and Task 5

- **AC2.3 Success — shared properties (`name`, `data_classification`, `protocol`, `authenticated`, `encrypted`) survive round-trip:**
  - **Test type:** unit (transform round-trip) + integration
  - **File:** `server/tests/test_import.py` (`TestRoundTrip`) and `server/tests/test_data_items.py` ("Free-form classifications preserved")
  - **Case:** `TestRoundTrip` assertions explicitly check each of the five shared fields survives; `test_data_items.py`'s classification carry-forward covers the classification round-trip.
  - **Phase:** Phase 1, Task 4 and Task 5

- **AC2.4 Edge — both-empty flow survives round-trip (not filtered):**
  - **Test type:** unit (schema + round-trip) + unit (frontend publisher)
  - **File:** `server/tests/test_schema.py`, `server/tests/test_import.py`, `server/tests/test_endpoints.py`, `src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts`, `src/assets/configuration/DfdPublisher/DfdPublisher.spec.ts`
  - **Case:** Server side: `TestDataFlow::test_both_refs_empty_accepted`, `TestRoundTrip::test_round_trip_both_empty`, `TestImportThenExportRoundTrip::test_round_trip_both_refs_empty`. Frontend side: `DfdFilePreprocessor.spec.ts` new case "publisher re-emits a flow with both ref arrays empty" asserts arrays are present with `[]` in the output (not undefined); `DfdPublisher.spec.ts` Phase 5 Task 5 adds "Single flow, both ref arrays empty → edge has both arrays as `[]`".
  - **Phase:** Phase 1 (Task 2, Task 4, Task 5), Phase 3 (Task 4), Phase 5 (Task 5)

---

### bidirectional-flow.AC3 — Arrow rendering is driven by ref-array state

- **AC3.1 Success — only `node1_src` populated → arrow at `node2`:**
  - **Test type:** unit (face layout)
  - **File:** `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts`
  - **Case:** `"renders an arrowhead at node2 when only node1_src is populated"` — asserts `face.arrowAtNode1 === null && face.arrowAtNode2 !== null && face.arrowAtNode2.length === 6`.
  - **Phase:** Phase 4, Task 3

- **AC3.2 Success — only `node2_src` populated → arrow at `node1`:**
  - **Test type:** unit (face layout)
  - **File:** `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts`
  - **Case:** `"renders an arrowhead at node1 when only node2_src is populated"`
  - **Phase:** Phase 4, Task 3

- **AC3.3 Success — both arrays populated → arrows at both ends:**
  - **Test type:** unit (face layout)
  - **File:** `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts`
  - **Case:** `"renders arrowheads at both ends when both arrays are populated"`
  - **Phase:** Phase 4, Task 3

- **AC3.4 Success — both empty → plain line:**
  - **Test type:** unit (face layout)
  - **File:** `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts`
  - **Case:** `"renders no arrowheads when both ref arrays are empty"`
  - **Phase:** Phase 4, Task 3

- **AC3.5 Edge — mutating a ref array re-layouts and updates arrow count without full rebuild:**
  - **Test type:** unit (reactivity / re-layout guard); partially covered
  - **File:** `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts`
  - **Case:** `"toggling a ref array re-layouts and updates arrowhead count"` — builds a Line with both empty, runs layout, mutates `node1_src_data_item_refs` via `ListProperty.addProperty`, re-runs layout, asserts `arrowAtNode2 !== null`, clears and asserts back to null. Phase 4 notes that if the existing property-observer doesn't fire layout recomputation automatically in a test env, the spec triggers recomputation manually — this automates the arrow-slot transition but the "no full canvas rebuild" invariant and UI-driven re-layout are partially covered by human verification (see Human Verification section).
  - **Phase:** Phase 4, Task 3 (automated slot update); interactive smoke test verifies "without a full canvas rebuild"

---

### bidirectional-flow.AC4 — Editor UX for ref-array editing

- **AC4.1 Success — two labelled sections per direction:**
  - **Test type:** unit (Vue component with jsdom)
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.1: renders a labelled section for the direction"`
  - **Phase:** Phase 7, Task 5

- **AC4.2 Success — direction labels display endpoint names:**
  - **Test type:** unit (Vue component with jsdom)
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.2: label displays endpoint names (not node1/node2)"` — asserts rendered label `=== "Data from Browser to ALB"` for node1="Browser", node2="ALB", direction=node1ToNode2.
  - **Phase:** Phase 7, Task 5

- **AC4.3 Success — selecting a data-item via dropdown appends to correct ref array and re-renders:**
  - **Test type:** unit (Vue component) + human verification for end-to-end arrow re-render
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.3: selecting from the dropdown emits a createSubproperty execute event"` — verifies the command is emitted targeting the correct ref-array property. The arrow-render reaction is covered transitively by AC3's `DynamicLine.spec.ts` (`toggling a ref array re-layouts`) plus the Phase 7 Task 6 smoke check.
  - **Phase:** Phase 7, Task 5 (automated) + Phase 7, Task 6 (interactive smoke)

- **AC4.4 Success — delete button removes UUID and re-renders; arrowhead disappears if array becomes empty:**
  - **Test type:** unit (Vue component) + partially human-verified for arrowhead disappearance
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.4: clicking delete on a chip emits deleteSubproperty"` — asserts the emitted command and target id. Arrowhead disappearance on empty ref array is covered by AC3.5's `DynamicLine.spec.ts` "toggling a ref array re-layouts" case; the end-to-end UI path requires Phase 7 Task 6 interactive smoke.
  - **Phase:** Phase 7, Task 5 (automated command emission) + Phase 4 Task 3 (automated arrow slot transition) + Phase 7 Task 6 (interactive integration)

- **AC4.5 Success — dropdown hides already-selected items:**
  - **Test type:** unit (Vue component with jsdom)
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.5: dropdown hides already-selected items"` — canvas seeded with 3 data items, 2 already selected; asserts `<select option>` count = 1 + placeholder, and that the hidden GUIDs are absent.
  - **Phase:** Phase 7, Task 5

- **AC4.6 Edge — renaming an endpoint updates the direction label reactively:**
  - **Test type:** unit (Vue component with jsdom) — primary automated attempt; human verification required as fallback
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.6: renaming an endpoint updates the label reactively"` — mounts with node1="A", mutates the name StringProperty to "AA", awaits `$nextTick`, asserts the rendered label reflects "AA". Phase 7 notes a possible fallback: if Vue declarative watch doesn't fire under the non-Vue-reactive canvas model, the component uses `RootProperty.subscribe("rename", handler)`. Either way the spec is authoritative; human verification below backs up the interactive UI confidence.
  - **Phase:** Phase 7, Task 5 (automated); Phase 7, Task 6 (human sanity)

- **AC4.7 Edge — zero data-items shows empty-state hint:**
  - **Test type:** unit (Vue component with jsdom)
  - **File:** `src/components/Controls/Fields/DataItemRefListField.spec.ts`
  - **Case:** `"AC4.7: empty diagram shows the empty-state hint"` — canvas has zero data items; asserts `.empty-state` rendered and `<select>` absent/hidden.
  - **Phase:** Phase 7, Task 5

---

### bidirectional-flow.AC5 — Downstream consumers handle the new shape

- **AC5.1 Success — `DfdPublisher` emits one edge per Flow carrying both ref arrays and Flow GUID as edge id:**
  - **Test type:** unit
  - **File:** `src/assets/configuration/DfdPublisher/DfdPublisher.spec.ts`
  - **Case:** Phase 5 Task 5 additions — asserts single flow emits exactly one edge with `node1`, `node2`, `node1_src_data_item_refs`, `node2_src_data_item_refs`, `id === flow.instance`, and "loop over edges, assert no duplicate ids". Also covered transitively by `DfdFilePreprocessor.spec.ts`'s "publisher re-emits data_items and both ref arrays identically" test (Phase 3 Task 4).
  - **Phase:** Phase 5, Task 5 (primary); Phase 3, Task 4 (integration smoke through preprocessor)

- **AC5.2 Success — `DfdValidator` emits per-array dangling-ref warnings with direction in the message:**
  - **Test type:** unit
  - **File:** `src/assets/configuration/DfdValidator/DfdValidator.spec.ts`
  - **Case:** Phase 5 Task 4 new cases — `"dangling ref in node1_src_data_item_refs emits a warning mentioning that direction"`, `"dangling ref in node2_src_data_item_refs emits a warning mentioning that direction"`, `"dangling refs in both directions emit two warnings"`. Assertions grep the warning `reason` for the direction key substring.
  - **Phase:** Phase 5, Task 4

- **AC5.3 Success — `DfdValidator` does NOT flag empty-both-sides flows:**
  - **Test type:** unit
  - **File:** `src/assets/configuration/DfdValidator/DfdValidator.spec.ts`
  - **Case:** Phase 5 Task 4 new case — `"empty-both-sides flow emits no warnings"`. Complemented by `"valid refs on both sides emit no warnings"`.
  - **Phase:** Phase 5, Task 4

- **AC5.4 Success — `SemanticAnalyzer` crossing classification unchanged after rename:**
  - **Test type:** unit
  - **File:** `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.spec.ts`
  - **Case:** Existing crossing tests at lines 259-369 pass verbatim after mechanical key renames (`edge.source` → `edge.node1`, etc.). Phase 5 Task 3 updates assertions at lines 364-365 (unbound-edge) and any fixture sites that set `source`/`target`. "Existing crossing tests pass verbatim" is the AC5.4 verification contract.
  - **Phase:** Phase 5, Task 3

- **AC5.5 Success — `D2Bridge.serializeToD2` emits one `node1 -> node2` edge with no attributes regardless of ref-array state:**
  - **Test type:** unit
  - **File:** `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.spec.ts`
  - **Case:** Phase 6 Task 1 adds a dedicated describe block `"D2Bridge.serializeToD2 — edge emission invariants (bidirectional flow)"` with four specs: `"emits one edge per Flow as \`node1 -> node2\`"`, `"emits no attributes on the edge"`, `"never emits \`<-\`, \`<->\`, or \`--\`"`, and `"SerializableLine interface is invariant to ref-array state"` (structural interface-shape guard).
  - **Phase:** Phase 6, Task 1

---

### bidirectional-flow.AC6 — Rename is mechanical and complete

- **AC6.1 Success — no `source`/`target` identifiers survive on Line-related types:**
  - **Test type:** unit (via build/grep verification)
  - **File:** Manual grep gate in Phase 2 Task 6 — `rg -n "\\b(setSource|setTarget|sourceObject|targetObject|rawSourceLatch|rawTargetLatch|_sourceLatch|_targetLatch)\\b" src --type ts`, plus `rg -n "line\\.(source|target)\\b" src --type ts`. Expected: zero matches (SemanticGraphEdge references are already renamed in Phase 5). The type-check gate (`vue-tsc`) enforces consistency across all renames.
  - **Case:** Phase 2 Task 6 verification grep (final commit gate). Also partially verified via `npm run build` in Phase 2 Task 6.
  - **Phase:** Phase 2, Task 6 (grep gate) + Phase 5, Task 6 (`SemanticGraphEdge` rename verification grep: `rg -n "edge\\.(source|target)\\b" src --type ts`)

- **AC6.2 Success — `npm run build` (vue-tsc) succeeds:**
  - **Test type:** unit (CI build gate)
  - **File:** `npm run build` and `npm run type-check`
  - **Case:** Phase 2 Task 6 run of `npm run type-check` and `npm run build`; reaffirmed in Phase 3 Task 4, Phase 4 Task 3, Phase 5 Task 6, Phase 6 Task 3, Phase 7 Task 6.
  - **Phase:** Phase 2, Task 6 (primary); all subsequent phases gate on it

- **AC6.3 Success — `npm run test:unit` passes with only key-name updates to specs:**
  - **Test type:** unit (test suite execution)
  - **File:** `npm run test:unit`
  - **Case:** Phase 2 Task 5 updates all affected `.spec.ts` files (`DiagramModel.spec.ts`, `OpenChart.spec.ts`, `SemanticAnalyzer.spec.ts`, `D2Bridge.spec.ts`, `NewAutoLayoutEngine.spec.ts`, `DfdPublisher.spec.ts`, `DfdValidator.spec.ts`, `DfdFilePreprocessor.spec.ts`); Phase 2 Task 6 runs the full suite.
  - **Phase:** Phase 2, Task 5 and Task 6

---

### bidirectional-flow.AC7 — Hard cutover — no legacy tolerance

- **AC7.1 Success — all JSON fixtures under `server/data/` and `server/temp/` are in the new shape:**
  - **Test type:** integration (fixture importability)
  - **File:** Phase 1 Task 6 rewrites the three `server/temp/*.json` fixtures and purges `server/data/*.json`. The full pytest suite and the three manual import curls verify the fixtures load.
  - **Case:** Phase 1 Task 6 manual curl verification (`curl -X POST /api/diagrams/import -d @<fixture>`, expect HTTP 201 for each); full pytest suite (`.venv/bin/python -m pytest tests/ -x -q`) remaining green after Task 6.
  - **Phase:** Phase 1, Task 6 (automated via full pytest + three import curls)

- **AC7.2 Success — no frontend test fixture or spec references old names on a flow:**
  - **Test type:** unit (via grep gate + full suite)
  - **File:** Phase 3 Task 4 runs a global grep: `rg -n '"data_item_refs"' src --type ts`, `rg -n "\\.data_item_refs\\b" src --type ts`, `rg -n "addDataItemRef\\([^,]*,[^,]*\\)" src --type ts`. Expected: zero matches under `src/`. Reinforced by the source/target grep in Phase 2 Task 6.
  - **Case:** Phase 3 Task 4 final grep gate; Phase 2 Task 6 for source/target parity.
  - **Phase:** Phase 2, Task 6 and Phase 3, Task 4

- **AC7.3 Failure — old-shape POST returns 400:**
  - **Test type:** unit (schema) + integration (HTTP endpoint)
  - **File:** `server/tests/test_schema.py` and `server/tests/test_endpoints.py`
  - **Case:** `TestDataFlow::test_old_shape_payload_rejected` (schema — relies on pydantic `extra="forbid"`) and `TestImportValidationErrors::test_old_shape_payload_returns_400` (endpoint — POST with `source`/`target`/`data_item_refs` keys, assert 400 with structured `details` list).
  - **Phase:** Phase 1, Task 2 and Task 5

---

## Human Verification Steps

The following AC cases have automated coverage for their model-layer behavior but additionally require a human interactive verification to confirm the full end-to-end UX experience as described in the design plan.

### bidirectional-flow.AC3.5 — Editing a ref array updates arrows without a full canvas rebuild

- **Why not automated:** The face-layout spec (`DynamicLine.spec.ts`'s `"toggling a ref array re-layouts and updates arrowhead count"`) verifies that the face slots transition correctly when a ref array mutates, but it cannot reliably assert "without a full canvas rebuild" (a negative visual/perf invariant). Phase 4 Task 2 explicitly notes that if the property-observer doesn't fire layout recomputation automatically in the test env, the spec manually triggers recomputation — so the reactivity path end-to-end is a human gate. Visually confirming that existing blocks/bounds don't re-flicker is a perception task.
- **Steps:**
  1. `npm run dev:all`.
  2. Import `server/temp/aws-ecs-webapp-with-reverse-flows.json` (contains bidirectional flows).
  3. Select any flow. Open the DevTools Performance tab; start a recording.
  4. In the property pane, add a data item to one direction via the dropdown.
  5. Remove a data item from the other direction by clicking the delete button on its chip.
  6. Stop the recording.
- **Expected:** Arrowhead count at each end of the selected flow updates immediately on each add/delete. Other canvas objects (blocks, groups, non-selected flows) do not visually re-flow. Performance trace shows re-render scoped to the selected flow (no full `DiagramView` rebuild frame).

### bidirectional-flow.AC4.3 — End-to-end add triggers arrow re-render

- **Why not automated:** The `DataItemRefListField.spec.ts` spec asserts the correct command is emitted, and `DynamicLine.spec.ts` asserts the arrow slot transitions when the model mutates. Neither directly validates that these pieces wire together in a running editor — the command must be accepted by `ApplicationStore.execute`, the property mutation propagates through the layout pipeline, and the canvas repaint happens. The Phase 7 Task 6 interactive smoke is the binding gate.
- **Steps:**
  1. `npm run dev:all`, import `server/temp/aws-ecs-webapp-with-data-items.json`.
  2. Select any flow edge.
  3. In the property pane, on the "Data from X to Y" section, pick any available data item from the dropdown.
- **Expected:** The chip appears in the selected items list for that direction; the arrowhead at the corresponding endpoint appears (or remains if it was already present) within a render frame.

### bidirectional-flow.AC4.4 — End-to-end delete triggers arrow disappearance on empty

- **Why not automated:** Same reasoning as AC4.3 — the automated specs verify the emitted command and the arrow slot transition independently, but not the full interactive pipeline including the arrowhead actually disappearing visually.
- **Steps:**
  1. Continuing from AC4.3's state (or importing a fixture with a flow that has exactly one ref in one direction).
  2. Click the `×` (delete) button on the chip so the array becomes empty.
- **Expected:** Chip disappears from the list; the arrowhead at the corresponding endpoint disappears; the opposite endpoint's arrowhead (if any) remains unchanged.

### bidirectional-flow.AC4.6 — Endpoint rename updates label reactively (human fallback)

- **Why not automated:** The automated spec in `DataItemRefListField.spec.ts` (`"AC4.6: renaming an endpoint updates the label reactively"`) is the primary gate, but Phase 7 flags a known reactivity risk — if Vue's declarative `watch` does not track the OpenChart model's mutation path (because the canvas model isn't backed by Vue's reactive system), the component falls back to `RootProperty.subscribe`. A human smoke test confirms the fallback wires up correctly against the real store, not a `createTestingPinia` stub.
- **Steps:**
  1. `npm run dev:all`, import any fixture with named blocks connected by a flow.
  2. Select the flow. Observe the label: "Data from X to Y" in both sections.
  3. In the canvas, double-click (or edit via property pane) the block X's `name` property and change it to "X-renamed".
  4. Return attention to the selected flow's property pane (selection should persist).
- **Expected:** Both direction labels that referenced block X now read "X-renamed" without requiring a manual re-selection of the flow.

### bidirectional-flow.AC5.5 — TALA auto-layout integration for bidirectional flows

- **Why not automated:** The `D2Bridge.spec.ts` additions (Phase 6 Task 1) cover the D2 output invariant (one `node1 -> node2` edge per Flow, no attributes, no alternate operators). But whether TALA produces valid and visually acceptable layout results for bidirectional flows — anchor placement, routing quality, round-trip SVG parsing — is an external-system integration only verifiable with `d2 --layout=tala` on `PATH`. Phase 6 Task 2 explicitly specifies this as a manual interactive smoke.
- **Steps:**
  1. `npm run dev:all` (requires `d2` with TALA on `PATH`).
  2. `curl -X POST http://localhost:5050/api/diagrams/import -H 'Content-Type: application/json' -d @server/temp/aws-ecs-webapp-with-reverse-flows.json` — capture the returned id.
  3. Open the frontend and load that diagram (auto-layout fires because no coords are stored).
  4. Open DevTools → Network tab; inspect the `/api/layout` request body for any occurrences of `<-`, `<->`, or `--`.
  5. Inspect the rendered diagram.
- **Expected:** `/api/layout` returns 200 with valid TALA SVG (no 502). `NewAutoLayoutEngine` parses without console errors. Every bidirectional flow shows arrows at both ends (arrows driven by our renderer, not by TALA). D2 request body contains only `->` edge operators. Anchor placement is comparable in quality to unidirectional fixtures. If materially degraded, flag as follow-up but do not block the phase.

### bidirectional-flow.AC7.1 — Fixtures are importable end-to-end

- **Why not automated:** Phase 1 Task 6 rewrites `server/temp/*.json` by hand (including the 14+14 → 14 merge in `aws-ecs-webapp-with-reverse-flows.json`). `server/data/` is gitignored and populated at runtime — no static test fixture lives there to assert on. The pytest suite uses synthetic in-memory dicts rather than reading these fixtures. The "all fixtures are in the new shape" invariant is only proven by importing each file through the live server.
- **Steps:**
  1. `cd /Users/josh/code/dfd_editor/server && .venv/bin/python -m pytest tests/ -x -q` — full suite must pass (gate 1).
  2. `npm run dev:flask` in one terminal.
  3. In another terminal, for each fixture file in `server/temp/*.json`, run:
     `curl -X POST http://localhost:5050/api/diagrams/import -H 'Content-Type: application/json' -d @server/temp/<fixture>.json`
  4. Observe each response.
- **Expected:** Every `curl` returns HTTP 201 with `{"id": "<uuid>"}`. No 400 validation errors.

---

## Coverage Summary

- Total AC cases: 37
  - AC1: 8 cases (AC1.1 through AC1.8)
  - AC2: 4 cases (AC2.1 through AC2.4)
  - AC3: 5 cases (AC3.1 through AC3.5)
  - AC4: 7 cases (AC4.1 through AC4.7)
  - AC5: 5 cases (AC5.1 through AC5.5)
  - AC6: 3 cases (AC6.1 through AC6.3)
  - AC7: 3 cases (AC7.1 through AC7.3)
- Automated: 36 (every AC case has at least one automated test or build/grep gate)
- Human-verified: 6 (AC3.5, AC4.3, AC4.4, AC4.6, AC5.5, AC7.1) — each as a supplementary confidence gate on top of automated coverage, except AC7.1 where the live-server import is the primary verification and the pytest suite is the supporting gate
- Overlap (both automated + human-verified): 6 (AC3.5, AC4.3, AC4.4, AC4.6, AC5.5, AC7.1)
