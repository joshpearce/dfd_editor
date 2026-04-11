# Trust Boundary Integration — Phase B

**Scope.** Land the *model correctness* half of
[trust-boundary-integration-plan.md](./trust-boundary-integration-plan.md)
§3.2 now that Phase A has persistence and primitive test coverage in place.
Phase B is about getting the **structural parent** of every trust-boundary
child right. No semantics, no validator work, no publisher work, no UX
polish.

**In scope:**

- **TB-4** — lines should belong to their innermost shared container
  (the lowest common ancestor of the source and target blocks' parent
  chains), not unconditionally to the canvas.
- **TB-5** — multi-block drags should reparent each block into the
  deepest containing group on release, not leave them all at their
  drag-source parent.
- **TB-7 audit** — make sure the multi-object reparent introduced by
  TB-5 doesn't allow a structural inversion when the selection contains
  both a group and one of its descendants.
- Wire the Phase A `RestoreGroupBounds` undo-anchor fix into
  `GenericMover.captureSubject` so multi-select drags that cause
  ancestor auto-grow are also reversible in one undo step.
- Unit tests for the one new pure helper introduced by TB-4
  (`findLowestCommonContainer`).

**Out of scope.** Explicitly deferred to later phases:

- **TB-6 (resize capture)** — the roadmap recommends Option A (no code
  change, accept that resize doesn't capture overlapping siblings).
  Phase B codifies that decision in text but writes no code.
- **TB-8 (`DfdValidator` boundary-crossing checks)** and **TB-9
  (`DfdPublisher` parent + crossings export)** — depend on TB-4 landing
  first but are their own workstream ("Phase C: semantic analysis").
- **TB-10, TB-11, TB-12 (UX polish)** — depth coloring, clamp cursor,
  context menu. "Phase D: UX polish."
- **TB-14 (`smartHover` integration test)** — requires editor-layer
  test scaffolding (plugin, executor, command-stream capture,
  `SubjectTrack` orchestration) that Phase A explicitly ruled out as
  its own workstream. Same rationale applies to Phase B — continue to
  defer.
- **Any mover-level unit test** (TB-13 block/group/latch mover bullets).
  Same scaffolding concern. These are validated by manual smoke as in
  Phase A.
- **Block-move-triggered line LCA recomputation.** The roadmap's TB-4
  bullet covers *latch*-rebind-time reparenting ("drag a latch from one
  anchor to another, recompute LCA"). It does **not** cover the case
  where a block is dragged into or out of a boundary and the lines
  attached to its anchors need their LCAs recomputed. This is a real
  gap — a connector whose endpoints end up in different containers
  after a block drag will be structurally misparented until the next
  latch edit — but fixing it requires changes in `BlockMover` and
  `GroupMover` that would more than double Phase B's scope. Note it
  explicitly as a follow-up. Call it **TB-4b** when it lands.

**Manual smoke-test checklist (run by hand at the end of Phase B).**
Each item is a hand-verified replacement for an automated test that
requires editor/mover scaffolding beyond Phase A's sandbox.

- **Line inside a boundary (TB-4).** Draw a connector between two blocks
  that both live inside trust boundary `B`. Save, reload. Open the
  serialized diagram and confirm the line is a structural child of `B`
  (it appears inside `B.objects` in the export), not of the canvas.
- **Line across boundaries (TB-4).** Draw a connector between a block
  inside boundary `B` and a block at the canvas root. Confirm the line
  is a structural child of the canvas (the LCA).
- **Nested line (TB-4).** Draw a connector between two blocks both
  inside inner boundary `B₁` which itself is inside `B₀`. Confirm the
  line is a child of `B₁`, not `B₀` or canvas.
- **Rebind target (TB-4).** Draw a line from block `A` in boundary `X`
  to block `B` in boundary `Y`. Confirm line parent is `LCA(X, Y)`.
  Drag the target latch off `B` and onto block `C` inside `X`. Confirm
  the line's structural parent updates to `X`.
- **Unbound target (TB-4).** Start dragging a line from an anchor but
  drop the target on empty canvas. Confirm the line is a child of
  canvas (not orphaned, not at the source block's parent).
- **Multi-block reparent on drop (TB-5).** Select three blocks that
  live at the canvas root. Drag them so their centers land inside a
  trust boundary. Drop. Confirm all three blocks are children of the
  boundary.
- **Multi-block partial (TB-5).** Select two blocks. Drag so one
  center lands inside a boundary and one center lands outside. Drop.
  Confirm each block goes to its own deepest-containing group
  (one inside, one at canvas root).
- **Mixed selection — group + descendant (TB-7 guard).** Select a
  nested group `G` *and* a block `b` that lives inside `G`. Drag the
  selection to a new location. Drop. Confirm `b`'s structural parent
  is still `G` (not whatever group `G` landed in — no inversion). The
  block rides along with its container; it is not independently
  reparented out from under it.
- **Multi-block drag inside a boundary auto-expand undo (TB-5 +
  Phase A carry-over).** Select two blocks inside a trust boundary.
  Drag them slowly so the boundary auto-expands to chase them. Drop.
  Press Ctrl+Z. Confirm both blocks return to origin **and** the
  boundary returns to its original size in one undo step — validates
  that `GenericMover` is now wired through
  `pinAncestorGroupBounds` the same way `BlockMover`/`GroupMover`/
  `LatchMover` were in Phase A.

---

## Design notes

### Why TB-4 is the keystone

Every later semantic item (§3.3 of the roadmap — validator, publisher,
threat-model export) needs to answer one question from the structural
data alone: *"what trust boundary does this data flow belong to, and
what boundaries does it cross?"*

Today, lines always live at the canvas root (`PowerEditPlugin.ts:313`
wires every new line into `canvas` unconditionally), so the structural
answer to that question is always "none, and zero crossings." The
visuals look right because latches follow anchors, but
`SemanticAnalyzer` has no structural basis for a boundary-crossing
judgment. Phase B fixes the structure so Phase C can read it.

### Where the line lives — LCA semantics

Given a line with a bound source latch on block `S` and a bound target
latch on block `T`, the line's structural parent should be the
**lowest common ancestor** of `S.parent` and `T.parent` in the view
tree. Concretely:

- **Both in the same group `G`**: line parent = `G`.
- **`S` in group `X` inside canvas, `T` in canvas**: line parent =
  canvas.
- **`S` in `X₁` inside `X₀`, `T` in `X₀`**: line parent = `X₀`.
- **`S` in `X`, `T` in `Y` (siblings, neither nested in the other)**:
  line parent = `LCA(X, Y)` = canvas (or their common outer group).

For an **unbound** target (latch dropped on empty canvas), there is
only one endpoint block, so the LCA is undefined. Rule: line parent =
`canvas`. The line stays on the canvas root and can be structurally
adopted later when the target binds.

### TB-4 touchpoints in the code

The line's structural parent is set in two places today:

1. **Creation.** `PowerEditPlugin.handleAnchor` at
   `PowerEditPlugin.ts:307-318` calls
   `addObjectToGroup(line, canvas)` the instant the user starts
   dragging from an anchor. At this moment the source is bound and
   the target is floating — LCA is undefined, but we can do better
   than canvas by seeding the line at *the source block's deepest
   containing group*. That way a connector drawn entirely inside
   boundary `B` lands in `B` even while the user is still dragging.
2. **Latch rebind.** `LatchMover.linkLatches` at
   `LatchMover.ts:117-124` emits `attachLatchToAnchor` commands but
   does not touch the line's structural parent. When the latch
   finally binds on release (or rebinds via a later drag), the
   line's parent needs to be recomputed against the new LCA and
   updated via a `removeObjectFromGroup` + `addObjectToGroup` pair.

The cleanest split: handle creation-time reparenting inside
`handleAnchor` (use source block's `findDeepestContainingGroup`, no
LCA needed yet), and handle bind/rebind-time reparenting in
`LatchMover.releaseSubject` (compute LCA now that both endpoints are
settled, reparent if the line's current parent differs). Computing the
LCA only at release avoids command-stream churn during drag.

Why not compute at `linkLatches` call time mid-drag? Because the latch
can bind and unbind many times as the user waves it around. Each
re-bind would emit a `removeObjectFromGroup`/`addObjectToGroup` pair,
bloating the stream with work the user will never see. Release-time
LCA is strictly cheaper and produces the same observable end state.

### TB-4 interaction with `RouteLinesThroughBlock`

`BlockMover.releaseSubject` at `BlockMover.ts:205-209` uses
`RouteLinesThroughBlock` to split a line across a block the user
dropped onto it. That command constructs a `clone()` of the line and
calls `AddObjectToGroup(clone, group)` where `group` is passed in from
the call site (`BlockMover.ts:206` passes `canvas`). After TB-4 lands,
this call site needs to pass the **LCA of the cloned line's new
endpoints**, not `canvas`, or the cloned halves will inherit the
canvas as parent while the original half inherits the LCA — producing
the same structural inconsistency TB-4 is meant to fix.

The fix: in `BlockMover.releaseSubject`, compute the clone's target
parent the same way the rewritten `LatchMover.releaseSubject` does —
via `findLowestCommonContainer(cloneSource.block, cloneTarget.block)`
— and pass it to `routeLinesThroughBlock`. Audit `RouteLinesThroughBlock`'s
internals to confirm it doesn't hardcode any `canvas` reference that
would defeat this.

### TB-5 — where multi-block reparent lives

`PowerEditPlugin.handleBlock` at `PowerEditPlugin.ts:332-348` routes
single-block drags to `BlockMover` and anything else (multi-block,
mixed selections including lines, handles, groups) to `GenericMover`.
`GenericMover` today is pure movement: it emits one `MoveObjectsBy`
for the whole selection and calls it done, with empty
`captureSubject()` and `releaseSubject()` bodies
(`GenericMover.ts:47, 81`).

The fix is to extend both hooks:

- **`captureSubject`** calls
  `pinAncestorGroupBounds(commonAncestor)` where the ancestor walk
  starts from the highest object in the selection. Simpler rule: walk
  from each object's parent and dedupe — the helper is idempotent if
  we pass a `Set<GroupView>` instead of a chain. Even simpler:
  snapshot the ancestor chain of *every* object in the selection
  individually. Duplicates are harmless (same group snapshotted twice
  just means `setBounds` is called twice with the same value on undo).
  Takes the simplest implementation that works.
- **`releaseSubject`** walks the selection; for each object whose
  `parent !== findDeepestContainingGroup(canvas, obj.x, obj.y)`, emits
  `removeObjectFromGroup([obj])` + `addObjectToGroup(obj, target)`.
  Same pattern as `BlockMover.releaseSubject` lines 212-216.

**TB-7 guard (critical to get right).** The selection can contain a
group `G` and a descendant of `G` at the same time. If we naively
reparent each object by deepest-container lookup:

1. `G` gets reparented to some new container (fine — `G` and its
   descendants all move together structurally because they are
   children of `G`).
2. Descendant `b` gets independently reparented to
   `findDeepestContainingGroup(canvas, b.x, b.y)` — which is whatever
   deepest group contains `b`'s *new* position. If that's not `G`
   (e.g., `b`'s center ended up outside `G` after the drag), `b` gets
   torn out of `G` and reparented elsewhere. Structural inversion.

**Guard rule:** an object in the selection is only reparented if no
other object in the selection is its ancestor. Concretely, skip any
object `b` for which `∃ obj ∈ selection : b.parent chain contains obj`.
When `G` and its descendant `b` are both selected, `b`'s parent chain
contains `G`, so `b` is skipped — `b` rides along with `G` via the
existing structural-parent relationship. No explicit reparent, no
inversion.

This is the TB-7 audit from the roadmap's §3.2, folded into TB-5's
implementation. Cheap to write; catastrophic if missed.

### TB-6 decision — no code change

The roadmap asks whether resize should capture siblings whose centers
end up inside the resized bounds. The recommended answer is **no**
(Option A): resize adjusts the rectangle only; capture is a separate
user gesture (drag the target into the boundary). Phase B codifies
this decision here and ships no code for it. A future phase that wants
capture-on-resize can revisit.

### New helper: `findLowestCommonContainer`

A free `export function` in
`src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/ViewLocators.ts`,
next to `findDeepestContainingGroup`:

```ts
/**
 * Returns the lowest (deepest) common container of two views — the
 * innermost `CanvasView | GroupView` that contains both in its
 * subtree via the parent chain. Returns `null` if the two views are
 * in disjoint trees (shouldn't happen in a well-formed diagram).
 *
 * For two views whose common ancestor is the canvas, returns the
 * `CanvasView`.
 */
export function findLowestCommonContainer(
    a: DiagramObjectView,
    b: DiagramObjectView
): CanvasView | GroupView | null;
```

Implementation: collect `a`'s parent chain into a `Set`, then walk
`b`'s parent chain looking for the first element already in the set.
O(depth) memory and time, trivially testable.

Why a new helper vs inlining: TB-4 needs it at two call sites (line
creation and latch rebind) and `BlockMover`'s `RouteLinesThroughBlock`
call site needs it too. Three call sites warrants a shared
implementation; inlining a parent-chain walk three times is the kind
of drift that costs later. The helper pattern also matches
`findDeepestContainingGroup` (Phase A Step 3), reusing the same test
scaffolding.

### Construction order invariant for TB-5

Same rule Phase A established for `pinAncestorGroupBounds`: the
`RestoreGroupBounds` command must be **first** in the drag stream so
its undo runs **last** on reverse playback. `GenericMover.captureSubject`
must call the helper before any other command is emitted in the
mover's lifecycle. This is already documented on the helper itself
(`ObjectMover.ts:pinAncestorGroupBounds` doc comment) — just follow
the pattern.

---

## Steps

### Step 1 — `findLowestCommonContainer` helper + unit tests

**Changes.**

1. `DiagramView/DiagramObjectView/ViewLocators.ts` — add
   `findLowestCommonContainer(a, b)` as described above, next to
   `findDeepestContainingGroup`. Export it via the
   `@OpenChart/DiagramView` barrel (the same one
   `findDeepestContainingGroup` travels through).
2. `DiagramView/DiagramObjectView/ViewLocators.spec.ts` — add a new
   `describe("findLowestCommonContainer", ...)` block alongside the
   existing Phase A Step 3 tests. Reuse the `GroupFace.testing.ts`
   fixture (`makeEmptyCanvas`, `makeGroupWithChildren`, etc.) — no new
   scaffolding.

**Test cases.**

- **Both in same group.** Two blocks in `G`. Returns `G`.
- **Same block twice.** Returns the block's parent (or the block
  itself, depending on the convention — pick one and pin it). Most
  useful: parent, so the function doesn't return a non-container.
- **One in group, one in canvas.** Returns canvas.
- **Nested: one in `G₁ ⊂ G₀`, one in `G₀`.** Returns `G₀`.
- **Nested: both in `G₁ ⊂ G₀`.** Returns `G₁` (deepest, not `G₀`).
- **Siblings: one in `G₁`, one in `G₂`, both inside `G₀`.** Returns
  `G₀`.
- **Disjoint (both in `G₀`, both in `G₁`, where `G₀` and `G₁` share
  only canvas).** Returns canvas.
- **Fully disjoint (should not happen in real diagrams but test the
  fallback):** two views from different canvases, or a view whose
  parent chain never hits a shared ancestor. Returns `null`.
- **Exact-boundary sanity (mirrors Phase A Step 3's style).** Not
  strictly needed since containment isn't tested here — this function
  is purely structural.

**Acceptance criteria.**

- All new tests pass under `npm run test:unit`.
- Helper is a free `export function`, no class instantiation, no
  mover or editor scaffolding.
- Total test count increases by the number of new `it(...)` blocks;
  no existing tests are modified or skipped.
- Mutation check (scratch-verify in the task): replacing the
  implementation with `return null` causes at least one test to fail.
  Include the failing-output evidence in the step's completion
  report the same way the Phase A Step 3 I1 fix did.

### Step 2 — Line reparenting on creation and latch bind (TB-4)

**Changes.**

1. `PowerEditPlugin.ts:307-318` — in `handleAnchor`'s line-creation
   branch, replace:
   ```ts
   execute(addObjectToGroup(line, canvas));
   ```
   with:
   ```ts
   const sourceContainer =
       findDeepestContainingGroup(canvas, anchor.x, anchor.y) ?? canvas;
   execute(addObjectToGroup(line, sourceContainer));
   ```
   This seeds a freshly-created line into the deepest group that
   contains the source anchor, so a connector drawn entirely inside
   boundary `B` lives in `B` from birth. The target is still floating
   at this point — final LCA is computed at release.
2. `LatchMover.ts` — extend `releaseSubject` to reparent the line
   to `findLowestCommonContainer(source.block, target.block)` when
   both latches are bound. Specifically: look up the line via the
   leader latch's parent (`leader.parent` is the line view; walk up
   via the line's known owner — read the existing code for the exact
   accessor pattern), fetch the source and target blocks via the
   attached anchors, compute the LCA, and if `line.parent !== lca`,
   emit `removeObjectFromGroup([line])` +
   `addObjectToGroup(line, lca)`.

   For an **unbound target** (latch dropped on empty canvas, target
   anchor is `null`), fall back to `canvas` per the design note. If
   the unbound state happens with `line.parent === canvas` already,
   skip the emit — don't clutter the stream with a no-op reparent.
3. `BlockMover.ts:205-209` — audit `RouteLinesThroughBlock` call
   site. Today it passes `canvas` as the container for the cloned
   line. Replace with `findLowestCommonContainer(newSource,
   newTarget)` where those are the two blocks the cloned line now
   spans. Verify `RouteLinesThroughBlock`'s internal
   `AddObjectToGroup(clone, group)` uses that parameter faithfully
   (read `RouteLinesThroughBlock.ts`).

**Files affected.**

- `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.ts`
- `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/LatchMover.ts`
- `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/BlockMover.ts`
- `src/assets/scripts/OpenChart/DiagramEditor/Commands/View/RouteLinesThroughBlock.ts`
  (audit only; change likely not needed if it already threads `group`
  through from the caller)

**Acceptance criteria.**

- Every smoke-test item in the "Line inside a boundary / across
  boundaries / nested / rebind target / unbound target" bullet list
  from the top of this doc passes by hand.
- `npm run test:unit` still green. `findLowestCommonContainer` tests
  from Step 1 continue to pass.
- Existing Phase A tests (`OpenChart.spec.ts`, `GroupFace.spec.ts`,
  `ViewLocators.spec.ts`, `RestoreGroupBounds.spec.ts`) pass
  unchanged.
- `npm run lint` — no new errors (Phase A's pre-existing
  `BlockMover.ts` debt remains out of scope per that plan's Definition
  of Done).
- `npm run type-check` — no new errors. `LatchMover.ts:170` is still
  the pre-existing type error Phase A called out; Phase B doesn't
  touch that line, so the error count is unchanged.

**Risks.**

- **`RouteLinesThroughBlock` assumed canvas-level lines.** Audit
  `RouteLinesThroughBlock.ts` before changing its caller; if it
  references `canvas` internally (e.g., for anchor lookup), the
  change may need to thread the new container through multiple call
  depths.
- **Latch rebind timing.** Binding happens on every mouse tick via
  `linkLatches` (`LatchMover.ts:91`), but reparenting should only
  happen on release. Make sure the reparent code path runs exactly
  once per drag — at release — and reads the final bound state, not
  an intermediate one.
- **Block-move-triggered LCA drift (out of scope, TB-4b).** After
  TB-4 lands, the LCA is correct at line-creation and at latch-bind.
  If the user then drags a block into or out of a boundary, the
  line's LCA becomes stale. Phase B does not fix this. Flag it as a
  known defect to address in a follow-up (TB-4b) and note it in the
  smoke-test instructions so the tester doesn't mistake it for a
  regression.

### Step 3 — Multi-object reparent in `GenericMover` (TB-5 + TB-7 guard + pin bounds)

**Changes.**

1. `GenericMover.ts:captureSubject` — replace the empty body with a
   call to `pinAncestorGroupBounds` for each object in the selection.
   Straight-line implementation:
   ```ts
   public captureSubject(): void {
       for (const obj of this.objects) {
           this.pinAncestorGroupBounds(obj.parent);
       }
   }
   ```
   This emits one `RestoreGroupBounds` command per object with
   possibly-overlapping snapshots. Duplicates are harmless (setBounds
   is idempotent). A future optimization could dedupe by group, but
   don't premature-optimize — the correct-and-simple version is what
   Phase B ships.

   **Wait, re-think:** Phase A's helper emits one
   `RestoreGroupBounds` per call. Emitting N of them stacks up N
   commands at the front of the stream. They all run first on
   execute (no-ops) and last on undo (setBounds cascade). Correct
   but noisy. A cleaner alternative: add an overload
   `pinAncestorGroupBounds(startFroms: Array<DiagramObjectView | null>)`
   on `ObjectMover` that collects snapshots from all starting points
   into one `RestoreGroupBounds` command. Decide during
   implementation based on how much the duplication bothers you; the
   overload is small and keeps the undo stack tidy. The Phase B step
   should ship one of these two; both are correct.

2. `GenericMover.ts:releaseSubject` — replace the empty body with the
   multi-object reparent loop:
   ```ts
   public releaseSubject(): void {
       const { addObjectToGroup, removeObjectFromGroup } = EditorCommands;
       const editor = this.plugin.editor;
       const canvas = editor.file.canvas;

       // TB-7 guard: build the set of objects whose ancestors also
       // appear in the selection. Those should not be independently
       // reparented — they ride along with their selected ancestor.
       const selectionSet = new Set<DiagramObjectView>(this.objects);
       const isDescendantOfSelection = (o: DiagramObjectView): boolean => {
           let p = o.parent;
           while (p) {
               if (selectionSet.has(p)) return true;
               p = p.parent;
           }
           return false;
       };

       for (const obj of this.objects) {
           if (isDescendantOfSelection(obj)) {
               continue;
           }
           // Blocks and groups get per-object reparent. Lines, latches,
           // handles, anchors do not — lines follow their LCA via TB-4,
           // latches/handles/anchors are children of lines, not of
           // groups directly.
           if (!(obj instanceof BlockView) && !(obj instanceof GroupView)) {
               continue;
           }
           const target = findDeepestContainingGroup(
               canvas, obj.x, obj.y,
               obj instanceof GroupView ? obj : undefined
           ) ?? canvas;
           if (obj.parent !== target) {
               this.execute(removeObjectFromGroup([obj]));
               this.execute(addObjectToGroup(obj, target));
           }
       }
   }
   ```
   Key details:
   - **TB-7 guard** via `isDescendantOfSelection`: skips any object
     that has a selected ancestor. Prevents the inversion described
     in the design notes.
   - **Type filter**: only `BlockView` and `GroupView` are
     reparent candidates. Lines go through TB-4 (LCA). Latches,
     handles, anchors are children of lines/blocks and have their
     structural parent set by their owner — not by drag.
   - **Self-exclusion on groups**: when the subject is a `GroupView`,
     pass it as `exclude` to `findDeepestContainingGroup` so the
     group can't become its own descendant. Same pattern as
     `GroupMover.releaseSubject` (`GroupMover.ts:139`).
   - **Fallback**: null target → canvas root.
3. **Audit `PowerEditPlugin.handleLine` and `handleHandle`** — both
   route to `GenericMover` today. Verify that after TB-5, pure-line
   drags (a line being selected and dragged alone) don't trigger
   unwanted reparenting. The type filter above handles this: lines
   are not `BlockView | GroupView`, so they're skipped. Single-handle
   drags similarly. Confirmed by reading the filter.

**Files affected.**

- `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/GenericMover.ts`
- Possibly `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/ObjectMover.ts`
  (if the overload of `pinAncestorGroupBounds` for multiple
  start-points is chosen).

**Acceptance criteria.**

- Every smoke-test item in the "Multi-block reparent on drop",
  "Multi-block partial", "Mixed selection — group + descendant",
  and "Multi-block drag inside a boundary auto-expand undo" bullets
  passes by hand.
- `npm run test:unit` still green. No new spec file is required
  because the logic lives entirely inside `GenericMover`, which
  needs editor-layer scaffolding to test — explicitly deferred per
  the Phase A pattern.
- `npm run lint` and `npm run type-check` — no new errors beyond the
  pre-existing Phase A debt.

**Risks.**

- **Order-of-operations within the selection.** If the selection
  contains 5 blocks and we reparent them one-by-one, each emitted
  command pair mutates the tree that the next iteration reads. Make
  sure the iteration uses a snapshotted `for (const obj of
  [...this.objects])` — or confirm `this.objects` is already stable
  across iterations. Read `GenericMover.ts` to verify how
  `this.objects` is populated.
- **Emission order of `RestoreGroupBounds` with multi-anchor
  captures.** If the overload path is taken, make sure the collected
  snapshots are unioned (one command, many snapshots) rather than
  appended in a way that could allow a later emission to merge or
  reorder them.

---

## Definition of Done

- All three step-level acceptance criteria met.
- `npm run test:unit` green; no existing tests modified or skipped.
  No jsdom or browser-environment tests added.
- Manual smoke-test checklist (above) completed and passing.
- A line drawn between two blocks inside the same trust boundary is
  a structural child of that boundary (visible in the `groupBounds`
  section of the export? no — visible in the `objects` structure:
  `boundary.objects` contains the line's instance id).
- A multi-block selection dragged into a trust boundary reparents
  each block individually to the deepest containing group, and the
  TB-7 inversion case is blocked.
- A multi-select drag that auto-expands a boundary is reversible in
  one undo step — same property Phase A's `RestoreGroupBounds` work
  established for `BlockMover`/`GroupMover`/`LatchMover`, now
  extended to `GenericMover`.
- `DfdValidator`, `DfdPublisher`, `SemanticAnalyzer`, and every
  Phase C / Phase D surface remain untouched.
- Lint passes (do not fix the pre-existing `BlockMover.ts` lint debt
  carried from Phase A — still a separate commit).
- Type-check passes with only the four pre-existing errors Phase A
  documented (`DarkTheme`, `LightTheme`, `LatchMover:170`, node22
  vendor). Phase B touches `LatchMover.ts` but must not touch line
  170 or its surrounding method.

---

## What comes after Phase B

Rough outline of subsequent phases. Not committed to, but sketched so
the model-correctness → semantics → polish progression is clear:

- **Phase C: Semantic analysis.** TB-8 (validator boundary-crossing
  checks) and TB-9 (publisher parent + crossings export, or full OTM
  output). Depends on Phase B's structural correctness. Probably the
  biggest remaining chunk of work by LOC.
- **Phase D: Editor-layer test scaffolding + TB-14.** Build the
  plugin/executor/`SubjectTrack` stubs that Phase A and Phase B both
  deferred, then land the `smartHover` integration test and catch up
  on mover-level unit tests (TB-13's block/group/latch-mover bullets).
  This unblocks automated coverage of everything the smoke checklist
  currently catches by hand.
- **Phase E: UX polish.** TB-10 (depth coloring), TB-11 (clamp
  cursor), TB-12 (context menu reparent). Polish that's only worth
  doing once the structural and semantic layers are stable.
- **Phase F or opportunistic cleanup:** TB-4b (block-move-triggered
  line LCA recomputation), TB-6 re-evaluation (if anyone ever wants
  capture-on-resize), the pre-existing `BlockMover.ts` lint debt,
  and the `CanvasView.groups` typing cleanup called out in §3.6 of
  the roadmap.
