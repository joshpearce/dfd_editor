# Trust Boundary Integration — Phase A

**Scope.** Lock in what already shipped (roadmap §2) so later phases can
build on stable ground. Phase A covers the Critical items from
[trust-boundary-integration-plan.md](./trust-boundary-integration-plan.md)
§4 — persistence and test coverage — and nothing else.

**In scope:** TB-1 (persist user-set group bounds), TB-2 (empty group
position round-trip — falls out of TB-1), and the subset of TB-13 that
covers pure-logic primitives directly accessible from the view layer:
`GroupFace` and `ViewLocators.findDeepestContainingGroup`. These are
testable using only the factory + view-layer constructors, with no
editor, plugin, mover, or DOM scaffolding.

**Out of scope:** TB-4 onward (model correctness, validator, publisher,
UX polish — all Phase B). Also out of scope:

- **TB-14 (smartHover integration test).** Hover priority is a
  browser-interaction concern; validated by human smoke testing.
- **Any test that requires constructing a mover, plugin, executor,
  editor, or `SubjectTrack`.** This includes `BlockMover`/`GroupMover`
  release and drag tests, `LatchMover.getBlocksAndAnchorsAt` (a private
  instance method), and the smartHover priority above. These are
  validated by code review plus the manual smoke checklist. Investing
  in editor-layer test infrastructure (plugin/executor stubs, command
  stream capture, `SubjectTrack` orchestration) is its own workstream
  and belongs to Phase B.

**Manual smoke-test checklist (run by hand at the end of Phase A).**
Each item below is a hand-verified replacement for an automated test
that was deemed out of scope for Phase A.

- **Persistence (TB-1/TB-2):** create a diagram with (a) a resized
  trust boundary holding two blocks, (b) an empty trust boundary at a
  non-origin coordinate, (c) a nested trust boundary inside (a). Save,
  reload, confirm every group is at the same position and size.
- **Restyle:** create a resized boundary, switch theme, confirm the
  size is preserved.
- **Backward compat:** load a diagram saved before Phase A, confirm it
  opens without error.
- **`BlockMover` reparent on drop:** drop a block at a coordinate
  inside a deeply nested boundary, confirm it becomes a child of the
  deepest containing boundary (not a sibling). Drag a block out of all
  containers, confirm it returns to the canvas root.
- **`BlockMover` chained eject during drag:** drag a block from inside
  a deeply nested boundary out through the side at speed, confirm it
  walks up the hierarchy one level at a time without the parent group
  visually chasing it.
- **`LatchMover` anchor visibility through nested boundaries:** start a
  connector drag from a block on the canvas root, drag the latch over
  a block that lives two levels deep inside nested trust boundaries,
  confirm the inner block's anchors highlight (the regression test for
  the §2.3 recursive `getBlocksAndAnchorsAt` rewrite).
- **`GroupMover` reparent + self-exclusion:** drag a group into a
  sibling boundary, confirm reparent. Drag a group so that its center
  passes over its own descendant, confirm it does **not** become its
  own descendant (falls through to canvas).
- **Undo collapse:** drag-reparent a block, hit undo once, confirm the
  block returns to its original parent in a single step (the
  remove-then-add command pair must collapse to one undo entry).
- **`smartHover` priority (TB-14):** with a canvas containing an outer
  boundary, a nested inner boundary, a block inside the inner
  boundary, and a connector line crossing the outer boundary's
  interior, verify:
  1. Clicking the line inside the outer boundary selects the line.
  2. Clicking the block inside the inner boundary selects the block.
  3. Clicking the empty interior of the inner boundary selects the
     inner boundary (not the outer).
  4. Hovering the inner boundary's resize halo while the outer
     boundary's body covers the same point shows the inner boundary's
     resize cursor.

---

## Design notes

**Layering for persistence (TB-1).** OpenChart already has an opinionated
pattern for persisting view-layer state: `DiagramViewFile` carries
top-level `layout` and `camera` fields parallel to `objects`, and a
view-layer engine (`ManualLayoutEngine`) generates them on export and
re-applies them on import over a freshly-built view tree. The model
serializer (`DiagramObjectSerializer`) is never involved in view state.

`GroupFace._user*` bounds are view-layer state of exactly this kind, so
Phase A follows the same idiom:

- **New `GroupBoundsEngine`** mirrors `ManualLayoutEngine` in shape.
  `GroupBoundsMap = { [instanceId]: [xMin, yMin, xMax, yMax] }`.
  `generateGroupBoundsMap([canvas])` walks the view tree and emits one
  entry for every `GroupView` (unconditional — see note below).
  `run([canvas])` walks the tree, looks up each `GroupView` by instance,
  and calls `face.setBounds(...)`.
- **New top-level `groupBounds?: GroupBoundsMap`** on
  `DiagramViewExport`, parallel to `layout` and `camera`. Optional for
  backward compatibility.
- **The model serializer and `GroupExport` are not touched.** Layer
  boundary preserved.
- **`GroupFace` gains** a public `get userBounds()` and
  `setBounds(xMin, yMin, xMax, yMax)`. No `userSetBounds` gate flag —
  unlike positions (where multiple layout engines can compete), group
  bounds have a single source of truth (user resize plus
  `calculateLayout`'s auto-grow), so the engine persists every group
  unconditionally. Cost is four numbers per group; the gain is zero
  flag-state to maintain across resize, clone, and restyle paths.
- **`DiagramViewFile.clone()`** (lines 93-99) already plumbs the
  position map through instance-id remapping. `groupBounds` piggybacks
  on the same remap with one added line.

**Construction-order invariant.** `GroupBoundsEngine.run` is invoked
after `super(factory, diagram)` (which builds the full `CanvasView`
tree via factory polymorphism), after `this.canvas.calculateLayout()`
(which auto-grows defaults around children), and after
`ManualLayoutEngine.run` (which applies persisted positions). Bounds
get the final word, overwriting both the auto-grown defaults and the
position-engine shifts with the exact persisted four-tuple.

**TB-2 (empty group round-trip)** falls out for free: the bounds
four-tuple encodes both position and size, so an empty group at
`(500, 500)` survives save/load via its `GroupBoundsMap` entry without
any dependency on the layout engine's child-centroid behavior.

**Restyle bug (§3.6).** `DiagramObjectViewFactory.restyleDiagramObject`
at line 401-403 constructs `new GroupFace()` on theme change, dropping
the `_user*` bounds. `GroupFace.clone()` already exists and copies the
bounds correctly. The fix is one line in the factory: replace
`new GroupFace()` with `(object.face as GroupFace).clone()`. It
belongs with the persistence work because the symptom (resize
forgotten on theme switch) is the same failure mode as the save/load
loss.

**Backward compatibility.** `groupBounds` is optional. A file saved
before Phase A parses cleanly: the import block is guarded by
`if (diagram.groupBounds)` and skipped. Groups fall back to the
existing layout-engine `moveTo` path plus `calculateLayout`'s
auto-grow behavior, matching today.

**Test scaffolding.** No existing spec constructs a `GroupView` or
`GroupFace`. Step 2 introduces a small `makeGroup(...)` fixture helper
that builds a `GroupView` via the existing `createTestingFactory()`
pattern from `OpenChart.spec.ts`. Step 3 reuses the same helper to
build nested-group trees for `findDeepestContainingGroup` tests. No
editor, plugin, or mover scaffolding is introduced in Phase A.

---

## Steps

### Step 1 — Persistence via `GroupBoundsEngine` (TB-1 + TB-2)

**Changes.**

1. `GroupFace.ts` — add public `get userBounds(): [number, number, number, number]`
   (returns the four `_user*` fields as a tuple) and
   `setBounds(xMin, yMin, xMax, yMax): void` (assigns the four fields).
   `clone()` already copies the four `_user*` fields and needs no
   change. No behavior change to `calculateLayout`/`resizeBy`/`moveBy`.
2. New `DiagramView/DiagramLayoutEngine/GroupBoundsEngine/` directory
   mirroring `ManualLayoutEngine/`'s structure: a
   `GroupBoundsMap.ts` (`{ [key: string]: [number, number, number, number] }`),
   a `GroupBoundsEngine.ts` with `generateGroupBoundsMap(objects)` static
   (traverse, emit one entry per `GroupView`) and a `run(objects)`
   method (traverse, look up by `instance`, call `face.setBounds`), and
   an `index.ts` barrel. Re-export from
   `DiagramView/DiagramLayoutEngine/index.ts`.
3. `DiagramViewExport.ts` — add optional top-level field
   `groupBounds?: GroupBoundsMap` parallel to `layout` and `camera`.
4. `DiagramViewFile.ts` — in `toExport()` (line 138), add
   `groupBounds: GroupBoundsEngine.generateGroupBoundsMap([this.canvas])`
   to the returned object. In the constructor (after the existing
   `ManualLayoutEngine` block at lines 48-50), add a symmetric
   `if (diagram && !(diagram instanceof Canvas) && diagram.groupBounds)
   { new GroupBoundsEngine(diagram.groupBounds).run([this.canvas]); }`.
   In `clone()` (lines 93-129), generate the bounds map from the source
   canvas, remap instance ids the same way `remappedLayout` does, and
   pass `groupBounds: remappedBounds` into the new `DiagramViewFile`
   constructor.
5. `DiagramObjectViewFactory.ts:401-403` — in `restyleDiagramObject` for
   `FaceType.Group`, replace `new GroupFace()` with
   `(object.face as GroupFace).clone()`.

**Acceptance criteria.**
- Round-trip test: create a `DiagramViewFile` containing (a) a resized
  trust boundary holding two blocks, (b) an empty trust boundary at a
  non-origin coordinate, (c) a nested trust boundary inside (a). Call
  `toExport()`, construct a fresh `DiagramViewFile` from the export,
  assert `userBounds` on each group matches the pre-export values
  exactly. The empty group from (b) preserves its position with no
  children.
- A file saved before this change (no `groupBounds` field) imports
  without throwing; groups fall back to default/auto-fit bounds.
- `clone()` preserves bounds: clone a file with a resized group,
  assert the cloned group's `userBounds` matches the source.
- Restyle test: create a resized group, call `applyTheme(...)`,
  assert `userBounds` is preserved.
- Existing tests in `OpenChart.spec.ts` and `DiagramModel.spec.ts`
  pass unchanged.

### Step 2 — `GroupFace` primitive unit tests (TB-13, part 1)

**Changes.** New `GroupFace.spec.ts` colocated with `GroupFace.ts`. Build
a small `makeGroupWithChildren(...)` fixture helper in the same file (or
a shared location if Step 3 needs the same thing). Test cases:

- `calculateLayout()` with no children returns default bounds.
- `calculateLayout()` grows `userBounds` when children overflow, and
  written-back bounds are stable across repeated calls.
- `resizeBy(W, +20)` shifts `xMin` forward; `resizeBy(E, -200)` clamps
  at children-floor + padding; returns the clamped delta.
- `resizeBy(NW, dx, dy)` shifts both axes.
- `getResizeEdgeAt` classifies all 8 edges + the interior.
- `moveBy(dx, dy)` shifts bounds *and* child positions.
- `clone()` copies all four bounds (regression test for the restyle
  fix from Step 1).

**Acceptance criteria.** All new tests pass under `npm run test:unit`.
Coverage touches every public method on `GroupFace`. No changes to
production code required.

### Step 3 — `findDeepestContainingGroup` unit tests (TB-13, part 2)

**Changes.** New `ViewLocators.spec.ts` colocated with
`ViewLocators.ts`. Reuse the `makeGroup(...)` fixture from Step 2.
Tests:

- Returns the deepest containing group when a point is inside multiple
  nested groups.
- Returns `null` when the point is outside every group.
- `exclude` parameter: skips the excluded group itself.
- `exclude` parameter: skips all descendants of the excluded group
  (the `isDescendantOf` walker case used by `GroupMover`'s
  self-exclusion).
- Sibling z-order: when two non-nested groups overlap and the point
  hits both, the last group in the array wins.

**Acceptance criteria.** All new tests pass under `npm run test:unit`.
The exclude test fails if the descendant walker regresses.
`findDeepestContainingGroup` is a free `export function` — no class
instantiation, no editor scaffolding, no mover construction.


---

## Definition of Done

- All three step-level acceptance criteria met.
- `npm run test:unit` green; no existing tests modified or skipped. No
  jsdom or browser-environment tests added.
- Manual smoke-test checklist (above) completed and passing — including
  the deferred TB-14 hover scenarios.
- A diagram saved, closed, and reopened preserves every trust boundary's
  size, position, nesting, and contents. A pre-Phase-A file still loads.
- Theme switch on a resized boundary preserves its size.
- No changes to `DfdValidator`, `DfdPublisher`, `SemanticAnalyzer`, or
  any UX path — Phase B's surface is untouched.
- Lint passes (do not fix the pre-existing `BlockMover.ts` lint debt
  called out in §3.6 — that's a separate commit).
