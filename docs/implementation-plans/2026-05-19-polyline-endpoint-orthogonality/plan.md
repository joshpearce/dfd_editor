# Plan: PolyLine end-segment orthogonality on endpoint move (issue #19)

**Issue:** #19 — moving an attached block breaks end-segment orthogonality
(the elbow does not follow the moving endpoint).
**Parent:** #14. **Depends on:** none (foundation tier, parallel with
#15/#16). **Blocks:** #18 (its diagonal-handling rationale is invalidated
by this fix — see issue #19 body).

## Problem (confirmed)

`PolyLine.calculateLayout` (`PolyLine.ts:164-207`) builds
`points = [src, ...handles, trg]` and calls `runMultiElbowLayout`
(`LineLayoutStrategies.ts:305-361`), which only applies marker offsets and
draws straight `L` segments. Nothing repositions the first/last interior
handle when an attached endpoint moves, so the end segment renders at an
angle, then fails H/V classification (`PolyLine.ts:192-197`) and produces
no draggable `PolyLineSpanView`. `DynamicLine`'s `axisCapTowards`
(`LineLayoutStrategies.ts:458`) is a 1-D clamp on the two-elbow path and is
not reusable as-is for the multi-elbow case.

## Data Model

No new persisted types. The fix introduces a **pure end-segment
orthogonality adjustment** applied during `PolyLine.calculateLayout`,
before span classification. Conceptually:

```
adjustEndElbow(endpoint, elbow, nextElbow | null):
  # keep endpoint→elbow axis-aligned by snapping the elbow onto the
  # endpoint's row/col, choosing the axis that preserves the
  # elbow→nextElbow segment's existing axis (H/V alternation)
```

The adjustment writes the corrected position to the **handle** (model
state, via the face-level `moveTo` path that the TALA steering pass
already uses — `handle.face.moveTo`, NOT `handle.moveTo`, to avoid the
`handleUpdate → dropHandles` cascade noted in OpenChart CLAUDE.md). One
open policy decision (see below) determines whether the elbow snaps on
the endpoint's axis or whether a new handle is inserted to absorb the
offset. Persistence is unchanged: corrected handle positions serialize
through the existing handle round-trip.

## Chosen policy: A — Snap-elbow (DECIDED 2026-05-19)

When the endpoint moves, project the adjacent elbow onto the endpoint's
row or column (whichever keeps the `elbow→nextElbow` segment's axis
intact). No handle-count change, preserves H/V alternation, reuses the
existing handle-write path. The elbow visibly slides along with the
block — this is the intended, industry-standard orthogonal-connector
behavior, not a regression. The helper must be written so #18 can reuse
it for any residual off-axis segment.

Rejected alternatives (recorded for context, do not implement):
- **B. Insert-corner** — freeze the elbow, insert a new handle per move
  to keep the route orthogonal. Rejected: unbounded handle growth and
  entangles with #17's bend-command ownership.
- **C. DynamicLine-parity refactor** — extract a shared helper from the
  two-elbow strategy. Rejected: `axisCapTowards` is cap-space clamp
  logic, not an orthogonality solver; reuse is a rewrite, larger than
  the bug warrants.

## Steps

### Step 1 — Pure end-elbow orthogonality helper + unit specs
Add a pure function (e.g. `orthogonalizeEndElbow`) in
`LineLayoutStrategies.ts` (or a sibling): given endpoint, elbow, and the
neighbor beyond the elbow, return the corrected elbow position that keeps
the end segment axis-aligned and preserves the next segment's axis.
**Tests:** table-driven specs over endpoint-moved-in-X / -in-Y / diagonal
inputs asserting the returned point is axis-aligned with the endpoint and
the neighbor segment's axis is unchanged.

### Step 2 — Apply in `PolyLine.calculateLayout`
Call the helper for `points[0]→handles[0]` (using `handles[1]` or `trg`
as neighbor) and `handles[n-1]→trg` (using `handles[n-2]` or `src`),
writing via the face-level handle path **before** the span-classification
loop. **Files:** `PolyLine.ts:176-200`. **Tests:** extend
`PolyLine.spec.ts` — construct a multi-bend PolyLine, move an endpoint,
assert end segment axis-aligned and a `PolyLineSpanView` is produced for
it (the symptom that ties to #18).

### Step 3 — Interactive + round-trip integration spec
Drive a block move via the editor/mover harness
(`PowerEditPlugin.testing.ts` pattern): attach a PolyLine endpoint to a
block, move the block on each axis, assert the end segment stays
orthogonal and span-draggable; then save/reload and assert the corrected
geometry persists. **Files:** new spec near `PolyLine.spec.ts`.

## Acceptance Criteria

- **S1:** Helper is pure (no view mutation), exported, and spec proves
  axis-alignment + neighbor-axis preservation across X/Y/diagonal inputs.
- **S2:** After moving either endpoint of a multi-bend PolyLine, both end
  segments are axis-aligned within `AXIS_EPSILON` and each produces a
  `PolyLineSpanView`; H/V alternation invariant holds; no handle-count
  change (under policy A).
- **S3:** Interactive block-move spec shows the end segment stays
  orthogonal and draggable; geometry survives save/reload unchanged.
- Existing PolyLine / auto-layout-fidelity / TALA round-trip specs pass
  unchanged (TALA-generated routes are already orthogonal, so the helper
  is a no-op on them — assert this explicitly).
- No serialized-format change; no Vue/Pinia import added to the engine.

## Definition of Done

All step criteria met; `npm run test:unit`, `type-check`, `lint` green;
the issue-#19 reproduction (move attached block → angled end segment) no
longer occurs and the formerly-dropped end span is draggable. Update #19
and re-confirm #18's scope is now "residual off-axis only." Update
OpenChart CLAUDE.md's PolyLine gotcha to note end-segment orthogonality
is now maintained on endpoint move.
