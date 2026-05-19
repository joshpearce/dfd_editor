# PolyLine: enable span editing when line is unanchored (#16)

**Issue:** [#16](https://github.com/.../issues/16) — child of #14. Fix order: FIRST
(unblocks #17). Independent of #15 (already landed).

## Problem

`PolyLine.getObjectAt`
(`src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/PolyLine.ts`,
~lines 97–156) gates all interior-segment / `PolyLineSpanView` resolution behind
`if (this.isAnchored())`. The `else` branch (~150–156) is a degraded copy that
only ever returns `this.view` for any hitbox hit. The moment a user unlinks
*both* endpoints of a multi-bend line (`isAnchored()` returns false only when
**neither** endpoint is linked — it is OR logic), per-segment drag via
`PolyLineSpanMover` silently vanishes: the line becomes an opaque blob. This is
undocumented, untested, and was an unintended gap in the
2026-04-23-polyline-face plan (which only marked *bend add/remove* out of
scope).

## Key findings (from code inventory)

- The unlinked-latch check (`findUnlinkedObjectAt(this.latchEndpoints, …)`,
  ~lines 102–105) already runs **before** the `isAnchored()` gate in both
  branches. Free-latch endpoint clicks resolve correctly today; only interior
  spans are lost. The fix must preserve this latch-first ordering.
- `PolyLineSpanMover`
  (`DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/PolyLineSpanMover.ts`)
  is **provably anchor-indifferent**: it reads only `span.parent`,
  `span.handleA`, `span.handleB`, `span.axis`. It never touches endpoint/latch
  geometry. No mover code change is required.
- `this.spans` and `this.hitboxes` are populated by `calculateLayout` /
  `runMultiElbowLayout` **regardless of anchor state** — the data the anchored
  branch consumes already exists in the unanchored case. The else branch simply
  never reads it.
- The anchored branch has two parts the else branch lacks: (a) a dead-zone
  loop matching clicks within an interior handle's marker-dot radius to its
  span, and (b) the hitbox loop's span lookup (`spans.find(handleA===… &&
  handleB===…)`), returning `span ?? this.view`.
- No anchored-only assumption exists anywhere in the resolution path —
  unification is safe.

## Chosen approach: unify the two paths

Remove the `if (this.isAnchored())` / `else` split in `getObjectAt`. Run one
shared resolution sequence regardless of anchor state:

1. latch endpoint check (unchanged, runs first),
2. interior-handle dead-zone loop,
3. hitbox loop with span lookup (`span ?? this.view`).

This eliminates the duplicated-branch defect class outright (a future edit can
no longer re-diverge the two paths), and is consistent with the inventory
finding that nothing in the path depends on anchor state. `DynamicLine` keeps
its own gate for now — its branches are *not* duplicates (anchored returns
individual handles; that is a separate face's concern, out of scope here).

```
getObjectAt(x, y):
    latch = findUnlinkedObjectAt(this.latchEndpoints, x, y)
    if latch: return latch
    # dead-zone: click within an interior handle's dot → its span
    for handle in this.view.handles:
        if isInsideMarkerDot(handle, x, y):
            span = spans.find(s => s.handleB===handle) ?? spans.find(s => s.handleA===handle)
            if span: return span
    # hitbox loop
    for i, hb in this.hitboxes:
        if not isInsideRegion(x, y, hb): continue
        if interior(i):
            a, b = handles[i-1], handles[i]
            return spans.find(s => s.handleA===a && s.handleB===b) ?? this.view
        return this.view            # end segments
    return null/undefined as today
```

## Steps

### Step 1 — Unify `getObjectAt`; remove the anchor gate

Replace the `if (this.isAnchored())` / `else` structure in
`PolyLine.getObjectAt` with the single shared sequence above. Preserve exact
ordering (latch → dead-zone → hitbox loop) and the `span ?? this.view`
fallbacks. Delete the now-dead else branch. Do not touch `calculateLayout`,
`isAnchored()`, or any sibling face.

- **Files:** `PolyLine.ts` (`getObjectAt` only).
- **Verify:** `npm run test:unit` — all existing `PolyLine.spec.ts` cases pass
  unchanged (including the anchored span tests and the "unlinked latch still
  returns latch" test, which exercises the now-shared path).

### Step 2 — Spec: unanchored interior segment resolves to a span

Add a `PolyLine.spec.ts` case using the existing `createPolyLineWithHandles`
fixture **without** `createAnchoredFixture` (both latches unlinked,
`isAnchored() === false`). Click an interior segment's hitbox centre; assert
`getObjectAt` returns the expected `PolyLineSpanView` (correct `handleA`,
`handleB`, `axis`) — not `this.view`. Add a companion case asserting the
dead-zone (click within an interior handle dot on an unanchored line) also
resolves to the span. Add a regression case: end segments on an unanchored
line still return `this.view`, and the free-latch click still returns the
latch (ordering preserved).

- **Files:** `PolyLine.spec.ts`.
- **Verify:** new cases fail against pre-Step-1 code (confirm the bug), pass
  after Step 1.

### Step 3 — Spec: end-to-end span-drag on a fully unanchored PolyLine

Add a `PolyLineSpanMover.spec.ts` case mirroring the existing
`createCanvasFixture` dispatch test **but skipping the
`line.node1.link(blockAnchor)` call** (the test code today comments that this
link "activates the anchored/span-aware branch" — that crutch is no longer
needed). Drive the full path: `getObjectAt` on an interior segment →
`PolyLineSpanMover` capture → `moveSubject` → assert `moveObjectsBy` is
emitted for `[handleA, handleB]` with the axis-locked delta, exactly as the
anchored case does. This is the spec-level verification of the mover's
anchor-indifference (no mover code changes).

- **Files:** `PolyLineSpanMover.spec.ts`.
- **Verify:** new case passes; existing anchored dispatch case still passes.

## Acceptance criteria

- **Step 1:** `PolyLine.getObjectAt` contains no `isAnchored()`-conditioned
  branch; one resolution path. Full existing suite green, no spec edits needed
  to keep old tests passing.
- **Step 2:** On an unanchored multi-bend PolyLine, an interior-segment hit and
  an interior-handle-dot hit both return the correct `PolyLineSpanView`; end
  segments return `this.view`; a free-latch hit returns the latch. New cases
  demonstrably red before Step 1, green after.
- **Step 3:** A fully unanchored PolyLine completes a span-drag end-to-end,
  emitting `moveObjectsBy([handleA, handleB], dx, dy)` with H/V axis-locking
  identical to the anchored path. No `PolyLineSpanMover` source changes.

## Definition of done

All three steps' criteria met; `npm run test:unit` and `npm run type-check`
green; no `PolyLineSpanMover` code modified; no sibling face touched; #16's
three scope bullets (allow span resolution unanchored; verify mover at free
latch; add the missing spec) satisfied. Unblocks #17.

## Out of scope

DynamicLine's own `isAnchored` gate (separate face, non-duplicate branches);
bend add/remove (#17); diagonal-segment policy (#18).
