/**
 * @file DataItemLookup.spec.ts
 *
 * Unit tests for the DataItemLookup helper module.
 * Covers dataItemsForParent, resolveRefs, pillLabel, and the truncate helper.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    dataItemsForParent,
    resolveRefs,
    readDataItemRefs,
    pillLabel,
    truncate
} from "./DataItemLookup";
import type { DataItem } from "./DataItemLookup";
import { DiagramObjectFactory, DiagramModelFile } from "./";
import { Block, Canvas, Line, ListProperty, StringProperty } from "./DiagramObject";
import { DfdCanvas } from "@/assets/configuration/DfdTemplates/DfdCanvas";
import { DfdObjects } from "@/assets/configuration/DfdTemplates/DfdObjects";
import { BaseTemplates } from "@/assets/configuration/DfdTemplates/BaseTemplates";
import type { DiagramSchemaConfiguration } from "./DiagramObjectFactory";
import { addDataItem } from "@/assets/configuration/DfdTemplates/dataItems.test-utils";

// ---------------------------------------------------------------------------
// Schema + factory shared by all tests
// ---------------------------------------------------------------------------

const dfdSchema: DiagramSchemaConfiguration = {
    id: "dfd_v1",
    canvas: DfdCanvas,
    templates: [...BaseTemplates, ...DfdObjects]
};

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
// Tests: resolveRefs
// ---------------------------------------------------------------------------

describe("resolveRefs", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("returns empty array for empty guid list", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        const result = resolveRefs(canvas, []);
        expect(result).toHaveLength(0);
    });

    it("maps a guid list to items in the supplied order", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        addDataItem(canvas, ITEM_A2_GUID, NODE_A, "D2", "Email");
        addDataItem(canvas, ITEM_B1_GUID, NODE_B, "D3", "Cert");

        const result = resolveRefs(canvas, [ITEM_B1_GUID, ITEM_A1_GUID]);
        expect(result).toHaveLength(2);
        expect(result[0].guid).toBe(ITEM_B1_GUID);
        expect(result[1].guid).toBe(ITEM_A1_GUID);
    });

    it("silently skips unknown guids", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        const result = resolveRefs(canvas, ["unknown-guid", ITEM_A1_GUID]);
        expect(result).toHaveLength(1);
        expect(result[0].guid).toBe(ITEM_A1_GUID);
    });

    it("returns empty array when all guids are unknown", () => {
        const result = resolveRefs(canvas, ["ghost-1", "ghost-2"]);
        expect(result).toHaveLength(0);
    });

    it("returns empty array for empty canvas with non-empty guid list", () => {
        const result = resolveRefs(canvas, [ITEM_A1_GUID]);
        expect(result).toHaveLength(0);
    });

});

// ---------------------------------------------------------------------------
// Tests: pillLabel
// ---------------------------------------------------------------------------

describe("pillLabel", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("returns bare identifier when viewedFrom equals the item parent (owner view)", () => {
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        const item = dataItemsForParent(canvas, NODE_A)[0];

        const label = pillLabel(item, NODE_A, canvas);
        expect(label).toBe("D1");
    });

    it("returns qualified label when viewedFrom differs from item parent (non-owner view)", () => {
        // Add the parent process block to the canvas so resolveParentName can find it.
        const block = factory.createNewDiagramObject("process", Block);
        // Override the block's name property.
        (block.properties.value.get("name") as StringProperty).setValue("Proc A");
        canvas.addObject(block);

        addDataItem(canvas, ITEM_A1_GUID, block.instance, "D1", "Token");
        const item = dataItemsForParent(canvas, block.instance)[0];

        const label = pillLabel(item, NODE_B, canvas);
        expect(label).toBe("Proc A.D1");
    });

    it("truncates parent name to 12 chars with ellipsis for non-owner view", () => {
        const block = factory.createNewDiagramObject("process", Block);
        // Name exactly 13 chars — should be truncated to 12 + "…".
        (block.properties.value.get("name") as StringProperty).setValue("VeryLongProc1");
        canvas.addObject(block);

        addDataItem(canvas, ITEM_A1_GUID, block.instance, "D1", "Token");
        const item = dataItemsForParent(canvas, block.instance)[0];

        const label = pillLabel(item, NODE_B, canvas);
        expect(label).toBe("VeryLongProc….D1");
    });

    it("does NOT truncate parent name that is exactly 12 chars", () => {
        const block = factory.createNewDiagramObject("process", Block);
        // Exactly 12 chars — no truncation.
        (block.properties.value.get("name") as StringProperty).setValue("ExactlyTwelv");
        canvas.addObject(block);

        addDataItem(canvas, ITEM_A1_GUID, block.instance, "D1", "Token");
        const item = dataItemsForParent(canvas, block.instance)[0];

        const label = pillLabel(item, NODE_B, canvas);
        expect(label).toBe("ExactlyTwelv.D1");
    });

    it("falls back to raw guid for non-owner view when parent node not found", () => {
        // "unknown-node-guid" is 17 chars → truncated to first 12 + "…"
        const unknownParent = "unknown-node-guid";
        addDataItem(canvas, ITEM_A1_GUID, unknownParent, "D1", "Token");
        const item = dataItemsForParent(canvas, unknownParent)[0];

        const label = pillLabel(item, NODE_B, canvas);
        // "unknown-node" is 12 chars → no truncation-within-truncation.
        expect(label).toContain(".D1");
        expect(label.startsWith("unknown-node….D1")).toBe(true);
    });

    it("null viewedFromGuid always produces the qualified form (no-owner view)", () => {
        // Passing null means "no owner" — always qualify, even if the GUID would
        // accidentally match (not possible with null, but the contract is explicit).
        addDataItem(canvas, ITEM_A1_GUID, NODE_A, "D1", "Token");
        const item = dataItemsForParent(canvas, NODE_A)[0];

        // null → qualified form (parent not in canvas object tree → raw guid prefix)
        const label = pillLabel(item, null, canvas);
        expect(label).toContain("D1");
        // Should NOT be bare "D1" — must be qualified
        expect(label).not.toBe("D1");
        expect(label).toMatch(/^.+\.D1$/);
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
// Tests: truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {

    it("returns string unchanged when shorter than maxLength", () => {
        expect(truncate("Hello", 10)).toBe("Hello");
    });

    it("returns string unchanged when equal to maxLength", () => {
        expect(truncate("HelloWorld", 10)).toBe("HelloWorld");
    });

    it("truncates string longer than maxLength and appends ellipsis", () => {
        expect(truncate("HelloWorldExtra", 10)).toBe("HelloWorld…");
    });

    it("truncates at boundary 12 (spec case: parent name)", () => {
        expect(truncate("VeryLongProc1", 12)).toBe("VeryLongProc…");
    });

    it("does not truncate exactly 12 chars", () => {
        expect(truncate("ExactlyTwelv", 12)).toBe("ExactlyTwelv");
    });

    it("returns empty string for empty input", () => {
        expect(truncate("", 12)).toBe("");
    });

    it("returns only ellipsis when maxLength is 0", () => {
        expect(truncate("abc", 0)).toBe("…");
    });

    it("counts emoji as single code points (surrogate-pair safety)", () => {
        // "👋" is one code point but two UTF-16 code units; it must not be
        // split.  A 5-char string where char 1 is an emoji: "A👋BCD" (5 code
        // points) truncated to 4 yields "A👋BC…".
        const str = "A\uD83D\uDC4BBCD"; // A + 👋 + BCD = 5 code points
        expect(truncate(str, 4)).toBe("A👋BC…");
        // Confirm the full string is not truncated at exactly 5 code points.
        expect(truncate(str, 5)).toBe("A👋BCD");
    });

});

