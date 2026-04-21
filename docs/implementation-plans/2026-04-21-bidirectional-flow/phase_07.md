# Phase 7 — Editor UX (`DataItemRefListField` + dynamic labels)

**Goal:** When the user selects a Flow, the property editor presents two labelled sections — one per direction — each with a dropdown for selecting data items from the diagram's top-level collection. Labels are dynamic ("Data from Browser to ALB"); adding or removing a data item mutates the correct ref array and triggers an arrow re-render.

**Architecture:** Introduce a `DataItemRefListProperty` subclass of `ListProperty` so `DictionaryFieldContents.vue`'s `type.constructor.name` dispatch can route it to a new `DataItemRefListField.vue` component without touching sibling `ListField` cases. The factory instantiates `DataItemRefListProperty` when `descriptor.type === PropertyType.DataItemRefList`. `PropertyEditor.vue` computes a per-field `context` object when a single Line is selected — `{ node1View, node2View, direction: "node1ToNode2" | "node2ToNode1" }` — and threads it through `DictionaryFieldContents.vue` to the new component. The component renders a chip list + dropdown, using `ApplicationStore.activeDataItems` for the source list.

**Tech Stack:** Vue 3 Options API (`defineComponent`, `<script lang="ts">`), Pinia, `@vue/test-utils` + Vitest jsdom environment for the new spec.

**Scope:** Phase 7 of 7. Depends on Phases 1-5.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### bidirectional-flow.AC4: Editor UX for ref-array editing

- **bidirectional-flow.AC4.1 Success:** Selecting a Flow shows two labeled ref-array sections in the property pane, one per direction.
- **bidirectional-flow.AC4.2 Success:** Direction labels display the two endpoints' actual names (e.g., "Data from Browser to ALB"), not `node1` / `node2`.
- **bidirectional-flow.AC4.3 Success:** Adding a data-item via the dropdown appends its UUID to the correct ref array and triggers an arrow re-render.
- **bidirectional-flow.AC4.4 Success:** Removing a data-item (via the per-item delete button) removes its UUID from the ref array and re-renders; if the array becomes empty, the corresponding arrowhead disappears.
- **bidirectional-flow.AC4.5 Success:** Dropdown is populated from the diagram's top-level data-items; already-selected items are hidden from the dropdown to avoid duplicates.
- **bidirectional-flow.AC4.6 Edge:** Renaming an endpoint block updates the direction labels reactively.
- **bidirectional-flow.AC4.7 Edge:** Diagrams with zero data-items show the empty-state hint instead of an empty dropdown.

---

## Context for the executor

**Codebase verification findings (2026-04-21):**

- ✓ `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DictionaryFieldContents.vue` dispatches on `type.constructor.name` at lines 75-93 (e.g., `case ListProperty.name: return "ListField"`). It is NOT descriptor-aware — it knows only the runtime class of the Property instance. To route the new component we introduce a class distinction, not a descriptor flag.
- ✓ `/Users/josh/code/dfd_editor/src/components/Elements/PropertyEditor.vue` uses Options API (`defineComponent`). It receives `property: DictionaryProperty` as a prop and forwards to `DictionaryFieldContents`. No per-field context plumbing today.
- ✓ `/Users/josh/code/dfd_editor/src/components/Elements/EditorSidebar.vue` lines 54-62 computes `selected`:
  - 0 selected → canvas properties.
  - 1 selected → `this.application.getSelection[0].properties`.
  - 2+ selected → undefined.
  Phase 7 augments this: when the single selection is a `LineView`, also compute `node1View` and `node2View` and hand them down as part of a new `context` prop.
- ✓ `/Users/josh/code/dfd_editor/src/components/Controls/Fields/ListField.vue` (lines 1-194) is the reference implementation. Props: `property: ListProperty`. Emits: `execute`. Add/delete dispatch via `EditorCommands.createSubproperty(property)` and `EditorCommands.deleteSubproperty(property, id)`.
- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Property/CollectionProperty/ListProperty.ts` has a `template: Property` field; the factory constructs it via `createListProperty(descriptor, ...)` inside `DiagramObjectFactory.ts` lines 394-396.
- ✓ `/Users/josh/code/dfd_editor/src/stores/ApplicationStore.ts` uses `defineStore` Options syntax with explicit `state`, `getters`, `actions`. Getter pattern:
  ```typescript
  getters: {
      hasSelection(): number { ... },
      // ...
  }
  ```
  Phase 7 adds `activeDataItems` here.
- ✓ `DataItemLookup.readDataItems(canvas)` at `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DataItemLookup.ts:101` returns `DataItem[]`. Use it for the dropdown source.
- ✓ `LineView` gives access to its endpoint blocks via `.node1Object` / `.node2Object` (renamed from `sourceObject`/`targetObject` in Phase 2). Each returns a `BlockView | null` (the block containing the latched anchor).
- ✓ Block display name access: `block.properties.value.get("name").toJson()`. Use `readDataItems` or a helper in `DataItemLookup` to keep the access pattern consistent.
- ✓ Vue reactivity: Options API `watch` on `"property.value"` (the Map of subproperties) auto-tracks mutations. For endpoint-name reactivity (AC4.6): watch `"context.node1View.properties.value"` deep, OR subscribe via `RootProperty.subscribe` manually (cleanup in `unmounted`). Start with Vue's declarative watch — simpler, more idiomatic. If Vue reactivity doesn't fire because the underlying model doesn't use Vue's reactive system, fall back to `RootProperty.subscribe("name", handler)`.
- ✓ `@vue/test-utils` + Pinia testing — project currently has zero Vue component specs. Phase 7 sets the precedent.
- ✓ `/Users/josh/code/dfd_editor/vitest.config.ts` runs node by default; spec files needing jsdom opt in via `// @vitest-environment jsdom` at the top (precedent: `D2Bridge.spec.ts`).

**Files touched in this phase:**

Production:
- Create: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Property/CollectionProperty/DataItemRefListProperty.ts` (new subclass).
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectFactory.ts` (factory switch — instantiate subclass for `DataItemRefList`).
- Modify: `/Users/josh/code/dfd_editor/src/stores/ApplicationStore.ts` (add `activeDataItems` getter).
- Create: `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DataItemRefListField.vue` (new field component).
- Modify: `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DictionaryFieldContents.vue` (add dispatch case + thread `context` prop).
- Modify: `/Users/josh/code/dfd_editor/src/components/Elements/PropertyEditor.vue` (accept + forward `context` for single-Line selection).
- Modify: `/Users/josh/code/dfd_editor/src/components/Elements/EditorSidebar.vue` (compute endpoint views; pass through).

Spec:
- Create: `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DataItemRefListField.spec.ts`.

Potentially modified (verify need):
- `package.json` — if `@pinia/testing` is not already a dev dependency, add it. Check first: `grep pinia package.json`.

**Decisions resolved for the executor:**

- **Subclass over metadata flag.** Introduce `DataItemRefListProperty extends ListProperty` with no new fields or methods — it exists solely so `type.constructor.name` dispatch picks it up. Rationale: minimal change to `ListProperty`, no new metadata plumbing, dispatch stays a flat switch.
- **Filter already-selected items (not dim).** AC4.5 says "hidden" — filter them out of the dropdown entirely. The OptionsList's `feature: false` dimming pattern is used in EnumField for non-canonical values; for this case, omit the option.
- **Single direction label template:** "Data from `<node1Name>` to `<node2Name>`" for the `node1ToNode2` array; "Data from `<node2Name>` to `<node1Name>`" for `node2ToNode1`.
- **Empty-state copy (AC4.7):** "No data items defined in this diagram. Import a diagram with data items to select references." (Concise. If i18n is planned for this project, use a literal string for now — there's no evidence of an i18n framework in the codebase.)
- **Reactivity primary path:** Vue declarative `watch`. Fallback to `RootProperty.subscribe` only if the declarative watch fails under the existing model reactivity.
- **Context prop shape:**
  ```typescript
  interface DataItemRefFieldContext {
      node1View: BlockView;
      node2View: BlockView;
      direction: "node1ToNode2" | "node2ToNode1";
  }
  ```
  `PropertyEditor` computes this per-field when the selection is a Line and the field key is one of the two ref-array keys.

**Skills to activate before implementing:**

- `ed3d-house-style:coding-effectively`
- `ed3d-house-style:howto-code-in-typescript`
- `ed3d-house-style:programming-in-react` — does NOT apply; this is Vue. Skip.
- `ed3d-house-style:writing-good-tests`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: `DataItemRefListProperty` subclass and factory dispatch

**Verifies:** bidirectional-flow.AC4.1 (foundation — the dispatch can now route a distinct class)

**Files:**
- Create: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Property/CollectionProperty/DataItemRefListProperty.ts`
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/DiagramObjectFactory.ts`
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramModel/DiagramObject/Property/CollectionProperty/index.ts` (or equivalent barrel) if one exists — re-export the new class.

**Implementation:**

1. Create `DataItemRefListProperty.ts`:
   ```typescript
   import { ListProperty } from "./ListProperty";

   /**
    * List of data-item GUID references carried by a Flow in one direction.
    * Identical runtime shape to ListProperty<StringProperty>; the distinct
    * class name lets the property editor dispatch to DataItemRefListField
    * (while ListProperty still renders the generic ListField).
    */
   export class DataItemRefListProperty extends ListProperty {
       // No new fields or methods. Inherits everything from ListProperty.
   }
   ```

2. In `DiagramObjectFactory.ts` (PropertyType dispatch switch at lines 384-421 — updated by Phase 3 to fall through `DataItemRefList` to the `List` path):
   - Split the case so `PropertyType.DataItemRefList` instantiates `DataItemRefListProperty` while `PropertyType.List` still instantiates `ListProperty`. Concretely:
     ```typescript
     case PropertyType.DataItemRefList: {
         return createListProperty(descriptor, DataItemRefListProperty);
         // or whatever the factory idiom is — if createListProperty doesn't
         // take a class ctor, inline it for the DataItemRefList branch.
     }
     case PropertyType.List: {
         return createListProperty(descriptor);
     }
     ```
   - If `createListProperty` doesn't take a class ctor today, the executor extracts a parameter or duplicates a 3-4-line branch. Keep both branches identical except for which class is `new`-ed.

3. Verify the barrel re-exports the new class so imports like `import { DataItemRefListProperty } from "@OpenChart/..."` work.

**Implementation notes:**
- `DataItemRefListProperty` must not introduce behavior divergence from `ListProperty`. Any new behavior (validation, etc.) would surprise consumers of the common `ListProperty` surface. The only purpose is dispatch routing.
- Serialization / deserialization is automatic — `toJson` / factory reconstruction both operate on the descriptor `type` value `"data_item_ref_list"`.

**Verification:** defer to Task 6.

**Commit:** (hold — single commit at end of Task 6).
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `ApplicationStore.activeDataItems` getter

**Verifies:** bidirectional-flow.AC4.5 (source data for the dropdown), AC4.7 (empty-state detection)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/stores/ApplicationStore.ts`

**Implementation:**

Add a new getter to the `defineStore` `getters` section:

```typescript
import { readDataItems, type DataItem } from "@OpenChart/DiagramModel/DataItemLookup";

// ... inside defineStore ...
getters: {
    // ... existing getters ...

    activeDataItems(): DataItem[] {
        const canvas = this.activeEditor?.file?.canvas;
        if (!canvas) return [];
        return readDataItems(canvas);
    },
}
```

Notes:
- `activeEditor` defaults to `PhantomEditor` in the state (per investigator). If it's a phantom, `readDataItems` should still return `[]`. Check `activeEditor.file.canvas` existence first; if the phantom has a placeholder canvas, fall through to `readDataItems` safely.
- Do NOT cache the returned array — Pinia getter computes lazily on each access. Consumers can memoise at the component level if profiling shows hot paths.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: `DataItemRefListField.vue` component

**Verifies:** bidirectional-flow.AC4.1, AC4.2, AC4.3, AC4.4, AC4.5, AC4.6, AC4.7

**Files:**
- Create: `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DataItemRefListField.vue`
- Create: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramEditor/Commands/Property/AddDataItemRef.ts` (new atomic create-with-value command — see below).
- Modify: wherever `EditorCommands` is exported (grep `rg -n "createSubproperty" src/assets/scripts/OpenChart/DiagramEditor/Commands` — expose `addDataItemRef` factory alongside the existing `createSubproperty`/`deleteSubproperty`).

**Implementation contract:**

```typescript
interface DataItemRefListFieldProps {
    property: DataItemRefListProperty;  // the ref array — [key, StringProperty-holding-guid] pairs
    context: {
        node1View: BlockView;
        node2View: BlockView;
        direction: "node1ToNode2" | "node2ToNode1";
    };
}
// Emits: execute(cmd: SynchronousEditorCommand)
```

Use `<script lang="ts">` + `defineComponent` per project style (see `ListField.vue`, `TextField.vue` for reference).

**Component behavior (render and logic):**

1. **Direction label (AC4.2, AC4.6):**
   - Computed `label(): string`:
     ```typescript
     label(): string {
         const from = this.context.direction === "node1ToNode2"
             ? this.blockName(this.context.node1View)
             : this.blockName(this.context.node2View);
         const to = this.context.direction === "node1ToNode2"
             ? this.blockName(this.context.node2View)
             : this.blockName(this.context.node1View);
         return `Data from ${from} to ${to}`;
     }
     ```
     `blockName(view)` reads `view.properties.value.get("name")`'s value (StringProperty `.toJson()`), with a fallback for empty/unset (e.g., "Unnamed").
   - Reactivity: add watchers on both endpoint names:
     ```typescript
     watch: {
         "context.node1View.properties.value": { handler() { /* trigger re-render */ }, deep: true },
         "context.node2View.properties.value": { handler() { /* trigger re-render */ }, deep: true },
     }
     ```
     If Vue declarative watchers don't reflect model mutations (because the OpenChart model isn't reactive via Vue), fall back to `this.context.node1View.properties.subscribe("rename", this.forceUpdate)` in `mounted`, unsubscribe in `unmounted`. Try Vue first; implement the fallback only if the Vue watch doesn't fire in the interactive smoke.

2. **Selected items list (AC4.4):**
   - Iterate `property.value` (a `Map<string, StringProperty>` — the synthetic keys are irrelevant to the user; the StringProperty's value is the data-item GUID).
   - For each entry, resolve the data item's display name via `canvasDataItems.find(di => di.guid === stringProp.toJson())`. If not found (dangling ref — validator handles this), display the GUID prefixed with `"?"` and a warning icon.
   - Render a chip with the data item's name + a delete button.
   - Click delete → `this.$emit("execute", EditorCommands.deleteSubproperty(this.property, entryKey))`.

3. **Dropdown (AC4.3, AC4.5, AC4.7):**
   - Source: `activeDataItems` from the store:
     ```typescript
     computed: {
         availableDataItems(): DataItem[] {
             const store = useApplicationStore();
             return store.activeDataItems;
         },
         alreadySelected(): Set<string> {
             const selected = new Set<string>();
             for (const [, prop] of this.property.value) {
                 const guid = (prop as StringProperty).toJson();
                 if (typeof guid === "string" && guid.length > 0) {
                     selected.add(guid);
                 }
             }
             return selected;
         },
         dropdownOptions(): Array<{ value: string; text: string }> {
             return this.availableDataItems
                 .filter(di => !this.alreadySelected.has(di.guid))
                 .map(di => ({ value: di.guid, text: di.name ?? "(unnamed)" }));
         },
     }
     ```
     Filter out already-selected items (AC4.5).
   - Render a `<select>` or existing combobox primitive (prefer whatever `EnumField.vue` uses for visual consistency). Wire `@change` (or equivalent) to a handler.
   - **New editor command `AddDataItemRef`.** The generic `createSubproperty` command only creates an empty entry (per `ListField.vue:106-108`); the value is edited separately by the user via `TextField`. The DataItemRefListField picks a value in one click, so two sequential commands would double-log undo. Introduce an atomic command:
     ```typescript
     // src/assets/scripts/OpenChart/DiagramEditor/Commands/Property/AddDataItemRef.ts
     export class AddDataItemRef extends SynchronousEditorCommand {
         public readonly property: ListProperty;
         private readonly subproperty: StringProperty;

         constructor(property: ListProperty, guid: string) {
             super();
             this.property = property;
             const entry = property.createListItem() as StringProperty;
             entry.setValue(guid);
             this.subproperty = entry;
         }

         public execute(issueDirective: DirectiveIssuer = () => {}): void {
             this.property.addProperty(this.subproperty, this.subproperty.id);
             issueDirective(EditorDirective.Record | EditorDirective.Autosave);
         }

         public undo(issueDirective: DirectiveIssuer = () => {}): void {
             this.property.removeProperty(this.subproperty.id);
             issueDirective(EditorDirective.Autosave);
         }
     }
     ```
     Register it in the `EditorCommands` export alongside `createSubproperty` / `deleteSubproperty` (follow the export style already used — usually a factory function, e.g., `addDataItemRef: (p, g) => new AddDataItemRef(p, g)`). **Add this file as part of Task 3** — it's a small, pure-logic addition that the component depends on.
   - Handler on select becomes a single command:
     ```typescript
     onSelect(guid: string) {
         if (!guid) return;
         const cmd = EditorCommands.addDataItemRef(this.property, guid);
         this.$emit("execute", cmd);
         // Reset the dropdown selection so the next pick fires another change event.
     }
     ```

4. **Empty-state (AC4.7):**
   - If `this.availableDataItems.length === 0` AND `this.property.value.size === 0`:
     ```html
     <div class="empty-state">
         No data items defined in this diagram. Import a diagram with data items to select references.
     </div>
     ```
   - Hide the dropdown in this case. Still render the direction label and (empty) chip list for visual consistency.

**Template skeleton** (inline for clarity — component file will be idiomatic `.vue`):

```html
<template>
    <section class="data-item-ref-list-field">
        <h4 class="direction-label">{{ label }}</h4>

        <ul v-if="property.value.size > 0" class="selected-items">
            <li v-for="[key, prop] in property.value" :key="key">
                <span class="chip">{{ resolveName(prop) }}</span>
                <button type="button" @click="onDelete(key)" aria-label="Remove">×</button>
            </li>
        </ul>

        <div v-if="availableDataItems.length === 0 && property.value.size === 0" class="empty-state">
            No data items defined in this diagram. Import a diagram with data items to select references.
        </div>

        <select v-else @change="onSelect(($event.target as HTMLSelectElement).value)">
            <option value="" disabled selected>Add data item…</option>
            <option v-for="opt in dropdownOptions" :key="opt.value" :value="opt.value">
                {{ opt.text }}
            </option>
        </select>
    </section>
</template>
```

**Implementation notes:**
- Preserve ref-array order on both add and delete (delete removes only the selected key; the remaining order is preserved by `Map` iteration order).
- `<select>` above is a placeholder — if the project has a nicer combobox primitive already in use (e.g., `OptionsList.vue`), compose that instead. Match visual style of existing property fields.
- Scoped CSS per `.vue` convention.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Dispatch routing + `PropertyEditor` / `EditorSidebar` context threading

**Verifies:** bidirectional-flow.AC4.1, AC4.3, AC4.4

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DictionaryFieldContents.vue`
- Modify: `/Users/josh/code/dfd_editor/src/components/Elements/PropertyEditor.vue`
- Modify: `/Users/josh/code/dfd_editor/src/components/Elements/EditorSidebar.vue`

**Implementation:**

1. **`DictionaryFieldContents.vue`** — add dispatch case for the new class:
   ```typescript
   getField(type: Property): string | undefined {
     switch(type.constructor.name) {
       case StringProperty.name:       return "TextField";
       case IntProperty.name:
       case FloatProperty.name:        return "NumberField";
       case DateProperty.name:         return "DateTimeField";
       case EnumProperty.name:         return "EnumField";
       case DataItemRefListProperty.name: return "DataItemRefListField";  // ← new
       case ListProperty.name:         return "ListField";
       case TupleProperty.name:        return "TupleField";
       case DictionaryProperty.name:   return "DictionaryField";
     }
   }
   ```
   **Order matters:** `DataItemRefListProperty.name` case must come BEFORE `ListProperty.name` if the switch's dispatch relies on the exact class name (`constructor.name`). The subclass has a distinct `constructor.name` — so it's actually fine if they're not adjacent — but placing them close keeps intent clear.

2. **Template** — pass `context` through when rendering the new field:
   ```html
   <component
       v-for="[key, subprop] in property.value"
       :key="key"
       :is="getField(subprop)"
       :property="subprop"
       :context="contextFor(key, subprop)"
       @execute="(cmd) => $emit('execute', cmd)"
   />
   ```
   Add a `contextFor(key, subprop)` method that returns the right object only for `DataItemRefListProperty` subprops; returns `undefined` for anything else. `DataItemRefListField` accepts `context` required; other fields accept nothing (extra props ignored in Vue).

3. **`DictionaryFieldContents.vue` — accept a parent-supplied `context` map:**
   - New prop: `context: Record<string, unknown>` (default `{}`) — keyed by property key. For a Line selection, the parent populates `{ node1_src_data_item_refs: {...}, node2_src_data_item_refs: {...} }`.

4. **`PropertyEditor.vue`** — accept and forward an `context` prop:
   - New prop: `context: Record<string, unknown>` (default `{}`).
   - Pass it to `<DictionaryFieldContents :context="context" ... />`.

5. **`EditorSidebar.vue` (or wherever `PropertyEditor` is instantiated)** — compute the context for a selected Line:
   ```typescript
   computed: {
       selected() { /* existing: returns RootProperty */ },
       fieldContext(): Record<string, unknown> {
           const app = this.application;
           if (app.hasSelection !== 1) return {};
           const obj = app.getSelection[0];
           if (!(obj instanceof LineView)) return {};
           const node1View = obj.node1Object as BlockView | null;
           const node2View = obj.node2Object as BlockView | null;
           if (!node1View || !node2View) return {};
           return {
               node1_src_data_item_refs: { node1View, node2View, direction: "node1ToNode2" },
               node2_src_data_item_refs: { node1View, node2View, direction: "node2ToNode1" },
           };
       },
   }
   ```
   Pass `:context="fieldContext"` to `<PropertyEditor>` in the template.

**Edge cases:**
- If `node1Object` or `node2Object` is null (dangling latch — shouldn't happen on a valid Flow, but possible during in-flight edits), fall back to a label like "Data from (unconnected) to X" and still allow edits. Don't crash the editor.
- If the selection is not a Line, `fieldContext` returns `{}` — `DataItemRefListField` should guard by checking `context` is populated and show a placeholder or nothing if not.

**Verification:** defer to Task 6.

**Commit:** (hold).
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: `DataItemRefListField.spec.ts` — first Vue component spec in the project

**Verifies:** bidirectional-flow.AC4.1, AC4.2, AC4.3, AC4.4, AC4.5, AC4.6, AC4.7

**Files:**
- Create: `/Users/josh/code/dfd_editor/src/components/Controls/Fields/DataItemRefListField.spec.ts`
- Potentially modify: `/Users/josh/code/dfd_editor/package.json` — if `@pinia/testing` is not already present, add `"@pinia/testing": "*"` to devDependencies and run `npm install`. Verify with: `rg '@pinia/testing' /Users/josh/code/dfd_editor/package.json` before adding.

**Implementation:**

Use the jsdom environment via file-level comment (precedent: `D2Bridge.spec.ts`).

Spec skeleton:

```typescript
// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createTestingPinia } from "@pinia/testing";
import DataItemRefListField from "./DataItemRefListField.vue";
// ... plus testing helpers to build ref-array properties and block views ...

describe("DataItemRefListField", () => {
    // Test harness: construct a real DataItemRefListProperty + BlockView stubs.
    // Use the DiagramObjectViewFactory pattern from OpenChart.spec.ts createTestingLine().

    it("AC4.1: renders a labelled section for the direction", async () => {
        // Build a property + context with named endpoints.
        // Mount the component.
        // Assert: section contains the label text; section has a chip-list area.
    });

    it("AC4.2: label displays endpoint names (not node1/node2)", async () => {
        // Endpoints named "Browser" and "ALB". Direction node1ToNode2.
        // Assert label === "Data from Browser to ALB".
    });

    it("AC4.3: selecting from the dropdown emits a createSubproperty execute event", async () => {
        // Mount with a canvas that has two data items (one unselected).
        // Trigger change on the <select> with that item's guid.
        // Assert wrapper.emitted("execute") length >= 1;
        //   first emission args[0] is a CreateSubproperty command targeting the property.
    });

    it("AC4.4: clicking delete on a chip emits deleteSubproperty", async () => {
        // Mount with one selected item.
        // Click the delete button.
        // Assert wrapper.emitted("execute")[0][0] instanceof DeleteSubproperty,
        //   and the target id matches the selected key.
    });

    it("AC4.5: dropdown hides already-selected items", async () => {
        // Canvas has three data items; two are already in the property.
        // Mount.
        // Assert wrapper.findAll("select option") has length 1 (plus the placeholder),
        //   and that the hidden guids are absent.
    });

    it("AC4.6: renaming an endpoint updates the label reactively", async () => {
        // Mount with node1 named "A".
        // After mount, mutate node1's name StringProperty to "AA".
        // await wrapper.vm.$nextTick() (or flush promises).
        // Assert the rendered label reflects "AA".
    });

    it("AC4.7: empty diagram shows the empty-state hint", async () => {
        // Canvas has zero data items.
        // Mount.
        // Assert .empty-state is rendered;
        // Assert <select> is absent (or has display:none).
    });
});
```

**Test infrastructure:**
- Use `createTestingPinia({ stubActions: false })` in `global.plugins` so the `ApplicationStore` is real (not stubbed) — needed for `activeDataItems` to return correct data.
- Pre-populate the store's `activeEditor.file.canvas` with a minimal diagram containing the expected data items. Build via `DiagramObjectViewFactory`. Avoid hand-crafting internal canvas JSON where possible.
- Stub nothing — the component is small enough that fully mounted rendering is tractable.

**Assertions:**
- Use `wrapper.find("selector").text()` for text assertions.
- Use `wrapper.emitted("execute")` for command emission assertions; check `instanceof` against the specific command classes.
- Use `wrapper.vm.$nextTick()` to flush reactivity before assertions that depend on watcher fire.

**Verification:**
```
cd /Users/josh/code/dfd_editor
npm run test:unit -- DataItemRefListField.spec
```
Expected: all 7 tests pass.

**Commit:** (hold).
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Full verification and interactive smoke test

**Verifies:** bidirectional-flow.AC4 end-to-end; no regressions elsewhere.

**Files:** None modified.

**Implementation:**

1. Run the automated suite:
   ```
   cd /Users/josh/code/dfd_editor
   npm run type-check
   npm run test:unit
   npm run build
   npm run lint
   ```
   All must pass.

2. Interactive smoke:
   - `npm run dev:all`.
   - Import `server/temp/aws-ecs-webapp-with-reverse-flows.json` (bidirectional flows).
   - Select any flow in the canvas.
   - Assert in the property pane:
     - Two labelled sections appear ("Data from X to Y", "Data from Y to X").
     - Each section lists the expected data-item chips.
     - Deleting a chip removes the ref and the corresponding arrowhead disappears if the array became empty (AC4.4 + Phase 4 integration).
     - Adding a new data item via the dropdown appends to the correct array and the arrow appears (AC4.3).
     - The dropdown does NOT list already-selected items (AC4.5).
   - Rename one of the endpoint blocks (edit the block's `name`) and confirm the direction label in the property pane updates (AC4.6).
   - Import a diagram with zero data items and select a flow — empty-state hint shows instead of the dropdown (AC4.7).
   - Round-trip test: save via server, reload, confirm arrangements persist.

3. Regression check — confirm generic list fields still work:
   - Select a block with a `List` property (e.g., `process.assumptions` — a list of strings).
   - Assert it still renders using `ListField.vue`, not `DataItemRefListField.vue`.

**Commit** (single commit covering Tasks 1-6):

```
feat(property-editor): DataItemRefListField for bidirectional flow data-item refs

Selecting a Flow now shows two labelled sections (one per direction) with
dropdown data-item pickers populated from the diagram's top-level data-items
collection. Implements the full AC4 of the bidirectional flow design:
- Dynamic direction labels using endpoint block names
- Add / remove ref triggers arrow re-render (AC3.5 integration)
- Already-selected items hidden from the dropdown
- Empty-state hint when no data items exist

Introduces DataItemRefListProperty subclass of ListProperty to route the
new component via the existing constructor-name dispatch.
```
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
