# DFD Editor — Getting Started

This project builds a browser-based **Data Flow Diagram (DFD) editor** by forking and re-skinning MITRE's [Attack Flow Builder](https://github.com/center-for-threat-informed-defense/attack-flow). The Attack Flow Builder is a thin configuration layer on top of an in-house, schema-driven diagram engine called **OpenChart**, so we get node editing, connection routing, containment, undo/redo, theming, file I/O, and validation for free. We only supply DFD-specific templates, themes, and a publisher.

---

## 1. Why fork Attack Flow Builder

- **Apache-2.0 licensed**, free to fork and rebrand.
- Ships a production-quality diagram engine (OpenChart) with a clean separation between engine (`scripts/OpenChart/`) and app (`configuration/`).
- **First-class containers.** `DiagramObjectType.Group` is a model class that holds child blocks and lines, nests recursively, and has built-in commands for add/remove/move-with-parent. This is exactly what trust boundaries need, and it is the single hardest thing to build from scratch.
- **Data-driven schema and theming.** Node types are declared as TypeScript template objects, not hard-coded components. Replace one file, get a different app.
- **Pluggable publisher/validator/preprocessor.** You choose the on-disk format.
- **Auto-load from URL.** The builder supports `?src=<url>` to load a file on page open, which satisfies the "API creates the diagram, user edits in the browser" workflow.

## 2. Upstream architecture at a glance

```
src/attack_flow_builder/
├── src/assets/
│   ├── scripts/
│   │   └── OpenChart/              ← reusable diagram engine (keep as-is)
│   │       ├── DiagramModel/       ← Block, Line, Group, Canvas, Anchor…
│   │       │   └── DiagramObjectFactory/
│   │       │       ├── DiagramObjectType.ts        (enum of core types)
│   │       │       └── DiagramSchemaConfiguration.ts (schema shape)
│   │       ├── DiagramView/        ← Faces (visual): DictionaryBlock,
│   │       │                          BranchBlock, TextBlock, DynamicLine,
│   │       │                          DotGridCanvas, GroupFace…
│   │       └── DiagramEditor/      ← commands, plugins, undo/redo, layout
│   └── configuration/              ← the only directory we rewrite
│       ├── app.configuration.ts    (entry point — swaps everything)
│       ├── AttackFlowTemplates/    → becomes DfdTemplates/
│       ├── AttackFlowThemes/       → becomes DfdThemes/
│       ├── AttackFlowPublisher/    → becomes DfdPublisher/
│       ├── AttackFlowValidator/    → becomes DfdValidator/
│       ├── AttackFlowFilePreprocessor/ → becomes DfdFilePreprocessor/
│       └── AttackFlowCommandProcessor/ → becomes DfdCommandProcessor/
```

Stack:
- **Vue 3** + **Pinia** (state) + **Vite** (bundler) + **TypeScript 5**
- **d3** (used only for camera/pan-zoom math and screen coordinates, not for rendering nodes)
- Rendering is custom SVG/Canvas via the OpenChart `DiagramInterface` and `Face` system — no external chart library
- Node 22 / TypeScript ~5.6

Builder lives in `src/attack_flow_builder/`. Parallel `src/attack_flow/` is the Python CLI/library for validation and STIX export — **not needed** for DFDs, delete it.

## 3. Core engine concepts

### 3.1 Object types

`DiagramObjectType` defines every class of thing that can live on the canvas:

| Type | Purpose | DFD mapping |
|---|---|---|
| `Canvas` | The root drawing surface | The DFD document itself |
| `Block` | A rectangular (or custom-faced) node | Process, External Entity, Data Store |
| `Line` | A connector between anchors | Data Flow |
| `Group` | A container that owns child blocks and lines | **Trust Boundary** |
| `Anchor` | A connection point on a block | (automatic, per-template) |
| `Latch` | The endpoint of a line attached to an anchor | (automatic) |
| `Handle` | A drag handle for resize / routing | (automatic) |

`Group` is the killer feature here. Unlike most browser-based diagram tools, it is part of the model, not an overlay: moving a group moves its children, nesting is supported (`AddGroupToGroup` command), and the visual `GroupFace` draws the border and resizes to fit contents.

### 3.2 Schema

```ts
// OpenChart/DiagramModel/DiagramObjectFactory/DiagramSchemaConfiguration.ts
export type DiagramSchemaConfiguration = {
  id: string;
  canvas: CanvasTemplate;
  templates: DiagramObjectTemplate[];
};
```

A template declares the *data* for a node type — its name, namespace, `DiagramObjectType`, field properties (with types, defaults, validators, enums, nested dicts), and anchor configuration. Engine consumes templates; UI builds a property editor from them automatically.

### 3.3 Themes

A theme is a map from template-name → `FaceType` + style object. Faces available out of the box:

| `FaceType` | Look |
|---|---|
| `DictionaryBlock` | Rectangle with a colored header bar and key/value rows for each property. The workhorse. |
| `BranchBlock` | Block with multiple labeled output anchors (for decisions / conditions). |
| `TextBlock` | Minimal labeled rectangle. |
| `DynamicLine` | Routed connector with arrowheads. |
| `DotGridCanvas` / `LineGridCanvas` | Two canvas backgrounds. |
| `GroupFace` | Container rendering. |
| `AnchorPoint`, `LatchPoint`, `HandlePoint` | Interactive handles. |

Creating a new shape = subclass `BlockFace` under `OpenChart/DiagramView/DiagramObjectView/Faces/Blocks/`, register a new `FaceType`, reference it from the theme.

## 4. DFD schema design

### 4.1 Node types and their mappings

| DFD element | `DiagramObjectType` | Suggested `FaceType` | Notes |
|---|---|---|---|
| **Process** (`1.0 Authenticate user`) | `Block` | `DictionaryBlock` (blue) | Classic circular notation would need a new `CircleBlock` face. Rectangles are fine and industry-acceptable. |
| **External Entity** (`User`, `Third-party API`) | `Block` | `DictionaryBlock` (orange) | |
| **Data Store** (`Users DB`, `Session cache`) | `Block` | `DictionaryBlock` (gray) by default; add `OpenSidedBlock` face if strict Yourdon/DeMarco notation is required | |
| **Data Flow** (arrow with label) | `Line` | `DynamicLine` | Carries `name`, `data_classification`, `protocol` |
| **Trust Boundary** (dashed container) | `Group` | `GroupFace` (dashed border, translucent fill) | Supports nesting — e.g. "AWS VPC" containing "Private subnet" |

### 4.2 Suggested property schema (starting point)

```ts
process: {
  name: string (required, representative),
  description: string,
  number: string,                 // "1.0", "1.1", etc for hierarchical numbering
  trust_level: enum,              // public / authenticated / admin / system
  assumptions: list<string>,
}
external_entity: {
  name: string (required, representative),
  description: string,
  entity_type: enum,              // user / service / system / device
  out_of_scope: bool,
}
data_store: {
  name: string (required, representative),
  description: string,
  storage_type: enum,             // database / cache / file / queue / bucket
  contains_pii: bool,
  encryption_at_rest: bool,
}
data_flow: {                       // Line
  name: string (required, representative),
  data_classification: enum,      // public / internal / confidential / secret
  protocol: string,               // "HTTPS", "gRPC", "SQL/TLS"
  authenticated: bool,
  encrypted_in_transit: bool,
}
trust_boundary: {                  // Group
  name: string (required, representative),
  description: string,
  privilege_level: enum,          // internet / dmz / corporate / restricted
}
```

Fields get a property editor for free. `is_representative: true` tells the builder which field to show as the node's label.

## 5. Project layout (this repo, once forked)

```
dfd_editor/
├── docs/                          ← you are here
│   └── getting-started.md
├── upstream/                      ← read-only pristine copy of attack-flow for reference
│   └── (git subtree or submodule of center-for-threat-informed-defense/attack-flow)
├── src/
│   ├── assets/
│   │   ├── scripts/
│   │   │   └── OpenChart/         ← copied verbatim from upstream
│   │   └── configuration/
│   │       ├── app.configuration.ts
│   │       ├── DfdTemplates/
│   │       │   ├── DfdCanvas.ts
│   │       │   ├── DfdObjects.ts
│   │       │   ├── AnchorFormat.ts
│   │       │   └── index.ts
│   │       ├── DfdThemes/
│   │       │   ├── LightTheme.ts
│   │       │   └── DarkTheme.ts
│   │       ├── DfdPublisher/
│   │       │   └── DfdPublisher.ts
│   │       ├── DfdValidator/
│   │       │   └── DfdValidator.ts
│   │       ├── DfdFilePreprocessor/
│   │       │   └── DfdFilePreprocessor.ts
│   │       └── DfdCommandProcessor/
│   │           └── DfdCommandProcessor.ts
│   ├── components/                ← Vue components, copied from upstream
│   ├── stores/                    ← Pinia stores, copied from upstream
│   ├── App.vue
│   └── main.ts
├── public/
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

**Copy strategy.** Do *not* fork-as-submodule the whole attack-flow repo — it also contains `src/attack_flow/` (Python CLI), `corpus/` (example attack flows), and MITRE ATT&CK data files we don't need. Copy `src/attack_flow_builder/` into this repo's root (or keep it under `src/attack_flow_builder/` if you want verbatim upstream paths), delete the Attack Flow–specific files, and replace the configuration.

## 6. Step-by-step: forking to first working DFD

### Step 1 — pull down upstream

```bash
git clone https://github.com/center-for-threat-informed-defense/attack-flow.git /tmp/af
cp -r /tmp/af/src/attack_flow_builder/. .
rm -rf attack/ data/                                    # MITRE ATT&CK download scripts + data
rm -rf src/assets/configuration/AttackFlow*             # every Attack-Flow-specific file
rm -rf src/assets/configuration/Images
```

Keep: `src/assets/scripts/`, `src/components/`, `src/stores/`, `src/App.vue`, `src/main.ts`, `index.html`, `package.json`, `vite.config.ts`, `tsconfig*.json`, `public/`.

### Step 2 — install and verify

```bash
npm install
npm run dev
```

At this point the app will fail to boot because `app.configuration.ts` imports deleted files. That's fine — fix as you go.

### Step 3 — write `DfdCanvas.ts`

Model after `AttackFlowTemplates/AttackFlow.ts`. Defines the document-level properties (name, description, author, created).

### Step 4 — write `DfdObjects.ts`

Model after `AttackFlowTemplates/AttackFlowObjects.ts`. One template per DFD element type. Start with `process` only, confirm it renders, then add the rest.

### Step 5 — write `DfdLightTheme.ts`

Model after `AttackFlowThemes/LightTheme.ts`. Map each template name to a `FaceType` + style. Use `DictionaryBlock` for every block type to start — you can design bespoke faces later.

### Step 6 — write `app.configuration.ts`

Replace every `AttackFlow*` import with your `Dfd*` equivalents. Set `application_name`, `file_type_name`, `file_type_extension` (e.g. `"dfd"`).

### Step 7 — stub out the plugins

`DfdValidator`, `DfdPublisher`, `DfdFilePreprocessor`, `DfdCommandProcessor` can all start as empty classes implementing the interfaces from `scripts/Application/`. Come back to them once you have a working canvas.

### Step 8 — rip out the recommender

Attack Flow ships an ATT&CK technique recommender (`AttackFlowRecommender.ts`, `StartRecommender`, `StopRecommender` commands). Delete it and its menu entries, or leave the classes and just return empty recommendation lists.

### Step 9 — rebrand

Replace `public/favicon.*`, splash screen images, and the strings in the splash config. Update `index.html` title.

### Step 10 — run it

```bash
npm run dev
# open http://localhost:5173
```

You should see a blank DFD canvas, be able to drag in each node type from the sidebar, connect them, drop them into a trust boundary group, save/load, and undo/redo.

## 7. The "API creates, user edits" workflow

This is the headline use case. Three pieces fit together:

1. **A programmatic generator** (Python, Node, whatever — runs outside the editor) produces a DFD file in the `.afb`-compatible JSON format defined by the engine. Two options:
   - **Easier**: build your own thin JSON schema, then implement `DfdFilePreprocessor` to map it into the engine's in-memory model. You control both ends of the wire.
   - **Lower-level**: emit the native OpenChart file format directly. Reverse-engineer by saving a file from the UI and diffing. More fragile but zero preprocessor needed.
2. **Host the file** anywhere the browser can fetch it with CORS allowed: local `python -m http.server`, S3, GitHub raw, an internal static host, etc.
3. **Open the builder with `?src=<url>`**:
   ```
   http://localhost:5173/?src=http://localhost:8000/my-diagram.dfd
   ```
   The builder fetches, preprocesses, and renders it. User edits by hand, saves back to disk.

The `?src=` feature is already wired in upstream — search for `src` query-param handling in `stores/` or `Application/`. You inherit it free.

### Layout considerations

The native file format stores node positions. If your generator doesn't know where to put nodes, you have two choices:

- **Emit without positions** and let the `AutomaticLayoutEngine` (already present at `OpenChart/DiagramView/DiagramLayoutEngine/AutomaticLayoutEngine/`) lay them out on load. Good default, user rearranges by hand.
- **Emit with positions** computed by your generator (e.g., simple grid, or Graphviz `dot` output). Better if you want reproducible layouts.

## 8. Build, test, and CI

Scripts from upstream `package.json` — keep them:

```bash
npm run dev          # vite dev server with HMR
npm run build        # vue-tsc type-check + vite build
npm run preview      # preview production build
npm run test:unit    # vitest
npm run test:watch   # vitest watch mode
npm run lint         # eslint
npm run lint:fix     # eslint --fix
```

Remove `update-attack` — it downloads MITRE ATT&CK data we don't use.

Unit tests live next to their sources as `*.spec.ts` (see `OpenChart/DiagramModel/DiagramModel.spec.ts` upstream for the pattern).

## 9. Known gotchas and open questions

- **Custom shapes.** If "Process = circle" or "Data Store = open-sided rectangle" are hard requirements, budget time to add new `FaceType` classes under `OpenChart/DiagramView/DiagramObjectView/Faces/Blocks/`. The existing `DictionaryBlock.ts` is the template to copy.
- **Trust boundary aesthetics.** `GroupFace` exists but we haven't verified whether its stroke style is easily themed to dashed. If not, a small patch to `GroupFace.ts` would add a `stroke_dasharray` style option.
- **File format stability.** The native `.afb` format was renamed/upgraded between v2 and v3 (`upgrade-v2` CLI command, `LegacyV2*` preprocessor classes). Expect future engine upgrades to need a `LegacyV1Dfd*` preprocessor path.
- **Upstream drift.** Decide early whether you track upstream (merge bug fixes into `OpenChart/` periodically) or fork hard. Tracking is easier if `OpenChart/` is left 100% untouched.
- **STIX code paths.** Upstream has STIX import/export baked into the UI ("Import STIX" splash button). Remove the splash entry and delete the STIX preprocessor.

## 10. Upstream references

Every file below is Apache-2.0. Read them before you start — they are the template for what you are building.

### Engine (reusable — keep untouched)
- [`DiagramObjectType.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectType.ts) — the 7 core types
- [`DiagramSchemaConfiguration.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramSchemaConfiguration.ts) — schema shape
- [`Group.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Group.ts) — container model
- [`Block.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Block.ts), [`Line.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Line.ts), [`Canvas.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Canvas.ts)
- [`AddObjectToGroup.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramEditor/Commands/Model/AddObjectToGroup.ts), [`AddGroupToGroup.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/scripts/OpenChart/DiagramEditor/Commands/Model/AddGroupToGroup.ts) — container commands

### Configuration (fork as template — copy, rename, edit)
- [`app.configuration.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/configuration/app.configuration.ts) — the single plug-in point
- [`AttackFlow.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/configuration/AttackFlowTemplates/AttackFlow.ts) — canvas template example
- [`AttackFlowObjects.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/configuration/AttackFlowTemplates/AttackFlowObjects.ts) — node template examples
- [`LightTheme.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/configuration/AttackFlowThemes/LightTheme.ts) — theme example
- [`AttackFlowPublisher.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/configuration/AttackFlowPublisher/AttackFlowPublisher.ts) — publisher reference
- [`AttackFlowValidator.ts`](https://github.com/center-for-threat-informed-defense/attack-flow/blob/main/src/attack_flow_builder/src/assets/configuration/AttackFlowValidator/AttackFlowValidator.ts) — validator reference

### Docs and meta
- [Project homepage](https://center-for-threat-informed-defense.github.io/attack-flow/)
- [Developers guide](https://center-for-threat-informed-defense.github.io/attack-flow/developers/)
- [Builder guide](https://center-for-threat-informed-defense.github.io/attack-flow/builder/)
- [Live hosted builder](https://center-for-threat-informed-defense.github.io/attack-flow/ui/) — for comparing behavior with your fork
- [Repo root](https://github.com/center-for-threat-informed-defense/attack-flow) — Apache-2.0

## 11. Next actions

1. Decide: fork hard vs. track upstream. Recommendation: **fork hard**, re-pull `OpenChart/` periodically.
2. Clone upstream into `/tmp`, copy `src/attack_flow_builder/` contents into this repo.
3. Delete Attack-Flow–specific config directories.
4. Write `DfdCanvas.ts`, `DfdObjects.ts` (start with `process` only), `DfdLightTheme.ts`, minimal `app.configuration.ts`.
5. `npm install && npm run dev`, confirm a single Process node can be created, edited, connected, and dropped into a Group.
6. Expand to full DFD schema.
7. Write `DfdPublisher` targeting your chosen file format.
8. Wire up `?src=` end-to-end with a simple Python generator script.
