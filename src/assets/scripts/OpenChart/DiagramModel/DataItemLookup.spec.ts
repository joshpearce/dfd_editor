/**
 * @file DataItemLookup.spec.ts
 *
 * Unit tests for the DataItemLookup helper module.
 * Covers dataItemsForParent, readDataItemRefs, readDataItems,
 * and narrowClassification.
 *
 * Schema and addDataItem helper are inlined here to avoid importing from
 * src/assets/configuration/ (OpenChart must not depend on configuration).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    dataItemsForParent,
    readDataItemRefs,
    readDataItems,
    narrowClassification
} from "./DataItemLookup";
import type { DataItem } from "./DataItemLookup";
import {
    DiagramObjectFactory, DiagramModelFile,
    Block, Canvas, Line, ListProperty, StringProperty, DictionaryProperty,
    DiagramObjectType, PropertyType
} from "./";
import type { DiagramSchemaConfiguration, CanvasTemplate, DiagramObjectTemplate } from "./DiagramObjectFactory";

// ---------------------------------------------------------------------------
// Minimal schema — inlined to keep OpenChart independent of configuration
// ---------------------------------------------------------------------------

const minimalCanvas: CanvasTemplate = {
    name: "dfd",
    type: DiagramObjectType.Canvas,
    properties: {
        data_items: {
            type: PropertyType.List,
            form: {
                type: PropertyType.Dictionary,
                form: {
                    parent:         { type: PropertyType.String },
                    identifier:     { type: PropertyType.String, is_representative: true },
                    name:           { type: PropertyType.String },
                    description:    { type: PropertyType.String },
                    classification: { type: PropertyType.String }
                }
            }
        }
    }
};

const minimalTemplates: DiagramObjectTemplate[] = [
    { name: "horizontal_anchor", type: DiagramObjectType.Anchor },
    { name: "vertical_anchor",   type: DiagramObjectType.Anchor },
    { name: "generic_latch",     type: DiagramObjectType.Latch  },
    { name: "generic_handle",    type: DiagramObjectType.Handle },
    {
        name: "process",
        type: DiagramObjectType.Block,
        properties: {
            name: { type: PropertyType.String, is_representative: true }
        },
        anchors: {}
    },
    {
        name: "data_flow",
        type: DiagramObjectType.Line,
        handle_template: "generic_handle",
        latch_template: { source: "generic_latch", target: "generic_latch" },
        properties: {
            name: { type: PropertyType.String, is_representative: true },
            data_item_refs: {
                type: PropertyType.List,
                form: { type: PropertyType.String },
                default: []
            }
        }
    }
];

const dfdSchema: DiagramSchemaConfiguration = {
    id: "dfd_v1",
    canvas: minimalCanvas,
    templates: minimalTemplates
};

// ---------------------------------------------------------------------------
// Local addDataItem helper — mirrors dataItems.test-utils without the
// cross-boundary import.
// ---------------------------------------------------------------------------

function addDataItem(
    canvas: Canvas,
    guid: string,
    parent: string,
    identifier: string,
    name: string,
    description?: string,
    classification?: string
): void {
    const dataItemsProp = canvas.properties.value.get("data_items");
    if (!(dataItemsProp instanceof ListProperty)) {
        throw new Error("canvas.properties.data_items is not a ListProperty");
    }
    const entry = dataItemsProp.createListItem() as DictionaryProperty;
    const fields = entry.value;
    (fields.get("parent")     as StringProperty).setValue(parent);
    (fields.get("identifier") as StringProperty).setValue(identifier);
    (fields.get("name")       as StringProperty).setValue(name);
    if (description !== undefined) {
        (fields.get("description") as StringProperty).setValue(description);
    }
    if (classification !== undefined) {
        (fields.get("classification") as StringProperty).setValue(classification);
    }
    dataItemsProp.addProperty(entry, guid);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let factory: DiagramObjectFactory;
let canvas: Canvas;

const NODE_A = "node-a-guid";
const NODE_B = "node-b-guid";

const ITEM_A1_GUID = "item-a1";
const ITEM_A2_GUID = "item-a2";
const ITEM_B1_GUID = "item-b1";

// ---------------------------------------------------------------------------
// Tests: dataItemsForParent
// ---------------------------------------------------------------------------

describe("dataItemsForParent", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("returns items matching the given parent guid in insertion order", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        addDataItem(canvas, ITEM_A2_GUID, NODE_A, "D2", "Email");
        addDataItem(canvas, ITEM_B1_GUID, NODE_B, "D3", "Cert");

        const result = dataItemsForParent(canvas, NODE_A);
        expect(result).toHaveLength(2);
        expect(result[0].guid).toBe(ITEM_A1_GUID);
        expect(result[1].guid).toBe(ITEM_A2_GUID);
    });

    it("returns empty array when no items match the parent guid", () => {
        addDataItem(canvas, ITEM_B1_GUID, NODE_B, "D3", "Cert");
        const result = dataItemsForParent(canvas, NODE_A);
        expect(result).toHaveLength(0);
    });

    it("returns empty array for an empty canvas (no data_items at all)", () => {
        const result = dataItemsForParent(canvas, NODE_A);
        expect(result).toHaveLength(0);
    });

    it("preserves insertion order for items belonging to the same parent", () => {
        addDataItem(canvas, "c", NODE_A, "D3", "Third");
        addDataItem(canvas, "b", NODE_A, "D2", "Second");
        addDataItem(canvas, "a", NODE_A, "D1", "First");

        const result = dataItemsForParent(canvas, NODE_A);
        expect(result.map(i => i.identifier)).toEqual(["D3", "D2", "D1"]);
    });

    it("returns items with all fields populated correctly", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Session Token", "A JWT", "secret");
        const [item] = dataItemsForParent(canvas, NODE_A);
        expect(item).toMatchObject<DataItem>({
            guid: ITEM_A1_GUID,
            parent: NODE_A,
            identifier: "D1",
            name: "Session Token",
            description: "A JWT",
            classification: "secret"
        });
    });

    it("omits description and classification when they are null", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        const [item] = dataItemsForParent(canvas, NODE_A);
        expect(item.description).toBeUndefined();
        expect(item.classification).toBeUndefined();
    });

});

// ---------------------------------------------------------------------------
// Tests: readDataItemRefs
// ---------------------------------------------------------------------------

describe("readDataItemRefs", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("returns empty array when object has no data_item_refs property", () => {
        // A block template has no data_item_refs, so the helper should return [].
        const block = factory.createNewDiagramObject("process", Block);
        canvas.addObject(block);
        expect(readDataItemRefs(block.properties)).toHaveLength(0);
    });

    it("returns all non-empty guid strings from data_item_refs", () => {
        const flow = factory.createNewDiagramObject("data_flow", Line);
        canvas.addObject(flow);
        const refsProp = flow.properties.value.get("data_item_refs");
        if (!(refsProp instanceof ListProperty)) {
            throw new Error("data_item_refs not a ListProperty");
        }
        // Add two entries
        const e1 = refsProp.createListItem() as StringProperty;
        e1.setValue("guid-1");
        refsProp.addProperty(e1);
        const e2 = refsProp.createListItem() as StringProperty;
        e2.setValue("guid-2");
        refsProp.addProperty(e2);

        const guids = readDataItemRefs(flow.properties);
        expect(guids).toEqual(["guid-1", "guid-2"]);
    });

    it("filters out empty-string entries", () => {
        const flow = factory.createNewDiagramObject("data_flow", Line);
        canvas.addObject(flow);
        const refsProp = flow.properties.value.get("data_item_refs");
        if (!(refsProp instanceof ListProperty)) {
            throw new Error("data_item_refs not a ListProperty");
        }
        const e1 = refsProp.createListItem() as StringProperty;
        e1.setValue("");
        refsProp.addProperty(e1);
        const e2 = refsProp.createListItem() as StringProperty;
        e2.setValue("guid-real");
        refsProp.addProperty(e2);

        const guids = readDataItemRefs(flow.properties);
        expect(guids).toEqual(["guid-real"]);
    });

    it("returns empty array when data_item_refs list is empty", () => {
        const flow = factory.createNewDiagramObject("data_flow", Line);
        canvas.addObject(flow);
        expect(readDataItemRefs(flow.properties)).toHaveLength(0);
    });

});

// ---------------------------------------------------------------------------
// Tests: readDataItems — partial items are surfaced (I2)
// ---------------------------------------------------------------------------

describe("readDataItems — partial items are surfaced", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("returns all items including those with missing required fields", () => {
        // Add a well-formed item
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Full Item");

        // Add a partial item (missing identifier and name — simulate by adding
        // only the parent field directly so required fields are unset).
        const dataItemsProp = canvas.properties.value.get("data_items") as ListProperty;
        const partialEntry = dataItemsProp.createListItem() as DictionaryProperty;
        (partialEntry.value.get("parent") as StringProperty).setValue(NODE_B);
        // Leave identifier and name unset.
        dataItemsProp.addProperty(partialEntry, "partial-guid");

        const items = readDataItems(canvas);
        // Both items must be present — no silent skipping.
        expect(items).toHaveLength(2);
        const partial = items.find(i => i.guid === "partial-guid");
        expect(partial).toBeDefined();
        // Missing fields default to empty string.
        expect(partial!.identifier).toBe("");
        expect(partial!.name).toBe("");
        expect(partial!.parent).toBe(NODE_B);
    });

});

// ---------------------------------------------------------------------------
// Tests: narrowClassification (M3)
// ---------------------------------------------------------------------------

describe("narrowClassification", () => {

    it("returns 'pii' for 'pii'",         () => expect(narrowClassification("pii")).toBe("pii"));
    it("returns 'secret' for 'secret'",   () => expect(narrowClassification("secret")).toBe("secret"));
    it("returns 'public' for 'public'",   () => expect(narrowClassification("public")).toBe("public"));
    it("returns 'internal' for 'internal'", () => expect(narrowClassification("internal")).toBe("internal"));
    it("returns 'default' for unknown",   () => expect(narrowClassification("top-secret")).toBe("default"));
    it("returns 'default' for null",      () => expect(narrowClassification(null)).toBe("default"));
    it("returns 'default' for undefined", () => expect(narrowClassification(undefined)).toBe("default"));
    it("returns 'default' for empty string", () => expect(narrowClassification("")).toBe("default"));

});
