# Phase 5 — Downstream consumers (DataItemLookup, Validator, Publisher, SemanticAnalyzer)

**Goal:** Every consumer of Flow properties handles the new two-array shape. Publisher emits one edge per Flow carrying both ref arrays. Validator warns per direction independently. SemanticAnalyzer's edge record renames `source`/`target` to `node1`/`node2`; crossing computation is unchanged in behavior (symmetric).

**Architecture:** Replace `DataItemLookup.readDataItemRefs(props) → string[]` with `readFlowRefs(props) → { node1ToNode2: string[]; node2ToNode1: string[] }`. Rename `SemanticGraphEdge.source`/`target` getters to `node1`/`node2` (Phase 2 deferred this deliberately; Phase 5 lands it). Update `DfdValidator.validateDataItemRefs` to iterate both arrays and produce warning messages that include the property-key direction. Update `DfdPublisher` to always emit both ref arrays as `node1_src_data_item_refs` / `node2_src_data_item_refs` in the edge record (not conditional on non-empty). Update every affected spec and the `dataItems.test-utils.ts` helper.

**Tech Stack:** TypeScript, Vitest. Gate: `vue-tsc` + `npm run test:unit` + `npm run lint`.

**Scope:** Phase 5 of 7. Depends on Phases 1-3 (schema + naming + PropertyType).

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### bidirectional-flow.AC5: Downstream consumers handle the new shape

- **bidirectional-flow.AC5.1 Success:** `DfdPublisher` emits one edge per Flow, carrying both ref arrays in the edge's `properties`, with `id` equal to the Flow's GUID.
- **bidirectional-flow.AC5.2 Success:** `DfdValidator` surfaces dangling-ref warnings per array independently, with a message identifying the direction.
- **bidirectional-flow.AC5.3 Success:** `DfdValidator` does NOT flag empty-both-sides flows as errors or warnings.
- **bidirectional-flow.AC5.4 Success:** `SemanticAnalyzer`'s trust-boundary crossing classification is unchanged in behavior after the source/target → node1/node2 rename (existing crossing tests pass verbatim after fixture key renames).

---

## Context for the executor

**Codebase verification findings (2026-04-21):**

- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.ts`:
  - `readDataItems(canvas): DataItem[]` at lines 101-135.
  - `dataItemsForParent(canvas, nodeGuid): DataItem[]` at lines 149-151.
  - `readDataItemRefs(props: RootProperty): string[]` at lines 169-182 — reads the single `"data_item_refs"` key, returns flat `string[]` of non-empty GUIDs.
  - `hashDataItems(items): number` at lines 204-213.
  - Callers of `readDataItemRefs`: `DfdValidator.ts:125` (direct) and indirectly via `DfdPublisher.projectDataItemRefs`.

- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticGraphEdge.ts`:
  - Fields at lines 9 (`id`), 14 (`props: RootProperty`), 22 (`crossings: SemanticGraphNode[]`).
  - Private `_source`, `_sourceVia`, `_target`, `_targetVia` at lines 27, 32, 37, 42.
  - Public getters `source()` at line 48, `target()` at line 62 (plus `sourceVia`, `targetVia`).
  - No pre-computed `data_item_refs` on the edge — consumers read via `edge.props`.

- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts`:
  - Crossing computation at lines 67-78 — symmetric (`sa` set-minus `ta` ∪ `ta` set-minus `sa`). Rename is purely mechanical.
  - Edge is keyed by Line `instance` at line 27: `edges.set(obj.instance, new SemanticGraphEdge(obj))`.
  - After Phase 2, already reads `line.node1` / `line.node2` (not `line.source` / `line.target`). No more changes on the Line read side.

- ✓ `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.ts`:
  - `validateDataItemRefs(id, edge, knownGuids)` at lines 120-134. Calls `readDataItemRefs(edge.props)` at line 125 and emits `Data flow references unknown data item '${guid}'.` for each dangling ref.
  - `validateEdge` at lines 136-159 — uses `edge.source`, `edge.target`, `edge.source!`, `edge.target!` for trust-boundary crossing rules. These are the `SemanticGraphEdge` getters renamed in this phase.

- ✓ `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.ts`:
  - Edge-record emission loop at lines 30-42. Reads `edge.props.value.get("data_item_refs")` at line 31 via `projectDataItemRefs(prop): string[]` at lines 76-88.
  - Emits the edge record with `id`, `source`, `target`, `crosses`, and conditionally `data_item_refs` (only if non-empty). `id` already equals the Flow's GUID (line 33) — satisfies AC5.1's id requirement.
  - Per AC2.4, both ref arrays must survive the round-trip in the output **even when empty** — change emission to always include both keys.

- ✓ Specs affected (file paths for context):
  - `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.spec.ts` (lines 55-300).
  - `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.spec.ts` (lines 48-209; primary assertions at lines 113-159).
  - `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.spec.ts` (crossing tests at lines 259-369; unbound-edge test at lines 356-367 reads `edge.source` / `edge.target` — both become `edge.node1` / `edge.node2`).
  - `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.spec.ts` (template fixture at lines 71-75 must provide both new property keys).
  - `/Users/josh/code/dfd_editor/src/assets/configuration/DfdTemplates/dataItems.test-utils.ts` (`addDataItemRef(line, guid)` helper at lines 57-65 — add a `direction: "node1" | "node2"` param).

**Decisions resolved for the executor (flagged by investigator as ambiguous):**

- **Yes, rename `SemanticGraphEdge.source` / `target` → `node1` / `node2`.** The design's Phase 5 explicitly says "edge record exposes node1, node2". Also update `_source` → `_node1`, `_target` → `_node2`, `sourceVia` → `node1Via`, `targetVia` → `node2Via`. Consumer updates cascade to `DfdValidator`, `SemanticAnalyzer` crossing code, and specs.
- **`DfdPublisher` always emits both keys.** Edge record contains `node1_src_data_item_refs: [...]` and `node2_src_data_item_refs: [...]` unconditionally (even when both are `[]`). Consumers can branch on `.length === 0` if needed. Drop the `if (dataItemRefs.length > 0)` guard — empty arrays must survive per AC2.4. Legacy `data_item_refs` key is not emitted.
- **Warning message format for AC5.2:** include the property-key name directly in the message. Exact format:
  - `Data flow references unknown data item '${guid}' in node1_src_data_item_refs.`
  - `Data flow references unknown data item '${guid}' in node2_src_data_item_refs.`
  Tests grep this text. Keep it consistent with the server-side 400 responses from Phase 1's dangling-ref validator.

**Skills to activate before implementing:**

- `ed3d-house-style:coding-effectively`
- `ed3d-house-style:howto-code-in-typescript`
- `ed3d-house-style:writing-good-tests`
- `ed3d-house-style:howto-functional-vs-imperative` — `DataItemLookup` is the functional core; keep it pure.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Replace `readDataItemRefs` with `readFlowRefs` in `DataItemLookup`

**Verifies:** bidirectional-flow.AC5.2 and AC5.3 foundation (consumed by the Validator)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.ts`

**Implementation:**

1. Add a new exported function `readFlowRefs`:
   ```typescript
   export interface FlowRefs {
       node1ToNode2: string[];
       node2ToNode1: string[];
   }

   export function readFlowRefs(props: RootProperty): FlowRefs {
       return {
           node1ToNode2: readSingleRefArray(props, "node1_src_data_item_refs"),
           node2ToNode1: readSingleRefArray(props, "node2_src_data_item_refs"),
       };
   }

   function readSingleRefArray(props: RootProperty, key: string): string[] {
       const refsProp = props.value.get(key);
       if (!(refsProp instanceof ListProperty)) {
           return [];
       }
       const guids: string[] = [];
       for (const [, entry] of refsProp.value) {
           const val = entry.toJson();
           if (typeof val === "string" && val.length > 0) {
               guids.push(val);
           }
       }
       return guids;
   }
   ```
   `readSingleRefArray` is intentionally private to the module — consumers should prefer the structured `readFlowRefs`. It inlines the existing `readDataItemRefs` body with a parameterised key.

2. Remove the old `readDataItemRefs` export. Do NOT keep it as an alias — the hard-cutover DoD forbids backwards-compatible shims. Every caller updates in tasks 3-5.

3. Keep `readDataItems`, `dataItemsForParent`, `hashDataItems` unchanged.

**Verification:** defer to Task 6.

**Commit:** (hold — single commit at end of Task 6).
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update `DataItemLookup.spec.ts` and `dataItems.test-utils.ts`

**Verifies:** bidirectional-flow.AC5.2, AC5.3 (test infrastructure for the Validator / Publisher specs that follow)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.spec.ts` (template fixture at lines ~71-75; every test that called `readDataItemRefs`).
- **Already updated by Phase 3 Task 4** (no changes here): `/Users/josh/code/dfd_editor/src/assets/configuration/DfdTemplates/dataItems.test-utils.ts` — the `addDataItemRef(line, guid, direction)` signature is in place before Phase 5 runs.

**Implementation:**

1. In `DataItemLookup.spec.ts`:
   - Update the minimal template fixture at lines 71-75: replace the single `data_item_refs` property with two:
     ```typescript
     node1_src_data_item_refs: {
         type: PropertyType.DataItemRefList,
         form: { type: PropertyType.String },
         default: []
     },
     node2_src_data_item_refs: {
         type: PropertyType.DataItemRefList,
         form: { type: PropertyType.String },
         default: []
     }
     ```
   - For any test that called `readDataItemRefs(props)` and expected `string[]`: rewrite to call `readFlowRefs(props)` and assert `.node1ToNode2` / `.node2ToNode1` shapes.
   - Add tests:
     - `readFlowRefs returns both empty arrays when no keys are set`.
     - `readFlowRefs reads only node1ToNode2 when node1_src_data_item_refs has entries`.
     - `readFlowRefs reads only node2ToNode1 when node2_src_data_item_refs has entries`.
     - `readFlowRefs reads both when both arrays are populated`.
     - `readFlowRefs preserves UUID order within each array`.

2. **`dataItems.test-utils.ts`** was updated by Phase 3 Task 4 (helper signature now takes `direction: "node1" | "node2"`). No further changes here in Phase 5; this task only ensures all Phase-5-owned specs call the helper with the new three-argument signature. Verify with: `rg -n "addDataItemRef\\([^)]*\\)" src --type ts` — every call site must pass three args. If Phase 3 wasn't run yet, escalate to the orchestrator before proceeding.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: Rename `SemanticGraphEdge.source` / `target` → `node1` / `node2` and update `SemanticAnalyzer`

**Verifies:** bidirectional-flow.AC5.4

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticGraphEdge.ts`
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts` (crossing code at lines 67-78; and any set* methods that wrote the old getters)
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.spec.ts` (fixture + assertions — lines 284-367, especially the unbound-edge assertions at 364-365).

**Implementation:**

1. In `SemanticGraphEdge.ts`:
   - Rename private fields: `_source` → `_node1`, `_sourceVia` → `_node1Via`, `_target` → `_node2`, `_targetVia` → `_node2Via`.
   - Rename public getters: `source()` → `node1()`, `sourceVia()` → `node1Via()`, `target()` → `node2()`, `targetVia()` → `node2Via()`. Preserve the return types (`SemanticGraphNode | null`, `string | null`).
   - If there are any `setSource` / `setTarget` mutators: rename to `setNode1` / `setNode2`.

2. In `SemanticAnalyzer.ts`:
   - The crossing computation at lines 67-78 switches from `edge.source` / `edge.target` to `edge.node1` / `edge.node2`. Names inside the block (`const sa = edge.source.trustBoundaryAncestors` etc.) use the local names `sa` / `ta`; rename to `n1a` / `n2a` for clarity:
     ```typescript
     if (!edge.node1 || !edge.node2) { continue; }
     const n1a = edge.node1.trustBoundaryAncestors;
     const n2a = edge.node2.trustBoundaryAncestors;
     const n2aSet = new Set(n2a);
     const n1aSet = new Set(n1a);
     edge.crossings = [
         ...n1a.filter(n => !n2aSet.has(n)),
         ...n2a.filter(n => !n1aSet.has(n))
     ];
     ```
     Logic is unchanged — symmetric.
   - If any `setSource` / `setTarget` calls on the edge were made from the analyzer, update to the new names.

3. In `SemanticAnalyzer.spec.ts`:
   - Lines 364-365 (`expect(edge.source).toBeNull(); expect(edge.target).toBeNull();`) → `expect(edge.node1).toBeNull(); expect(edge.node2).toBeNull();`.
   - Any other assertion on `edge.source` or `edge.target`: rename.
   - Crossing tests at lines 259-369 should pass unchanged (symmetric behavior). If any fixture uses the rename-affected properties (e.g., creating edges manually and setting `source`/`target`), update.

**Implementation notes:**
- The rename is mechanical. `vue-tsc` will catch any missed references.
- Keep `id`, `props`, `crossings` unchanged.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 4) -->

<!-- START_TASK_4 -->
### Task 4: Per-direction validation in `DfdValidator`

**Verifies:** bidirectional-flow.AC5.2, AC5.3

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.ts` (`validateDataItemRefs` at lines 120-134; `validateEdge` at 136-159).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdValidator/DfdValidator.spec.ts` (entire suite — all references to the old helper signature).

**Implementation:**

1. In `DfdValidator.ts`:
   - Replace `validateDataItemRefs`:
     ```typescript
     private validateDataItemRefs(
         id: string,
         edge: SemanticGraphEdge,
         knownGuids: Set<string>
     ): void {
         const refs = readFlowRefs(edge.props);
         for (const guid of refs.node1ToNode2) {
             if (!knownGuids.has(guid)) {
                 this.addWarning(
                     id,
                     `Data flow references unknown data item '${guid}' in node1_src_data_item_refs.`
                 );
             }
         }
         for (const guid of refs.node2ToNode1) {
             if (!knownGuids.has(guid)) {
                 this.addWarning(
                     id,
                     `Data flow references unknown data item '${guid}' in node2_src_data_item_refs.`
                 );
             }
         }
     }
     ```
     Both-empty flows produce zero warnings — satisfies AC5.3.
   - In `validateEdge` at lines 136-159, rename `edge.source` → `edge.node1`, `edge.target` → `edge.node2`, `edge.source!` → `edge.node1!`, etc. Trust-boundary crossing rule logic is unchanged.

2. In `DfdValidator.spec.ts`:
   - Update every `addDataItemRef(line, guid)` → `addDataItemRef(line, guid, "node1")` (or `"node2"` depending on what each test is exercising).
   - Rewrite the warning-assertion pattern to use the new message substrings:
     ```typescript
     const warnings = validator.getWarnings();
     expect(warnings.filter(w => w.reason.includes("node1_src_data_item_refs"))).toHaveLength(1);
     expect(warnings.filter(w => w.reason.includes("node2_src_data_item_refs"))).toHaveLength(0);
     ```
   - Add new tests:
     - `"dangling ref in node1_src_data_item_refs emits a warning mentioning that direction"` (AC5.2, node1 side).
     - `"dangling ref in node2_src_data_item_refs emits a warning mentioning that direction"` (AC5.2, node2 side).
     - `"dangling refs in both directions emit two warnings"` (AC5.2, both sides independent).
     - `"empty-both-sides flow emits no warnings"` (AC5.3).
     - `"valid refs on both sides emit no warnings"`.

3. Trust-boundary test coverage:
   - The existing `validateEdge` trust-boundary tests (if any) should be updated to use the renamed `edge.node1` / `edge.node2` in assertions (if they build SemanticGraphEdge-level fixtures) — mostly a Phase 2-style mechanical rename, already partly handled in Task 3.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 5) -->

<!-- START_TASK_5 -->
### Task 5: `DfdPublisher` emits both ref arrays unconditionally

**Verifies:** bidirectional-flow.AC5.1, AC2.4

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.ts` (emission loop at lines 30-42; `projectDataItemRefs` at lines 76-88).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdPublisher/DfdPublisher.spec.ts` (all assertions on `edge.data_item_refs` — primarily lines 113-159).

**Implementation:**

1. In `DfdPublisher.ts`:
   - Replace the emission loop:
     ```typescript
     for (const [id, edge] of graph.edges) {
         const refs = readFlowRefs(edge.props);
         const edgeRecord: Record<string, unknown> = {
             id,
             node1: edge.node1?.instance ?? null,
             node2: edge.node2?.instance ?? null,
             crosses: edge.crossings.map(n => n.instance),
             node1_src_data_item_refs: refs.node1ToNode2,
             node2_src_data_item_refs: refs.node2ToNode1,
         };
         edges.push(edgeRecord);
     }
     ```
     Two key changes vs current code:
     - Rename `source`/`target` keys to `node1`/`node2` (matches everywhere else).
     - Always emit both ref arrays (drop the `if (length > 0)` conditional).
   - Delete the private `projectDataItemRefs` helper (lines 76-88). It has exactly one caller — line 31 in the same file — which this task already replaces. Verified via: `rg -n "projectDataItemRefs" /Users/josh/code/dfd_editor/src` returns only the two in-file matches.

2. In `DfdPublisher.spec.ts`:
   - Update every `addDataItemRef(flow, refGuid)` call to pass the direction.
   - Rewrite assertions that checked `edge.data_item_refs` → both `edge.node1_src_data_item_refs` and `edge.node2_src_data_item_refs`.
   - Replace the `source` / `target` assertions:
     ```typescript
     expect(edge.node1).toBe(blockAGuid);
     expect(edge.node2).toBe(blockBGuid);
     ```
   - Cover:
     - Single flow, both ref arrays empty → edge has both arrays as `[]` (verify they're present, not undefined — AC2.4).
     - Single flow, only `node1ToNode2` populated → arrays have expected values.
     - Single flow, only `node2ToNode1` populated.
     - Single flow, both populated.
     - Publisher emits **one** edge per Flow (loop over `edges`, assert no duplicate ids; AC5.1).
     - `id` equals the Flow's instance GUID (AC5.1).

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_D -->

<!-- START_SUBCOMPONENT_E (tasks 6) -->

<!-- START_TASK_6 -->
### Task 6: Full-suite verification

**Verifies:** bidirectional-flow.AC5.1, AC5.2, AC5.3, AC5.4 end-to-end

**Files:** None modified.

**Implementation:**

1. Search for lingering legacy references:
   ```
   cd /Users/josh/code/dfd_editor
   rg -n "readDataItemRefs|data_item_refs" src --type ts --type vue
   rg -n "edge\\.(source|target)\\b" src --type ts
   rg -n "\\.sourceVia|\\.targetVia" src --type ts
   ```
   Zero matches expected under `src/`. Any match means a missed rename.

2. Run suites:
   ```
   cd /Users/josh/code/dfd_editor
   npm run type-check
   npm run test:unit
   npm run build
   npm run lint
   ```
   All must pass.

3. Confirm server-side drift still green:
   ```
   cd /Users/josh/code/dfd_editor/server
   .venv/bin/python -m pytest tests/test_drift.py -x -q
   ```
   Expected: pass — this phase does not touch property names.

4. Manual smoke test (not a gate): `npm run dev:all`, import `server/temp/aws-ecs-webapp-with-reverse-flows.json`, select a flow with refs populated in both directions, inspect:
   - Publisher output (browser dev console: export diagram, verify `edges[*]` contains both `node1_src_data_item_refs` and `node2_src_data_item_refs`).
   - Validator output: introduce a dangling ref by editing the fixture to include a data-item UUID that doesn't exist; the validator warnings should say "in node1_src_data_item_refs" or "in node2_src_data_item_refs".

**Commit** (one commit covering Tasks 1-6):

```
refactor(downstream): per-direction ref handling in Lookup, Validator, Publisher, SemanticAnalyzer

DataItemLookup.readDataItemRefs is replaced with readFlowRefs returning
{ node1ToNode2, node2ToNode1 }. DfdValidator warns per direction.
DfdPublisher always emits both ref arrays in the edge record.
SemanticGraphEdge source/target getters are renamed to node1/node2;
crossing computation is unchanged in behavior.
```
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_E -->
