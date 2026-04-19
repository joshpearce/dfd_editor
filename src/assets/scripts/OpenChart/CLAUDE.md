# OpenChart (Diagram Engine — Forked)

Last verified: 2026-04-19

## Purpose

Our forked diagram engine. Originated as a verbatim copy of
`center-for-threat-informed-defense/attack-flow`'s
`src/attack_flow_builder/src/assets/scripts/OpenChart/`, then modified
extensively to support DFD-specific trust-boundary and editing features
(316 files / 32.6k insertions since the scaffold commit). The original
intent to "track upstream as-is" described in `docs/getting-started.md`
has been abandoned; treat this directory as first-party code.

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
  `AnchorRebind` (`pickCardinalAnchor` / `rebindLatchToAnchor` — line
  endpoint rebinding after layout); `AnchorStrategy` (`"none"` /
  `"geometric"` / `"tala"`, default `"geometric"`); `DiagramLayoutEngine`
  (sync interface) and `AsyncDiagramLayoutEngine` (async interface);
  `computeFitCamera` (viewport-fit helper used by `MoveCameraToObjects`).
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
  Latch, Handle), factory, serializer, schema config, semantic analysis.
- `DiagramView/` — Face system, renderers, view factory,
  `DiagramLayoutEngine/` (incl. `GroupBoundsEngine` and
  `NewAutoLayoutEngine/` — the async TALA/D2 engine), style-aware
  `GroupFace` (dashed / translucent), `FitCamera.ts` (pure
  viewport-fit math).
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
  `DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/`;
  Phase D Step 1–5 commits are the authoritative reference for
  expected Mover interactions.
- `docs/trust-boundary-phase-{a,b,c,d}.md` document the rationale for
  the bulk of fork-level engine changes.
- `GroupBoundsEngine` lives under `DiagramView/DiagramLayoutEngine/`,
  not under `DiagramEditor/` — it's a view-layer concern.
- `NewAutoLayoutEngine` must stay HTTP-free: it takes a `LayoutSource`
  callback at construction rather than importing `src/assets/scripts/api/`.
  The Vite-side wiring that injects the callback lives in the Application
  layer (`DiagramModelEditor` / file-management commands).
- Default `AnchorStrategy` is `"geometric"` as of `de99bd9`; the `"tala"`
  path depends on parseable TALA SVG and falls back to `"geometric"`
  per-line when edge data is missing.
