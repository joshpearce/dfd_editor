# Flow Schema Overhaul — Requirements

Last written: 2026-04-21 · Status: requirements / pre-plan

## Purpose

Replace the current directional `DataFlow` concept with a single
bidirectional `Flow` type whose direction is implicit in which data-item
reference arrays are populated. Eliminates the ambiguity that forces a
request/response relationship to be modeled as two separate flow objects,
and dissolves the associated rendering ambiguity ("which flow's path do
we draw?") without needing a view-layer coalescing pass.

## Current state

- `DataFlow` is strictly directional: `source: UUID`, `target: UUID`,
  `properties.data_item_refs: list[UUID]`. Arrowhead is always rendered at
  the `target` end.
- Logical bidirectional connections must be modeled as **two** separate
  flow objects with opposite endpoints.
- Consequence in data: no single owner for the "connection" between two
  nodes; shared properties (name, protocol, classification) must be
  duplicated or kept in sync across two objects.
- Consequence in rendering: to visually merge a request/response pair, the
  editor has to detect pairs at render time, pick one line's path, and
  draw a second arrowhead on it — all handled as a workaround.

## Proposed design

One `Flow` object per pair of connected nodes, regardless of direction.

Fields:

- `node1: UUID` — one endpoint.
- `node2: UUID` — the other endpoint.
- `node1_src_data_item_refs: list[UUID]` — data items flowing **from**
  node1 **to** node2.
- `node2_src_data_item_refs: list[UUID]` — data items flowing **from**
  node2 **to** node1.
- Shared flow properties (name, description, protocol, authenticated,
  encrypted, etc.) stay on the flow, not per-direction.

Direction is **derived, not stored**:

- `node1_src_data_item_refs` non-empty → arrowhead at node2 end.
- `node2_src_data_item_refs` non-empty → arrowhead at node1 end.
- Both non-empty → double-headed arrow (bidirectional flow).
- Both empty → see open questions.

## Requirements

### Data model (server)

- `server/schema.py` `DataFlow` replaces `source` / `target` /
  `data_item_refs` with the four new fields.
- Pydantic validation: `node1 != node2`; both reference existing node
  GUIDs; refs reference existing data-item GUIDs.
- Native canvas format (stored on-disk in `server/data/<id>.json`)
  uses the same new shape. No dual representation between native and
  minimal.
- `server/transform.py` `to_native` / `to_minimal` operate on the new
  shape end-to-end.
- Drift test (`tests/test_drift.py`) updated against any corresponding
  frontend enum changes.

### Migration

- Existing diagrams in `server/data/`, `server/temp/`, and all test
  fixtures use the old directional schema.
- A migration pass must:
  - Detect paired directional flows (same unordered node pair, opposite
    directions) and collapse them into one bidirectional flow. Shared
    properties from both are merged; conflicting properties pick a
    deterministic rule (likely: keep the lower-GUID flow's properties,
    flag conflicts in logs).
  - Lift unpaired directional flows into bidirectional flows with only
    one side's refs populated.
  - Be idempotent and independently testable.
- Open question: automatic migration on load in
  `DfdFilePreprocessor`, or a one-shot migration command? Affects UX for
  users with in-progress diagrams.

### Frontend template + editor model

- `DfdObjects.ts` `data_flow` template: the two ref-array properties
  replace the single `data_item_refs`.
- `LineView.source` / `LineView.target` become **structural** (which
  endpoint latches to which block) and no longer carry semantic
  direction. Convention to pick: `source` ↔ `node1`, `target` ↔ `node2`
  at load time.
- Editor commands that create / reparent / split flows need audit but
  should not break — they already operate on structural endpoints.
- `DfdFilePreprocessor` handles old-format stored diagrams on load if
  automatic migration is chosen.

### Rendering

- `DynamicLine` (or its successor) renders arrowheads by consulting the
  flow's ref arrays, not the LineView source/target roles:
  - Arrow at `node2` end iff `node1_src_data_item_refs` is non-empty.
  - Arrow at `node1` end iff `node2_src_data_item_refs` is non-empty.
- The existing view-layer pair-coalescing plan (`docs/bidirectional-flow-rendering-plan.md`)
  becomes unnecessary once the schema is unified and **is replaced by
  this overhaul** — delete that plan when this one lands.

### Validator

- Dangling-ref checks extend to both ref arrays.
- New rule candidate: a flow with zero refs on both sides is invalid or
  at least a warning (an arrow-less connection). Final rule is a design
  decision in the open questions.

### Publisher / SemanticAnalyzer

- The downstream semantic graph remains directional at the edge level.
- One bidirectional flow fans out to 0, 1, or 2 semantic edges based on
  which ref arrays are populated.
- Each emitted semantic edge carries the data items from the relevant
  `nodeX_src_data_item_refs` array plus the flow's shared properties.

### TALA auto-layout

- `D2Bridge.serializeToD2` emits one D2 edge per `Flow`. D2 only speaks
  directional edges, so pick a convention (likely `node1 -> node2`) and
  apply it uniformly.
- TALA rebind in `NewAutoLayoutEngine` works on the single line
  geometrically; the recent "rebind to D180 when both anchors land on the
  same face" fix carries over without change.
- The dual-arrow render logic lives in the line face, not the engine.

### Sample files / tests

- Every fixture in `server/temp/*.json`, `server/data/*.json`,
  `server/tests/`, and every frontend spec that references
  `source` / `target` / `data_item_refs` gets rewritten.
- Migration tests: an old directional JSON imports correctly and exports
  in new bidirectional shape.
- Round-trip tests: new bidirectional JSON round-trips through
  `POST /api/diagrams/import` and `GET /api/diagrams/<id>/export`
  losslessly.

## Out of scope

- Per-direction labels on the same visual line.
- N-way (3+) coalescing — not applicable; the new schema already
  allows only one flow per node pair, and multiple flows between the
  same pair should either be merged or disallowed.
- Changes to how data items themselves are modeled (still top-level on
  the canvas, still have `parent: UUID`).

## Open questions for the plan

1. **Canonical ordering of `node1` / `node2`** for a given pair: lowest
   GUID? Authoring order? Does the serialization care, or is it purely
   the author's choice?
2. **Flow with both ref arrays empty**: is it valid (a "presence only"
   connection rendered as a plain line with no arrows)? Validator
   warning? Validator error?
3. **Migration trigger**: automatic in `DfdFilePreprocessor` on every
   load, one-shot migration command, or a versioned-schema approach?
4. **Property conflict resolution during migration**: when the two
   directional flows being merged disagree on `name`, `classification`,
   `protocol`, etc. — deterministic rule, or surface a prompt?
5. **Multiple flows between the same node pair in the old format**:
   e.g., three flows all `A → B`. Disallow outright, or merge and
   concatenate refs?
6. **Publisher edge identity**: does downstream tooling need the
   semantic edge to carry a stable id tied back to the original flow,
   or is a synthesized id acceptable?

## Scope estimate

~10–15 story points across:

- server/ schema + transform + tests (~2–3 pts)
- Frontend template + preprocessor + LineView semantics (~3–4 pts)
- Rendering arrow logic (~1 pt)
- Publisher + validator (~2 pts)
- Sample files + test sweep (~2–3 pts)
- Migration pass + migration tests (~1–2 pts)

Warrants a phase-document-level plan on par with
`docs/trust-boundary-integration-plan.md` or
`docs/flask-backend-plan.md`, not a quick-plan.

