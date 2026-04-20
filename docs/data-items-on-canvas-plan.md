# Data Items on the DFD Canvas — Implementation Plan

**Spec:** `~/.claude/plans/i-want-to-have-floating-finch.md` (design rationale,
color decisions, qualified-vs-bare rules, deferred questions).
**Scope:** schema shape + canvas rendering for first-class data items. No
properties-panel UI.

## Pre-flight corrections to the spec

- `DynamicLine` lives at
  `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts`
  (not `Faces/Bases/`). New sibling `LabeledDynamicLine.ts` goes in
  `Faces/Lines/`.
- `FaceDesign` wiring lives in
  `src/assets/scripts/OpenChart/DiagramView/DiagramObjectViewFactory/FaceDesign.ts`
  and `DiagramObjectViewFactory.ts` — both must register the new face.
- Preprocessor is a single file (`DfdFilePreprocessor.ts`), not a directory.

## Step 1 — Schema + round-trip (backend + interchange)

**Changes.** Extend the minimal interchange format so data items survive
import/export before any UI work lands.

- `server/schema.py`: add `DataItem` model (fields per spec: `guid`, `parent`,
  `identifier`, `name`, `description?`, `classification?`). Add
  `data_items: list[DataItem] = []` to `Diagram`. Add
  `data_item_refs: list[UUID] = []` to `DataFlowProps`.
- `server/transform.py` (if it mediates import/export): plumb the new fields
  through; empty lists are the safe default for legacy diagrams.
- `server/tests/`: add a round-trip test — POST an import payload with two
  `data_items` and a flow with one `data_item_ref`, GET it back, assert
  equality.

**Affected files.** `server/schema.py`, `server/transform.py`,
`server/tests/`.

**Acceptance.**
- `/api/diagrams/import` accepts payloads with `data_items` and flow
  `data_item_refs`; GET returns them unchanged.
- Legacy diagrams (no `data_items`) import and export identically to today
  (field omitted or empty list; no schema errors).
- Backend tests pass; `npm run lint` and `npm run type-check` still clean
  (frontend untouched this step).

## Step 2 — In-memory model on the canvas

**Changes.** Mirror the schema into OpenChart's property framework so the
frontend has somewhere to read/write from. Piggybacks on existing
serialization — no new storage primitive.

- `DfdTemplates/DfdCanvas.ts`: add a `data_items` `ListProperty`. Each entry
  is a `DictionaryProperty` with `parent_guid`, `identifier`, `name`,
  `description`, `classification`.
- `DfdTemplates/DfdObjects.ts`: add `data_item_refs` (`ListProperty` of GUID
  strings) to the flow template. Do **not** add to node templates yet
  (deferred per spec § open questions).
- `DfdPublisher/DfdPublisher.ts`: project canvas `data_items` → top-level
  minimal-format list; project flow `data_item_refs` onto `DataFlowProps`.
- `DfdFilePreprocessor/DfdFilePreprocessor.ts`: reverse direction on import —
  hydrate canvas `data_items` and per-flow refs from the minimal payload.
- Add a small helper module (e.g.
  `src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.ts` or a pure
  function alongside the canvas model) exposing:
  - `dataItemsForParent(canvas, nodeGuid) → DataItem[]`
  - `resolveRefs(canvas, guids[]) → DataItem[]`
  - `pillLabel(item, viewedFromGuid, canvas) → string` (bare vs qualified per
    spec).

**Affected files.** `DfdCanvas.ts`, `DfdObjects.ts`, `DfdPublisher.ts`,
`DfdFilePreprocessor.ts`, new lookup helper + its spec.

**Acceptance.**
- New Vitest spec for `DfdPublisher` — canvas with 2 data items + 1 flow ref
  publishes the expected minimal-format shape.
- New Vitest spec for the preprocessor — round-trip (minimal → canvas →
  minimal) is identity.
- Lookup helper spec covers bare (owner) vs qualified (non-owner) label
  resolution, including the ~12-char parent-name truncation rule from the
  spec.
- No visual change yet; existing diagrams still render identically.

## Step 3 — Theme tokens for data pills

**Changes.** Introduce the classification color vocabulary before touching
either face, so both faces consume a single token set.

- `DfdThemes/LightTheme.ts` and `DfdThemes/DarkTheme.ts`: add a `DataPill`
  style block keyed by `pii | secret | public | internal | default`
  (fill+text), plus `pillRowVerticalPaddingUnits` and `pillSpacingUnits` on
  the `DictionaryBlock` style. Pick concrete hex values from the existing
  palette; the spec suggests amber/red/blue/violet for light theme — mirror
  with adjusted contrast in dark.
- Extend the theme type where these styles are declared so TS enforces
  presence in both themes.

**Affected files.** `LightTheme.ts`, `DarkTheme.ts`, the theme style type
(wherever `DictionaryBlock` style is typed; likely under `DfdThemes/` or
`OpenChart/DiagramView/.../Themes`).

**Acceptance.**
- `npm run type-check` clean: both themes declare the new fields; omission
  from one theme is a compile error.
- No runtime behavior change — tokens are defined but unused until Steps 4–5.

## Step 4 — Entity pill row (`DictionaryBlock`)

**Changes.** Render a wrapping chip row at the bottom of the block body for
any data item parented to the node.

- `Faces/Blocks/DictionaryBlock.ts`: in `calculateLayout()`, after the last
  key/value row, emit a pill-row section:
  - Source = `dataItemsForParent(canvas, this.node.guid)`.
  - Chip = rounded rect, width = `measureText(identifier) + 2 * chipPadX`,
    height = one body-line.
  - Flow chips left→right with `pillSpacingUnits`, wrap to a new sub-row at
    block content width.
  - Chip fill = `theme.DataPill[classification ?? "default"].fill`; text =
    matching `.text`. Use bare `identifier` (owner view).
  - Grow block `height` by the pill-row block including
    `pillRowVerticalPaddingUnits` top and bottom.
- No behavior change when the parent has zero items — skip the section and
  leave layout unchanged.

**Affected files.** `DictionaryBlock.ts` and colocated spec.

**Acceptance.**
- `DictionaryBlock.spec.ts` additions:
  - 0 items → layout + draw identical to pre-change snapshot.
  - 3 items (mixed classifications) → 3 chips in a single row, correct
    fills, bare identifiers.
  - N items wider than block → wraps onto a second row; block height grows
    by exactly (rows × chip height + padding).
- Manual visual (`npm run dev:all`): process with `D1 (pii)` + `D2 (secret)`
  shows two colored pills below property rows; theme toggle swaps colors.
- Nested-group sanity: placing the entity inside a trust boundary reflows
  the group to the new block height (`GroupBoundsEngine` already reactive;
  no code change expected, verify only).

## Step 5 — Flow midpoint strip (`LabeledDynamicLine`) + wiring

**Changes.** New line face that inherits `DynamicLine`'s geometry and adds a
midpoint pill strip for referenced data items.

- New `Faces/Lines/LabeledDynamicLine.ts`:
  - Extends `DynamicLine`.
  - At draw time: resolve `this.line.properties.data_item_refs → DataItem[]`;
    if empty, draw exactly like `DynamicLine`.
  - Compute midpoint via the existing `t=0.5` helper used for handles.
  - Render an axis-aligned background plate + horizontal chip sequence
    centered on the midpoint; each chip shows qualified label
    (`Parent.Identifier`, truncated per helper).
  - Classification fill from `DataPill` theme tokens.
- `FaceType` union (wherever face kinds are enumerated — likely
  `FaceDesign.ts` or a shared types file): add `LabeledDynamicLine`.
- `DiagramObjectViewFactory.ts` / `FaceDesign.ts`: map the new face kind to
  the new class.
- `DfdThemes/LightTheme.ts` + `DarkTheme.ts`: switch the DFD flow template's
  `FaceDesign` from `DynamicLine` → `LabeledDynamicLine`. Leave the bare
  `DynamicLine` class exported for non-DFD reuse.
- Optional (low-cost): `DfdValidator.ts` warning on `data_item_refs` that
  point at a non-existent `guid` in `canvas.data_items`.

**Affected files.** New `LabeledDynamicLine.ts` + spec;
`FaceDesign.ts`; `DiagramObjectViewFactory.ts`; `LightTheme.ts`;
`DarkTheme.ts`; optionally `DfdValidator.ts`.

**Acceptance.**
- `LabeledDynamicLine.spec.ts`: flow with 2 refs emits midpoint strip with
  qualified labels; zero refs → no strip, draw output matches base
  `DynamicLine`.
- Manual (`npm run dev:all`): flow referencing `Proc.D1` shows a single
  pill at the connector midpoint; dragging endpoints keeps the strip
  centered and axis-aligned; light/dark toggle swaps colors.
- Dangling ref (optional validator): validator surfaces a warning but does
  not block save/publish.

## Next steps (follow-on plans)

Out of scope here; each warrants its own plan once this one lands:

- **Properties-panel CRUD for data items.** The primary follow-on. Add
  create/edit/delete of data items inside the parent entity's property
  panel: identifier assignment (auto `D1/D2/…` vs. user-typed), name,
  description, classification picker. No canvas click-to-edit.
- **Cross-parent references from entities.** Decide whether non-owning
  entities can also reference data items (would promote `data_item_refs`
  from "reserved name" to a live field on `NodeProps`).
- **Flow pill UX polish.** Truncation rules for long qualified labels,
  overflow behavior when a flow references many items, hover/tooltip for
  full name + description.
- **Validator hardening.** Surface dangling refs, orphaned items (parent
  deleted), and classification/name drift against a shared catalog if one
  is later introduced.

## Overall Definition of Done

- All five steps' acceptance criteria met.
- `npm run test:unit`, `npm run lint`, `npm run type-check` all green.
- Legacy diagrams (no `data_items`) load, render, and save without any
  visible or structural change.
- A hand-crafted diagram with items on multiple entities and a flow
  referencing items across parents renders correctly in both themes and
  round-trips through `/api/diagrams/import` → GET → save unchanged.
- No regressions in nested-group sizing, TALA auto-layout, or existing flow
  routing.
- Deferred work (properties-panel CRUD, cross-parent entity refs on
  `NodeProps`, identifier assignment strategy) stays deferred; `NodeProps`
  schema field is reserved in a comment but not introduced.
