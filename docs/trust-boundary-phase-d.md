# Trust Boundary Integration — Phase D

**Scope.** Build the *editor-layer test scaffolding* that Phases A, B, and
C all deferred, then use it to land the automated coverage for
interaction-layer behavior that has only been validated by hand so far
([trust-boundary-integration-plan.md](./trust-boundary-integration-plan.md)
§3.5). Phase D does **not** change runtime behavior. Every test added
must pass against the code as it stands at the end of Phase C, with no
production edits beyond those explicitly called out in a step's risk
section (e.g. narrowing a visibility modifier to make a method
testable).

**In scope:**

- **Editor-layer testing fixtures** (`PowerEditPlugin.testing.ts`) —
  helpers to stand up a `DiagramViewEditor` + `PowerEditPlugin` pair
  against an in-memory canvas, a no-op `CommandExecutor`, and a
  `subclass-to-expose` pattern that exposes `protected smartHover` and
  private mover dispatch for assertions. Also: a `driveDrag` helper that
  fakes a `captureSubject → moveSubject(track) → releaseSubject` cycle
  using a real `SubjectTrack`, so mover specs can assert reparent and
  undo behavior without a browser event loop.
- **TB-14** — `PowerEditPlugin.smartHover.spec.ts`. Verifies the
  five-pass priority order documented on `smartHover` against nested
  trust-boundary scenarios.
- **TB-13 mover-level specs** — the bullets the plan explicitly calls
  out as still missing:
  - `BlockMover.spec.ts` — drop-into-nested-deepest, drag-out-of-all,
    during-drag eject chain (one level at a time).
  - `GroupMover.spec.ts` — drop-into-boundary, self-exclusion
    (a group dropped into its own descendant area falls through to
    canvas).
  - `LatchMover.spec.ts` (or an `OpenChart.spec.ts` extension) —
    `getBlocksAndAnchorsAt` recurses into nested groups so anchors on
    deeply nested blocks are discoverable during a connector drag.
- **`GenericMover` multi-object spec** — multi-block reparent on
  release (TB-5 behavior), plus the TB-7 guard that prevents processing
  a descendant before its ancestor in the same selection.

**Out of scope.** Explicitly deferred:

- **TB-4b** (block-move-triggered line LCA recomputation) — still
  deferred. Phase D does not write a test that would require this
  behavior.
- **TB-10, TB-11, TB-12** (UX polish) — Phase E.
- **`GroupResizeMover.spec.ts`** — covered by the acceptance criteria
  of `RestoreGroupBounds.spec.ts` and `GroupFace.spec.ts` already; an
  additional mover spec is not worth the scaffold cost at this phase.
  Revisit if TB-6 (resize-captures-siblings) ever lands.
- **End-to-end browser tests** — Phase D does not add Playwright-driven
  checks. The manual smoke checklists from Phases A, B, and C continue
  to serve that role until a dedicated E2E phase is scoped.
- **New validator or publisher behavior.** Phase C locked those down.
  Phase D does not modify `SemanticAnalyzer`, `DfdValidator`,
  `DfdPublisher`, or the semantic graph types.

**Manual smoke-test checklist.** Phase D adds no new runtime behavior,
so the existing Phase A/B/C smoke-test checklists remain the source of
truth for manual verification. The only "did this phase work?" check is
that `npm run test:unit` reports the new specs as passing and the test
count grows by the expected number of cases (see Step-level acceptance
criteria).

---

## Design notes

### The scaffolding problem

Phases A–C shipped four new mover classes, a rewritten `smartHover`, and
a cross-cutting `findDeepestContainingGroup` walker — none of which
have unit tests, because instantiating a `PowerEditPlugin` against a
real editor requires a non-trivial amount of wiring:

- A `DiagramViewEditor` bound to a `DiagramViewFile` with a real
  `CanvasView` tree.
- A `DiagramObjectViewFactory` configured against a real theme + schema.
- A `CommandExecutor` that routes `SynchronousEditorCommand`s into the
  editor's undo stack.
- A `PowerEditPluginSettings` object (even if every value is a default).
- A way to call `protected smartHover` and `private` dispatch entry
  points without violating encapsulation in the unit under test.

The Phase A `GroupFace.testing.ts` fixture already solves the
factory/theme/schema half (it boots a `DarkStyle`-backed factory with a
minimal schema extended to include `generic_group`). Phase D adds the
editor/plugin/executor half, reusing that factory so tests share one
theme-load path.

### Test-only subclass pattern for `smartHover`

`PowerEditPlugin.smartHover` is `protected`, and the plan is to keep it
that way — external callers shouldn't bypass the event dispatch. The
spec exposes it via a narrow test-only subclass:

```ts
class TestablePowerEditPlugin extends PowerEditPlugin {
    public hoverAt(x: number, y: number): DiagramObjectView | undefined {
        // smartHover expects a MouseEvent; pass a minimal stub.
        return this.smartHover(x, y, {} as MouseEvent);
    }
}
```

This keeps the production signature protected while letting the spec
exercise the 5-pass priority against constructed scenarios. The
`MouseEvent` parameter is typed in the signature but currently unused
(`_event`), so a cast-to-`MouseEvent` stub is sufficient.

### `driveDrag` — synthesising a drag cycle

Mover specs need to assert what the model looks like after a
`captureSubject → moveSubject(track) → releaseSubject` cycle. Doing this
by hand in every spec would duplicate boilerplate. `driveDrag(mover,
path)` takes a mover and a list of `[x, y]` cursor points, calls
`captureSubject()` once, then for each point constructs a `SubjectTrack`
with `applyCursorDelta` to the delta from the previous point and calls
`moveSubject(track)`, and finally calls `releaseSubject()`. After
return, the caller inspects the resulting canvas structure.

`SubjectTrack` is a concrete class (`ObjectTrack.ts:4`) with a small
surface. The helper is a ~25-line utility, not a framework.

### Command stream bookkeeping in tests

Real drags open a command stream via
`DiagramModelEditor.beginCommandStream` before the first mover command
fires and close it with `endCommandStream` on release. The scaffolding
must open/close the stream around `driveDrag` so mover-emitted commands
land somewhere. Two options:

- **Option A — wrap `driveDrag` in a stream.** Caller always gets a
  committed stream. Undo history grows by 1 per `driveDrag` invocation.
- **Option B — expose `captureSubject / releaseSubject` directly.**
  Caller manages the stream. More verbose, but matches production
  exactly.

Choose Option A. Simpler spec code; undo history behavior is exactly
what production does.

### Why no editor-layer integration test for resize

`GroupResizeMover` is exercised transitively by `GroupFace.spec.ts`
(resize math) and `RestoreGroupBounds.spec.ts` (undo pin bounds). The
only untested seam is "does a resize drag open a stream correctly?" and
that's covered by the editor's drag contract, not resize specifics. A
standalone `GroupResizeMover.spec.ts` would be pure redundancy at the
cost of more scaffolding. Defer until TB-6 (resize-captures-siblings)
forces new logic.

### `LatchMover.getBlocksAndAnchorsAt` is the right test target

`LatchMover.spec.ts` should exercise the recursion fix from §2.3 (Phase
3 uncommitted) documented in the roadmap: "Rewrote the walker to test
direct blocks first and then *recurse into nested groups*." The
spec does not need to simulate a full latch drag — it just needs to
construct a canvas with a block nested two or three groups deep and
assert that `getBlocksAndAnchorsAt(x, y)` at the nested block's
coordinates returns the expected `(block, anchor)` pair. The method may
need a visibility relaxation (`private → protected` or `public` for
testing), noted as a risk in Step 4.

---

## Steps

### Step 1 — Editor-layer testing scaffold

**Changes.**

1. New file `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.testing.ts`.
   Test-only; not exported from any production barrel. Provides:

   - `createTestableEditor(canvas: CanvasView): { editor, plugin, executor }` —
     constructs a `DiagramViewEditor` around a `DiagramViewFile` containing
     the given canvas, a no-op `CommandExecutor` that still applies the
     command via `editor.execute` so undo/redo is real, and a
     `TestablePowerEditPlugin` (see below) wired through the plugin
     registration path.
   - `TestablePowerEditPlugin extends PowerEditPlugin` — exposes
     `hoverAt(x, y)` wrapping `smartHover`, and a narrow
     `dispatchHandle(obj, x, y)` that routes to the same internal mover
     selector the production pointer-down path uses (read: `handleBlock`,
     `handleGroup`, `handleAnchor`, or `handleLine` depending on the
     concrete type of `obj`). Keeps production `smartHover` /
     dispatch methods at their current visibility.
   - `driveDrag(mover: ObjectMover, path: [number, number][])` — runs
     `captureSubject → moveSubject(track)* → releaseSubject` across the
     given cursor path, wrapping it in an editor command stream.
   - `buildCanvas(spec)` — a small declarative builder that produces a
     `CanvasView` matching `spec`, reusing the `createGroupTestingFactory`
     from `GroupFace.testing.ts`. Accepts nested group and block
     descriptors so tests can write:
     ```ts
     buildCanvas({
         groups: [
             { id: "B0", bounds: [0, 0, 500, 500], children: [
                 { id: "B1", bounds: [50, 50, 450, 450], children: [
                     { block: "A", x: 200, y: 200 },
                 ]},
                 { block: "C", x: 480, y: 480 },
             ]},
         ],
         blocks: [{ block: "B", x: 600, y: 600 }],
     });
     ```
   - `spyCommandExecutor()` — returns an executor that records every
     emitted command so specs can assert the command sequence
     (`removeObjectFromGroup`, `addObjectToGroup`, etc.) without
     reaching into the editor's undo stack.

2. Re-export test helpers through a local testing barrel adjacent to
   the file (`PowerEditPlugin.testing.ts` is self-contained; no new
   index.ts entry).

**Files affected.**

- `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.testing.ts` (NEW)
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing.ts` — may gain `makeGroupWithBoundsAndChildren` helper if the existing `makeGroupWithChildren` doesn't accept user bounds. (Confirm by reading the file before editing.)

**Test cases.** No assertions yet — the scaffold is exercised by
Steps 2–5. Add a *single* smoke spec
`PowerEditPlugin.testing.spec.ts` that:

- Builds a canvas with one block at `(0, 0)`.
- Calls `hoverAt(0, 0)` and expects the block back.
- Constructs a `BlockMover` and runs `driveDrag` across
  `[(0, 0), (10, 0)]`. Expects the block's position to end at `(10, 0)`
  and the editor's undo stack to have grown by 1.

This smoke spec is the proof that the scaffold works end-to-end before
specs depend on it.

**Acceptance criteria.**

- `PowerEditPlugin.testing.ts` exists and is not imported from any
  production file (grep for its path in non-`.spec.ts` / non-`.testing.ts`
  files; zero hits).
- Smoke spec passes.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **Plugin registration path may require an event dispatcher.**
  `DiagramInterfacePlugin` is the base. Check whether constructing a
  `PowerEditPlugin` requires a live canvas interface (e.g. a registered
  pointer-event source). If yes, the scaffold provides a minimal stub;
  if no, just `new TestablePowerEditPlugin(editor, settings)` suffices.
  Read `DiagramInterfacePlugin.ts` before implementing.
- **`CommandExecutor` side-effects.** `CommandExecutor` is a function
  `(cmd) => void` that in production routes the command into the
  active stream. The test helper must route to
  `editor.execute`/equivalent so `Remove/AddObjectToGroup` actually
  mutates the model. Verify by reading `PowerEditPlugin.ts`'s
  constructor to see how the executor is set up there.
- **`DiagramViewFile` constructor.** The scaffold must hand the plugin
  a real file, not just a canvas. If `DiagramViewFile` needs more than a
  canvas (e.g. metadata, an autosave bucket), wrap in minimal defaults.

### Step 2 — TB-14: `smartHover` priority integration test

**Changes.**

1. New file `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.smartHover.spec.ts`.

**Test cases.** Each test constructs a canvas via `buildCanvas`,
instantiates a `TestablePowerEditPlugin` via `createTestableEditor`, and
calls `hoverAt(x, y)`. All scenarios are drawn from the 5-pass
documentation on `smartHover` itself.

- **Pass 1 beats everything.** A canvas-level block at `(100, 100)`
  plus a canvas-level group whose bounds enclose `(100, 100)`. Hover
  `(100, 100)` → returns the block.
- **Pass 2 — halo wins over body.** A group at `(0, 0, 400, 400)`.
  Hover at `(−5, 200)` (just outside the west edge, inside the west
  halo). Returns the group with `hoveredEdge === ResizeEdge.W`.
- **Pass 2 — innermost halo wins.** Outer group `(0, 0, 400, 400)`,
  inner group `(100, 100, 300, 300)`. Hover at `(95, 200)` (outside
  inner's west edge, still inside outer's body). Returns the inner
  group with `hoveredEdge === ResizeEdge.W`.
- **Pass 3 — content inside group.** Group `(0, 0, 400, 400)` with a
  child block at `(200, 200)`. Hover at `(200, 200)` → returns the
  block, not the group.
- **Pass 3 — nested-nested block.** Boundary `B0` `(0, 0, 500, 500)`
  contains boundary `B1` `(50, 50, 450, 450)` containing block `A` at
  `(200, 200)`. Hover at `(200, 200)` → returns `A`.
- **Pass 4 — canvas line inside a boundary.** A `trust_boundary` at
  `(0, 0, 400, 400)` plus a canvas-level line visually crossing the
  interior (e.g. endpoints at `(10, 10)` and `(390, 390)`). Hover on
  the line's midpoint → returns the line, not the group body.
- **Pass 5 — empty interior falls through to group body.** A boundary
  at `(0, 0, 400, 400)` with no children. Hover at `(200, 200)` →
  returns the group.
- **Halo state is cleared each call.** Hover in inner group's halo
  (sets `hoveredEdge`). Then hover at `(200, 200)` on a child block
  (Pass 3 hit). Assert the inner group's `hoveredEdge` is now
  `ResizeEdge.None` — the smartHover `for (g of allGroups) g.hoveredEdge
  = ResizeEdge.None` line runs first.

**Acceptance criteria.**

- 8 new test cases pass.
- `npm run test:unit` green overall; no existing tests modified.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **Hit-testing relies on real `face.boundingBox` values.** The
  scaffold's `buildCanvas` must set user bounds on groups so
  `getObjectAt` reports the right values. The `bounds` field in the
  spec flows through `GroupView.setBounds` (added in Phase A TB-1).
  Verify by asserting `group.face.userBounds` matches input in the
  smoke spec.
- **Line hit-testing requires non-degenerate geometry.** A line with
  source and target at canvas coordinates needs the `LineView`'s handle
  positions computed. Use the factory's line-creation path (not a raw
  model-layer line) so handles are initialized.

### Step 3 — TB-13: `BlockMover.spec.ts`

**Changes.**

1. New file `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/BlockMover.spec.ts`.

**Test cases.**

- **Drop into deepest nested boundary.** Canvas with B0 `(0, 0, 500,
  500)` containing B1 `(50, 50, 450, 450)`. A canvas-level block at
  `(600, 600)`. `driveDrag` from `(600, 600)` to `(200, 200)`. After
  release, the block's structural parent is **B1** (not B0, not
  canvas).
- **Drag out of all containers.** Block inside B1 which is inside B0.
  `driveDrag` from the block's center to `(900, 900)` (outside all
  groups). After release, `block.parent === canvas`.
- **During-drag eject chain: one level at a time.** Block inside B1
  which is inside B0. `driveDrag` path has three intermediate points:
  inside B1, inside B0 but outside B1, outside B0 entirely. Assert the
  block reparents B1 → B0 → canvas in order across the three
  `moveSubject` calls, not B1 → canvas in one jump.
- **Release-side reparent uses `findDeepestContainingGroup`.** Canvas
  with sibling groups `G1` and `G2` overlapping at `(200, 200)` (G2
  added last, so it wins by z-order). `driveDrag` ends at `(200, 200)`.
  Block's parent is **G2** (last-added sibling wins).
- **Commands emitted.** Use `spyCommandExecutor()` from Step 1.
  `driveDrag` a block from canvas into a group. Assert the command
  sequence contains exactly one `removeObjectFromGroup` (from canvas)
  and one `addObjectToGroup` (to group), in that order, inside a
  single stream.
- **Undo collapses to one step.** Same scenario as above. After
  `driveDrag`, `editor.undo()` restores the block to canvas in a
  single call — the bundled `GroupCommand` is one undo unit.

**Acceptance criteria.**

- All 6 cases pass.
- `BlockMover.ts` itself is not modified.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **`BlockMover.ts` has pre-existing lint debt** (§3.6 of the plan:
  "6 pre-existing eslint errors"). Do not touch them in this spec's
  PR. A spec file is orthogonal and shouldn't reopen that debate.
- **Reparent coordinates are block-*center*, not cursor.** The during-
  drag eject fires when the block's snapshot bbox center leaves its
  current parent's bbox. Construct test blocks with small, known sizes
  so the center's movement is easy to reason about (e.g. 40×40 at the
  drag path's endpoints).
- **Canvas coordinate system.** `BlockMover` reads `subject.center` in
  canvas coordinates. If `buildCanvas` places blocks via `view.setX/Y`
  the numbers match; if it places via group-local coords, they don't.
  Confirm by logging `block.center` in the smoke spec before depending
  on exact coordinates.

### Step 4 — TB-13: `GroupMover.spec.ts`

**Changes.**

1. New file `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/GroupMover.spec.ts`.

**Test cases.**

- **Drop into another boundary.** Canvas with a top-level group `G1`
  `(0, 0, 200, 200)` and another top-level group `G2` `(400, 400, 800,
  800)`. `driveDrag` G1 to end at `(600, 600)`. After release,
  `G1.parent === G2`.
- **Self-exclusion.** A group `G` with a nested child group `G'`.
  `driveDrag` G to end at a coordinate inside `G'`'s bbox.
  `findDeepestContainingGroup(exclude=G)` returns `null` (G' is
  excluded as a descendant of G), so the block falls through to
  canvas: `G.parent === canvas` (unchanged — technically still at
  canvas; assert no reparent command emitted).
- **Drop into nested target.** Canvas with B0 at `(0, 0, 500, 500)`
  containing B1 at `(100, 100, 400, 400)`. A top-level group `G` at
  `(600, 600, 700, 700)`. `driveDrag` G to end at `(200, 200)`.
  After release, `G.parent === B1` (deepest non-self, non-descendant
  target).
- **Descendants come along.** Group `G` with child block `A`.
  `driveDrag` G into target group `T`. After release,
  `G.parent === T` *and* `A.parent === G` still (A is structurally
  inside G, not reparented independently).
- **Command stream is one undo step.** Same as Block case — undo
  restores `G.parent` in a single call.

**Acceptance criteria.**

- All 5 cases pass.
- `GroupMover.ts` is not modified.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **Self-exclusion is enforced by `findDeepestContainingGroup`'s
  `exclude` parameter + `isDescendantOf` walker.** This is already
  covered by `ViewLocators.spec.ts` at the walker level; the
  `GroupMover.spec.ts` test asserts that `GroupMover.releaseSubject`
  *calls it* with the right arguments. Use `spyCommandExecutor()` to
  verify no reparent commands fire for the self-exclusion case.
- **Group drag coordinates.** `GroupMover` uses
  `groupBoundingBox.center` for the reparent query. As with
  `BlockMover.spec.ts`, make the group's bbox small and known so its
  center's trajectory is predictable.

### Step 5 — TB-13: `LatchMover.spec.ts` (or `OpenChart.spec.ts` extension)

**Changes.**

1. Decide: new `LatchMover.spec.ts` next to the mover, or extend the
   existing `OpenChart.spec.ts` with a new `describe("LatchMover —
   nested anchor visibility")` block. Prefer a new file for discoverability
   and to match BlockMover/GroupMover patterns.
2. Possible visibility change on `LatchMover.getBlocksAndAnchorsAt`.
   It is currently `private` (confirm by reading `LatchMover.ts` before
   writing the spec). Relaxing to `protected` lets the spec subclass
   expose it the same way `TestablePowerEditPlugin` exposes
   `smartHover`. If it's already `public` or the call can be routed
   through `moveSubject`, no production change is needed.

**Test cases.**

- **Direct child of canvas.** Canvas with one block at `(100, 100)`
  with its standard anchor layout. `getBlocksAndAnchorsAt(100, 90)`
  (the top-edge horizontal anchor) returns the block and that anchor.
- **Inside one group.** Same block, now inside a group at `(0, 0,
  400, 400)`. Query at the same anchor coordinate returns the same
  block/anchor pair. (Asserts the walker doesn't only check canvas's
  flat `blocks` array.)
- **Inside nested groups.** Block inside B1 inside B0. Query at the
  anchor coordinate returns the block/anchor pair. (This is the
  exact scenario the §2.3 "Phase 3 uncommitted" fix addresses.)
- **Query outside all anchors.** Same nested setup. Query at a
  coordinate not on any anchor returns `null`/`undefined` (whatever
  the method's empty return is — read the code).

**Acceptance criteria.**

- All 4 cases pass.
- Any production change is limited to a visibility relaxation of
  `getBlocksAndAnchorsAt` (`private → protected`) — no logic change.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **Anchor coordinates depend on block face geometry.** Use the
  factory-built block so its anchor positions are stable and known,
  or read `block.anchors[i].center` before querying instead of
  hard-coding.
- **Visibility change may ripple.** If `LatchMover.getBlocksAndAnchorsAt`
  is already called only from within `LatchMover` itself, a
  `private → protected` change is contained. If it's called from
  `PowerEditPlugin` via a public seam, the spec can call that seam
  directly and skip the visibility change. Audit call sites first.

### Step 6 — TB-13 wrap-up: `GenericMover.spec.ts` (multi-object)

**Changes.**

1. New file `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/GenericMover.spec.ts`.

**Test cases.**

- **Multi-block reparent on release (TB-5).** Canvas with three
  canvas-level blocks `A`, `B`, `C` and a top-level group `G`
  `(400, 400, 800, 800)`. Select all three, `driveDrag` ending with
  all three centers inside `G`. After release, each block's parent is
  `G`.
- **Mixed selection: block + its containing group.** Select a group
  `G` and its child block `A`. `driveDrag` into target group `T`.
  After release, `G.parent === T`, `A.parent === G` (A is not
  independently reparented into T — the TB-7 guard processes
  ancestors before descendants and skips objects already moved
  transitively). Assert via `spyCommandExecutor` that only one
  `addObjectToGroup(T, G)` command fires for this reparent, not two.
- **Per-object target.** Selection of two blocks where one's release
  position lands in group `G1` and the other's lands in `G2`. Each
  reparents independently.
- **No reparent when release stays in same parent.** Block already
  inside `G`. `driveDrag` short-distance, ends still inside `G`. No
  reparent command emitted.

**Acceptance criteria.**

- All 4 cases pass.
- `GenericMover.ts` is not modified.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **TB-7 guard implementation.** The plan describes this as "process
  parents before children, or skip reparenting any object that is a
  descendant of another object in the same selection." Read
  `GenericMover.releaseSubject` to confirm which approach is actually
  implemented; write the assertion against the real behavior. If the
  code does the skip-descendant variant, the "only one command fires"
  assertion is correct; if it does the parents-first variant, update
  the assertion to match the emitted order.
- **Selection list ordering.** `GenericMover` walks the selection
  list; order can matter for the TB-7 guard. Construct the selection
  deliberately (e.g. `[G, A]` vs `[A, G]`) and assert the guard works
  both ways.

---

## Definition of Done

- Six step-level acceptance criteria met.
- `npm run test:unit` green; new spec files add **~28 test cases**
  (8 + 6 + 5 + 4 + 4 + ~1 smoke) without modifying or skipping any
  existing test.
- `PowerEditPlugin.testing.ts` exists, is test-only, and is imported
  only from `*.spec.ts` files.
- No runtime behavior changes. The only allowed production edit is a
  visibility relaxation on `LatchMover.getBlocksAndAnchorsAt`
  (`private → protected`) if needed for Step 5, documented in the
  commit message with the Phase D reference.
- `npm run lint` passes; `npm run type-check` passes with only the
  four pre-existing errors Phases A/B/C documented (`DarkTheme`,
  `LightTheme`, `LatchMover:170`, node22 vendor).
- The roadmap's TB-13 bullets for `BlockMover.spec.ts`,
  `GroupMover.spec.ts`, and `LatchMover.spec.ts` are checked off; TB-14
  is checked off.

---

## What comes after Phase D

- **Phase E: UX polish.** TB-10 (depth coloring for nested
  boundaries), TB-11 (clamp cursor at resize minimum), TB-12
  (context-menu reparent). Worth doing once the structural, semantic,
  and test layers are stable.
- **Phase F (opportunistic cleanup).** TB-4b (block-move-triggered
  line LCA recomputation), OTM publisher variant of TB-9, TB-6
  re-evaluation (resize-captures-siblings), the pre-existing
  `BlockMover.ts` lint debt, and the `CanvasView.groups` typing
  cleanup.
- **Potential Phase G: end-to-end browser tests.** With editor-layer
  coverage in place, the manual smoke checklists from Phases A–D are
  the next automation target. A Playwright suite driven through the
  already-installed playwright MCP integration could replay the C1–C5
  validator scenarios and the TB-9 publisher scenarios without a human
  running through them each release.
