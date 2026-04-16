# TALA Layout Integration — Implementation Plan

Last verified: 2026-04-16

Fills in the `NewAutoLayoutEngine` stub (commit `5d850f5`) so that
coord-less diagrams get positions from TALA via the `d2 --layout=tala`
binary. Design rationale is in `docs/tala-layout-integration-notes.md`;
this plan is the execution split.

## Shape of the solution

- **Backend (`server/`)** — add a single thin endpoint,
  `POST /api/layout`, that pipes a D2 source string through
  `d2 --layout=tala` and returns the rendered SVG. It does **not**
  know DFD schema.
- **Frontend D2 bridge** — pure module that (a) walks a DFD canvas and
  emits D2 source with explicit `width`/`height` per node (and D2
  containers for groups), and (b) parses TALA's SVG response into an
  `id → {x, y}` map.
- **`NewAutoLayoutEngine.run()`** — becomes async, calls the bridge,
  `fetch`es the endpoint, and applies positions back onto the view.
  The existing `DiagramLayoutEngine` contract changes from `void` to
  `Promise<void>`; both call sites in `FileManagement/index.ts` already
  sit in `async` functions.

## Decisions baked in (not up for re-litigation)

- D2 binary is assumed on `PATH` (verified locally:
  `/opt/homebrew/bin/d2 0.7.1`, with `d2plugin-tala` available).
- Source is passed via **stdin**, never argv — prevents shell/arg
  injection from node labels.
- Subprocess timeout 30s; stderr captured and surfaced on non-zero
  exit.
- Groups (trust boundaries) are emitted as D2 containers from v1.
  DFD's reason-for-being is trust boundaries; flat-only layout would
  misplace every realistic diagram.
- On layout failure, the error propagates; the load path logs it and
  proceeds without applied positions (nodes land at model defaults)
  rather than blocking file load.

## Steps

### Step 1 — `POST /api/layout` endpoint

Add one route to `server/app.py`. Accepts
`{"source": "<d2 text>"}`, runs
`subprocess.run(["d2", "--layout=tala", "-", "-"], input=source,
capture_output=True, timeout=30)`, returns `{"svg": <stdout>}` on
success or `{"error": <stderr>}` with HTTP 502 on non-zero exit /
timeout. No CORS widening — existing `:5173` scope is sufficient.

**Files**: `server/app.py`.

**Acceptance**:
- `curl -XPOST /api/layout -d '{"source":"a -> b"}'` returns 200 with
  an `svg` field containing `<svg …>` payload.
- Empty/invalid source → 502 with `error` string from `d2` stderr.
- Endpoint rejects non-JSON or missing `source` with 400.
- Subprocess bounded by 30s (verify by inspection of the code path
  and a crafted timeout-short test if feasible).
- No regression: existing `/api/diagrams` routes still respond as
  before.

### Step 2 — D2 bridge module (pure)

New module colocated under
`src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/`:

- `serializeToD2(canvas: DiagramObjectView): string`
  - Walks `canvas.blocks` / `canvas.groups` (recursively) / `canvas.lines`.
  - Per block: emit `<id>: { shape: <mapped>; width: <face.width>;
    height: <face.height>; label: <quoted label or empty> }`. Shape
    mapping is a small table keyed by `face` concrete class
    (`DictionaryBlock` → `rectangle`/`cylinder` as appropriate, etc.);
    unknown faces default to `rectangle`.
  - Per group: emit as D2 container wrapping its children, preserving
    `face.width`/`height` as explicit sizes.
  - Per line: emit `<sourceId> -> <targetId>` using endpoint block ids.
  - Ids and labels are quoted/escaped to be D2-safe (quote strings
    containing spaces, escape embedded quotes).
- `parseTalaSvg(svg: string): Map<string, {x: number; y: number}>`
  - Uses `DOMParser` (browser-native, already available in the Vite
    runtime and jsdom for tests).
  - Locates shape `<g>` elements by the data attribute / class that
    encodes the node id (determined empirically in Step 3) and extracts
    top-left from their `transform` / child `<rect x y>`.

**Files**: new `D2Bridge.ts` + `D2Bridge.spec.ts` colocated.

**Acceptance**:
- Unit tests exercise a 2-block + 1-group + 1-line fixture: serializer
  output contains one D2 statement per node/edge with explicit
  `width`/`height`, and container nesting matches the fixture.
- Label-escaping test covers spaces, quotes, and reserved D2 chars
  (`:`, `->`, `{`).
- Parser test: given a canned SVG with two known shape groups, returns
  a map with both ids and the x/y the SVG encoded.
- Module has **no** imports from Vue, Pinia, `components/`, or the
  HTTP client — keeps the OpenChart boundary clean (per
  `OpenChart/CLAUDE.md`).

### Step 3 — Sample round-trip calibration

Per the notes (§"Verify on a sample before trusting output"), before
wiring TALA into the main flow, round-trip one representative diagram
and confirm sizes line up.

Manual procedure (a small helper in `tools/` is optional):

1. Pick one coord-less diagram from `server/data/` (or craft a minimal
   one: two blocks, one group, one edge).
2. Run `serializeToD2` on it, pipe the result to
   `d2 --layout=tala`, parse the SVG via `parseTalaSvg`.
3. Compare each node's TALA-reported `{width, height}` (read from the
   same SVG) against the editor's `face.width`/`face.height`. If TALA
   has added per-shape padding (cylinder caps, container inner
   padding), record the delta and adjust the shape-mapping table in
   `D2Bridge` (or emit smaller `width`/`height` to compensate) until
   deltas are zero.

**Files**: possibly small fixes to the shape-mapping table in
`D2Bridge.ts`; a notes update in
`docs/tala-layout-integration-notes.md` if new gotchas surface.

**Acceptance**:
- For the sample diagram, every block's applied coordinates place its
  editor-bounded rectangle inside TALA's intended footprint with zero
  overlap.
- Any discovered per-shape padding is either compensated in the bridge
  or explicitly documented as a follow-up with a reproducer.

### Step 4 — Async engine + wire-up

- Change `DiagramLayoutEngine.run` to return `Promise<void>` (engine
  interface in `DiagramView/DiagramLayoutEngine/DiagramLayoutEngine.ts`).
- Update existing implementations (`AutomaticLayoutEngine`) to return
  `Promise.resolve()` — no behavior change.
- Update `DiagramViewFile.runLayout` to be `async` and propagate the
  promise.
- Add `layoutDiagram(source: string): Promise<string>` to
  `src/assets/scripts/api/DfdApiClient.ts` (thin `fetch` wrapper around
  `/api/layout`).
- Fill in `NewAutoLayoutEngine.run`:
  `serializeToD2` → `layoutDiagram` → `parseTalaSvg` → iterate canvas
  descendants and call `node.moveTo(x, y)` for matched ids; for
  groups, move the group (children move atomically per the engine
  invariants in `OpenChart/CLAUDE.md`).
- Update both call sites in
  `src/assets/scripts/Application/Commands/FileManagement/index.ts`
  (lines 74 and 238) to `await viewFile.runLayout(...)` wrapped in
  `try/catch` that logs and continues on failure.

**Files**:
`OpenChart/DiagramView/DiagramLayoutEngine/DiagramLayoutEngine.ts`,
`NewAutoLayoutEngine.ts`, `AutomaticLayoutEngine.ts`,
`DiagramViewFile.ts`, `api/DfdApiClient.ts`,
`Application/Commands/FileManagement/index.ts`,
`NewAutoLayoutEngine.spec.ts` (new).

**Acceptance**:
- `npm run type-check` green; no lingering `void`-returning
  `DiagramLayoutEngine` implementations.
- `NewAutoLayoutEngine.spec.ts`: with the API client mocked to return
  a canned SVG, `run(canvas)` mutates each block's `{x, y}` to match
  the parsed positions; a rejected mock propagates and the spec
  asserts the thrown error shape.
- `npm run test:unit` green.
- Manual: `npm run dev:all`, create a new diagram via
  `POST /api/diagrams`, open it in the editor — the blocks appear at
  TALA-computed positions, not stacked at origin. Reload a diagram
  that already has a `layout` field — TALA is **not** invoked (the
  existing `if (!jsonFile.layout)` guard is unchanged).

## Definition of done

- All four step-level acceptance criteria met.
- `npm run build` (type-check + Vite) succeeds.
- `npm run test:unit` and `npm run lint` pass with no new warnings.
- A coord-less diagram round-trips from `POST /api/diagrams` → editor
  load → TALA layout → drag + `PUT` save → reload, and on reload the
  saved positions are used (layout engine is skipped) — i.e., TALA
  participates only on the coord-less path, as intended.
- `docs/tala-layout-integration-notes.md` updated if Step 3 uncovered
  a new calibration gotcha worth recording.
