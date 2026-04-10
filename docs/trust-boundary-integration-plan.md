# Trust Boundary Integration — Roadmap

**Status as of 2026-04-10.** This document inventories the trust-boundary work
that has shipped (or is in flight) and lays out the work still needed before
trust boundaries can be considered a fully integrated feature of the DFD
editor.

It is intended to be picked up by a future contributor (human or otherwise)
without context from the sessions in which the existing work was done.

---

## 1. Scope of "completely integrated"

A user should be able to:

1. Spawn a `trust_boundary` from the sidebar / context menu and have it land
   in a sensible container — including inside another trust boundary if the
   pointer is over one.
2. **Resize** it to any user-chosen size, with handles, cursor feedback, and
   undo/redo.
3. **Drag** it around (alone or with its contents) and **reparent** it into,
   out of, or between other trust boundaries by dropping.
4. **Nest** trust boundaries arbitrarily — the spec for nested trust zones is
   formalized in the OTM standard and supported by tools like OWASP Threat
   Dragon, so the editor must support it too.
5. **Connect** blocks with data-flow lines that work the same way inside a
   trust boundary as outside (anchor visibility during drag, click-to-select
   on existing connectors, etc.).
6. **Save and reopen** without losing the boundary's user-set size, position,
   nesting structure, or the parent/child relationship of contents.
7. **Validate** the diagram for trust-boundary-aware semantic issues (e.g. an
   unauthenticated flow crossing a boundary, a high-classification flow
   leaving a low-trust zone).
8. **Export** the boundary nesting + crossings to whatever consumer needs it
   (currently `DfdPublisher` writes a flat node/edge graph).

Items 1–5 are mostly done. Items 6–8 are largely not.

---

## 2. What has been built

This section is the audit of git history from
`14ff8fb` ("phase1 DFD editor work") forward, including in-flight changes
that exist in the working tree but have not yet been committed at the time
of writing.

### 2.1 Phase 1 — `14ff8fb` (committed)

`feat: phase1 DFD editor work — base templates, group primitives, power-edit
extensions`

- Added the `BaseTemplates` module (`anchors`, `latches`, `handles`) and wired
  it into `DfdTemplates/index.ts`.
- Wrote a first-pass `GroupFace` (`Faces/Bases/GroupFace.ts`) that derived its
  bounding box entirely from its children plus a 20px padding. **No
  user-controlled size, no resize affordance.** This is the implementation
  the rest of the work was built on top of.
- Extended `Group` model and `CanvasView` for the new primitives.
- Extended `BlockMover` to do a single-level reparent: if a block is dragged
  out of its source group during a drag, eject to the canvas root; on release,
  if the block landed inside any top-level `canvas.group`, reparent into it.
- Hard-coded `anchor_line_template: "data_flow"` in
  `public/settings_macos.json` and `public/settings_win.json` so dragging from
  a block anchor creates a `data_flow` line by default.
- Added theme entries (`LightTheme`, `DarkTheme`) for the DFD object family.

### 2.2 Phase 2 — `cbc8d9d` (committed)

`feat(groups): arbitrary resize for trust boundaries + content-beats-container
hit priority`

- Replaced the auto-sized `GroupFace` with an explicit user-bounds model
  (`_userXMin`, `_userYMin`, `_userXMax`, `_userYMax`). The user-set bounds
  are the source of truth; `calculateLayout` only ever *grows* them to keep
  children visible, never shrinks. This means a user resize sticks even if
  children later move around inside.
- Added `getResizeEdgeAt(x, y)` and `resizeBy(edge, dx, dy)` to `GroupFace`,
  with clamping that enforces both an absolute minimum size (`MIN_SIZE = 60`)
  and a children-with-padding floor.
- Surfaced `hoveredEdge`, `getResizeEdgeAt`, `resizeBy` on `GroupView`.
- Added `ResizeEdge` bitmask enum + 8 visible resize handles drawn on focused
  groups.
- Added two new diagonal cursors to `Mouse.ts` (`NESW_Resize`, `NWSE_Resize`).
- Added `ResizeGroupBy` editor command + `GroupResizeMover` so resize drags
  flow through the undo stack like every other editor action.
- Rewired `PowerEditPlugin.smartHover` with a 5-pass priority order: direct
  canvas blocks → group resize halos → content inside groups (children win
  over containers) → canvas-level lines → group body fallback. This was the
  fix for "selecting a connector inside a trust boundary always selected the
  boundary instead."
- Made the cursor map for `GroupView` sensitive to `hoveredEdge` so the right
  resize cursor shows up at each edge/corner.

### 2.3 Phase 3 — uncommitted at time of writing

These changes are in the working tree (`git status` will show them as
modified/untracked) and represent the *nesting* and *anchor visibility*
work.

**LatchMover anchor recursion** — `LatchMover.getBlocksAndAnchorsAt`
previously walked only the direct `group.blocks` collection and had a dead
`instanceof GroupView` branch on it that never fired (because that array
contains only `BlockView`s). Result: anchors of blocks inside a trust
boundary were invisible during a connector drag from the outside, so users
had no visual feedback when trying to drop a connector onto them. Rewrote
the walker to test direct blocks first and then *recurse into nested
groups*.

**Recursive halo hit-test in `smartHover`** — added
`PowerEditPlugin.collectGroupsDeepestFirst` (a depth-first walker, deepest
sibling first) and updated `smartHover` to test resize halos and clear stale
`hoveredEdge` state on the entire group tree, not just `canvas.groups`. A
nested boundary's halo now wins over its container's halo even when the
cursor is in both halos at once.

**Spawn into the deepest containing group** — `SpawnObject` now resolves the
target container by calling `findDeepestContainingGroup(file.canvas, x, y)`
and falls through to `file.canvas` only when nothing contains the spawn
point. New trust boundaries land inside whichever boundary the user aimed
at instead of always at the canvas root.

**Reparent on drop, both blocks and groups.**
- `BlockMover` was rewritten to track `currentGroup`/`currentGroupBox` (the
  block's *current* parent during a drag, not the static drag-source group).
  The during-drag eject loop chains *one level at a time up the hierarchy*
  instead of jumping straight to the canvas. The release-side reparent uses
  `findDeepestContainingGroup` to land the block in the deepest container
  that contains its center, replacing the previous `for (const group of
  canvas.groups)` flat scan.
- New `GroupMover` (`ObjectMovers/GroupMover.ts`) handles single-group
  drag with the same chained-eject pattern and the same release-side
  innermost-group reparent. It excludes itself and its descendants from the
  reparent search so a group can never become its own ancestor.
- `PowerEditPlugin.handleGroup` now dispatches to `GroupMover` instead of
  `GenericMover` for the move case (resize is still routed to
  `GroupResizeMover`).

**Shared helper** — `findDeepestContainingGroup` was added to
`DiagramView/DiagramObjectView/ViewLocators.ts` next to the existing
`findUnlinkedObjectAt` and `findObjectAt` locators, and exported through the
`@OpenChart/DiagramView` barrel so `SpawnObject`, `BlockMover`, and
`GroupMover` can all use the same implementation. It includes an optional
`exclude` parameter (with `isDescendantOf` walker) for the group-reparent
self-exclusion case.

### 2.4 What this gives us *today*

Putting Phases 1 + 2 + 3 together, the in-memory model and interaction
layer can do all of items 1–5 from §1. A user can spawn nested boundaries,
resize them, drag them in and out, drop blocks into them across nesting
levels, draw connectors between blocks inside them with proper anchor
visibility, and click-select existing connectors that cross boundary
interiors. Undo/redo works because every drag is wrapped in a single
`GroupCommand` via `beginCommandStream` / `endCommandStream`
(`DiagramModelEditor.ts:135-157`), so the two-step
`removeObjectFromGroup` + `addObjectToGroup` reparent collapses to a single
undo entry.

What is **not** done is everything that has to survive a save/load round
trip, anything semantic about what trust boundaries *mean*, and any
threat-model-aware export.

---

## 3. Work remaining

Items are tagged with severity (Critical / Important / Polish) and a rough
size estimate (S = under a day, M = a day or two, L = several days).

### 3.1 Critical — data integrity

#### TB-1. Persist user-set group bounds [Critical, M]

**Problem.** `GroupFace._userXMin/_userYMin/_userXMax/_userYMax` are not
serialized. After save/load:
- Every group's bounds reset to `(-150, -100, 150, 100)` (the
  `DEFAULT_HW`/`DEFAULT_HH` constants) recentered on origin.
- Empty groups lose their position entirely.
- Non-empty groups visually re-fit to their children plus padding because
  `calculateLayout` will simply *grow* the default bounds back out — but
  any extra room the user added is gone, and the group ends up centered on
  the centroid of its children rather than on its old center.

**Files involved.**
- `OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectExport.ts` —
  add fields to `GroupExport`.
- `OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectSerializer.ts`
  `yieldExportFromGroup` and `yieldImportFromGroup` — write/read.
- `OpenChart/DiagramView/DiagramObjectView/Faces/Bases/GroupFace.ts` — accept
  bounds at construction or via a setter; expose accessors.
- `OpenChart/DiagramView/DiagramObjectViewFactory/DiagramObjectViewFactory.ts`
  — feed bounds into the new `GroupFace` after construction in both the
  `createNewDiagramObject` and `restyleDiagramObject` paths.

**Approach.**
1. Extend `GroupExport` with optional `bounds: [xMin, yMin, xMax, yMax]`
   (omit when defaults). Optional to keep the format backward-compatible
   with diagrams saved before this change.
2. `yieldExportFromGroup` reads the bounds *if* the group's runtime
   instance is a `GroupView` (i.e. has a `face` with the `_user*` fields).
   Use a getter on `GroupFace` rather than reaching at private state.
3. `yieldImportFromGroup` returns the bounds alongside the `Group` model,
   stashed somewhere the view factory can pick them up post-construction.
   The cleanest path is probably a small `setBounds(xMin, yMin, xMax, yMax)`
   method on `GroupView` that the factory calls right after creating the
   view from the model.
4. Serializer is in the model layer, view is in the view layer, so this
   touches a layer boundary. Keep the model-side ignorant of pixel-space
   bounds — only the view layer reads/writes them.
5. Restyle (theme switch) creates a fresh `GroupFace` and calls
   `replaceFace`. Ensure the new face inherits the previous bounds from
   the old face. The current `clone()` already copies `_user*` fields, so
   verify the restyle path uses cloning (it currently constructs a fresh
   `GroupFace()` — that's the bug to fix here).

**Test.** Create a trust boundary, resize it, save, reload — bounds match.
Empty boundary at `(500, 500)` survives. Restyle (theme change) preserves
bounds.

**Risk.** Backward-compat for existing files (acceptable to default
old files to auto-fit).

#### TB-2. Empty group position survives save/load [Critical, S]

A subset of TB-1, but worth calling out separately because it was already
broken before any of this session's work. The current `GroupFace` (and the
older "phase 1" version it replaced) have no position serialization at all.
With persistence (TB-1) this is fixed for free since the bounds are the
position. List explicitly so the test plan covers it.

#### TB-3. Persist line-to-group containment [Important, S]

Lines are *already* serialized correctly (`GroupExport.objects` is a flat
list of child instance IDs that includes lines, blocks, and sub-groups in
one bag), but only if they were structurally added to the group in the
first place. Today they aren't — see TB-4 for the fix to the *creation*
side. Once TB-4 lands, no extra serializer work is needed. Mark this item
"covered by TB-4" and move on.

### 3.2 Important — model correctness

#### TB-4. Lines should belong to their innermost shared container [Important, M]

**Problem.** `PowerEditPlugin.handleAnchor` (`PowerEditPlugin.ts:307-318`)
unconditionally adds new lines to `canvas`, regardless of where the source
and target anchors live. So:
- A connector drawn between two blocks both inside trust boundary A is
  structurally a child of the canvas, not A.
- Visually it works because latches follow anchors, which follow blocks,
  which move with their parent group.
- Semantically the model loses information: the data flow is "internal to
  A", but you can't tell that from the structure.
- For threat-model export (see TB-9), this matters: an OTM export wants to
  attribute each data flow to its containing trust zone, and we can't if
  the structural parent is always the canvas.

**Approach.** When the line is finalized (in `LatchMover.releaseSubject`,
not at `handleAnchor` time, because the target latch isn't bound yet),
compute the innermost group that contains both the source anchor and the
target anchor (the *lowest common ancestor* of their parent containers).
Reparent the line to that container via `removeObjectFromGroup` +
`addObjectToGroup`, same pattern as the block reparent.

For an unbound target (line dropped on empty canvas, target latch
floating), leave the line at the canvas root.

For a target that gets re-bound by a later edit (drag a latch from one
anchor to another), recompute LCA and reparent again.

**Files.**
- `LatchMover.ts` `releaseSubject` and `linkLatches`.
- New helper `findLowestCommonContainer(a: BlockView, b: BlockView)` in
  `ViewLocators.ts` next to `findDeepestContainingGroup`. Walks each
  block's parent chain into a set, then walks the other block's parent
  chain looking for the first hit.

**Test.** Draw a line between two blocks both inside boundary B which is
inside boundary A → line.parent === B. Move one block out of B but still
inside A → line.parent === A on next bind. Drag a line endpoint to a
canvas-level block → line.parent === canvas.

**Risk.** Existing `RouteLinesThroughBlock` logic (the line-through-block
behavior in `BlockMover`) probably assumes lines live at one specific
level. Audit before changing line ownership.

#### TB-5. Multi-block drag should reparent each block [Important, S]

`PowerEditPlugin.handleBlock` dispatches to `BlockMover` for single-block
drags and to `GenericMover` for any multi-selection. `GenericMover` only
shifts coordinates — no reparent on release. So if you select three blocks
and drag them into a trust boundary, none of them become children of the
boundary.

**Approach.** Either (a) extend `GenericMover.releaseSubject` to call
`findDeepestContainingGroup` per object, or (b) add a `MultiBlockMover`
that wraps the per-block reparent logic. Option (a) is smaller and matches
the existing pattern where `GenericMover` is the catch-all for
mixed-object drags.

Be careful: if the selection contains both blocks and a group at different
levels, the reparent target should still be picked per-object. Exclude any
selected groups from being valid reparent targets for selected blocks
(otherwise dragging a block + its containing group would loop).

#### TB-6. Group resize should not capture neighbors [Polish, S]

When you resize a group such that its new bounds enclose a sibling group
or a canvas-level block, nothing reparents — the sibling stays a sibling
and just visually overlaps. That's defensible behavior (resize is about
adjusting the rectangle, not capturing arbitrary content), but it can be
surprising. Decision needed:

- **Option A (no change):** document that resize doesn't capture. Users
  who want to capture should drag the captured object into the boundary
  instead.
- **Option B (capture on resize):** at the end of a `GroupResizeMover`
  drag, scan the canvas (and any common-ancestor container) for objects
  whose center is now inside the resized group but whose current parent
  isn't the resized group, and reparent them.

Recommend Option A. Cheaper, predictable, less likely to surprise.

#### TB-7. Dragging a group should not reparent its descendants out from under it [Important, S]

When `GroupMover` reparents the dragged group, its descendants come with
it because they're structural children. This already works correctly. But
the *during-drag* eject logic eject-chains the dragged group up the
hierarchy when it leaves a parent's snapshot bbox. If a child of the
dragged group is *also* selected as part of a multi-select, the chained
eject could re-parent the parent group out from under the child, which
would be a structural inversion.

**Approach.** Audit the multi-select case for `GroupMover` paths (today
this routes to `GenericMover` so it's a non-issue, but if TB-5 lands as
"per-object reparent in `GenericMover`" then we need to be careful to
process parents before children, or to skip reparenting any object that
is a descendant of another object in the same selection).

### 3.3 Important — threat-model semantics

#### TB-8. `DfdValidator` should understand trust boundaries [Important, M]

Today `DfdValidator` (`configuration/DfdValidator/DfdValidator.ts`) does
exactly two things: checks each property's `is_required` flag, and warns
if a data flow isn't connected on both ends. It has no awareness of trust
boundaries at all.

Trust-boundary-aware validations to add:

1. **Boundary crossings should be authenticated.** A line whose source and
   target are in *different* trust boundaries (or one is in a boundary and
   the other is at canvas / outside) is a boundary crossing. If
   `data_flow.authenticated === "false"`, warn.
2. **Boundary crossings should be encrypted in transit.** Same rule with
   `encrypted_in_transit === "false"`.
3. **High-classification data crossing into a lower-trust boundary.** If a
   data flow's `data_classification` is `secret` or `confidential` and it
   crosses *outward* into a less-privileged zone (e.g. `corporate` →
   `internet`), warn.
4. **Out-of-scope external entity inside an internal boundary.** A
   `external_entity.out_of_scope === "true"` placed inside a
   `trust_boundary.privilege_level === "restricted"` is probably wrong.
5. **Empty trust boundary.** A boundary with no children is probably an
   editing artifact — info-level note.

**Files.**
- `configuration/DfdValidator/DfdValidator.ts` — extend `validateEdge` and
  add a new `validateBoundary` pass.
- `OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts` — currently
  produces a flat node/edge graph. Extend `SemanticGraphEdge` to expose
  `crossings: SemanticGraphNode[]` (the boundaries the edge crosses), or
  add a separate `getBoundaryCrossings(edge): GroupView[]` helper that
  walks both endpoint blocks' parent chains.

**Risk.** "Crosses a boundary" needs a precise definition. Suggested rule:
the set of trust-boundary ancestors of `source.block` symmetric-difference
the set of trust-boundary ancestors of `target.block`. Anything in that
symmetric difference is a boundary that exactly one endpoint is inside, so
the line crosses it.

#### TB-9. `DfdPublisher` should emit boundary parent + crossings [Important, M]

`DfdPublisher` currently writes a flat `{ nodes, edges }` JSON document.
Trust boundaries are emitted as nodes alongside processes, but with no
parent relationship and no indication of what they contain.

**Approach.**
- Add `parent: <instance-id-or-null>` to every node so the consumer can
  reconstruct the containment tree.
- Add `crosses: [<boundary-instance-ids>]` to every data flow edge.
- Or: emit in [Open Threat Model (OTM)](https://github.com/iriusrisk/OpenThreatModel)
  format directly, which already has a `parent` field on `trustZone` and a
  formal nesting model. OTM is the most authoritative published spec for
  trust-boundary nesting (see `docs/getting-started.md` and the source
  links in this session's research).

**Decision needed.** Native JSON with parents added, vs. native OTM
output. OTM is more useful long-term (interop with IriusRisk, threat-model
toolchains) but is a bigger one-time cost.

### 3.4 Polish — UX

#### TB-10. Visual differentiation of nested depth [Polish, S]

With nesting, two overlapping boundaries can be hard to tell apart at a
glance. Options: vary the indigo accent slightly per depth (depth 0 = the
current `rgba(99, 102, 241, …)`; depth 1 slightly darker; etc.), or draw
a small `[depth N]` badge in the label area when depth > 0.

#### TB-11. Resize cursor at minimum-size clamp [Polish, S]

When a resize hits the minimum-size or children-floor clamp, the cursor
keeps showing the active resize cursor as if motion were possible.
Consider switching to `Cursor.NotAllowed` while clamped.

#### TB-12. "Move into" / "Remove from" context menu actions [Polish, M]

Drag-based reparenting works but isn't discoverable. A right-click context
menu on any selected block / group could expose:
- "Move into containing boundary" (when one exists at the cursor position)
- "Move out of <containing boundary name>"

Wires through `ContextMenuStore`. New entries call the same
`removeObjectFromGroup` + `addObjectToGroup` pair the movers use.

### 3.5 Tests — coverage gaps

#### TB-13. Unit tests for trust-boundary primitives [Critical, M]

Today the test suite has 68 tests across `App.spec.ts`, `Math.spec.ts`,
`DiagramModel.spec.ts`, and `OpenChart.spec.ts`. **Zero of them** cover
the work in this session. Add at minimum:

- `GroupFace.spec.ts`
  - `calculateLayout()` with no children uses defaults
  - `calculateLayout()` grows user bounds to contain children + padding
  - `calculateLayout()` written-back bounds are preserved across calls
  - `resizeBy(W, +20)` shifts xMin and clamps at children-floor
  - `resizeBy(E, -200)` clamps at children-floor + padding
  - `resizeBy(NW, dx, dy)` shifts both axes
  - `resizeBy` returns the actual clamped delta
  - `getResizeEdgeAt` classifies all 8 edges and the interior correctly
  - `moveBy` shifts user bounds *and* children
- `ViewLocators.spec.ts`
  - `findDeepestContainingGroup` with nested structure returns the
    deepest hit
  - `findDeepestContainingGroup(exclude)` skips the excluded group and
    its descendants
  - Sibling z-order is honored (last in array wins)
- `LatchMover.spec.ts` (or extend `OpenChart.spec.ts`)
  - `getBlocksAndAnchorsAt` finds anchors on blocks nested arbitrarily
    deep
- `BlockMover.spec.ts`
  - Drop a block at a coordinate inside a deeply nested boundary →
    `block.parent` is the deepest one
  - Drag a block out of all containers → `block.parent === canvas`
- `GroupMover.spec.ts`
  - Drop a group inside another boundary → reparented
  - Drop a group's center inside its own descendant area → falls through
    to canvas (self-exclusion)

#### TB-14. Integration test for `smartHover` priority [Important, S]

Mock or stub the editor and verify the 5-pass priority order in
`PowerEditPlugin.smartHover` against constructed scenarios:
- Cursor on a line inside a boundary → returns the line
- Cursor on a block inside a nested-nested boundary → returns the block
- Cursor in empty interior of an inner boundary → returns the inner
  boundary
- Cursor in the inner boundary's halo while the outer boundary's body
  contains the same point → returns the inner boundary with `hoveredEdge`
  set

### 3.6 Cross-cutting risks worth knowing about

- **Layer boundary at the model/view split.** TB-1 (persistence) is the
  one item that has to cross the model/view layer boundary because the
  serializer is in `DiagramModel` and bounds live in `DiagramView`. The
  cleanest fix is to extend `GroupExport` with an optional bounds field
  and let the `DiagramObjectViewFactory` inject the bounds onto the new
  view post-construction. Keep `Group` (model) ignorant of pixel-space.
- **Restyle path drops face state.** `restyleDiagramObject` in
  `DiagramObjectViewFactory.ts:401-403` constructs a fresh `GroupFace()`
  on theme change, which throws away `_user*` bounds. The `clone()`
  method already exists for this — switch the restyle path to use it.
  Verify `clone()` is also called in any other "rebuild face" code path.
- **`AddObjectToGroup.undo()` is `removeObject(...)`.** Be aware that
  using `addObjectToGroup` for a *reparent* (without first calling
  `removeObjectFromGroup`) leaves the undo broken — undoing the add just
  removes from the new parent, not restores to the old. Today the reparent
  flow correctly emits both commands and the surrounding command stream
  bundles them, so undo works in one step. New code that touches
  parentage should follow the same pattern.
- **`canvas.groups` typing inconsistency.** `CanvasView` doesn't override
  the `get groups()` accessor it inherits from `Canvas → Group`, so the
  return type is `ReadonlyArray<Group>` (model) while the runtime values
  are `GroupView` instances. The codebase relies on TypeScript's
  structural typing tolerating this. Cast to `GroupView` at the use site
  when accessing view-only members. (Long-term cleanup: override
  `CanvasView.groups` to narrow the return type, matching how `blocks`
  and `lines` are already overridden on `CanvasView`.)
- **Pre-existing lint debt in `BlockMover.ts`.** The file has 6
  pre-existing eslint errors (unused import + member-delimiter + indent)
  that predate this work. Resist the urge to fix them in trust-boundary
  patches; they're orthogonal and will balloon the diff. Address them in
  a dedicated cleanup commit.

---

## 4. Recommended order

Pick up in roughly this order. The Critical items are blockers; everything
else is incremental polish.

1. **TB-1 + TB-2** — persistence, including the restyle path. Without this
   the resize feature is unusable in practice (every save loses it).
2. **TB-13** — unit tests for the primitives that already shipped, before
   anything else changes them. Lock in current behavior.
3. **TB-14** — integration test for `smartHover` priority.
4. **TB-4** — line-to-innermost-shared-container reparenting. Unlocks
   meaningful threat-model semantics for §3.3 work.
5. **TB-5** — multi-block reparent on drop.
6. **TB-8** — `DfdValidator` boundary-aware checks (the small ones first;
   crossing-encryption is the highest-value).
7. **TB-9** — `DfdPublisher` parent + crossings export. Decide native JSON
   vs OTM.
8. **TB-10, TB-11, TB-12** — UX polish.
9. **TB-6, TB-7** — edge-case audits.

---

## 5. Glossary of file references

For the contributor picking this up cold:

| Concept | Path |
|---|---|
| Trust boundary template | `src/assets/configuration/DfdTemplates/DfdObjects.ts` (`name: "trust_boundary"`) |
| Group runtime view | `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Views/GroupView.ts` |
| Group face (size + render) | `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Bases/GroupFace.ts` |
| Group model | `src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Group.ts` |
| Containing-group locator | `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/ViewLocators.ts` |
| Hit-test priority | `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.ts` (`smartHover`) |
| Block drag + reparent | `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/BlockMover.ts` |
| Group drag + reparent | `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/GroupMover.ts` |
| Group resize | `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/GroupResizeMover.ts` |
| Anchor visibility during line drag | `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/LatchMover.ts` (`getBlocksAndAnchorsAt`) |
| Resize editor command | `src/assets/scripts/OpenChart/DiagramEditor/Commands/View/ResizeGroupBy.ts` |
| Reparent editor commands | `src/assets/scripts/OpenChart/DiagramEditor/Commands/Model/AddObjectToGroup.ts` and `RemoveObjectFromGroup.ts` |
| Spawn-at-coordinate | `src/assets/scripts/OpenChart/DiagramEditor/Commands/ViewFile/SpawnObject.ts` |
| Serialization | `src/assets/scripts/OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectSerializer.ts`, `DiagramObjectExport.ts` |
| Validator (DFD-specific) | `src/assets/configuration/DfdValidator/DfdValidator.ts` |
| Publisher (DFD-specific) | `src/assets/configuration/DfdPublisher/DfdPublisher.ts` |
| Semantic graph builder | `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts` |
