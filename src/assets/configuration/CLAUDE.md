# Configuration (DFD Fork Point)

Last verified: 2026-04-21

## Purpose
This directory is what turns the upstream attack-flow builder scaffold into a DFD editor. Everything DFD-specific (schema, themes, export format, validation, incoming-file handling) lives here; the rest of the app is domain-agnostic and consumes what this directory declares.

## Contracts
- **Exposes**: `AppConfiguration` default export from `app.configuration.ts`, wiring a `schema` (`DfdCanvas` + `BaseTemplates` + `DfdObjects`), two `themes` (Light, Dark), and `validator` / `publisher` / `filePreprocessor` / `cmdProcessor` factories.
- **Guarantees**:
  - Schema id `dfd_v1`; file extension `.dfd`.
  - Templates: `process`, `external_entity`, `data_store` (Blocks); `data_flow` (Line); `trust_boundary`, `container` (Groups); plus base `horizontal_anchor` / `vertical_anchor` / `generic_latch` / `generic_handle`.
  - Every non-base template has exactly one `is_representative: true` property (currently `name`).
  - Every template name referenced by a theme `designs` map corresponds to a real template (and vice versa for renderable types).
  - `DfdCanvas` carries a `data_items` `ListProperty<DictionaryProperty>` keyed by item GUID; each sub-dict has `parent`, `identifier`, `name` (required) plus optional `description` and `classification`.
  - `data_flow` template carries `data_item_refs`: `ListProperty<StringProperty>` (default `[]`), holding GUIDs of canvas-level data items that flow through the edge.
  - `DfdPublisher` emits `{ nodes, edges }` JSON via `SemanticAnalyzer.toGraph`, with node `parent` and edge `crosses` preserved — so trust-boundary containment and crossings round-trip.
  - `DfdFilePreprocessor` is currently pass-through (no legacy migration).
  - `DfdCommandProcessor` is currently pass-through (returns `undefined`).
  - Both themes assign `FaceType.DynamicLine` to `data_flow`. The `data_item_refs` property still round-trips (schema, publisher, preprocessor, validator all intact) for a future properties-panel / hover-tooltip feature.
- **Expects**: OpenChart's `DiagramObjectType`, `PropertyType`, `FaceType`, `FaceDesign`, `CanvasTemplate`, `DiagramObjectTemplate`, `DiagramThemeConfiguration` contracts from `@OpenChart/*`; `AppConfiguration`, `FilePublisher`, `FilePreprocessor`, `FileValidator` from `src/assets/scripts/Application/`.

## Dependencies
- **Uses**: `src/assets/scripts/OpenChart/` (engine types, `SemanticAnalyzer`, `ThemeLoader` styles/colors), `src/assets/scripts/Application/` (app-level interfaces).
- **Used by**: `src/main.ts` / app boot path (imports the default `configuration`), splash/file-open flows, and anything that reads schema via the Application layer.
- **Boundary**: do not import from `src/components/`, `src/stores/`, or Vue code. This directory is declarative config consumed by those layers, not the other way around.

## Key Decisions
- `DictionaryBlock` is the default face for Process / External Entity / Data Store so their enum/list properties (trust level, storage type, PII flags, etc.) render as structured key/value rows rather than free text.
- Trust boundary is a `DiagramObjectType.Group` (not an overlay) so the semantic graph's `trustBoundaryAncestors` and edge `crossings` come from real containment — the validator and publisher depend on this.
- Both themes key their `designs` map by template `name`, so adding a template requires adding a matching design in every theme.
- Publisher emits a flat `{ nodes, edges }` JSON (not the internal view export) — that's the stable on-disk contract consumers see.

## Invariants
- Exactly one property per template carries `is_representative: true` (the label-producing field).
- Every `name` appearing in `DfdObjects` / `BaseTemplates` / `DfdCanvas` must have a matching entry in each theme's `designs` map.
- `data_flow.handle_template` and `latch_template` names must resolve to entries in `BaseTemplates`.
- `DfdValidator.PRIVILEGE_RANK` keys must stay in sync with the `trust_boundary.privilege_level` enum options.
- `data_item_refs` GUIDs must resolve to entries in the canvas `data_items` list; dangling refs produce validator warnings (non-blocking). `DfdValidator.validateDataItemRefs` enforces this.

## Key Files
- `app.configuration.ts` — single plug-in point assembling schema, themes, and processor factories into the exported `AppConfiguration`.
- `DfdTemplates/index.ts` — re-exports `DfdCanvas`, `DfdObjects`, `BaseTemplates`.
- `DfdTemplates/DfdCanvas.ts` — canvas template (`dfd`) with diagram-level metadata.
- `DfdTemplates/DfdObjects.ts` — the five DFD element templates plus generic `container`.
- `DfdTemplates/BaseTemplates.ts` — engine-required anchor / latch / handle templates.
- `DfdTemplates/AnchorFormat.ts` — shared `AnchorConfiguration` used by Block templates.
- `DfdThemes/LightTheme.ts`, `DfdThemes/DarkTheme.ts` — `FaceType` + style per template name.
- `DfdPublisher/DfdPublisher.ts` — exports graph as `{ nodes, edges }` JSON (extension `json`).
- `DfdFilePreprocessor/DfdFilePreprocessor.ts` — pass-through hook for incoming `DiagramViewExport` (the place to add API/`?src=` mapping if the on-disk shape diverges).
- `DfdValidator/DfdValidator.ts` — required-field check plus trust-boundary / crossing rules (C4, C5, auth/encryption, classification vs. privilege rank).
- `DfdCommandProcessor/DfdCommandProcessor.ts` — pass-through command hook.

## Gotchas
- Template and theme shapes couple tightly to OpenChart's `FaceDesign` / `FaceType` unions; engine-level refactors surface here first as type errors (see commits `ace7b29` "satisfy FaceDesign types in Dark/Light themes" and `9fd2e1c` "correct DFD template and theme type errors").
- Adding a template without updating both themes will silently render as missing design at runtime — keep Light and Dark in lockstep.
- Publisher output is derived from `SemanticAnalyzer.toGraph`, not the raw view; changes to semantic graph shape change the on-disk contract.
- `DfdValidator.validateBoundary` only inspects direct children for the out-of-scope rule; nested boundaries are not recursed (documented in code comment, intentional for now).
- `DfdFilePreprocessor` being pass-through is a contract: if/when a server-driven `?src=<url>` workflow needs shape mapping, this is the single place to add it.
