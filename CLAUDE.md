# dfd_editor

Last verified: 2026-04-21

Browser-based Data Flow Diagram (DFD) editor. Scaffolded from MITRE's
Apache-2.0 [attack-flow](https://github.com/center-for-threat-informed-defense/attack-flow)
(specifically `src/attack_flow_builder/`) and then hard-forked. Pairs a Vue 3
SPA with a small Flask backend for server-side file storage.

## Tech Stack

- **Language:** TypeScript ^6.0 (compiled via `vue-tsc` ^3.2), Vue ^3.5
- **State:** Pinia ^3.0
- **Build:** Vite ^8.0 (ESM, `"type": "module"`)
- **Runtime target:** Node 22 (`@tsconfig/node22`)
- **Testing:** Vitest ^4.1 (+ `@vue/test-utils`, jsdom)
- **Lint:** ESLint ^10.2 with `@vue/eslint-config-typescript` and
  `@stylistic/*` plugins
- **Render/math libs:** d3 ^7.9 (camera/coordinate math only), flexsearch,
  luxon
- **Backend:** Python 3 Flask (`flask>=3.0`, `flask-cors>=4.0`) in `server/`,
  runs in a local `server/.venv`

## Commands

From `package.json` (canonical):

- `npm run dev` — Vite dev server (http://localhost:5173)
- `npm run dev:flask` — Flask backend on port 5050 (uses `server/.venv`)
- `npm run dev:all` — both concurrently
- `npm run build` — parallel `type-check` + `build-only` (vue-tsc then `vite build`)
- `npm run build-only` — `vite build` without type-check
- `npm run type-check` — `vue-tsc --build`
- `npm run preview` — preview the production build
- `npm run test:unit` — Vitest single run
- `npm run test:watch` — Vitest watch mode
- `npm run lint` / `npm run lint:fix`

### Flask backend

Declared in `server/app.py`, deps in `server/requirements.txt`. First-time
setup:

```
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then `npm run dev:flask` (or `npm run dev:all`). The server persists diagrams
as JSON files under `server/data/` and exposes `/api/health`,
`/api/diagrams[/<id>]` (GET/POST/PUT), `/api/diagrams/<id>/export` + `/api/diagrams/import`
for the minimal DFD interchange format, and `/api/layout` (shells `d2 --layout=tala`
for `NewAutoLayoutEngine`). CORS is allowed only for `http://localhost:5173`.
See `server/CLAUDE.md` for the full contract.

### TALA auto-layout

`NewAutoLayoutEngine` (under `OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/`)
is an async layout engine used for coord-less imported diagrams. It serializes
the canvas to D2, POSTs to `/api/layout`, and re-parses the returned TALA SVG to
place blocks/groups. `d2` with the TALA plugin must be on the server's `PATH`;
without it, `/api/layout` returns 502 rather than failing at startup. Line
endpoints are then rebound via an `AnchorStrategy` (default `"tala"`, which
uses TALA's own edge endpoints + polyline bend to pick anchor faces and steer
the handle; `"geometric"` and `"none"` also supported — see the engine source).
After a `loadFileFromServer` call triggers auto-layout (i.e. the stored file
had no `layout`), the result is PUT back to the server so subsequent opens
skip TALA and reuse the stable positions.

## Project Structure

- `src/assets/scripts/OpenChart/` — the diagram engine (model, view, editor,
  commands, layout, plugins). Originally copied from upstream
  `attack_flow_builder`; **substantially modified in this repo**. Trust-
  boundary / group work (GroupBoundsEngine, style-aware GroupFace,
  PowerEditPlugin, Mover family, nested groups, LCA reparenting, corner-snap,
  arrow-nudge, snap-grid) lives here.
- `src/assets/scripts/Application/` — app-level commands, stores glue,
  file-management commands (server save/load lives here).
- `src/assets/scripts/Browser/` — browser-side utilities.
- `src/assets/scripts/api/` — HTTP client for the Flask backend
  (`DfdApiClient.ts`: list/create/get/save, minimal-format import/export, TALA
  layout).
- `src/assets/scripts/OpenChartFinder/` — search/index over diagram contents.
- `src/assets/scripts/SegmentLayoutEngine/` — layout helpers.
- `src/assets/scripts/StixToAttackFlow/` — vestigial STIX-import code carried
  over from upstream; not used for DFDs, but still present.
- `src/assets/scripts/PointerTracker.ts` — shared pointer/input state.
- `src/assets/configuration/` — the DFD fork point. `app.configuration.ts`
  wires together the `Dfd*` directories: `DfdTemplates/`, `DfdThemes/`,
  `DfdPublisher/`, `DfdValidator/`, `DfdFilePreprocessor/`,
  `DfdCommandProcessor/`. Replacing these directories is how you change what
  the app is.
- `src/components/`, `src/stores/` — Vue UI and Pinia stores.
- `src/App.vue`, `src/main.ts` — entry points.
- `server/` — Flask backend + `data/` persistence directory.
- `docs/` — forward-looking design / requirements notes (human-authored;
  see "Boundaries" below).
- `tools/` — build/dev tooling.
- `public/`, `dist/` — static assets and build output.

## Conventions

- Unit tests are colocated with sources as `*.spec.ts` (Vitest). Example:
  `DiagramModel/DiagramModel.spec.ts`.
- TypeScript is strict; the build fails on type errors via `vue-tsc`.
- Lint on save; `npm run lint:fix` for mechanical fixes.
- "API creates the diagram, user edits in the browser" workflow is backed by
  the Flask server's `/api/diagrams` endpoints (see `server/` and
  `src/assets/scripts/api/DfdApiClient.ts`). Server save/load is the default
  file surface (`1e5a7af feat(files): make server save/load the default`); the
  recovery bank is a fallback only. An upstream `?src=<url>` query parameter
  is not wired in this fork.
- Per-domain context lives in sibling `CLAUDE.md` files: `server/CLAUDE.md`,
  `src/assets/configuration/CLAUDE.md`, and
  `src/assets/scripts/OpenChart/CLAUDE.md`. Prefer updating those over
  inflating this file when changing a specific domain.

## Boundaries

- `src/assets/scripts/OpenChart/` — **our fork**, not upstream-verbatim.
  Since the scaffold commit it has gained a large body of changes (trust-
  boundary integration, TALA auto-layout, data-item modeling) reaching
  deep into the model, view, and editor layers. Edits here are expected
  and precedented.
- `src/assets/configuration/Dfd*/` — primary place to change schema, theme,
  persistence, or validation behavior.
- `server/data/` — user diagram storage. Do not hand-edit; do not commit.
- `node_modules/`, `dist/`, `package-lock.json` — generated, never hand-edit.
- `docs/` — human-authored design and implementation notes.
  `flow-schema-overhaul-requirements.md` is the pre-plan requirements doc
  that motivated the bidirectional `Flow` rework (that work has now
  landed on the `bidirectional-flow` branch — see the Conventions
  section). `docs/implementation-plans/2026-04-21-bidirectional-flow/`
  contains the seven-phase plan and test-requirements that drove the
  cutover; phase plans are kept (not purged) as the authoritative record
  of scope transfers and amendments. Treat implementation-plan contents
  as historical context — current-state contracts live in the relevant
  domain `CLAUDE.md`.
- `src/assets/scripts/StixToAttackFlow/` — upstream vestige; safe to ignore
  but don't delete without confirming no stray imports.
