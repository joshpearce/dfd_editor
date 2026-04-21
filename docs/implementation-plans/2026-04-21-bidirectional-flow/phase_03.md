# Phase 3 — Frontend canvas model, template, and new `PropertyType`

**Goal:** Canvas model and template declare the Flow's two ref-array properties under a new `PropertyType.DataItemRefList` variant, so later phases can route them to a dedicated field component. Wire shape is identical to `ListProperty<StringProperty>`; the distinction exists only in UI dispatch.

**Architecture:** Extend the `PropertyType` enum with a `DataItemRefList` value. Teach the `DiagramObjectFactory` dispatch to build the same `ListProperty<StringProperty>` the `List` case produces today. Update the `data_flow` template in `DfdObjects.ts` to replace the legacy single `data_item_refs` with `node1_src_data_item_refs` + `node2_src_data_item_refs`, both typed `DataItemRefList`. Update the `DfdFilePreprocessor` comment and its spec's `makeNativeFile` helper + round-trip test for the new keys.

**Tech Stack:** TypeScript, Vitest. Build gate: `vue-tsc` strict + `npm run test:unit` + `npm run lint`.

**Scope:** Phase 3 of 7 from design plan `docs/design-plans/2026-04-21-bidirectional-flow.md`. Depends on Phase 1 (server schema) and Phase 2 (naming consistency).

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase partially implements:

### bidirectional-flow.AC3 (foundation for AC3 — rendering ties off in Phase 4)

*No AC case is fully verified by this phase alone. Phase 3 lays the template + PropertyType foundation; Phase 4 makes rendering honour the new properties. Concretely this phase covers:*

- Canvas-level property presence — loading a diagram with the new two-key shape does NOT throw, the template declares both keys, and the canvas holds two `ListProperty<StringProperty>` instances on each Flow.

### bidirectional-flow.AC7 (partial — drift remains green)

- **bidirectional-flow.AC7.2 Success:** No frontend test fixture or spec references `source` / `target` / `data_item_refs` (the old names) on a flow. *(Final guard here. Phase 2 handled source/target; Phase 3 retires the legacy `data_item_refs` fixture key.)*

**Verification gate:** `npm run test:unit` green; `npm run build` green; drift tests green after the extended check landed in Phase 1.

---

## Context for the executor

**Codebase verification findings (2026-04-21):**

- ✓ `PropertyType` enum at `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/PropertyDescriptor/PropertyType.ts` lines 4-13 — TypeScript `enum` with 8 string-valued members: `Int = "int"`, `Float = "float"`, `String = "str"`, `Date = "date"`, `Enum = "enum"`, `List = "list"`, `Dictionary = "dict"`, `Tuple = "tuple"`.
- ✓ `DiagramObjectFactory` dispatches on `descriptor.type` (PropertyType enum value) at `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectFactory.ts` lines 384-421. `PropertyType.List` calls `createListProperty(descriptor, ...)`. Adding a new PropertyType that isn't cased in this switch will throw at instantiation time.
- ✓ UI dispatch in `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DictionaryFieldContents.vue` lines 75-93 switches on `type.constructor.name` (the Property class name like `"ListProperty"`), NOT on `PropertyType`. A `DataItemRefList` descriptor still produces a `ListProperty` instance at runtime, so the current switch would route it to `ListField` by default. **Phase 3 does NOT change this switch** — Phase 7 adds a discriminator (reading the descriptor's `type` off the ListProperty) to route to the new `DataItemRefListField` component. Phase 3 callers get `ListField` on selection, which is fine as an interim state.
- ✓ `DfdObjects.ts` `data_flow` template at lines 150-218. The current `data_item_refs` entry at lines 212-216 is the canonical `PropertyType.List` declaration to model from. Phase 1's placeholder already renamed `data_item_refs` → `node1_src_data_item_refs` and added `node2_src_data_item_refs`; Phase 3 changes both entries from `PropertyType.List` to `PropertyType.DataItemRefList`.
- ✓ `DfdFilePreprocessor.ts` at `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.ts` lines 4-25 — literally pass-through: `process(file: DiagramViewExport): DiagramViewExport { return file; }`. Comment says it exists as a hook point for future shape migrations.
- ✓ `DfdFilePreprocessor.spec.ts` `makeNativeFile()` at lines 52-123 builds a fixture dfd_v1 native file. Flow properties at lines 66-75 include `["data_item_refs", ...]` (optionally). The round-trip test at lines 307-342 (`publisher re-emits data_items and data_item_refs identically`) ends with `expect(edge?.data_item_refs).toEqual([itemGuid])`. Phase 3 must update the helper to emit both new keys and the test to assert them.
- ✓ `ListProperty` at `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Property/CollectionProperty/ListProperty.ts` — stores `Map<string, Property>`. For `ListProperty<StringProperty>` (which `DataItemRefList` maps to), each element is a StringProperty instance. Clone preserves the keyed shape (lines 65-66).
- ✓ `test_drift.py` does not check property keys — so adding `PropertyType.DataItemRefList` or changing property PropertyTypes in `DfdObjects.ts` has no direct drift impact. Phase 1's extended drift check (property-name parity) continues to pass because the keys still match server-side `DataFlowProps` field names.

**File inventory for this phase:**

Production:
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/PropertyDescriptor/PropertyType.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectFactory.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdTemplates/DfdObjects.ts`
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.ts`

Spec:
- `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts`

**Skills to activate before implementing:**

- `ed3d-house-style:coding-effectively`
- `ed3d-house-style:howto-code-in-typescript`
- `ed3d-house-style:writing-good-tests`

---

<!-- START_TASK_1 -->
### Task 1: Add `PropertyType.DataItemRefList` and teach the factory to build it

**Verifies:** Phase 3 foundation for AC3, AC7.2

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/PropertyDescriptor/PropertyType.ts:4-13` (add enum variant).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectFactory.ts:384-421` (factory switch — add a case that aliases `DataItemRefList` to the same factory path as `List`).

**Implementation:**

1. Add the enum variant at the end of the `PropertyType` enum (preserving declaration order):
   ```typescript
   export enum PropertyType {
       Int              = "int",
       Float            = "float",
       String           = "str",
       Date             = "date",
       Enum             = "enum",
       List             = "list",
       Dictionary       = "dict",
       Tuple            = "tuple",
       DataItemRefList  = "data_item_ref_list"
   }
   ```
   The string value is the serialized discriminator. Pick `"data_item_ref_list"` (snake_case to match sibling values). Confirm by grep that no other PropertyType string equals this.

2. In `DiagramObjectFactory.ts`'s PropertyType dispatch switch, add a case that falls through to the `List` path so runtime behavior is identical:
   ```typescript
   case PropertyType.DataItemRefList:
   case PropertyType.List:
       return createListProperty(descriptor, ...);
   ```
   Preserve the existing `case PropertyType.List` body — just prepend the new case so both target the same code.

3. Verify there are no other PropertyType-exhaustive switches in the codebase. Grep: `rg -n "switch\\s*\\(.*PropertyType" src --type ts` — update every exhaustive switch to handle `DataItemRefList` (either explicitly or by fallthrough to `List`). The Property **descriptor serializer** and **import helper** are prime suspects.

**Verification:**

```
cd /Users/josh/code/dfd_editor
npm run type-check
```
Expected: clean. Any `Property type "data_item_ref_list" not supported` runtime error means a switch was missed; grep and fix.

**Commit:** (hold — single commit at end of Task 4).
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Retire Phase 1 placeholder — `data_flow` template uses `PropertyType.DataItemRefList`

**Verifies:** bidirectional-flow.AC7.2

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdTemplates/DfdObjects.ts:150-218` (`data_flow` template — upgrade both ref-array property types from `List` to `DataItemRefList`).

**Implementation:**

After Phase 1, the `data_flow` template should have two entries shaped like:
```typescript
node1_src_data_item_refs: {
    type: PropertyType.List,
    form: { type: PropertyType.String },
    default: []
},
node2_src_data_item_refs: {
    type: PropertyType.List,
    form: { type: PropertyType.String },
    default: []
}
```

Change both `type: PropertyType.List` to `type: PropertyType.DataItemRefList`:
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

**Do not** remove the `form` or `default` fields — they're still required. The `form: { type: PropertyType.String }` tells `createListProperty` to build `StringProperty` elements; `default: []` is the empty-list default.

Verify there are no other templates or uses of `data_item_refs` in this file (search). The field should only appear in the `data_flow` template.

**Verification:**

```
cd /Users/josh/code/dfd_editor
npm run type-check
npm run test:unit
```
Expected: clean. Drift test (in `server/`) stays green because the property names did not change (only the PropertyType value did, and `test_drift.py` doesn't check PropertyType values).

**Commit:** (hold).
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update `DfdFilePreprocessor` comment and `makeNativeFile()` helper

**Verifies:** bidirectional-flow.AC7.2

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.ts:4-25` (comment-only update).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts:52-123` (`makeNativeFile()` helper — replace `data_item_refs` with two new keys).

**Implementation:**

1. Update the class-doc comment in `DfdFilePreprocessor.ts`:
   - Current comment mentions `data_item_refs` as a pass-through case. Rewrite to reference `node1_src_data_item_refs` and `node2_src_data_item_refs` (the bidirectional pair). Keep wording that the class is intentionally pass-through and exists as a future shape-migration hook.
   - The `process(file)` body stays unchanged — still `return file`.

2. In `DfdFilePreprocessor.spec.ts`'s `makeNativeFile(overrides?)` helper (lines 52-123):
   - Flow properties block at lines 66-75: replace the optional `["data_item_refs", ...]` entry with TWO optional entries:
     ```typescript
     ...(overrides?.node1_src_data_item_refs !== undefined
         ? [["node1_src_data_item_refs", overrides.node1_src_data_item_refs]]
         : []),
     ...(overrides?.node2_src_data_item_refs !== undefined
         ? [["node2_src_data_item_refs", overrides.node2_src_data_item_refs]]
         : []),
     ```
     (Exact shape depends on the current helper's override mechanism; preserve its style. If the helper uses a typed interface for overrides, update it too.)
   - If `makeNativeFile` emits `["data_item_refs", ...]` in any non-override code path (not just the conditional), remove or update those sites.
   - **Order matters:** the two new keys go in `_FLOW_PROP_ORDER` order (node1 first, then node2) per Phase 1.

**Verification:** deferred to Task 4.

**Commit:** (hold).
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update `dataItems.test-utils.ts`, `DfdFilePreprocessor.spec.ts`, and verify the phase end-to-end

**Verifies:** bidirectional-flow.AC7.2 (final guard)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdTemplates/dataItems.test-utils.ts` (`addDataItemRef` helper — add `direction: "node1" | "node2"` parameter targeting the correct new key).
- Modify: `/Users/josh/code/dfd_editor/src/assets/configuration/DfdFilePreprocessor/DfdFilePreprocessor.spec.ts` (all references listed below).
- Any other `.spec.ts` or fixture under `src/` that still mentions `data_item_refs` — search-and-replace to the new names.

**Implementation:**

1. **`dataItems.test-utils.ts` helper signature change** (this is consumed by Phase 4's new `DynamicLine.spec.ts`, Phase 5's Validator / Publisher specs, and the preprocessor specs below — so the update must land here):
   - Current (lines 57-65):
     ```typescript
     export function addDataItemRef(line: Line, refGuid: string): void {
         const refsProp = line.properties.value.get("data_item_refs");
         if (!(refsProp instanceof ListProperty)) {
             throw new Error("line.properties.data_item_refs is not a ListProperty");
         }
         const entry = refsProp.createListItem() as StringProperty;
         entry.setValue(refGuid);
         refsProp.addProperty(entry);
     }
     ```
   - Replace with:
     ```typescript
     export function addDataItemRef(
         line: Line,
         refGuid: string,
         direction: "node1" | "node2"
     ): void {
         const key = direction === "node1"
             ? "node1_src_data_item_refs"
             : "node2_src_data_item_refs";
         const refsProp = line.properties.value.get(key);
         if (!(refsProp instanceof ListProperty)) {
             throw new Error(`line.properties.${key} is not a ListProperty`);
         }
         const entry = refsProp.createListItem() as StringProperty;
         entry.setValue(refGuid);
         refsProp.addProperty(entry);
     }
     ```
   - The previous two-argument form is removed (no backwards compatibility — the hard-cutover rule applies to test helpers too). Phase 5 Task 2 consumes this already-updated helper; Phase 4 Task 3 can use it immediately.

2. **`DfdFilePreprocessor.spec.ts` — complete rewrite of every `data_item_refs` site:**
   - Line 5 (file doc comment): `"data_item_refs" in the correct"` → update comment to mention `node1_src_data_item_refs` and `node2_src_data_item_refs`.
   - Line 10 (describe-block doc): update `"no data_items / no data_item_refs"` to reference both new keys, or broaden to "no ref arrays".
   - Lines 12-13 (doc comment): update the two bullets describing wire-shape tolerance to reference `node1_src_data_item_refs` / `node2_src_data_item_refs`.
   - Line 74 (`makeNativeFile` helper override): `flowProps.push(["data_item_refs", overrides.flowDataItemRefsValue])` → replace with two conditional pushes for each of the two new keys. Rename the override field `flowDataItemRefsValue` to `flowNode1SrcDataItemRefsValue` and add a sibling `flowNode2SrcDataItemRefsValue`.
   - Lines 155-156 (describe + it titles): replace "legacy files — no data_items / no data_item_refs" with "files with empty ref arrays", updating the `it` title similarly.
   - Line 172 (it title): `"flow data_item_refs ListProperty is empty after loading a legacy file"` → update to reference the two new keys; consider splitting into two `it` blocks (one per key).
   - Line 181: `flowObj!.properties.value.get("data_item_refs")` → two gets, one for each key; assert both return empty `ListProperty`s.
   - Lines 205-208 (describe + it titles + doc): `"flow data_item_refs — backend [[key, guid], ...] format"` → rename describe block; subject both new keys.
   - Lines 220, 227, 236: `flowObj!.properties.value.get("data_item_refs")` → update to new keys in each test.
   - Line 308 (it title): `"publisher re-emits data_items and data_item_refs identically"` → `"publisher re-emits data_items and both ref arrays identically"`.
   - Line 316 (doc comment): update to mention both keys.
   - Line 338 (comment): `"data_item_refs on flow published"` → `"both ref arrays on flow published"`.
   - Line 340 (assertion): `expect(edge?.data_item_refs).toEqual([itemGuid])` → split into `expect(edge?.node1_src_data_item_refs).toEqual([itemGuid]); expect(edge?.node2_src_data_item_refs).toEqual([])`.

3. Add new tests covering the bidirectional cases at the preprocessor + publisher layer:
   - `"publisher re-emits a flow with both ref arrays populated"` — asserts both arrays round-trip unchanged with order preserved.
   - `"publisher re-emits a flow with both ref arrays empty"` — asserts arrays are `[]` in the output, NOT absent (AC2.4 guard).

4. Global grep — verify zero stragglers:
   ```
   cd /Users/josh/code/dfd_editor
   rg -n '"data_item_refs"' src --type ts --type vue
   rg -n "\\.data_item_refs\\b" src --type ts --type vue
   rg -n "addDataItemRef\\([^,]*,[^,]*\\)" src --type ts   # catches two-arg calls missed during signature change
   ```
   Any surviving match under `src/` must be updated or flagged. Matches in `server/` or `docs/` are intentional archive references only.

**Verification:**

```
cd /Users/josh/code/dfd_editor
npm run type-check
npm run test:unit
npm run build
npm run lint
```
All four must pass clean.

Also verify server-side drift test still green:
```
cd /Users/josh/code/dfd_editor/server
.venv/bin/python -m pytest tests/test_drift.py -x -q
```
Expected: pass.

Manual smoke test (not a gate): `npm run dev:all`, import a diagram, select a flow in the property editor. The property pane still uses the existing `ListField` for both new ref arrays (Phase 7 upgrades this to `DataItemRefListField`).

**Commit** (one commit covering Tasks 1-4):

```
feat(property-type): add DataItemRefList variant; route data_flow ref arrays through it

Canvas model and data_flow template declare the two bidirectional ref
arrays under the new PropertyType.DataItemRefList variant. Serialization
behaviour is identical to List — the distinction exists for UI dispatch
and is activated in Phase 7 (DataItemRefListField).
```
<!-- END_TASK_4 -->
