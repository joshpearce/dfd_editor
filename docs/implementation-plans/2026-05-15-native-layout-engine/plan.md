# NativeLayoutEngine scaffold + parity harness + engine switch

**Date:** 2026-05-15 · **Scope:** scaffold-only engine (no position math) +
temporary parity harness + multi-engine switch

## Goal & key finding

Introduce `NativeLayoutEngine` (async, TALA/D2/SVG-free), make the live
layout engine **switchable** (so two-plus engines coexist), and add a
**temporary Python-API harness** that round-trips a diagram through the real
engine code and returns the laid-out document — so a coding agent can iterate
`NativeLayoutEngine` toward parity with `NewAutoLayoutEngine`. v1 of the
native engine does no math (server returns an empty position map ⇒ no-op);
the harness is the tool used to *develop* that math.

**Confinement finding (the explicit ask):** D2/TALA/SVG are *already*
confined to `NewAutoLayoutEngine/`, `layoutDiagram` in `DfdApiClient.ts`, the
`/api/layout` route, two call sites + comments in `FileManagement/`, and
cosmetic comments in `PolyLine.ts`. Generic plumbing (`AsyncDiagramLayoutEngine`,
`inferLineFaces`, `PolyLine`, `ManualLayoutEngine`, `calculateLayout`) is
**not entangled**. The switch supersedes the original hard swap: removing the
TALA path later = drop one registry key + delete its files, zero ripple.

## Architecture additions

- **Engine registry/resolver** — a **neutral pure module** (no
  command/store/Vue imports) `resolveLayoutEngine(key, {layoutDiagram,
  nativeLayout}): AsyncDiagramLayoutEngine` binding callbacks to constructors
  (`tala→NewAutoLayoutEngine`, `native→NativeLayoutEngine`). Single source of
  truth for key→engine, importable by both the app and the standalone
  harness. OpenChart stays HTTP-free (callbacks injected, as today). Exports
  `LayoutEngineKey` + default constant. The query-string reader
  `selectedLayoutEngineKey()` is a *separate* browser-only helper that lives
  with the app wiring — the harness never imports it, so a query string
  **cannot structurally reach the harness** (enforced by the import graph,
  not by convention).
- **App selection = query string** — `?layoutEngine=native|tala` (alias
  `new`→`tala`); unknown/absent ⇒ the default constant. Both
  `FileManagement/index.ts` sites resolve through `resolveLayoutEngine`.
  **Default = `tala`** during the parity phase so layout-less imports keep
  working; flipping to `native` is a one-line constant change once parity is
  reached (that flip *is* the eventual "swap").
- **Parity harness — a fully separate module**, outside the
  Application/command graph: nothing in the app imports it and it imports no
  command/store/Vue code. Substrate: headless **Node/jsdom** (the engine
  already runs headless under jsdom — precedent:
  `NewAutoLayoutEngine.integration.spec.ts` builds factories and drives view
  primitives standalone, zero command layer). It does **not** call
  `loadExistingFile`; it invokes the same parity-relevant leaf primitives
  directly — preprocessor → factory(schema, default theme) → `new
  DiagramViewFile` → `runLayout(resolveLayoutEngine(param, callbacks))` →
  `toExport()` — printing `{engine, ms, document}`. `POST
  /api/layout-harness` (Flask, beside `layout()`) shells the entry (stdin job
  JSON) and returns stdout. Invariants: never writes `storage`/`DATA_DIR`;
  never touches a browser/editor session; never imports the query-string
  reader. Deletable in one commit alongside the TALA path. Fallback if jsdom
  fidelity is insufficient: a dedicated headless Vite harness route via
  Playwright — heavier, deferred.

## Data model & boundaries

- **Interface:** `AsyncDiagramLayoutEngine.run(objects): Promise<void>` —
  in-place mutation.
- **Reuse:** `NativeLayoutEngine.run()` = serialize canvas (same path as
  `DiagramViewFile.toExport()`) → injected `NativeLayoutSource` → `new
  ManualLayoutEngine(map).run(objects)`. `PositionMap` is the same type as
  `DiagramViewExport.layout`; empty map ⇒ provable no-op.
- **New API:** `POST /api/native-layout` → `{"layout":{}}` (scaffold).
  `POST /api/layout-harness` → `{engine, ms, document}` (dev-only).

## Multi-lens notes

- **Security:** `/api/layout-harness` shells a Node subprocess — same posture
  as the existing `/api/layout` `d2` shell. Fixed argv list (no `shell=True`),
  job JSON via stdin (no string interpolation), localhost-only dev server,
  CORS unchanged. Strictly within the existing trust zone.
- **Perf:** harness is the iteration loop — jsdom keeps it ~sub-second vs.
  multi-second browser launches; that speed is the whole point.
- **Ops:** harness needs Flask reachable (engines' HTTP callbacks); document
  "run under `npm run dev:all`". TALA still needs `d2`; native does not.
- **Product:** registry generalizes to N engines and makes the TALA deletion
  a localized change behind a stable contract.

## Steps

### Step 1 — Server: scaffold `POST /api/native-layout`

Route in `editor_api.py` beside `layout()`: parse JSON (400 if not), return
`{"layout":{}}` 200. No subprocess/pydantic/transform. Note in
`server/CLAUDE.md`.
- **Files:** `editor_api.py`, `server/CLAUDE.md`, server test.
- **Tests:** valid JSON→200 `{"layout":{}}`; non-JSON→400.
- **AC:** `pytest` green; no `d2`/`tala` in the new code.

### Step 2 — Client: `nativeLayout()` API function

Add `nativeLayout(doc): Promise<PositionMap>` to `DfdApiClient.ts`, mirroring
`layoutDiagram` error handling; returns `body.layout`.
- **Files:** `DfdApiClient.ts` (+ spec).
- **Tests:** mocked fetch resolves to parsed map; non-2xx throws backend msg.
- **AC:** `npm run type-check` clean; test green; no D2/SVG vocabulary.

### Step 3 — `NativeLayoutEngine` + neutral engine resolver

New `DiagramLayoutEngine/NativeLayoutEngine/` (class + `index.ts`, barrel)
implementing the async interface via the reuse path above. New **neutral**
module (no command/store/Vue imports) exporting `resolveLayoutEngine(key,
callbacks)` + `LayoutEngineKey` + `DEFAULT_LAYOUT_ENGINE = "tala"`. The
browser-only `selectedLayoutEngineKey()` (reads `location.search`) is
*separate* and lands with the app wiring in Step 4, not in this module.
- **Files:** new engine dir + barrel; new resolver module in a neutral
  location (e.g. beside `api/`) importable by both app and harness without
  coupling.
- **Tests:** empty map ⇒ positions unchanged; non-empty ⇒ object moves;
  rejection propagates; resolver maps each key to the right class, falls back
  to default on garbage; a test asserting the resolver module has no
  command/store/Vue import.
- **AC:** type-checks; engine imports nothing from `api/` or
  `D2Bridge`/`AnchorRebind`; resolver importable from a non-Vue context.

### Step 4 — Wire the switch (app only) + comment hygiene

Add the browser-only `selectedLayoutEngineKey()` helper here. Replace both
`new NewAutoLayoutEngine(layoutDiagram)` (FileManagement ~76/199) with
`resolveLayoutEngine(selectedLayoutEngineKey(), {layoutDiagram,
nativeLayout})`. Fix imports. Neutralize TALA/AnchorStrategy comments here,
in `AutoLayoutActiveFile.ts`, and origin comments in `PolyLine.ts`.
- **Files:** `FileManagement/index.ts` (+ `selectedLayoutEngineKey`),
  `AutoLayoutActiveFile.ts`, `PolyLine.ts`.
- **Tests:** existing FileManagement/PolyLine suites green; `?layoutEngine=
  native` vs `tala` selects the expected engine.
- **AC:** `npm run build` + `lint` clean; default load uses `tala`;
  `?layoutEngine=native` constructs `NativeLayoutEngine`; no harness file
  imports this glue.

### Step 5 — Parity harness, standalone module (~1.5 SP — heaviest; splittable)

Self-contained harness in its own directory (e.g. `tools/layout-harness/` or
`src/assets/scripts/LayoutHarness/`) the app never imports. It directly
invokes preprocessor → factory(schema, default theme) → `new DiagramViewFile`
→ `runLayout(resolveLayoutEngine(param, callbacks))` → `toExport()`, emitting
`{engine, ms, document}`; it does **not** call `loadExistingFile` or any
command/store/Vue code. `POST /api/layout-harness` shells it (stdin job JSON,
fixed argv list); 400 bad input, 502 non-zero exit/timeout. Docs:
`server/CLAUDE.md`, `OpenChart/CLAUDE.md`, root `CLAUDE.md`.
- **Files:** new standalone harness dir (TS, repo's ESM/jsdom runner);
  `editor_api.py`; three `CLAUDE.md`.
- **Tests:** `engine=tala` ⇒ `layout` populated; `engine=native` ⇒ geometry
  unchanged; endpoint 400/502; no file written under `server/data/`; a guard
  test asserting the harness import graph excludes `Application/Commands` /
  Pinia / Vue / `selectedLayoutEngineKey`; confinement grep gate.
- **AC:** `curl -XPOST /api/layout-harness {diagram, engine:"tala"}` returns
  laid-out doc + `ms`; `engine:"native"` returns input geometry; suites +
  `pytest` green; deleting the harness dir + the `tala` key leaves the app
  building.

## Definition of done

All step ACs met. `npm run build`, `lint`, `test:unit`, server `pytest`
green. The app selects engines by `?layoutEngine=…` (default `tala`);
`NativeLayoutEngine` + `/api/native-layout` complete as a no-op.
`/api/layout-harness` round-trips either engine and returns
`{engine, ms, document}` without persisting state or affecting any browser
session. The harness is a standalone module that shares only the pure
resolver + view/config leaf primitives with the app; nothing in the app
imports it, it cannot read a query string (no import path to the reader), and
deleting its directory plus the `tala` key leaves the app building.
`NewAutoLayoutEngine`, `/api/layout`, `layoutDiagram` remain intact, compile,
and are reachable only via the `tala` key — deletable later in one localized
commit. No D2/TALA/SVG reference is reachable from the live path except
neutralized comments.
