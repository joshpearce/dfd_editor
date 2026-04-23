# Multi-Bend Flow Routing — Problem & Options

Last written: 2026-04-23 · Status: problem analysis / pre-plan

## Summary

TALA auto-layout emits edge polylines with an arbitrary number of bends,
but the editor's `DynamicLine` face can only render an L-shape (one
elbow) or a Z-shape (two elbows), each parameterized by a single
draggable waypoint. Any TALA route with three or more elbows — a
"staircase" that snakes around intermediate containers — is lossily
compressed to a single waypoint at import time and re-rendered as an L
or Z that no longer avoids the obstacles TALA routed around. The
resulting visual failure is flow lines that cross container faces or
terminate on interior edges.

Block-level positioning is unaffected: leaf block centers round-trip
through TALA → `parseTalaSvg` → `placeBlock` → `moveTo(center)` with
zero pixel delta. The problem is isolated to the polyline-to-single-
waypoint reduction in the flow-routing path.

## Evidence

Run `python3 scripts/compare_layout.py --svg-only <diagram-id>` against
any sample with three-plus-bend TALA routes (e.g. the Java web app
diagram at `server/examples/java_web_app.json`). The script reports
`PASS` — all 14 leaf block centers match the saved layout at Δ = 0.0 px
— yet the rendered diagram has flow lines crossing trust-boundary
faces. The script's scope is block centers only; it does not validate
flow geometry, which is where the discrepancy lives.

## The Pipeline

### TALA produces full polylines

`parseTalaSvg` (`D2Bridge.ts:519-575`) extracts every coordinate pair
from each edge's `<path d="...">` attribute into `TalaEdge.points`.
Full fidelity is preserved at this stage — an N-bend staircase comes
through as N+1 vertices.

### The engine compresses to a single waypoint

`NewAutoLayoutEngine.ts:785` calls `pickPolylineElbow(bestEdge.points)`
(defined at `:672-699`), which returns the **one** interior vertex with
the greatest perpendicular distance from the straight start-to-end
chord — the "bulgiest" bend. That single point is pushed into
`line.handles[0]`. The other N-1 bends are discarded before the model
ever sees them.

### The view reads only `handles[0]`

`DynamicLine.calculateLayout` (`DynamicLine.ts:156-219`) reads
`this.view.handles[0]` and dispatches to one of four layout strategies
in `LineLayoutStrategies.ts` — each of which also reads only
`handles[0]` (`:27, :97, :170, :231`). Any `handles[1..N]` that might
exist in the model are silently ignored at render time.

### Shape family is fixed

The four strategies produce either:

- **L-shape** (`runHorizontalElbowLayout` / `runVerticalElbowLayout`):
  one computed corner, positioned from `node1.anchor.orientation`,
  `node2.anchor.orientation`, and `handles[0]`.
- **Z-shape** (`runHorizontalTwoElbowLayout` /
  `runVerticalTwoElbowLayout`): two computed corners, with `handles[0]`
  sitting on the middle crossbar.

Both corners (for Z) are derived from the anchors plus the single
waypoint at each render call; neither is stored anywhere. There is no
code path that iterates a handle list and renders an arbitrary-length
`M p0 L p1 L p2 … L pN` polyline.

## Why "Just Store More Handles" Doesn't Help

The model layer (`Line.ts:191-200`) already supports an unbounded
`_handles: Handle[]`. Extra handles persist through save / load via
the `layout` key with their own GUIDs. The constraint is not storage —
it is that the `DynamicLine` renderer has exactly one degree of
freedom for the bend path, regardless of how many handles sit in the
model.

Stating the constraint precisely:

> A DynamicLine renders an L or a Z, parameterized by two endpoint
> anchors plus a single draggable waypoint. The intermediate corners,
> if any, are computed — not stored, not handle-backed, not
> user-movable.

This is why TALA staircases can't be round-tripped: the renderer has
one bend-path degree of freedom; TALA routes often need three or more.

## Options

### Option 1 — New PolyLine face

Add a new `LineFace` subclass (e.g. `PolyLine`) that iterates the
line's `handles[]` in order and strokes
`M anchor1 L handles[0] L handles[1] … L anchor2`. Each handle in the
array is a real, stored, user-draggable vertex.

Auto-layout import becomes: parse TALA polyline → create N handles for
N interior vertices → bind endpoints as today. DynamicLine keeps its
one-waypoint semantics for user-drawn flows (draw an edge by clicking,
get a simple L or Z with a grab handle).

- **Pros:** preserves TALA's routing exactly; manual edits still work
  per-vertex; model layer already supports it.
- **Cons:** two line faces to maintain; need a policy for when a line
  becomes a PolyLine (always after auto-layout? opt-in?); hitbox /
  selection code must branch on face type.
- **Scope:** new face + new layout strategy + auto-layout import
  adapter. Manual edits (latch drag, handle drag, line reparent) need
  to be exercised on the new face.

### Option 2 — Extend DynamicLine to N elbows

Rewrite `LineLayoutStrategies.ts` to accept `handles[0..N]` and emit a
staircase through all of them. DynamicLine stays the sole line face.

- **Pros:** single face, single code path.
- **Cons:** the current strategies are tightly coupled to the
  two-orientation dispatch table and produce canonical L/Z shapes that
  the user interacts with as a single pivot; generalising to N bends
  breaks the manual-edit UX (what does "drag the elbow" mean when there
  are five of them?) and complicates the hitbox / cap-offset logic in
  `axisCapTowards`. Risk of destabilising user-drawn flows while trying
  to fix auto-laid-out ones.
- **Scope:** large rewrite of layout strategies + interaction model;
  regression risk to existing manual-editing behaviour.

### Option 3 — Frozen polyline as a render artifact

Treat the TALA output as a cached rendering: store the full polyline
point list on the line (e.g. in a new `auto_layout_path` property) and
render it directly, without routing it through `handles[] +
calculateLayout`. The moment a user drags an endpoint, latch, or the
line itself, the cache invalidates and the line falls back to
DynamicLine's computed L/Z shape.

- **Pros:** smallest change; TALA geometry is preserved exactly until
  the user touches the line; no new face, no strategy rewrite.
- **Cons:** user can't tweak a single bend of an auto-laid-out line
  without losing the entire route; any block move that shifts an
  endpoint invalidates the cache and the line snaps to a computed
  shape; storing "rendered geometry" on a model object is a layering
  violation that the rest of the codebase does not make.
- **Scope:** new model property + render-time branch in DynamicLine +
  invalidation hooks on the relevant commands.

## Recommendation

Option 1 (new `PolyLine` face) is the right shape for a DFD editor
because users do need to adjust auto-laid-out routes without losing
them, and the model layer is already built for it. Option 3 is the
cheapest stopgap if tweaking auto-laid-out lines is rare and losing
the route on interaction is acceptable. Option 2 is not recommended —
the return on the manual-editing-UX regression risk is poor.

## How We'd Validate

Extend `scripts/compare_layout.py` with the "rendered-path fidelity"
check described in the block-bounds / edge-routing discussion:

1. For each flow, identify the corresponding SVG edge `<g>` via its
   base64-encoded class (`(src-path -&gt; tgt-path)[N]`) — decoded,
   HTML-entity-unescaped, matched on the unordered endpoint-GUID pair
   plus index.
2. Parse TALA's full polyline from the edge's `<path d>` attribute.
3. Reconstruct the editor's rendered polyline using the same logic the
   target face uses at render time (DynamicLine: anchor(node1) →
   L/Z through handles[0] → anchor(node2); PolyLine: anchor(node1) →
   handles[0..N] → anchor(node2)).
4. Report per-flow max deviation (sampled-point or Hausdorff).

Under the current DynamicLine, this check would show persistent high
deviation on every flow TALA routed with three-plus bends. That output
is itself the evidence for whichever option we pick: if multi-bend
deviations dominate, Option 1 pays off; if they're rare and small,
Option 3 is enough.

## Related Files

- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts` —
  `parseTalaSvg` / `TalaEdge`
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/NewAutoLayoutEngine.ts` —
  `pickPolylineElbow`, the handle-steering pass
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts` —
  the single-waypoint view
- `src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts` —
  the four L/Z strategies
- `src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Line.ts` —
  the unbounded `_handles` model (already sufficient for Option 1)
- `scripts/compare_layout.py` — today's block-only validator; the natural
  place to add the rendered-path fidelity check
