# dfd_editor

Last verified: 2026-04-14

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
as JSON files under `server/data/` and exposes `/api/health` and
`/api/diagrams[/<id>]` (GET/POST/PUT). CORS is allowed only for
`http://localhost:5173`.

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
- `src/assets/scripts/api/` — HTTP client for the Flask backend.
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
- `docs/` — design notes and phase plans (human-authored; see below).
- `tools/` — build/dev tooling.
- `public/`, `dist/` — static assets and build output.

## Conventions

- Unit tests are colocated with sources as `*.spec.ts` (Vitest). Example:
  `DiagramModel/DiagramModel.spec.ts`.
- TypeScript is strict; the build fails on type errors via `vue-tsc`.
- Lint on save; `npm run lint:fix` for mechanical fixes.
- "API creates the diagram, user edits in the browser" workflow is now
  backed by the Flask server's `/api/diagrams` endpoints (see `server/` and
  `src/assets/scripts/api/DfdApiClient.ts`). `docs/getting-started.md`
  describes an upstream `?src=<url>` query parameter, but that path is not
  currently wired in this fork — server HTTP is the working surface.
- Subdirectory `CLAUDE.md` files are expected (follow-up phase) under
  `src/assets/configuration/`, `src/assets/scripts/OpenChart/`, and `server/`
  to capture per-domain contracts. None exist yet.

## Boundaries

- `src/assets/scripts/OpenChart/` — **our fork**, not upstream-verbatim.
  Since the scaffold commit it has gained ~316 files of changes (trust-
  boundary integration reaches deep into the model, view, and editor layers).
  Edits here are expected and precedented. Note: `docs/getting-started.md`
  describes an initial intent to keep OpenChart untouched; that intent was
  abandoned.
- `src/assets/configuration/Dfd*/` — primary place to change schema, theme,
  persistence, or validation behavior.
- `server/data/` — user diagram storage. Do not hand-edit; do not commit.
- `node_modules/`, `dist/`, `package-lock.json` — generated, never hand-edit.
- `docs/` — read for context. Phase plans (`trust-boundary-phase-*.md`,
  `trust-boundary-integration-plan.md`, `flask-backend-plan.md`) are
  historical records of completed work; treat as background, not as
  current-state documentation.
- `src/assets/scripts/StixToAttackFlow/` — upstream vestige; safe to ignore
  but don't delete without confirming no stray imports.
