# Phase 2 — Mechanical rename `source`/`target` → `node1`/`node2`

**Goal:** All Line-related frontend code uses non-directional `node1` / `node2` naming. No behavior change. Foundation for subsequent phases that reason about "which end carries which data."

**Architecture:** Rename the `Line` / `LineView` public API (`source`/`target` getters & setters, `setSource`/`setTarget` methods, `rawSourceLatch`/`rawTargetLatch`, internal `_sourceLatch`/`_targetLatch`). Rename the canvas serialization types (`DiagramObjectExport`, `DiagramObjectTemplate.latch_template`). Rename `D2Bridge.SerializableLine` / `resolveLineEndpoints`. Rename Line-endpoint reads in consumer `.ts` and `.spec.ts` files. **Do NOT rename `SemanticGraphEdge.source`/`target` or its getters** — that type stays directional and is handled in Phase 5 as part of the edge-record reshape.

**Tech Stack:** TypeScript, Vue 3, Vitest. Build gate: `vue-tsc` (strict) must pass.

**Scope:** Phase 2 of 7 from design plan `docs/design-plans/2026-04-21-bidirectional-flow.md`. Depends on Phase 1 — server side already canonicalised and renamed.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### bidirectional-flow.AC6: Rename is mechanical and complete

- **bidirectional-flow.AC6.1 Success:** No `source` / `target` identifiers survive on Line-related types in `DiagramView/`, `DiagramModel/`, or `Application/Commands/`.
- **bidirectional-flow.AC6.2 Success:** `npm run build` (including `vue-tsc`) succeeds after the rename with no type errors.
- **bidirectional-flow.AC6.3 Success:** `npm run test:unit` passes after the rename with no behavior change (existing tests updated for the new key names only).

---

## Context for the executor

**Codebase verification findings (2026-04-21):**

Approximate symbol counts (ballpark, from investigation):
- Public API getters/setters/methods on Line + LineView: ≈10
- Internal latch fields and raw-accessor getters: ≈6
- Serialization type fields (`DiagramObjectExport`, `DiagramObjectTemplate`): 4
- D2Bridge interface fields and return type: 5
- Direct property-access call sites across `.ts` files: ≈75+
- Spec files with Line endpoint references: 8 files, ≈40+ sites
- Comments / doc strings: ≈50
- **Total: ~185–210 references across 25+ files**

**Files touched (absolute paths):**

Production `.ts`:
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Line.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Views/LineView.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Bases/LineFace.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectExport.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectSerializer.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectTemplate.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/Commands/View/RouteLinesThroughBlock.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/LatchMover.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/BlockMover.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.ts` (if it reads Line endpoints — verify with grep)
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.ts` (if it reads `DiagramObjectExport` Line fields)
- Any `.ts` file under `src/assets/scripts/Application/Commands/` that reads `line.source` / `line.target` (verify with grep).

Spec `.ts`:
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramModel.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/OpenChart.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/NewAutoLayoutEngine.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.spec.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts`

**Rename dictionary (apply everywhere):**

| Old | New | Notes |
| --- | --- | --- |
| `source` (on Line, LineView) | `node1` | Public getter + setter + private accessor |
| `target` (on Line, LineView) | `node2` | Public getter + setter + private accessor |
| `setSource(...)` | `setNode1(...)` | Method on Line |
| `setTarget(...)` | `setNode2(...)` | Method on Line |
| `_sourceLatch` | `_node1Latch` | Internal field on Line |
| `_targetLatch` | `_node2Latch` | Internal field on Line |
| `rawSourceLatch` | `rawNode1Latch` | Public getter returning `Latch \| null` |
| `rawTargetLatch` | `rawNode2Latch` | Public getter |
| `sourceObject` (on SerializableLine / LineView) | `node1Object` | — |
| `targetObject` (on SerializableLine / LineView) | `node2Object` | — |
| `LineExport.source` | `LineExport.node1` | On-disk JSON key |
| `LineExport.target` | `LineExport.node2` | On-disk JSON key |
| `latch_template.source` | `latch_template.node1` | Template JSON key |
| `latch_template.target` | `latch_template.node2` | Template JSON key |
| `{ sourceInstance, targetInstance }` (D2Bridge return type) | `{ node1Instance, node2Instance }` | Purely internal |
| Error string `"No source latch assigned."` | `"No node1 latch assigned."` | Match new name |
| Error string `"No target latch assigned."` | `"No node2 latch assigned."` | Match new name |

**Scope — what NOT to rename:**

- `SemanticGraphEdge.source` / `target` getters and their `_source` / `_sourceVia` / `_target` / `_targetVia` fields — the semantic graph stays directional. Phase 5 reshapes this type.
- Anchor-to-block relationships (e.g., `anchor.source` if it exists) — unrelated concept.
- DOM / pointer event `source` / `target` — unrelated.
- Camera / pan / zoom `source` — unrelated.
- Local variables named `source`, `target`, `src`, `tgt`, `trg` inside function bodies. Updating their initialiser to read `view.node1` / `view.node2` is required; the local name can stay the same or be renamed at the executor's discretion for readability, but that's cosmetic.

**Testing conventions:** No new tests added in this phase. Every existing spec continues to work with renamed identifiers. `npm run test:unit` must pass verbatim (modulo the key-name updates).

**Skills to activate before implementing:**

- `ed3d-house-style:coding-effectively`
- `ed3d-house-style:howto-code-in-typescript`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Rename model + view public API on Line and LineView

**Verifies:** bidirectional-flow.AC6.1 (partially), AC6.2

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Models/Line.ts` (all `source`/`target` references — see investigator notes below).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Views/LineView.ts` (all `source`/`target` references).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts` (lines 152-154 `this.view.source`/`target`).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts` (every `view.source`/`view.target` destructuring site — investigator found sites across lines 25-275).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Bases/LineFace.ts` (every `this.view.source`/`this.view.target`).

**Implementation:**

1. In `Line.ts`:
   - Rename `public get source()` → `public get node1()` and `public set source(...)` → `public set node1(...)`.
   - Rename `public get target()` → `public get node2()` and setter symmetrically.
   - Rename `public setSource(latch, update)` → `public setNode1(latch, update)` and `public setTarget(...)` → `public setNode2(...)`.
   - Rename private field `_sourceLatch` → `_node1Latch`, `_targetLatch` → `_node2Latch`.
   - Rename `public get rawSourceLatch()` → `public get rawNode1Latch()` and `rawTargetLatch` → `rawNode2Latch`.
   - Update the two throw strings: `"No source latch assigned."` → `"No node1 latch assigned."`, `"No target latch assigned."` → `"No node2 latch assigned."`.
   - Update every internal reference (field init in constructor at lines 120-121; `makeChild` calls at lines 141-148, 167-174; `clone` path at lines 299-303).

2. In `LineView.ts`:
   - Mirror the Line.ts rename: getters/setters, private `_sourceLatch` → `_node1Latch` (line 41) and `_targetLatch` → `_node2Latch` (line 46), internal `setSource` / `setTarget` calls at lines 71, 92 become `setNode1` / `setNode2`.
   - `super.source` / `super.target` calls at lines 64, 85 become `super.node1` / `super.node2`.
   - Update `this.source.calculateLayout()` / `this.target.calculateLayout()` at lines 340-341.

3. In `DynamicLine.ts` lines 152-154:
   - `const src = this.view.source;` → `const src = this.view.node1;` (keep local var name `src` for readability; only the accessed property changes).
   - `const trg = this.view.target;` → `const trg = this.view.node2;`.

4. In `LineLayoutStrategies.ts`:
   - At every destructure (lines 25-27 and equivalents in `runVerticalTwoElbowLayout`, `runHorizontalElbowLayout`, `runVerticalElbowLayout`): update `src = view.source` → `src = view.node1`; `trg = view.target` → `trg = view.node2`. Local var names stay.

5. In `LineFace.ts`:
   - Update every `this.view.source` / `this.view.target` to `this.view.node1` / `this.view.node2`.

**Implementation notes:**
- The `@vue/tsc` strict build will catch any missed spot; it's a safety net.
- Do not collapse or re-order these renames. Keep mechanical.
- Update doc comments (`/** The line's source latch. */`) to match the new names.

**Verification:**

```
cd /Users/josh/code/dfd_editor
npm run type-check
```
Expected: either compiles clean, or reports errors only in files touched by Tasks 2-5 (which will all be fixed before the phase ends). Do not commit Task 1 alone expecting `npm run build` to pass — treat Tasks 1-5 as one logical change-set and commit at the end of Task 5.

**Commit:** (hold — single commit at end of Task 5).
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Rename serialization types and serializer

**Verifies:** bidirectional-flow.AC6.1 (partially), AC6.2

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectExport.ts` (lines 78-85 — `LineExport.source/target`).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectTemplate.ts` (lines 109-116 — `latch_template.source/target`).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectSerializer/DiagramObjectSerializer.ts` (lines 174-184 plus the `yieldImportFromLine` region — reads `template.latch_template.source/target` and writes `obj.source/obj.target`).

**Implementation:**

1. `DiagramObjectExport.ts`:
   - Rename the two fields on the Line export type: `source?: string` → `node1?: string`, `target?: string` → `node2?: string`. Update doc comments accordingly.

2. `DiagramObjectTemplate.ts`:
   - Rename `latch_template.source: string` → `latch_template.node1: string`, `latch_template.target: string` → `latch_template.node2: string`. Update doc comments.

3. `DiagramObjectSerializer.ts`:
   - Writer side: `source: line.rawSourceLatch?.instance ?? undefined` → `node1: line.rawNode1Latch?.instance ?? undefined`. Symmetric for target → node2.
   - `yieldExportFromDiagramObject(line.source, exportMap)` → `yieldExportFromDiagramObject(line.node1, exportMap)`. Symmetric.
   - Reader side: wherever `template.latch_template.source` / `.target` is read, update to `.node1` / `.node2`. The assignment `object.source = ...` becomes `object.node1 = ...`. Symmetric for target.
   - `line.source = this.yieldImportFromDiagramObject(...)` → `line.node1 = ...`.

**Breaking-change note:** this changes the on-disk native JSON format for Line objects. Any existing saved diagram (e.g., in `server/data/`) that still contains `"source"` / `"target"` keys will fail to deserialize. This is the expected hard-cutover behavior — Phase 1 already purged stale `server/data/*.json` artifacts. Do NOT add a backwards-compatible reader; rely on the fresh-import path via the server's `/api/diagrams/import`.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Rename `SerializableLine` and `resolveLineEndpoints` in `D2Bridge`

**Verifies:** bidirectional-flow.AC6.1 (partially)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`.

**Implementation:**

1. In the `SerializableLine` (or equivalent) interface around lines 71-72:
   - `readonly sourceObject: SerializableEndpoint | null` → `readonly node1Object: SerializableEndpoint | null`.
   - `readonly targetObject: SerializableEndpoint | null` → `readonly node2Object: SerializableEndpoint | null`.

2. In `resolveLineEndpoints` (around lines 157-181):
   - Rename return type: `{ sourceInstance: string; targetInstance: string } | null` → `{ node1Instance: string; node2Instance: string } | null`.
   - Rename local bindings: `const src = line.sourceObject` → `const src = line.node1Object`; symmetric for target.
   - Rename return object: `{ sourceInstance: src.instance, targetInstance: tgt.instance }` → `{ node1Instance: src.instance, node2Instance: tgt.instance }`.

3. In the line-emission loop (around lines 324-330):
   - `const { sourceInstance, targetInstance } = endpoints;` → `const { node1Instance, node2Instance } = endpoints;`.
   - `${absoluteD2Path(sourceInstance, index)} -> ${absoluteD2Path(targetInstance, index)}` → `${absoluteD2Path(node1Instance, index)} -> ${absoluteD2Path(node2Instance, index)}`.
   - The literal `" -> "` D2 arrow stays — D2 direction is pinned to `node1 -> node2` by design, Phase 6 re-verifies.

4. Update any doc comments that mention `sourceObject` / `targetObject` / `sourceInstance` / `targetInstance`.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Rename Line-endpoint reads in consumer `.ts` files

**Verifies:** bidirectional-flow.AC6.1

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts` (lines 45-46, 121-153 — read sites for line endpoints; also the `dirSource`/`dirTarget` literal union).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.ts` (lines ~34-35 if it reads Line endpoints directly; if it reads `SemanticGraphEdge` only, no change here — verify with grep).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.ts` (grep; update any `.source` / `.target` access on Lines).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.ts` (grep; update any reads of LineExport `source`/`target` keys).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/Commands/View/RouteLinesThroughBlock.ts` (all ~20 sites).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.ts` (grep).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/LatchMover.ts` (lines ~134-135).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/ObjectMovers/BlockMover.ts` (lines ~194-219).
- Modify: every other `.ts` file under `src/` that references `line.source` / `line.target` / `line.setSource` / `line.setTarget` / `line.sourceObject` / `line.targetObject` on a Line. Use grep: `rg -n "\\bline\\.(source|target|setSource|setTarget|sourceObject|targetObject|rawSourceLatch|rawTargetLatch)\\b" src/assets`.

**Implementation:**

1. `SemanticAnalyzer.ts`:
   - Lines 45-46: `line.source.anchor?.instance` → `line.node1.anchor?.instance` (symmetric for target/node2).
   - Lines 121-128: the `dirSource: "source" | "target"` / `dirTarget: "source" | "target"` literal union changes. This is a direction-picking helper — the crossing computation is symmetric. Rename the union to `"node1" | "node2"`; update the four assignment sites at lines 124-128 from `"source"`/`"target"` literals to `"node1"`/`"node2"`.
   - Lines 141, 153: `line[dirSource]` and `line[dirTarget]` still work with the new literals because Line now exposes `node1` / `node2` as matching property names.
   - **Do NOT** change lines 69-71 (`edge.source`, `edge.target`) — those are `SemanticGraphEdge` getters which stay as-is in Phase 2 (Phase 5 renames them).

2. `DfdPublisher.ts`:
   - Grep for any `line.source` / `line.target` read. The investigator saw at lines ~34-35 `edge.source?.instance ?? null` / `edge.target?.instance ?? null` — those are `SemanticGraphEdge` reads, **leave alone**. Only rename if there's a direct Line-endpoint read.

3. Every other file in the list: mechanical rename per the Rename Dictionary above. In each case, inspect briefly to confirm it's a Line-endpoint read (not a SemanticGraphEdge read, not a DOM event).

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Update all `.spec.ts` files for the new names

**Verifies:** bidirectional-flow.AC6.3

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramModel.spec.ts` (lines 32-33: `expect(line.source).toBeInstanceOf(Latch)` → `expect(line.node1).toBeInstanceOf(Latch)`, symmetric for target/node2).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/OpenChart.spec.ts` (lines 211-264 — all `line.source` / `line.target` call chains).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.spec.ts` (lines 85-86 template strings `source: "generic_latch", target: "generic_latch"` → `node1: "generic_latch", node2: "generic_latch"`; lines 158-159 `line.source.link(...)` → `line.node1.link(...)`; lines 304, 359, 364-365 test names and assertions; any `edge.source` / `edge.target` assertions — leave alone, they're SemanticGraphEdge).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.spec.ts` (lines 120-126 stub types `sourceObject` / `targetObject` → `node1Object` / `node2Object`; lines 196, 430, 441, 452, 478-483 test names, descriptions, stub getters, error messages).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/NewAutoLayoutEngine.spec.ts` (lines 257-279 line stub getters; lines 263-264 `sourceLatch` / `targetLatch` PARAMETER NAMES — leave alone, these are local to a helper and not part of the renamed public API, OR rename for consistency at executor's discretion; lines 827-880, 908-912, 1299-1303 test names, comments).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.spec.ts` (lines 34-41 doc comment + `line.source.link(srcAnchor)` / `line.target.link(tgtAnchor)` on the `connect()` helper).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.spec.ts` (lines 38-43 same pattern as DfdPublisher spec).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts` (lines 114-115 fixture JSON keys `source: "latch-src", target: "latch-tgt"` → `node1: "latch-src", node2: "latch-tgt"`; also any other occurrences of `source` / `target` as Line export keys in the `makeNativeFile` helper).
- Modify: any other `.spec.ts` under `src/` that references `.source` / `.target` on a Line. Find with `rg -n "\\.(source|target|setSource|setTarget|rawSourceLatch|rawTargetLatch|sourceObject|targetObject)\\b" src --type ts -g '*.spec.ts'`.

**Implementation:**

Apply the Rename Dictionary above to every site. Test descriptions that say "source → target connection" may be rewritten to "node1 → node2 connection" for clarity, though the semantic meaning of "source" in a test description is not always endpoint-related — use judgment.

For `DfdFilePreprocessor.spec.ts` fixtures: because the on-disk export format changes (Task 2), any fixture JSON that emulates a `LineExport` object must also flip its keys. Update `makeNativeFile()`'s produced shape accordingly so the preprocessor's pass-through check continues to work.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Full-suite verification and single commit

**Verifies:** bidirectional-flow.AC6.1, AC6.2, AC6.3

**Files:** None modified.

**Implementation:** confirm the rename is complete and nothing regressed.

1. Final grep check for stragglers:
   ```
   cd /Users/josh/code/dfd_editor
   # Should find only SemanticGraphEdge (renamed later) and legitimate non-Line uses.
   rg -n "\\b(setSource|setTarget|sourceObject|targetObject|rawSourceLatch|rawTargetLatch|_sourceLatch|_targetLatch)\\b" src --type ts
   rg -n "line\\.(source|target)\\b" src --type ts
   rg -n '"(source|target)":\s*' src --type ts  # JSON fixture keys on LineExport shapes
   ```
   Any remaining matches must be either on `SemanticGraphEdge` (legit — Phase 5 handles it) or clearly unrelated (camera, DOM event, anchor). Investigate each.

2. Type-check:
   ```
   npm run type-check
   ```
   Expected: clean, zero errors.

3. Build:
   ```
   npm run build
   ```
   Expected: clean, zero errors. (AC6.2)

4. Tests:
   ```
   npm run test:unit
   ```
   Expected: all pass with no new failures. Any new failure indicates a behavior regression — fix the rename, don't change test expectations. (AC6.3)

5. Lint:
   ```
   npm run lint
   ```
   Expected: clean.

6. Optional interactive smoke test (not a gate):
   ```
   npm run dev:all
   ```
   Open `http://localhost:5173`, import a diagram via the UI, confirm lines render. No behavior change expected — if lines are missing / miswired, a latch binding got rewired during rename.

**Commit** (one commit covering Tasks 1-6):

```
refactor(lines): rename Line/LineView source+target to node1+node2 throughout

Mechanical rename of Line-related endpoint identifiers so naming no longer
implies flow direction. SemanticGraphEdge keeps source/target; Phase 5
handles that type separately.
```

Verify commit staged files match the expected file list from the phase header (grep the commit for `source`/`target` on Line-related types to confirm zero survivors).
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
