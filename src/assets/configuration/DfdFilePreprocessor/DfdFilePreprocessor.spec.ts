/**
 * @file DfdFilePreprocessor.spec.ts
 *
 * Verifies that DfdFilePreprocessor correctly passes through native dfd_v1
 * files.  Since the backend now emits `data_item_refs` in the correct
 * ListProperty<StringProperty> wire shape ([[key, guid], ...]), the
 * preprocessor is pass-through and needs no normalization logic.
 *
 * Coverage:
 *   - Legacy files (no data_items / no data_item_refs) pass through without error.
 *   - Canvas data_items in [[guid, [[k,v],...]],...] format pass through and load.
 *   - Flow data_item_refs in [[key, guid],...] format (backend shape) load correctly.
 *   - Empty data_item_refs resolves to a well-formed empty ListProperty.
 *   - Non-flow objects (process, etc.) pass through unchanged.
 *   - Round-trip: minimal-format input → preprocessor + factory → publisher
 *     re-emits the same minimal shape (identity).
 *   - DictionaryProperty with description sub-key absent entirely (not explicit null)
 *     round-trips identically.
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
import { traverse } from "@OpenChart/DiagramModel/DiagramNavigators";

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
    // Pass-through identity
    // -----------------------------------------------------------------------

    describe("pass-through identity", () => {
        it("returns the exact same object reference (pure pass-through)", () => {
            const native = makeNativeFile({});
            const processed = preprocessor.process(native);
            expect(processed).toBe(native);
        });
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

            // Use traverse navigator to find the flow object.
            const flowObj = [...traverse(file.canvas)]
                .find(o => o.id === "data_flow");
            expect(flowObj).toBeDefined();
            const refsProp = flowObj!.properties.value.get("data_item_refs");
            expect(refsProp).toBeInstanceOf(ListProperty);
            // Empty refs — resolves to well-formed empty ListProperty.
            expect((refsProp as ListProperty).value.size).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Non-flow objects pass through unchanged  [I5]
    // -----------------------------------------------------------------------

    describe("non-flow objects pass through unchanged", () => {
        it("a process object's properties are unchanged after preprocessing", () => {
            const native = makeNativeFile({});
            // The process object (src-block) should survive untouched.
            const srcBefore = native.objects.find(o => o.instance === "src-block");
            const processed = preprocessor.process(native);
            const srcAfter = processed.objects.find(o => o.instance === "src-block");
            // Same reference — preprocessor returns file unchanged.
            expect(srcAfter).toBe(srcBefore);
        });
    });

    // -----------------------------------------------------------------------
    // Flow data_item_refs — backend [[key, guid], ...] format
    // -----------------------------------------------------------------------

    describe("flow data_item_refs — backend [[key, guid], ...] format", () => {
        it("loads backend-shape [[key, guid], ...] refs into a ListProperty<StringProperty>", () => {
            const guid1 = "aaaa-0001";
            const guid2 = "aaaa-0002";
            // Backend now emits [[syntheticKey, guidStr], ...] directly.
            const refsValue = [["key0", guid1], ["key1", guid2]];
            const native = makeNativeFile({ flowDataItemRefsValue: refsValue });
            const processed = preprocessor.process(native);
            const file = new DiagramModelFile(factory, processed);

            const flowObj = [...traverse(file.canvas)]
                .find(o => o.id === "data_flow");
            const refsProp = flowObj!.properties.value.get("data_item_refs") as ListProperty;
            expect(refsProp).toBeInstanceOf(ListProperty);

            const vals = [...refsProp.value.values()].map(p => (p as StringProperty).toJson());
            expect(vals).toEqual([guid1, guid2]);
        });

        it("loads empty data_item_refs into a well-formed empty ListProperty", () => {
            // Empty array — must result in a valid empty ListProperty (not an error).
            const native = makeNativeFile({ flowDataItemRefsValue: [] });
            const processed = preprocessor.process(native);
            expect(() => new DiagramModelFile(factory, processed)).not.toThrow();

            const file = new DiagramModelFile(factory, processed);
            const flowObj = [...traverse(file.canvas)]
                .find(o => o.id === "data_flow");
            const refsProp = flowObj!.properties.value.get("data_item_refs") as ListProperty;
            expect(refsProp).toBeInstanceOf(ListProperty);
            expect(refsProp.value.size).toBe(0);
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

        it("absent description sub-key in a data item round-trips to the same minimal shape  [M5]", () => {
            // This covers the Step 1 → Step 2 handoff from transform.py:678-682:
            // optional sub-keys are omitted entirely (not emitted as null) and the
            // engine must tolerate absent sub-keys on load.
            const itemGuid = "item-absent-desc";
            const parentGuid = "proc-abs-1";

            // description is deliberately absent (not even null).
            const dataItemsValue = [
                [itemGuid, [["parent", parentGuid], ["identifier", "D1"], ["name", "NoDesc"]]]
            ];

            const native = makeNativeFile({ canvasDataItemsValue: dataItemsValue });
            const file = new DiagramModelFile(factory, preprocessor.process(native));
            const publisher = new DfdPublisher();
            const output = JSON.parse(publisher.publish(file));

            // Round-trip: description should remain absent from the published output.
            expect(output.data_items).toHaveLength(1);
            const item = output.data_items[0];
            expect(item.description).toBeUndefined();
            expect(item.classification).toBeUndefined();
            expect(item.identifier).toBe("D1");
            expect(item.name).toBe("NoDesc");
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

            // Backend-shape: [[key, guid], ...] for data_item_refs.
            const refsValue = [["some-key", itemGuid]];

            const native = makeNativeFile({
                canvasDataItemsValue: dataItemsValue,
                flowDataItemRefsValue: refsValue
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
