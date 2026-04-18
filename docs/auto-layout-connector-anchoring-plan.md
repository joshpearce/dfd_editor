# Auto-layout: connector anchoring

## Problem

After `NewAutoLayoutEngine` runs, node positions come from TALA but each
line still attaches to the anchor the user (or factory) picked at line
creation time. When TALA moves blocks, the existing anchor side is often
wrong for the new topology — e.g. source latch on the top anchor while
the target is now to the right — so the elbow router faithfully routes
up-and-around, often slicing through neighboring containers.

The line rendering and elbow routing are correct; the only missing piece
is that nothing updates which *side* of each block the line enters and
exits.

## Approaches

Two anchor-picking strategies. The engine exposes a switch so callers
can pick at construction time; both strategies target the four cardinal
anchors (`D0` / `D90` / `D180` / `D270`).

- **`geometric`** — For each line, compare source-block center to
  target-block center. Pick the source-block cardinal anchor on the side
  facing the target's center; pick the target-block cardinal anchor on
  the side facing the source's center. No D2 edge data used.
- **`tala`** — Parse `<g class="connection">` elements from TALA's SVG
  (currently dropped by `parseTalaSvg`'s base64 class guard). Take the
  start/end point of each connection's `<path>`. Match SVG edges to our
  `LineView` instances by proximity (start→source-block perimeter,
  end→target-block perimeter). Pick each block's cardinal anchor
  nearest TALA's endpoint. Our elbow router still draws the stroke.

Both strategies are destructive to user-chosen anchor sides, but auto-
layout only runs on first-load of a diagram without a persisted layout
(`if (!jsonFile.layout)` in `FileManagement/index.ts`), so the only
anchor choices at risk are the factory defaults.

## Steps

### Step 1 — `pickCardinalAnchor` helper + `rebindLatchToAnchor` helper

Add a pure helper `pickCardinalAnchor(block, target: {x, y})` that
returns one of the four cardinal `AnchorPosition` values (D0 = right,
D90 = top, D180 = left, D270 = bottom) based on which side of the
block's bounding box `target` is nearest. Ties go right → top → left →
bottom.

Add a helper `rebindLatchToAnchor(latch, newAnchor)` that detaches the
latch from its current anchor and attaches it to the new one. Trace the
existing latch-linking path (`LatchView`) to find the right mutator —
do not invent a new one.

Neither helper is wired into the engine yet. Both are covered by unit
tests.

**Files touched**: `NewAutoLayoutEngine/AnchorRebind.ts` (new),
`NewAutoLayoutEngine/AnchorRebind.spec.ts` (new).

**Acceptance**: `pickCardinalAnchor` unit tests cover all 8 octants plus
tie-break cases; `rebindLatchToAnchor` test verifies detach+attach on a
stubbed latch/anchor pair. `npm run test:unit` green.

### Step 2 — Geometric re-latch pass

Add `AnchorStrategy = "none" | "geometric" | "tala"` as a constructor
parameter on `NewAutoLayoutEngine`, default `"tala"`. Callers that want
to preserve the pre-fix behavior pass `"none"` explicitly. Add a third
pass after the block/group placement passes in `run`: if strategy is
`"geometric"`, iterate every line, resolve its source-block and target-
block post-TALA centers, call `pickCardinalAnchor` twice, and call
`rebindLatchToAnchor` for each endpoint. Lines with unresolved
endpoints are skipped.

Resolving source-block and target-block given a `LineView`: follow the
latch → anchor → containing block chain. Keep this logic inside the
engine (it does not belong in `AnchorRebind`).

**Files touched**:
`NewAutoLayoutEngine/NewAutoLayoutEngine.ts`,
`NewAutoLayoutEngine/NewAutoLayoutEngine.spec.ts`.

**Acceptance**: engine-level test with two top-level blocks and one line
(strategy `"geometric"`) — rebind sets source latch to the anchor
facing the target and vice-versa; both existing passes still run; lines
with null endpoints are skipped silently.

### Step 3 — Extend `parseTalaSvg` to return edge endpoints

Drop the base64-only class guard for connection elements
(`D2Bridge.ts::parseTalaSvg`). Introduce a second return shape
`TalaEdge = { start: {x,y}, end: {x,y} }` and change the return type to
`{ nodes: Map<string, TalaPlacement>, edges: TalaEdge[] }`. For each
`<g class="connection">` found in document order, read the inner
`<path>`'s `d` attribute, extract the first and last coordinates from
the path commands (`M x y … L|C x y`), and push a `TalaEdge`.

Update the one existing caller (`NewAutoLayoutEngine.run`) to destructure
the new shape. Nothing else consumes this function.

**Files touched**:
`NewAutoLayoutEngine/D2Bridge.ts`,
`NewAutoLayoutEngine/D2Bridge.spec.ts`,
`NewAutoLayoutEngine/NewAutoLayoutEngine.ts` (call-site only).

**Acceptance**: `parseTalaSvg` spec gains tests for: two connection
groups return two `TalaEdge`s with correct start/end; malformed path
`d` attribute falls through to `edges: []` rather than throwing; node
parsing is unchanged (all existing tests pass without modification to
their setup beyond the destructure).

### Step 4 — TALA-guided re-latch pass

When strategy is `"tala"`, use the new `edges` output from Step 3. For
each `LineView`, take its resolved source-block and target-block
(same logic from Step 2). Scan `edges`, pick the edge whose `start` is
closest to the source-block perimeter AND `end` closest to the target-
block perimeter (nearest-neighbor match). Call `pickCardinalAnchor`
using the matched edge's start/end points, then rebind.

Fallback: if `edges` is empty or no plausible match (distance exceeds
one block's half-width), fall back to geometric re-latch for that
line. This keeps behavior sensible when TALA omits an edge.

**Files touched**:
`NewAutoLayoutEngine/NewAutoLayoutEngine.ts`,
`NewAutoLayoutEngine/NewAutoLayoutEngine.spec.ts`.

**Acceptance**: engine-level test with two blocks and one line, strategy
`"tala"`, SVG contains a connection whose start/end point at the
blocks' right/left sides — rebind picks the corresponding cardinal
anchors; if the SVG has zero connections, the fallback engages and the
line still gets sane cardinal anchors.

### Step 5 — Wire the switch + verify

The engine defaults to `"tala"` (from Step 2), so the existing call
sites in `src/assets/scripts/Application/Commands/FileManagement/index.ts`
do not need code changes to get the improved behavior. Add a short
comment at each call site noting the strategy is configurable and that
`"none"` restores the pre-fix behavior. No UI toggle yet — the
constructor parameter is the configuration surface.

Manual verification: import the repro diagram
(`server/temp/bdf1c563-…json`). With strategy `"tala"`, confirm
visually that the cross-boundary line between CRM Service and SF Web
Server no longer cuts through `AWS Private Subnet` or `Internet`.
Repeat with strategy `"geometric"` and strategy `"none"` to confirm
the switch works end-to-end.

**Files touched**:
`src/assets/scripts/Application/Commands/FileManagement/index.ts`.

**Acceptance**: toggling strategy between `"none"` / `"geometric"` /
`"tala"` at the call site produces three observably different
anchor-side choices on the repro diagram; no console errors; `npm
run build` succeeds.

## Definition of done

- All five step-level acceptance criteria met.
- `npm run test:unit`, `npm run type-check`, `npm run lint` green (no
  new errors beyond the existing pre-existing lint errors on `main`).
- Manual verification passes for all three strategy values.
- No persistence or schema changes; no user-facing UI changes.

## Out of scope

- Consuming TALA's full edge waypoints (bend points) as the rendered
  line geometry. Would require replacing or bypassing the elbow
  router and is a much larger scope.
- Supporting the full 12-position anchor ring in re-latch — cardinal
  only. Diagonals can be added later without breaking the helper API.
- A user-facing settings UI for the strategy.
- Re-latching during interactive edits (this plan only touches the
  auto-layout code path).
