# OpenChart (Diagram Engine — Forked)

Last verified: 2026-04-21

## Purpose

Our forked diagram engine. Originated as a verbatim copy of
`center-for-threat-informed-defense/attack-flow`'s
`src/attack_flow_builder/src/assets/scripts/OpenChart/`, then modified
extensively to support DFD-specific trust-boundary, layout, and editing
features. The original intent to "track upstream as-is" has been
abandoned; treat this directory as first-party code.

## Contracts

- **Exposes**: `DiagramObjectType` (7 core types — Canvas, Block, Line,
  Group, Anchor, Latch, Handle); `DiagramSchemaConfiguration`; the Face
  system (`DictionaryBlock`, `BranchBlock`, `TextBlock`, `DynamicLine`,
  `DotGridCanvas`/`LineGridCanvas`, `GroupFace`,
  `AnchorPoint`/`LatchPoint`/`HandlePoint`); `DiagramEditor` commands +
  interface plugins; `AutomaticLayoutEngine` (sync); `NewAutoLayoutEngine`
  (async, implements `AsyncDiagramLayoutEngine`, takes a `LayoutSource`
  callback at construction so no HTTP client is imported here) plus its
  siblings `D2Bridge` (canvas ↔ D2 text + TALA-SVG parsing) and
  `AnchorRebind` (`pickCardinalAnchor` / `pickNearestAnchor` /
  `rebindLatchToAnchor` — line endpoint rebinding after layout);
  `AnchorStrategy` (`"none"` / `"geometric"` / `"tala"`, default
  `"tala"`); `DiagramLayoutEngine` (sync interface) and
  `AsyncDiagramLayoutEngine` (async interface); `computeFitCamera`
  (viewport-fit helper used by `MoveCameraToObjects`); `DataItemLookup`
  helpers (`readDataItems`, `dataItemsForParent`, `readDataItemRefs`,
  `hashDataItems`, `narrowClassification`, `DataItem` /
  `PillClassificationKey` types, plus `CHIP_PAD_X_OF_HEIGHT` /
  `CHIP_BASELINE_OF_HEIGHT` shared chip-geometry constants) from
  `DiagramModel/DataItemLookup.ts` — pure model helpers, no DOM/View
  imports; `faceCanvasLookup.findCanvas` shared helper for walking a view's
  parent chain to the nearest `Canvas` ancestor.
- **Guarantees**: Group is a first-class model object (not an overlay)
  that owns children, supports nesting, and persists via the same file
  format as blocks/lines. `GroupBoundsEngine` persists user-set group
  bounds across save / load / clone / restyle.
- **Expects**: schema and themes supplied by
  `src/assets/configuration/` conform to `DiagramSchemaConfiguration`.

## Dependencies

- **Uses**: d3 (pan/zoom math only), `Utilities/` within OpenChart.
- **Used by**: `src/assets/configuration/` (templates / themes /
  publisher), `src/assets/scripts/Application/` (commands),
  `src/components/` (rendering integration).
- **Boundary**: must not depend on Vue, Pinia, or anything in
  `src/components/` or `src/stores/`. Engine stays framework-agnostic.

## Key Decisions

- First-class Group with nesting was chosen because it's what trust
  boundaries need; the upstream project shipped this shape.
- Deliberate divergence from upstream: the trust-boundary feature set
  lives inside the engine (model / view / editor) rather than as an
  external overlay or a plugin-only extension.

## Invariants

- Moving a Group moves its children atomically (undo/redo safe).
- Lines reparent to the lowest-common-ancestor container on creation
  and on latch release (`c0da9b6`).
- Multi-block reparent is a single undo step (`4299906`).
- User-set group bounds survive round-trips through save / load /
  clone / restyle (`94fb6ed`).
- Content beats container in hit priority so clicks on a child inside a
  group hit the child, not the group (`cbc8d9d`).

## Key Files / Subdirs

- `DiagramModel/` — model classes (Canvas, Block, Line, Group, Anchor,
  Latch, Handle), factory, serializer, schema config, semantic analysis;
  `DataItemLookup.ts` — pure helpers for reading canvas `data_items` and
  resolving `data_item_refs` (no DOM/View imports).
- `DiagramView/` — Face system, renderers, view factory,
  `DiagramLayoutEngine/` (incl. `GroupBoundsEngine` and
  `NewAutoLayoutEngine/` — the async TALA/D2 engine), style-aware
  `GroupFace` (dashed / translucent), `FitCamera.ts` (pure viewport-fit
  math); `DiagramObjectView/Faces/faceCanvasLookup.ts` — shared
  `findCanvas` helper used by block faces.
- `DiagramEditor/` — commands, `SynchronousCommandProcessor`,
  `AutosaveController`, `InterfacePlugins/PowerEditPlugin/` (incl.
  `ObjectMovers/` — Block / Group / Generic / Latch Movers) and
  `InterfacePlugins/RectangleSelectPlugin/`.
- `DiagramInterface/` — DOM / pointer glue.
- `SchemaRegistry/`, `ThemeRegistry/`, `ThemeLoader/` — runtime
  registries.
- `Utilities/` — misc helpers.
- `OpenChart.spec.ts` — smoke-level engine tests.

## Gotchas

- This is NOT upstream-verbatim. Do not assume a function matches
  upstream OpenChart behavior — read the local code. Upstream is useful
  for origin context only.
- Edits that change exposed types / enums can ripple into
  `src/assets/configuration/` via theme `FaceDesign` coupling
  (`ace7b29`).
- Mover tests are colocated under
  `DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/`; the
  trust-boundary commits that introduced each Mover (see `git log` for
  `test(trust-boundary): Phase D Step …`) are the authoritative reference
  for expected Mover interactions. The phase plan docs that originally
  accompanied them have been purged from `docs/`.
- `GroupBoundsEngine` lives under `DiagramView/DiagramLayoutEngine/`,
  not under `DiagramEditor/` — it's a view-layer concern.
- `NewAutoLayoutEngine` must stay HTTP-free: it takes a `LayoutSource`
  callback at construction rather than importing `src/assets/scripts/api/`.
  The Vite-side wiring that injects the callback lives in the Application
  layer (`DiagramModelEditor` / file-management commands).
- Default `AnchorStrategy` is `"tala"` as of `6734431` (reverting
  `de99bd9`'s brief experiment with `"geometric"`): TALA's SVG edge
  endpoints drive anchor selection via `pickNearestAnchor` (12 anchors
  per block — 4 face midpoints + 8 quarters) and `pickPolylineElbow`
  additionally steers the line's single handle onto TALA's bend point.
  The `"tala"` path falls back to `"geometric"` per-line when edge data
  is missing or the nearest TALA edge is more than one block
  half-dimension away from either endpoint.
- The TALA handle-steering pass sets `PositionSetByUser.True` on the
  handle before calling `moveTo`; without it, the next
  `DynamicLine.calculateLayout` tick would snap the handle back to the
  source/target midpoint and discard TALA's elbow (see commit
  `a410dc2`). The engine inlines the bitmask (`0b11000`) rather than
  importing from `ViewAttributes.ts` to avoid dragging the
  `@OpenChart/Utilities` barrel (and its canvas-dependent FontStore)
  into the engine layer.
- `LineLayoutStrategies.ts` two-elbow layouts apply cap offsets toward
  the handle (via `axisCapTowards`), not toward the opposite endpoint.
  This matters when TALA rebinds both source and target anchors to the
  same face (both left, both top, etc.) — the old `oneAxisCapSpace`
  would push the source's first segment back through its own block
  instead of out past the face.
