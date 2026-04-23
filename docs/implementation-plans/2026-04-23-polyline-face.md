# PolyLine Face — Implementation Plan

Last written: 2026-04-23 · Status: ready for implementation

Source design: `docs/design-plans/2026-04-23-multi-bend-flow-routing.md`
(Option 1 — new PolyLine face).

## Goal

Preserve TALA's multi-bend flow routes through auto-layout import by adding
a `PolyLine` `LineFace` that renders and makes user-draggable an arbitrary
ordered list of interior vertices. User-drawn flows continue to use
`DynamicLine` (one waypoint, L/Z). PolyLine is selected only when a line
has ≥ 2 stored handles.

## Key Decisions

- **Face selection is inferred from handle count.** A line with
  `handles.length >= 2` is a PolyLine; otherwise DynamicLine. This keeps
  the `LineExport` schema unchanged (no `face_type` field, no version
  bump) and matches the runtime invariant the auto-layout engine will
  maintain when it populates handles.
- **Reuse `runMultiElbowLayout`.** It already accepts a flat
  `[x0,y0,…,xN,yN]` vertex array, builds per-segment hitboxes, applies cap
  offsets, and produces rounded-corner output. `PolyLine.calculateLayout`
  skips the orientation-dispatch table and feeds all N handles directly.
- **Handle → hitbox mapping is unchanged.** The existing `getObjectAt`
  logic (`hitboxes[i]` → `handles[i-1]` for interior segments) already
  generalizes to N handles once `this.points = [src, h0, …, hN, trg]`.
- **User interactions that change handle count switch face type.**
  `LineView.replaceFace` is the single upgrade/downgrade hook. A PolyLine
  that drops below 2 handles (future feature, out of scope here) would
  downgrade to DynamicLine via the same hook. For this plan, only the
  auto-layout path upgrades DynamicLine → PolyLine.
- **Out of scope:** manually adding a bend to an existing line (no UI
  affordance for inserting new handles), PolyLine for user-drawn flows,
  a `compare_layout.py` rendered-path fidelity check (tracked separately
  in `docs/implementation-plans/2026-04-23-compare-layout-full-geometry.md`).

## Steps

### 1 — Add PolyLine face + factory plumbing

Create `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/PolyLine.ts`,
a `LineFace` subclass structurally parallel to `DynamicLine`:

```
class PolyLine extends LineFace implements GenericLineInternalState {
    vertices, hitboxes, points, arrowAtNode1, arrowAtNode2, style, grid

    calculateLayout():
        points = [src_anchor, ...handles, trg_anchor]
        vertices = flatten(points)
        runMultiElbowLayout(view, this, vertices)
        boundingBox = calculateBoundingBoxFromViews(this.points)
    renderTo(ctx): drawAbsoluteMultiElbowPath(ctx, this.vertices)
    getObjectAt(x,y): reuse DynamicLine's implementation verbatim
    clone(): new PolyLine(style, grid)
}
```

Plumbing:
- Add `FaceType.PolyLine = "line_polyline"` to `FaceType.ts`.
- Add `PolyLineDesign` variant to `FaceDesign.ts` (structurally identical
  to `LineDesign`).
- Add `case FaceType.PolyLine` branches in
  `DiagramObjectViewFactory.createBaseDiagramObjectFromTemplate` and
  `restyleDiagramObject`.
- Both themes (`DarkTheme.ts`, `LightTheme.ts`) keep the existing
  `data_flow` template pointing at `DynamicLine`; no new template is
  added. PolyLine is a runtime-selected face, not a separate
  diagram-object kind.
- Export from `Faces/Lines/index.ts`.

**Acceptance:**
- `npm run type-check` passes.
- `npm run lint` passes.
- Unit test: constructing a `PolyLine` with a mock `LineView` carrying
  three handles produces `vertices` with 5 points (src, h0, h1, h2, trg)
  and `hitboxes.length === 4`.
- No behavioural change to any existing diagram (DynamicLine still the
  sole active face).

### 2 — Auto-layout engine populates N handles and swaps face

In `NewAutoLayoutEngine.ts`, replace the `pickPolylineElbow` block
(around `:785`, with helper at `:672-699`) with a pass that keeps all
interior TALA vertices:

```
interior = bestEdge.points.slice(1, -1)           # drop endpoints
ensureHandleCount(line, interior.length)          # addHandle / dropHandles
for i, pt in interior:
    line.handles[i].userSetPosition = USER_TRUE
    line.handles[i].moveTo(pt.x, pt.y)
if line.handles.length >= 2:
    lineView.replaceFace(new PolyLine(style, grid))
else:
    # already DynamicLine; nothing to do
```

`ensureHandleCount` uses the existing `line.addHandle(newHandle)` and
`line.dropHandles(n)` APIs on the model. Delete `pickPolylineElbow` and
its call site once the new pass lands. The face swap is done against
the `LineView` accessor that the engine already has (the view is the
same object whose handles it mutates).

**Acceptance:**
- Existing `NewAutoLayoutEngine.spec.ts` suites still pass unchanged
  (straight and one-bend edges).
- New spec: a TALA edge with 4 polyline points produces a line with 2
  interior handles at the correct coords, and `lineView.face instanceof
  PolyLine`.
- New spec: a TALA edge with 2 points (straight) produces a line still
  backed by `DynamicLine`.
- Visual smoke: reload `server/examples/java_web_app.json`; flows no
  longer cross trust-boundary faces.

### 3 — Infer face type on diagram import

In the import path used by `DiagramObjectSerializer.yieldImportFromLine`
(or in `DiagramObjectViewFactory` where the `LineView` is constructed
around its face), add a post-construction step: after all handles have
been re-attached from `LineExport.handles`, if `line.handles.length >= 2`,
call `lineView.replaceFace(new PolyLine(style, grid))`. The `style` and
`grid` come from the same template lookup that produced the initial
`DynamicLine`.

This makes PolyLine files round-trip: saved by step 2's engine run with
N handles, reloaded as PolyLine on next open because the inference rule
matches.

**Acceptance:**
- New spec: serialize a PolyLine-backed line to `GenericObjectExport`,
  round-trip back through import, assert `face instanceof PolyLine` and
  handle positions preserved.
- Existing serialization tests in the OpenChart suite pass unchanged.
- Load an auto-laid-out diagram, save it, close, reopen: flow rendering
  is visually identical across the cycle (no fallback to L/Z).

### 4 — Exercise manual edits on PolyLine

Add targeted tests that exercise the interaction paths the design doc
flagged as regression risk, since PolyLine reuses `DynamicLine.getObjectAt`
and the existing `GenericMover`/`LatchMover`:

- Drag an interior handle: `lineView.face.calculateLayout` rebuilds
  `vertices` with the moved handle, other handles unchanged.
- Drag a latch (endpoint): endpoint anchor updates, interior handles
  unchanged.
- Drag the whole line (`moveBy`): all handles + latches translate.
- Line reparent (e.g. delete source block): no crash; handles persist.

Place these in `PolyLine.spec.ts`, colocated with the new face.

**Acceptance:**
- All four interaction tests pass.
- `npm run test:unit` green.
- Manual check in dev: drag one bend of an auto-laid-out flow; only
  that bend moves.

## Definition of Done

- All four step-level acceptance criteria met.
- `npm run build` (parallel `type-check` + `build-only`) succeeds.
- `npm run test:unit`, `npm run lint` green.
- `server/examples/java_web_app.json` renders with no flow crossings
  through trust-boundary faces on fresh import AND after a save/reload
  cycle.
- No regression in existing DynamicLine behaviour: user-drawn flows
  still produce a single grab handle on an L or Z shape.
- `pickPolylineElbow` and its test coverage are removed (no longer
  referenced).
- `docs/design-plans/2026-04-23-multi-bend-flow-routing.md` gets a
  one-line status footer pointing at this plan and noting Option 1 is
  implemented.
