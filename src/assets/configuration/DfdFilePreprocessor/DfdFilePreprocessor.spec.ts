/**
 * @file DfdFilePreprocessor.spec.ts
 *
 * Verifies that DfdFilePreprocessor normalises incoming native dfd_v1 files:
 *   - Backend-emitted `data_item_refs` plain-string arrays are converted to
 *     the JsonEntries [[key, guid], ...] format the OpenChart factory expects.
 *   - Canvas `data_items` in the correct [[guid, [[k,v],...]], ...] format
 *     pass through untouched.
 *   - Legacy files (no data_items / data_item_refs) pass through without error.
 *   - Round-trip: minimal-format input → preprocessor + factory → publisher
 *     re-emits the same minimal shape (identity).
 */

import { describe, it, expect, beforeEach } from "vitest";
import DfdPublisher from "../DfdPublisher/DfdPublisher";
import DfdFilePreprocessor from "./DfdFilePreprocessor";
import { DiagramObjectFactory, DiagramModelFile, ListProperty, StringProperty } from "@OpenChart/DiagramModel";
import type { DiagramViewExport } from "@OpenChart/DiagramView";
import { DfdCanvas } from "../DfdTemplates/DfdCanvas";
import { DfdObjects } from "../DfdTemplates/DfdObjects";
import { BaseTemplates } from "../DfdTemplates/BaseTemplates";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const dfdSchema: DiagramSchemaConfiguration = {
    id: "dfd_v1",
    canvas: DfdCanvas,
    templates: [...BaseTemplates, ...DfdObjects]
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal native dfd_v1 export with two process blocks connected by
 * a single data_flow.  This mirrors the shape that transform.to_native()
 * produces, with anchors referenced only through the block's `anchors` map
 * (not added directly to the canvas's `objects` list).
 */
function makeNativeFile(overrides: {
    canvasDataItemsValue?: unknown;
    flowDataItemRefsValue?: unknown;
}): DiagramViewExport {
    const canvasProps: [string, unknown][] = [
        ["name", "Test Diagram"],
        ["description", null],
        ["author", null],
        ["created", null]
    ];
    if (overrides.canvasDataItemsValue !== undefined) {
        canvasProps.push(["data_items", overrides.canvasDataItemsValue]);
    }

    const flowProps: [string, unknown][] = [
        ["name", "F1"],
        ["data_classification", null],
        ["protocol", null],
        ["authenticated", "false"],
        ["encrypted_in_transit", "false"]
    ];
    if (overrides.flowDataItemRefsValue !== undefined) {
        flowProps.push(["data_item_refs", overrides.flowDataItemRefsValue]);
    }

    // Anchors belong to blocks (via `anchors` map) and are NOT listed in the
    // canvas's `objects` array.  Adding them to the canvas would cause
    // "Groups cannot contain 'Anchor'" from Group.addObject.
    return {
        schema: "dfd_v1",
        objects: [
            {
                id: "dfd",
                instance: "canvas-1",
                properties: canvasProps as [string, unknown][],
                objects: ["src-block", "tgt-block", "flow-1"]
            },
            {
                id: "process",
                instance: "src-block",
                anchors: { 0: "src-anchor" },
                properties: [["name", "Process A"]]
            },
            {
                id: "process",
                instance: "tgt-block",
                anchors: { 0: "tgt-anchor" },
                properties: [["name", "Process B"]]
            },
            {
                id: "horizontal_anchor",
                instance: "src-anchor",
                latches: ["latch-src"]
            },
            {
                id: "horizontal_anchor",
                instance: "tgt-anchor",
                latches: ["latch-tgt"]
            },
            {
                id: "data_flow",
                instance: "flow-1",
                source: "latch-src",
                target: "latch-tgt",
                handles: [],
                properties: flowProps as [string, unknown][]
            },
            { id: "generic_latch", instance: "latch-src" },
            { id: "generic_latch", instance: "latch-tgt" }
        ]
    } as unknown as DiagramViewExport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DfdFilePreprocessor", () => {

    let preprocessor: DfdFilePreprocessor;
    let factory: DiagramObjectFactory;

    beforeEach(() => {
        preprocessor = new DfdFilePreprocessor();
        factory = new DiagramObjectFactory(dfdSchema);
    });

    // -----------------------------------------------------------------------
    // Legacy / no data_items / no refs
    // -----------------------------------------------------------------------

    describe("legacy files — no data_items / no data_item_refs", () => {
        it("passes through a file with no data_items or data_item_refs without error", () => {
            const native = makeNativeFile({});
            const processed = preprocessor.process(native);
            // Should produce a loadable file.
            expect(() => new DiagramModelFile(factory, processed)).not.toThrow();
        });

        it("canvas data_items ListProperty is empty after loading a legacy file", () => {
            const native = makeNativeFile({});
            const processed = preprocessor.process(native);
            const file = new DiagramModelFile(factory, processed);
            const dataProp = file.canvas.properties.value.get("data_items");
            expect(dataProp).toBeInstanceOf(ListProperty);
            expect((dataProp as ListProperty).value.size).toBe(0);
        });

        it("flow data_item_refs ListProperty is empty after loading a legacy file", () => {
            const native = makeNativeFile({});
            const processed = preprocessor.process(native);
            const file = new DiagramModelFile(factory, processed);
            // Find the flow object.
            const flowObj = [...(file.canvas as unknown as { objects: Set<{ id: string, properties: { value: Map<string, unknown> } }> }).objects]
                .find(o => o.id === "data_flow");
            expect(flowObj).toBeDefined();
            const refsProp = flowObj!.properties.value.get("data_item_refs");
            expect(refsProp).toBeInstanceOf(ListProperty);
            expect((refsProp as ListProperty).value.size).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Backend-emitted plain string list for data_item_refs
    // -----------------------------------------------------------------------

    describe("flow data_item_refs — backend plain-string-list format", () => {
        it("normalises plain string array to loadable JsonEntries", () => {
            const guid1 = "aaaa-0001";
            const guid2 = "aaaa-0002";
            const native = makeNativeFile({ flowDataItemRefsValue: [guid1, guid2] });
            const processed = preprocessor.process(native);

            // After processing, the data_flow properties should have
            // data_item_refs as [[key, guid], ...].
            const flowExport = processed.objects.find(o => o.id === "data_flow");
            const refsEntry = (flowExport!.properties as [string, unknown][])
                ?.find(([k]) => k === "data_item_refs");
            expect(refsEntry).toBeDefined();
            const refsValue = refsEntry![1] as unknown[][];
            expect(Array.isArray(refsValue)).toBe(true);
            // Each sub-entry should be [string, string].
            for (const entry of refsValue) {
                expect(Array.isArray(entry)).toBe(true);
                expect(typeof (entry as string[])[0]).toBe("string");
                expect(typeof (entry as string[])[1]).toBe("string");
            }
            // Values in order.
            expect(refsValue.map(([, v]) => v)).toEqual([guid1, guid2]);
        });

        it("loads normalised refs into a ListProperty<StringProperty> correctly", () => {
            const guid1 = "aaaa-0001";
            const guid2 = "aaaa-0002";
            const native = makeNativeFile({ flowDataItemRefsValue: [guid1, guid2] });
            const processed = preprocessor.process(native);
            const file = new DiagramModelFile(factory, processed);

            const flowObj = [...(file.canvas as unknown as { objects: Set<{ id: string, properties: { value: Map<string, unknown> } }> }).objects]
                .find(o => o.id === "data_flow");
            const refsProp = flowObj!.properties.value.get("data_item_refs") as ListProperty;
            expect(refsProp).toBeInstanceOf(ListProperty);

            const vals = [...refsProp.value.values()].map(p => (p as StringProperty).toJson());
            expect(vals).toEqual([guid1, guid2]);
        });

        it("passes through an already-JsonEntries data_item_refs untouched", () => {
            // Simulate frontend-saved format: [[key, guid], ...].
            const guid1 = "aaaa-0001";
            const guid2 = "aaaa-0002";
            const alreadyNormalized = [["key0", guid1], ["key1", guid2]];
            const native = makeNativeFile({ flowDataItemRefsValue: alreadyNormalized });
            const processed = preprocessor.process(native);

            const flowExport = processed.objects.find(o => o.id === "data_flow");
            const refsEntry = (flowExport!.properties as [string, unknown][])
                ?.find(([k]) => k === "data_item_refs");
            // Should be unchanged.
            expect(refsEntry![1]).toEqual(alreadyNormalized);
        });

        it("handles empty data_item_refs list without error", () => {
            const native = makeNativeFile({ flowDataItemRefsValue: [] });
            const processed = preprocessor.process(native);
            expect(() => new DiagramModelFile(factory, processed)).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // Canvas data_items — backend [[guid, [[k,v],...]], ...] format
    // -----------------------------------------------------------------------

    describe("canvas data_items — backend nested-pairs format", () => {
        it("loads 2 data items into canvas.data_items ListProperty", () => {
            const itemGuid1 = "item-1";
            const itemGuid2 = "item-2";
            const parentGuid = "proc-1";

            // This is the format that transform._build_canvas_props emits.
            const dataItemsValue = [
                [itemGuid1, [["parent", parentGuid], ["identifier", "D1"], ["name", "Token"], ["classification", "secret"]]],
                [itemGuid2, [["parent", parentGuid], ["identifier", "D2"], ["name", "Email"]]]
            ];

            const native = makeNativeFile({ canvasDataItemsValue: dataItemsValue });
            const processed = preprocessor.process(native);
            const file = new DiagramModelFile(factory, processed);

            const dataProp = file.canvas.properties.value.get("data_items") as ListProperty;
            expect(dataProp.value.size).toBe(2);

            // Check item 1 fields.
            const e1 = dataProp.value.get(itemGuid1) as import("@OpenChart/DiagramModel").DictionaryProperty;
            expect(e1.value.get("identifier")?.toJson()).toBe("D1");
            expect(e1.value.get("classification")?.toJson()).toBe("secret");

            // Check item 2 fields (no classification).
            const e2 = dataProp.value.get(itemGuid2) as import("@OpenChart/DiagramModel").DictionaryProperty;
            expect(e2.value.get("identifier")?.toJson()).toBe("D2");
            expect(e2.value.get("classification")?.toJson()).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // Round-trip: load → publish → same shape
    // -----------------------------------------------------------------------

    describe("round-trip: load (preprocessor + factory) → publish", () => {
        it("publisher re-emits data_items and data_item_refs identically", () => {
            const itemGuid = "item-guid-rt-1";
            const parentGuid = "proc-rt-1";

            const dataItemsValue = [
                [itemGuid, [["parent", parentGuid], ["identifier", "D1"], ["name", "Token"]]]
            ];

            const native = makeNativeFile({
                canvasDataItemsValue: dataItemsValue,
                flowDataItemRefsValue: [itemGuid]   // backend plain-list format
            });

            const processed = preprocessor.process(native);
            const file = new DiagramModelFile(factory, processed);
            const publisher = new DfdPublisher();
            const output = JSON.parse(publisher.publish(file));

            // data_items published
            expect(output.data_items).toHaveLength(1);
            expect(output.data_items[0]).toMatchObject({
                guid: itemGuid,
                parent: parentGuid,
                identifier: "D1",
                name: "Token"
            });

            // data_item_refs on flow published
            const edge = output.edges.find((e: Record<string, unknown>) => e.id === "flow-1");
            expect(edge?.data_item_refs).toEqual([itemGuid]);
        });
    });

});
