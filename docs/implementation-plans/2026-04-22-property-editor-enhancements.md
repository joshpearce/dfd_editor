# Property Editor Enhancements

Date: 2026-04-22
Branch: `property-editor-enhancements`

## Goal

Four focused DFD property-editor changes:

1. **Data Item `parent`** — render as a dropdown of canvas elements that
   can contain data (Process / Data Store / External Entity), plus an
   explicit "(unowned)" option. Server-side `DataItem.parent` relaxes
   to `UUID | None` so the unowned state round-trips.
2. **Data Item `classification`** — render as a dropdown constrained to
   `pii | secret | public | internal | unclassified`. `unclassified`
   is a first-class enum member with its own pill color (replaces
   the implicit `"default"` fallback in `PillClassificationKey`) and
   is the default for newly-created data items.
3. **Flow `data_classification`** — remove entirely from schema, UI,
   validator, publisher, server, and drift tests.
4. **Element-scoped data-item adoption** — on Process / Data Store /
   External Entity property forms, show a compact chip list of owned
   data items plus a dropdown to adopt unowned items. No inline edit
   from the element form; editing still happens at the canvas level.
   Modeled after `DataItemRefListField.vue` (Flow's data-item
   handling).

## Non-Goals

- No migrations or backwards compatibility (`server/data/` is empty).
  Sample files at `server/temp/*.json` are the user's to refresh
  manually — the implementer does **not** edit them.
- No "create new data item" button on the element form; creation
  still happens at the canvas-level `data_items` list.
- No new pill colors; `"default"` is simply renamed to
  `"unclassified"` end-to-end.
- No generalised `ElementRef` property type — the new type is
  specific to the data-item parent use case.

## Approach

Each step ships independently (builds, tests pass, no regressions).
Step 1 is a deletion. Step 2 is a schema-shape change plus a
pill-key rename. Step 3 introduces a new
`PropertyType.DataItemParentRef` following the `DataItemRefList`
precedent (serialization-identical to `String`, custom component).
Step 4 is UI-only in the sidebar, no schema change.

---

## Step 1 — Remove Flow `data_classification`

**Changes**

- `DfdObjects.ts` — drop the `data_classification` property from the
  `data_flow` template.
- `DfdValidator.ts` — delete the "high-classification flow exits
  less-privileged zone" rule at ~line 163.
- `server/schema.py` — drop `data_classification` from
  `DataFlowProps`; delete the now-unreferenced `DataClassification`
  enum.
- `server/transform.py` — remove `"data_classification"` from the
  flow-props ordered list (~line 58) and its read/write branch
  (~lines 616–618).
- `server/tests/test_drift.py` — remove the `DataClassification`
  parity row.
- `server/tests/` — remove/update any test asserting
  `data_classification` round-trip.

**Acceptance**

- Canvas, property panel, and validator contain no reference to
  `data_classification`. `rg data_classification src server` returns
  zero hits.
- `npm run lint && npm run type-check && npm run test:unit` pass.
- `server/.venv/bin/pytest server/tests` passes.

---

## Step 2 — Constrain Data Item `classification` to an enum

**Changes**

- `DfdCanvas.ts` — change `data_items.form.classification` from
  `PropertyType.String` to `PropertyType.Enum` with options
  `[["unclassified","Unclassified"], ["pii","PII"],
  ["secret","Secret"], ["public","Public"], ["internal","Internal"]]`,
  default `"unclassified"`.
- `DataItemLookup.ts` — replace `"default"` with `"unclassified"` in
  the `PillClassificationKey` union and in `narrowClassification`'s
  fallback return.
- `BuiltinDesigns.ts` — rename the `default` entry in `darkDataPill`
  / `lightDataPill` to `unclassified` (colors unchanged).
- Any other caller that literal-matches `"default"` as a pill key —
  update the literal.
- Server:
  - `server/schema.py` — introduce
    `DataItemClassification(StrEnum)` with the five members above;
    change `DataItem.classification` type from `str | None` to
    `DataItemClassification` (no longer optional; default
    `DataItemClassification.unclassified`). Emit unconditionally.
  - `server/transform.py` — ensure classification always round-trips
    (it is no longer optional); update the omit-when-None branch in
    `_data_item_to_pairs` so the pair is always emitted.
  - `server/tests/test_drift.py` — add parity row for
    `DataItemClassification`.
  - `server/tests/test_data_items.py` — delete
    `test_free_form_classification_preserved`,
    `test_multiple_custom_classifications`, and any other test
    that has become meaningless under the enum constraint. Update
    remaining fixtures that use free-form values.

**Acceptance**

- Selecting a Data Item in the sidebar renders `classification` as a
  dropdown with exactly five options; newly-created items default
  to `Unclassified`.
- `PillClassificationKey` no longer contains `"default"`; pill
  rendering on the canvas shows the prior default color under the
  `"unclassified"` key. `rg '"default"' src/assets/scripts/OpenChart`
  returns no pill-related hits.
- All server tests pass; pydantic rejects imports with
  classification values outside the enum with HTTP 400.

---

## Step 3 — Dynamic parent picker (`DataItemParentRef`)

**Changes**

- OpenChart engine:
  - Add `DataItemParentRef` to the `PropertyType` enum
    (`src/assets/scripts/OpenChart/DiagramModel/DiagramObjectFactory/PropertyDescriptor/PropertyType.ts`)
    and a `StringProperty` subclass that serializes identically.
    Mirror the `DataItemRefList` precedent.
- UI:
  - New component
    `src/components/Controls/Fields/DataItemParentRefField.vue`.
    Pseudocode:
    ```
    options = [ {value: "", text: "(unowned)"} ]
           ++ activeCanvas.blocks
                .filter(b => b.template in {process, external_entity, data_store})
                .map(b => ({value: b.guid, text: b.displayName}))
    on change: emit SetStringProperty(this.property, selectedValue)
    ```
  - Register dispatch in
    `src/components/Controls/Fields/DictionaryFieldContents.vue`:
    `DataItemParentRefProperty → DataItemParentRefField`.
  - Subscribe to canvas mutations the same way
    `DataItemRefListField` subscribes to endpoint `RootProperty`
    updates, so newly-added or renamed elements refresh the
    dropdown.
- Schema (frontend):
  - `DfdCanvas.ts` — change `data_items.form.parent` from
    `PropertyType.String` to `PropertyType.DataItemParentRef`.
- Schema (server):
  - `server/schema.py` — relax `DataItem.parent` from `UUID` to
    `UUID | None`. Empty-string parent on the frontend serializes to
    absent / `null` on the server; no stray empty-string values in
    wire format.
  - `server/transform.py` — tolerate absent `parent` on incoming
    items and omit the `parent` pair on outgoing items whose parent
    is `None` (mirroring the existing `description` /
    `classification` optionality pattern).
  - `server/tests/test_data_items.py` — add a round-trip test for an
    unowned item (`parent=None`).

**Acceptance**

- Opening a Data Item via the canvas-level list shows `parent` as a
  dropdown listing all Process / Data Store / External Entity blocks
  on the current canvas (labeled by representative name), plus an
  "(unowned)" option at the top.
- Adding or renaming one of those blocks updates the dropdown labels
  / options without a reselect.
- Selecting "(unowned)" clears the parent; save → reload → save
  round-trips the unowned state (server persists `parent = null` or
  omits it; frontend restores the empty string).
- Selecting an element writes its GUID into the underlying property;
  save/load of owned items remains byte-identical to the prior
  String field.

---

## Step 4 — Owned-data-items section on element forms

**Changes**

- New component
  `src/components/Controls/Fields/OwnedDataItemsSection.vue`.
  Pseudocode:
  ```
  ownedItems   = canvas.dataItems.filter(i => i.parent === blockGuid)
  unownedItems = canvas.dataItems.filter(i => !i.parent)

  render:
    <ul>chip for each ownedItem, × sets that item's parent = ""
        (generic SetStringProperty on the data item's parent sub-prop)</ul>
    <select> "Add unowned data item…" + unownedItems
             on select: SetStringProperty(item.parent, blockGuid)
  ```
- Sidebar integration
  (`src/components/Elements/EditorSidebar.vue`): when
  `getSelection.length === 1` and the selected block's template
  `name` is in `{process, external_entity, data_store}`, render
  `OwnedDataItemsSection` below the standard property form. Other
  selections (Flow / Trust Boundary / Container / Canvas) do not
  render it.
- Reuse `store.activeDataItems` and
  `DataItemLookup.dataItemsForParent` for filtering.
- Subscribe to canvas mutations the same way
  `DataItemRefListField` does so add/remove/rename/re-parent
  propagates.

**Acceptance**

- Clicking a Process / Data Store / External Entity on the canvas
  shows a "Data Items" section in the sidebar (chip list +
  dropdown) in addition to the normal property form.
- Adopting an unowned item updates both the element-form chip list
  AND — if the user opens that Data Item via the canvas-level list —
  the item's `parent` dropdown now reflects this element.
- The × affordance on a chip un-owns the item (moves it back into
  the unowned dropdown) as a single undo step.
- Selecting a Flow / Trust Boundary / Container / Canvas does **not**
  render the section.

---

## Definition of Done

- All four step-level acceptance criteria met.
- `npm run lint`, `npm run type-check`, `npm run test:unit`, and
  `server/.venv/bin/pytest server/tests` all pass.
- `rg data_classification src server` returns zero hits.
- New Vue components have `*.spec.ts` coverage for the store-
  subscription reactivity path and the filter logic (chip list +
  dropdown contents).
- PR description flags that example files at `server/temp/*.json`
  are stale pending manual user refresh; implementer does not edit
  those files.
