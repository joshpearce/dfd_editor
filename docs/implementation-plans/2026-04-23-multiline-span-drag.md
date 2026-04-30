# PolyLine span-drag editor UX

Date: 2026-04-23

## Problem

`PolyLine` renders multi-bend routes produced by TALA, but today it's not
usefully editable:

- Grabbing an interior handle dot and dragging moves that handle freely in
  2D. That breaks the horizontal/vertical alternation invariant baked into
  the corner-radius math in `getAbsoluteMultiElbowPath`
  (`Utilities/Drawing/Shapes.ts`), producing the "rounded corner inverts"
  artifact the user observed.
- `DynamicLine`'s natural edit affordance — grab a segment between two
  vertices and drag it perpendicular to its axis — has no counterpart on
  `PolyLine`. Today the interior hitboxes route to `handles[i-1]` and fire
  `GenericMover`, which is the root cause of the inversion.

## Decisions (from clarification)

- **Scope:** only *interior* spans (between two user-movable handles) are
  span-draggable. End spans (latch ↔ first/last handle) keep today's
  "select the line" behavior, matching `DynamicLine`. No bend insertion.
- **Point-drag:** disabled. Clicks on an interior handle dot fall through
  to the span hitbox underneath. Handle dots still render for selection
  feedback but are not drag targets.
- **Renderer hardening:** not in scope. Preserving the H/V alternation
  invariant via span-drag is sufficient; we don't add a diagonal-corner
  fallback in `getAbsoluteMultiElbowPath`.

## Approach

Introduce a lightweight `PolyLineSpanView` that represents one axis-aligned
segment between two flanking handles. `PolyLine.calculateLayout` builds one
per interior segment and classifies its axis (H/V). `PolyLine.getObjectAt`
returns the matching span for interior hitboxes and excludes interior
handles from point hit-testing. A dedicated `PolyLineSpanMover` consumes
the span, zeroes the parallel component of each drag delta, and dispatches
a single `MoveObjectsBy` over the pair of real flanking handles — so the
H/V alternation invariant is preserved by construction and undo stays one
step per drag.

Rendering, arrow heads, hitbox generation, and the `runMultiElbowLayout`
path are unchanged. All behavior changes are in hit-test dispatch and a
new mover.

## Steps

### Step 1 — `PolyLineSpanView` + layout classification

Add `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/PolyLineSpanView.ts`.
Minimal view (not a `HandleView`) carrying:

```
PolyLineSpanView:
  parent: LineView
  handleA: HandleView           // handles[i]
  handleB: HandleView           // handles[i+1]
  axis: "H" | "V"
  hitbox: number[]              // cached polygon, for debug/overlaps
```

In `PolyLine.calculateLayout`, after `runMultiElbowLayout` populates
`this.hitboxes`, rebuild a `this.spans: PolyLineSpanView[]` array:

- For each pair of consecutive interior handles `handles[i], handles[i+1]`:
  - If `handles[i].y === handles[i+1].y` → axis `"H"`.
  - Else if `handles[i].x === handles[i+1].x` → axis `"V"`.
  - Else skip (diagonal; never produced by TALA, defensive only).

No behavior change yet — spans are built but never returned from
hit-test. `PolyLine.getObjectAt` unchanged.

**Acceptance:**
- `PolyLine.spec.ts` — N-interior-handle line produces `N-1` spans, axes
  classified correctly; diagonal layout (hand-constructed) yields fewer
  spans with the diagonal segments skipped.
- Existing `PolyLine.spec.ts` tests and `inferLineFaces.spec.ts` pass
  unchanged.

### Step 2 — `PolyLineSpanMover` with axis-locked delta

Add `src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/PolyLineSpanMover.ts`,
following the existing `GenericMover` / `BlockMover` pattern (see sibling
movers under `ObjectMovers/`).

```
PolyLineSpanMover(span: PolyLineSpanView):
  moveSubject(dx, dy):
    if span.axis === "H": dx = 0
    else:                 dy = 0
    return MoveObjectsBy([span.handleA, span.handleB], dx, dy)
```

Single `MoveObjectsBy` = one command, one undo step, one `handleUpdate`
cascade from each handle. Layout reruns naturally and the H/V
alternation invariant holds because both endpoints translated by
identical perpendicular delta.

Unit-test by constructing a span over a hand-built PolyLine (no plugin
wiring yet).

**Acceptance:**
- `PolyLineSpanMover.spec.ts`:
  - H span + delta `(5, 3)` → both handles move by `(0, 3)`; resulting
    vertices still axis-alternating; `runMultiElbowLayout` output has
    no diagonal segments.
  - V span + delta `(5, 3)` → both handles move by `(5, 0)`; same
    invariant check.
  - Single undo after a multi-tick drag returns both handles to their
    original positions in one step.
- Existing mover specs untouched.

### Step 3 — Hit-test cutover + plugin dispatch

Changes in `PolyLine.ts`:

- `getObjectAt`: when searching `this.points` for an unlinked hit, only
  consider `src` and `trg` (the latches), not the interior handles.
  Handle dots still render (they're in `this.points` for rendering), but
  don't appear as hit targets.
- For interior hitboxes (`0 < i < hitboxes.length - 1`), return
  `this.spans[i - 1]` instead of `handles[i - 1]`. If the corresponding
  span was skipped (diagonal), fall through to `this.view`.
- End hitboxes still return `this.view`.

Changes in `PowerEditPlugin.ts` (mirror `handleHandle` at line 369):

- Add `handleSpan(span, ...)` branch that constructs `PolyLineSpanMover`.
- Extend `CursorMap` so `PolyLineSpanView.name` → `Cursor.Resize_EW` for
  `"V"` axis, `Cursor.Resize_NS` for `"H"` axis (axis read from the
  span at cursor-lookup time).

**Acceptance:**
- `PolyLine.spec.ts`:
  - Click at interior-handle-dot coordinates returns the span beneath,
    not the handle.
  - Click on an interior-segment hitbox returns a `PolyLineSpanView`.
  - Click on an end-segment hitbox returns the `LineView` (unchanged).
  - Click on `src`/`trg` latch still returns the latch.
- Manual UX check: load a TALA-laid-out diagram with a ≥3-bend
  PolyLine, drag an interior segment — it translates perpendicular, no
  corner inversion, undo restores in one step.

## Definition of Done

- All three step-level acceptance criteria met.
- `npm run lint`, `npm run type-check`, and `npm run test:unit` pass
  with no new warnings.
- No regressions: `DynamicLine.spec.ts`, `inferLineFaces.spec.ts`,
  `NewAutoLayoutEngine.spec.ts`, `PowerEditPlugin` mover specs, and
  `OpenChart.spec.ts` are unchanged and green.
- Manual smoke: auto-layout a DFD that produces a ≥3-bend route; every
  interior segment drags perpendicular; handle dots render but don't
  respond to drag; end segments select the line; save → reload →
  handles land at the same positions.
- `src/assets/scripts/OpenChart/CLAUDE.md` note in "Gotchas" updated to
  record that PolyLine edit affordance is span-drag only (interior
  handles are non-draggable by design).
