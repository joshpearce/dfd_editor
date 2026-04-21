# Bidirectional Flow Design

## Summary

This project replaces the existing directional `DataFlow` edge type in the DFD
editor with a single bidirectional `Flow` type that spans the entire stack —
server storage, import / export wire format, frontend canvas model, and the
publisher's semantic graph. Rather than storing direction as a field, the new
design derives it from two data-item reference arrays: one for each side of
the connection. If either array is non-empty, an arrowhead appears at the
corresponding endpoint; if both are populated, the edge is double-headed; if
both are empty, the edge renders as a plain presence-only line.

The implementation is divided into seven sequential phases: server schema and
fixtures first, then a mechanical frontend rename of `source` / `target` to
`node1` / `node2`, followed by canvas model and template changes, dual-arrow
rendering, downstream consumer updates, D2 integration, and finally a new
property-editor field component that lets authors assign data items to each
direction via a dropdown. The project is a hard cutover — no migration path,
no legacy reader, no schema versioning.

## Definition of Done

1. **Schema unified end-to-end.** The directional `DataFlow` is replaced by a
   single bidirectional `Flow` type across every representation — server
   native on-disk format, server minimal import/export, frontend canvas model
   and template, and publisher semantic graph. One Flow = one edge everywhere;
   no directional fan-out anywhere in the stack.

2. **New Flow shape:**
   - Two structural endpoints: `node1`, `node2`, with `node1` = lower GUID for
     a deterministic canonical order.
   - Two data-item ref arrays: `node1_src_data_item_refs` (data flowing
     node1 → node2) and `node2_src_data_item_refs` (data flowing
     node2 → node1).
   - Shared flow properties (name, protocol, classification, authenticated,
     encrypted, …) stay on the Flow object, not per-direction.

3. **Direction is derived, not stored.** Rendering consults the ref arrays:
   - `node1_src_data_item_refs` non-empty → arrowhead at node2 end.
   - `node2_src_data_item_refs` non-empty → arrowhead at node1 end.
   - Both non-empty → double-headed arrow.
   - Both empty → valid "presence-only" line, no arrowheads.

4. **Editor UX (new).** When the user selects an edge, the edge's property
   editor lets them add / remove data items independently in each direction.
   The data-item input is a **selector** populated from the diagram's
   already-imported top-level data-items collection. Creating new data items
   inline in the editor is out of scope — data items arrive via import.

5. **Code naming.** The Line / LineView `source` / `target` properties are
   renamed to `node1` / `node2` (or an equivalent non-directional pair)
   throughout the view layer so naming no longer implies direction.

6. **Hard cutover — no backwards compatibility.** Fresh project, no released
   data. All existing fixtures under `server/data/`, `server/temp/`, and
   frontend test specs are rewritten in the new shape. No migration code,
   no schema-version field, no legacy-shape tolerance.

7. **Tests updated.** Server schema + transform + drift tests rewritten.
   Frontend specs (`DfdPublisher`, `DfdValidator`, `DfdFilePreprocessor`,
   `SemanticAnalyzer`, `DataItemLookup`) rewritten. Round-trip tests verify
   the new minimal format imports / exports losslessly.

**Explicitly out of scope:**

- Creating new data items inline in the editor.
- Per-direction labels on the same visual line.
- N-way coalescing (already disallowed by the new schema — one Flow per node
  pair).
- Changes to how data items themselves are modeled (parent, identifier, etc.
  stay as they are).
- Any form of migration, versioned schema, or backwards-compatible reader.

## Acceptance Criteria

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

### bidirectional-flow.AC3: Arrow rendering is driven by ref-array state

- **bidirectional-flow.AC3.1 Success:** Flow with only `node1_src_data_item_refs` populated renders a single arrowhead at the `node2` end.
- **bidirectional-flow.AC3.2 Success:** Flow with only `node2_src_data_item_refs` populated renders a single arrowhead at the `node1` end.
- **bidirectional-flow.AC3.3 Success:** Flow with both ref arrays populated renders two arrowheads (one at each end).
- **bidirectional-flow.AC3.4 Success:** Flow with both ref arrays empty renders a plain line with no arrowheads.
- **bidirectional-flow.AC3.5 Edge:** Editing a ref array (add or remove) triggers a re-layout that updates the arrowhead count without a full canvas rebuild.

### bidirectional-flow.AC4: Editor UX for ref-array editing

- **bidirectional-flow.AC4.1 Success:** Selecting a Flow shows two labeled ref-array sections in the property pane, one per direction.
- **bidirectional-flow.AC4.2 Success:** Direction labels display the two endpoints' actual names (e.g., "Data from Browser to ALB"), not `node1` / `node2`.
- **bidirectional-flow.AC4.3 Success:** Adding a data-item via the dropdown appends its UUID to the correct ref array and triggers an arrow re-render.
- **bidirectional-flow.AC4.4 Success:** Removing a data-item (via the per-item delete button) removes its UUID from the ref array and re-renders; if the array becomes empty, the corresponding arrowhead disappears.
- **bidirectional-flow.AC4.5 Success:** Dropdown is populated from the diagram's top-level data-items; already-selected items are hidden from the dropdown to avoid duplicates.
- **bidirectional-flow.AC4.6 Edge:** Renaming an endpoint block updates the direction labels reactively.
- **bidirectional-flow.AC4.7 Edge:** Diagrams with zero data-items show the empty-state hint instead of an empty dropdown.

### bidirectional-flow.AC5: Downstream consumers handle the new shape

- **bidirectional-flow.AC5.1 Success:** `DfdPublisher` emits one edge per Flow, carrying both ref arrays in the edge's `properties`, with `id` equal to the Flow's GUID.
- **bidirectional-flow.AC5.2 Success:** `DfdValidator` surfaces dangling-ref warnings per array independently, with a message identifying the direction.
- **bidirectional-flow.AC5.3 Success:** `DfdValidator` does NOT flag empty-both-sides flows as errors or warnings.
- **bidirectional-flow.AC5.4 Success:** `SemanticAnalyzer`'s trust-boundary crossing classification is unchanged in behavior after the source/target → node1/node2 rename (existing crossing tests pass verbatim after fixture key renames).
- **bidirectional-flow.AC5.5 Success:** `D2Bridge.serializeToD2` emits one D2 edge per Flow as `node1 -> node2` with no attached attributes, regardless of ref-array state.

### bidirectional-flow.AC6: Rename is mechanical and complete

- **bidirectional-flow.AC6.1 Success:** No `source` / `target` identifiers survive on Line-related types in `DiagramView/`, `DiagramModel/`, or `Application/Commands/`.
- **bidirectional-flow.AC6.2 Success:** `npm run build` (including `vue-tsc`) succeeds after the rename with no type errors.
- **bidirectional-flow.AC6.3 Success:** `npm run test:unit` passes after the rename with no behavior change (existing tests updated for the new key names only).

### bidirectional-flow.AC7: Hard cutover — no legacy tolerance

- **bidirectional-flow.AC7.1 Success:** All JSON fixtures under `server/data/` and `server/temp/` are in the new bidirectional shape.
- **bidirectional-flow.AC7.2 Success:** No frontend test fixture or spec references `source` / `target` / `data_item_refs` (the old names) on a flow.
- **bidirectional-flow.AC7.3 Failure:** `POST /api/diagrams/import` with an old-shape payload (`source`, `target`, `data_item_refs`) returns 400 with a structured validation error.

## Glossary

- **Flow / DataFlow**: The edge type in a DFD diagram. `DataFlow` is the old
  directional type being replaced; `Flow` is the new bidirectional type. One
  Flow object represents one edge between two nodes, regardless of how many
  directions carry data.
- **DynamicLine**: The canvas face class responsible for drawing a flow edge
  (line body + arrowhead triangles). Extended in Phase 4 to hold two
  independent arrow slots (`arrowAtNode1`, `arrowAtNode2`) rather than one.
- **LineView**: The frontend view-layer object that wraps a flow edge in the
  canvas. Its `source` / `target` endpoint references are renamed to
  `node1` / `node2` in Phase 2.
- **`_FLOW_PROP_ORDER`**: A tuple in `server/transform.py` that pins the
  emission order of flow properties in serialized JSON. Deterministic ordering
  keeps diffs readable and the drift test stable.
- **`PropertyType` / `DataItemRefList`**: `PropertyType` is an enum that
  governs how the property editor dispatches rendering. `DataItemRefList` is
  the new variant added in Phase 3; it serializes identically to a list of
  strings but routes to the new `DataItemRefListField` component rather than a
  generic list field.
- **`ListProperty` / `StringProperty`**: Internal canvas-model property wrapper
  types. A `ListProperty<StringProperty>` is how a ref array is stored on the
  canvas model — a list of UUID strings.
- **`PropertyEditor` / `DictionaryFieldContents` / `ListField`**: The
  three-layer Vue component chain that renders an object's properties in the
  editor sidebar. `PropertyEditor.vue` renders the outer pane,
  `DictionaryFieldContents.vue` dispatches each field by `PropertyType`, and
  `ListField.vue` is the existing generic list renderer. The new
  `DataItemRefListField.vue` is registered in the same dispatch table.
- **`DataItemLookup`**: A module of pure helper functions (`readDataItems`,
  `readDataItemRefs`, `hashDataItems`) that query data items out of the canvas
  model without side effects. Refactored in Phase 5 to expose per-direction
  arrays.
- **`DfdPublisher` / `DfdValidator` / `DfdFilePreprocessor`**:
  Configuration-layer classes that sit between the canvas model and the
  outside world. The Publisher produces the semantic graph for export; the
  Validator surfaces warnings about dangling refs and schema violations; the
  FilePreprocessor normalises loaded JSON before the engine consumes it.
- **`SemanticAnalyzer`**: Analyses the canvas graph to classify edges as
  trust-boundary crossings. Its crossing computation is symmetric, so the
  `source` / `target` → `node1` / `node2` rename is mechanical with no logic
  change.
- **Drift test (`test_drift.py`)**: A server-side pytest that asserts enum and
  key parity between the frontend's `DfdObjects.ts` template and
  `server/schema.py`. Any schema rename that is not mirrored on the frontend
  breaks this test, so Phase 1 includes a placeholder frontend edit to keep
  it green.
- **Canonical ordering**: The invariant that `node1 < node2` in UUID
  lexicographic order. The server enforces this on import by silently
  swapping both the endpoints and the two ref arrays when a client posts them
  reversed, so all stored documents are in a consistent form.
- **D2 / TALA**: D2 is a diagram-as-code language; TALA is its proprietary
  auto-layout engine. The backend `/api/layout` endpoint shells out to the
  `d2` binary with TALA to compute geometric positions for newly imported
  diagrams. `D2Bridge.ts` serialises the canvas to D2 syntax; arrow direction
  in D2 output is always `node1 -> node2` and is irrelevant to rendering.
- **pydantic**: Python data-validation library used in `server/schema.py` to
  define and enforce the server-side Flow schema, including the self-loop
  constraint and dangling-ref checks. Validation errors are returned as
  structured 400 responses.
- **`EditorCommand` / `ApplicationStore`**: The command pipeline for all
  canvas mutations. `ApplicationStore.execute(command)` dispatches commands
  that mutate the model and push an entry onto the undo stack. The new
  ref-array editing reuses existing `EditorCommands` (create subproperty,
  delete subproperty); no new command classes are added.

## Architecture

One `Flow` type replaces the directional `DataFlow` everywhere — server native
JSON (`server/data/<id>.json`), the minimal import / export format, the
frontend canvas model, the publisher's semantic graph. There is no
"native ⇄ minimal" shape adapter for flows, and no per-direction fan-out at
any layer. One Flow is one edge, top to bottom.

**Core invariant (server-enforced):** for any Flow, `node1 < node2` in UUID
lexicographic order. Clients may POST a flow with the endpoints reversed;
the importer swaps them and swaps the two ref arrays so storage is always
canonical. This means readers can rely on canonical ordering without
branching.

**Direction is derived from data, not stored as a field.** `DynamicLine`
reads the Flow's two ref-array properties at layout time and populates one
of two `arrow` slots per endpoint. Empty-both-sides renders a plain
line — a valid "presence-only" connection per the DoD.

**TALA / D2 integration stays directional at the wire level.**
`D2Bridge.serializeToD2` emits one `node1 -> node2` edge per Flow, ignoring
the ref arrays. Layout is a purely geometric problem for TALA; the arrow
logic lives entirely in our Vue / Canvas renderer. This avoids depending
on TALA's undocumented treatment of the `<->` operator.

**Editor UX introduces one new property type.** `PropertyType.DataItemRefList`
dispatches through the existing `PropertyEditor.vue` →
`DictionaryFieldContents.vue` chain to a new Vue component,
`DataItemRefListField.vue`. The component renders a multi-select combobox
of data-items sourced from the active canvas, plus dynamic direction
labels derived from the two endpoint blocks' names. Edits flow through the
existing `EditorCommand` pipeline — no new command types, no new undo / redo
plumbing.

**Key data-flow paths:**

- **Import:** client POSTs a minimal doc → `schema.py` validates + canonicalises
  (`node1 < node2`) → `transform.to_native` writes canvas JSON with the two
  `ListProperty<StringProperty>` ref arrays → disk.
- **Load in editor:** backend GET → canvas JSON → `DfdFilePreprocessor`
  (pass-through) → engine instantiates `LineView` with `node1` / `node2`
  latches.
- **Render:** `LineLayoutStrategies` computes line vertices → reads both ref
  arrays from the Line's `props` → populates `DynamicLine.arrowAtNode1` and /
  or `arrowAtNode2` → `renderTo` draws 0, 1, or 2 triangles.
- **Edit:** user selects line → `PropertyEditor.vue` renders → two
  `DataItemRefListField` sections with dynamic labels → user modifies ref
  array → `EditorCommand` dispatched → canvas mutated → re-layout →
  re-render.
- **Export:** `transform.to_minimal` reads canonical canvas JSON → emits
  minimal doc in the new shape.
- **Publish:** `DfdPublisher` walks `SemanticAnalyzer`'s graph → emits one
  edge per Flow carrying both ref arrays in `properties`.

## Existing Patterns

Investigation confirmed these patterns; the design follows them:

- **Property-type dispatch.** `PropertyEditor.vue` →
  `DictionaryFieldContents.vue` (`src/components/Controls/Fields/`, lines
  75-93) dispatches by `PropertyType` name to type-specific field
  components (`StringField`, `EnumField`, `ListField`). The new
  `DataItemRefListField.vue` is registered the same way. No special-case
  wiring in the property pane itself.
- **Editor command pipeline.** `ApplicationStore.execute(command)`
  (`src/stores/ApplicationStore.ts:83-96`) drives all model mutations.
  `ListField.vue` already uses `EditorCommands.createSubproperty` /
  sibling delete commands (lines 31-45). The new field reuses the same
  commands; no new command classes.
- **Pure model helpers in `DataItemLookup.ts`.** Existing helpers
  (`readDataItems`, `dataItemsForParent`, `readDataItemRefs`,
  `hashDataItems`) are pure functions over the canvas model. The
  rename / split of `readDataItemRefs` into something like `readFlowRefs`
  (returning both arrays) follows the same style.
- **`_FLOW_PROP_ORDER` deterministic property enumeration.**
  `server/transform.py:56-63` defines the emission order for flow
  properties. The two new keys (`node1_src_data_item_refs`,
  `node2_src_data_item_refs`) replace the single `data_item_refs` entry
  in the same tuple; ordering stays deterministic.
- **Single `DynamicLine` face** registered in both `DfdThemes/DarkTheme.ts`
  and `LightTheme.ts` (`line 72-75`) as `data_flow → FaceType.DynamicLine`.
  Existing code models have been additive on `DynamicLine` rather than
  subclassing. This design extends the class in place (a second arrow
  slot) rather than introducing a `BidirectionalFlowLine` subclass — the
  codebase has no precedent for line-face polymorphism.
- **Drift test coupling.** `tests/test_drift.py` asserts enum / key parity
  between `DfdObjects.ts` and `server/schema.py`. Every server-side schema
  change to flow property names is paired with a frontend template edit
  in the same phase to keep the drift test green.

No existing patterns are diverged from.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Server schema, transform, and fixtures
**Goal:** Server accepts, stores, validates, and round-trips the new bidirectional Flow shape. Drift test passes against a parallel frontend-template placeholder edit.

**Components:**
- `server/schema.py` — `DataFlow` model (`source`/`target` → `node1`/`node2`),
  `DataFlowProps` (drop `data_item_refs`, add `node1_src_data_item_refs`
  and `node2_src_data_item_refs`), canonical-order validator (swap endpoints
  + ref arrays if reversed), per-array dangling-ref validation.
- `server/transform.py` — `_FLOW_PROP_ORDER` updated; `to_native` emits
  two `ListProperty<StringProperty>` ref arrays; `_emit_data_flow` reads
  them back; `source`/`target` keys renamed everywhere; legacy
  "pre-I3 shape" tolerance branch deleted.
- `server/tests/` — `test_schema.py`, `test_transform.py`,
  `test_endpoints.py`, `test_drift.py` rewritten. New cases for
  canonical-swap, both-empty, and per-direction dangling refs.
- `server/data/*.json`, `server/temp/*.json` — hand-rewritten to the new
  shape (including `aws-ecs-webapp-with-reverse-flows.json`, where paired
  directional flows are hand-merged into bidirectional flows).
- `src/assets/configuration/DfdTemplates/DfdObjects.ts` — placeholder
  rename of the two property keys in the `data_flow` template, so the
  drift test stays green. (Full template work lands in Phase 3.)

**Dependencies:** None — first phase, self-contained.

**Done when:** Phase covers `bidirectional-flow.AC1`, `bidirectional-flow.AC2`, and `bidirectional-flow.AC7`. `npm run test:unit` (frontend) unchanged; server pytest suite passes; `/api/diagrams/import` + `/api/diagrams/<id>/export` round-trips a new-format doc; posting an old-format doc returns 400.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Mechanical rename `source`/`target` → `node1`/`node2`
**Goal:** All Line-related frontend code uses `node1` / `node2` naming with no behavior change. Foundation for subsequent phases that reason about "which end is which."

**Components:**
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Views/LineView.ts`
  — rename `source`/`target` getters, latch references, and related
  types.
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/`
  — `DynamicLine.ts`, `LineLayoutStrategies.ts` updated to read
  `node1` / `node2`.
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/`
  — `D2Bridge.ts` `resolveLineEndpoints` uses `node1` / `node2`.
- `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts`
  — crossing computation input renamed.
- `src/assets/configuration/DfdPublisher/`, `DfdValidator/`,
  `DfdFilePreprocessor/` — references renamed.
- `src/assets/scripts/Application/Commands/` — command classes that
  operate on Line endpoints updated.
- All `*.spec.ts` referencing `source` / `target` on Lines updated.

**Dependencies:** Phase 1 (server schema fixed).

**Done when:** Phase covers `bidirectional-flow.AC6`. `npm run build` (vue-tsc) passes. `npm run test:unit` passes. `npm run lint` passes. No `source:` / `target:` identifiers survive on Line-related types.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Frontend canvas model, template, and new `PropertyType`
**Goal:** Canvas model and template declare the Flow's two ref-array properties under a new `PropertyType` so the editor dispatch can later route them to a dedicated field component.

**Components:**
- `src/assets/scripts/OpenChart/DiagramModel/Property/PropertyType.ts` (or
  wherever the enum lives) — add `DataItemRefList`. Serialization shape
  identical to `List<String>`; UI-only distinction.
- `src/assets/configuration/DfdTemplates/DfdObjects.ts` — `data_flow`
  template drops `data_item_refs`; adds `node1_src_data_item_refs` and
  `node2_src_data_item_refs` with `PropertyType.DataItemRefList`.
- `src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.ts` —
  comment updated. Remains a pass-through.
- `src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts`
  — specs updated to reflect new property names; hash-stability cases
  regenerated.

**Dependencies:** Phase 1 (server-side keys settled), Phase 2 (naming
consistent).

**Done when:** Template compiles, canvas loads diagrams with both ref arrays populated, property names match server's `_FLOW_PROP_ORDER`, drift test green.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: DynamicLine dual-arrow rendering
**Goal:** Arrowheads are drawn at 0, 1, or 2 endpoints based on the Flow's two ref arrays.

**Components:**
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts`
  — replace single `arrow: number[]` with `arrowAtNode1: number[] | null`
  and `arrowAtNode2: number[] | null`. Update `renderTo` to draw each
  non-null slot.
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts`
  — layout hook reads both ref arrays from the Line's `props` dictionary;
  populates the two slots conditionally using
  `getAbsoluteArrowHead` (endpoints swapped for the node1-end case).
- `src/assets/scripts/OpenChart/Utilities/Drawing/Shapes.ts` — optional
  sibling helper or reused `getAbsoluteArrowHead` with swapped arguments.
  Pure geometry; no new math.
- New spec (or extended existing spec) — render a mock `LineView` with
  each combination of ref-array states, assert the expected number of
  arrowheads.

**Dependencies:** Phases 1-3.

**Done when:** Phase covers `bidirectional-flow.AC3`. Rendering tests pass for 0, 1, and 2 arrowhead cases. Interactive sanity check: selecting a Flow, adding / removing data-items on either side in the property pane triggers the expected arrow count update.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Downstream consumers (Publisher, Validator, SemanticAnalyzer, DataItemLookup)
**Goal:** Every consumer of flow properties handles the new two-array shape. No fan-out in the publisher.

**Components:**
- `src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.ts` —
  `readDataItemRefs(props)` replaced with a structured reader (e.g.,
  `readFlowRefs(props)` returning `{ node1ToNode2: string[]; node2ToNode1: string[] }`).
  Consumers updated.
- `src/assets/configuration/DfdValidator/DfdValidator.ts` —
  `validateDataItemRefs` iterates both arrays; per-direction dangling-ref
  warnings. Edge-level trust rules unchanged.
- `src/assets/configuration/DfdPublisher/DfdPublisher.ts` — emits one
  edge per Flow, carrying both ref arrays plus shared properties. Edge
  id stays as the flow's GUID.
- `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts`
  — edge record exposes `node1`, `node2`, both ref arrays. Crossing
  computation (symmetric) unchanged in logic.
- All corresponding `*.spec.ts` rewritten — `DfdPublisher.spec.ts`,
  `DfdValidator.spec.ts`, `SemanticAnalyzer.spec.ts`,
  `DataItemLookup.spec.ts`.

**Dependencies:** Phases 1-3 (schema + template + rename).

**Done when:** Phase covers `bidirectional-flow.AC5.1` through `bidirectional-flow.AC5.4`. All frontend tests pass. Publisher's output for a mixed diagram (one-direction, two-direction, empty-both-sides flows) snapshots the expected shape.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: D2Bridge single-edge emission
**Goal:** D2 output still emits one edge per Flow; direction convention pinned to `node1 -> node2` regardless of ref-array state.

**Components:**
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`
  — `serializeToD2` line-emission loop (lines ~324-330) references
  `node1` / `node2` endpoints; literal `" -> "` preserved; no attributes
  attached.
- Existing `D2Bridge.spec.ts` (if present) updated to assert the new
  endpoint naming.
- Smoke test (manual or automated): auto-layout on a diagram with a
  bidirectional flow produces anchor placements that `AnchorStrategy =
  "tala"` can rebind cleanly. If anchor quality is visibly worse than
  for directional flows, flag as a follow-up — not in scope for this
  plan.

**Dependencies:** Phases 2, 3, 5.

**Done when:** Phase covers `bidirectional-flow.AC5.5`. `npm run test:unit` passes. End-to-end: loading a diagram with a bidirectional flow through `/api/layout` produces valid TALA SVG that `NewAutoLayoutEngine` re-parses without errors.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Editor UX — `DataItemRefListField` + dynamic labels
**Goal:** Authors can add / remove data-items into either direction of a selected Flow via a dropdown selector with live endpoint-name labels.

**Components:**
- `src/components/Controls/Fields/DataItemRefListField.vue` — new Vue
  component. Contract:
  ```ts
  interface DataItemRefListFieldProps {
      property: ListProperty;  // the ref array
      context: {
          node1View: BlockView;
          node2View: BlockView;
          direction: "node1ToNode2" | "node2ToNode1";
      };
  }
  ```
  Renders a section with a dynamic label ("Data from `node1.name` to
  `node2.name`"), a list of selected data-items (chip + delete button),
  and an add-dropdown of remaining data-items.
- `src/components/Controls/Fields/DictionaryFieldContents.vue` — add
  `PropertyType.DataItemRefList` case in the dispatch switch (around
  lines 75-93), passing `context` to the new component.
- `src/components/Elements/PropertyEditor.vue` — when the selection is a
  single Line, computes the two endpoint views and passes them through to
  the dispatcher as part of the per-property `context` object.
- `src/stores/ApplicationStore.ts` — new computed / getter
  `activeDataItems` returning `readDataItems(activeEditor.file.canvas)`
  or `[]`. Used by `DataItemRefListField.vue` to populate the dropdown.
- `DataItemRefListField.spec.ts` (new) — `@vue/test-utils` specs for:
  dropdown populated from `activeDataItems`, add / remove flow, empty-state
  hint when no data-items exist, label reactivity to endpoint-name
  changes.

**Dependencies:** Phases 1-5.

**Done when:** Phase covers `bidirectional-flow.AC4`. Interactive sanity: importing a fixture with data-items → selecting any flow → both directions show labeled dropdowns → adding a data-item on one side renders an arrow at the correct end.
<!-- END_PHASE_7 -->

## Additional Considerations

**Error handling:** Pydantic validation errors on import return structured
400 responses via the existing `schema.py` → `app.py` error-handling path
(`details` list). No new error types. Canonical-swap on import is silent
(not an error) — clients can send either ordering and get canonical
storage back.

**Edge cases:**

- **Lines with no flow template / non-`data_flow` line types.** No current
  code path creates such lines in the DFD fork, but the DynamicLine
  rendering logic degrades safely: absent ref-array properties means both
  arrow slots stay `null` — a line with no arrowheads.
- **Data-item deletion.** If a data-item is removed from the canvas while
  it is still referenced by a flow, the existing
  `DfdValidator.validateDataItemRefs` warning surfaces the dangling ref
  on the correct direction. No new cleanup logic needed.
- **Empty diagram.** `DataItemRefListField.vue`'s empty-state hint fires
  for diagrams with zero data-items. Authors can still see both direction
  sections (with empty selected-items lists) but cannot add references —
  expected and documented.

**Future extensibility:** The `PropertyType.DataItemRefList` mechanism is
generic — if future features need other "pick from known canvas objects"
selectors (e.g., block-ref lists), a sibling `BlockRefListField.vue` can
be added with the same dispatch pattern. This design does not need it;
it's a latent affordance, not a planned extension.

**Scope reminder — not added in this plan:**

- No `<->` or `<-` emission in `D2Bridge`. Emission is always
  `node1 -> node2`.
- No inline creation of data-items in the editor.
- No per-direction shared properties (name, protocol, etc.). Shared
  properties stay on the Flow; direction only distinguishes ref arrays.

