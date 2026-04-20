/**
 * @file DfdPublisher.spec.ts
 *
 * Verifies that DfdPublisher correctly projects canvas data_items and
 * flow data_item_refs onto the minimal-format JSON output.
 */

import { describe, it, expect, beforeEach } from "vitest";
import DfdPublisher from "./DfdPublisher";
import { DiagramObjectFactory } from "@OpenChart/DiagramModel";
import { DiagramModelFile } from "@OpenChart/DiagramModel";
import { Block, Line, ListProperty, DictionaryProperty, StringProperty } from "@OpenChart/DiagramModel";
import type { Canvas } from "@OpenChart/DiagramModel";
import { DfdCanvas } from "../DfdTemplates/DfdCanvas";
import { DfdObjects } from "../DfdTemplates/DfdObjects";
import { BaseTemplates } from "../DfdTemplates/BaseTemplates";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";

// ---------------------------------------------------------------------------
// Schema + factory shared by all tests
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
 * Adds a data item entry to a canvas's data_items ListProperty.
 *
 * @param canvas      The canvas to mutate.
 * @param guid        The item guid (used as the ListProperty entry key).
 * @param parent      The parent node guid.
 * @param identifier  Display token, e.g. "D1".
 * @param name        Human-readable name.
 * @param description Optional description.
 * @param classification Optional classification.
 */
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
    (fields.get("parent") as StringProperty).setValue(parent);
    (fields.get("identifier") as StringProperty).setValue(identifier);
    (fields.get("name") as StringProperty).setValue(name);
    if (description !== undefined) {
        (fields.get("description") as StringProperty).setValue(description);
    }
    if (classification !== undefined) {
        (fields.get("classification") as StringProperty).setValue(classification);
    }
    dataItemsProp.addProperty(entry, guid);
}

/**
 * Adds a data_item_ref GUID to a flow's data_item_refs ListProperty.
 */
function addDataItemRef(line: Line, refGuid: string): void {
    const refsProp = line.properties.value.get("data_item_refs");
    if (!(refsProp instanceof ListProperty)) {
        throw new Error("line.properties.data_item_refs is not a ListProperty");
    }
    const entry = refsProp.createListItem() as StringProperty;
    entry.setValue(refGuid);
    refsProp.addProperty(entry);
}

/**
 * Connects a Line's source to blockA's first anchor and target to blockB's
 * first anchor so SemanticAnalyzer can resolve the edge.
 */
function connect(line: Line, blockA: Block, blockB: Block): void {
    const srcAnchor = [...blockA.anchors.values()][0];
    const tgtAnchor = [...blockB.anchors.values()][0];
    line.source.link(srcAnchor);
    line.target.link(tgtAnchor);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DfdPublisher", () => {

    let factory: DiagramObjectFactory;
    let publisher: DfdPublisher;

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        publisher = new DfdPublisher();
    });

    describe("publish — no data items", () => {
        it("returns valid JSON with nodes/edges arrays for an empty diagram", () => {
            const file = new DiagramModelFile(factory);
            const output = JSON.parse(publisher.publish(file));
            expect(Array.isArray(output.nodes)).toBe(true);
            expect(Array.isArray(output.edges)).toBe(true);
            expect(output.data_items).toBeUndefined();
        });
    });

    describe("publish — canvas data_items", () => {
        it("projects 2 data items (with optional fields) onto top-level data_items", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;

            const parentGuid = "process-guid-1";
            const item1Guid = "item-guid-1";
            const item2Guid = "item-guid-2";

            addDataItem(canvas, item1Guid, parentGuid, "D1", "Session Token", "JWT token", "secret");
            addDataItem(canvas, item2Guid, parentGuid, "D2", "User Email");

            const output = JSON.parse(publisher.publish(file));

            expect(output.data_items).toHaveLength(2);

            const item1 = output.data_items.find((i: Record<string, unknown>) => i.guid === item1Guid);
            expect(item1).toEqual({
                guid: item1Guid,
                parent: parentGuid,
                identifier: "D1",
                name: "Session Token",
                description: "JWT token",
                classification: "secret"
            });

            const item2 = output.data_items.find((i: Record<string, unknown>) => i.guid === item2Guid);
            expect(item2).toEqual({
                guid: item2Guid,
                parent: parentGuid,
                identifier: "D2",
                name: "User Email"
            });
            // Optional fields absent — not emitted.
            expect(item2.description).toBeUndefined();
            expect(item2.classification).toBeUndefined();
        });

        it("emits nothing when canvas has no data items", () => {
            const file = new DiagramModelFile(factory);
            const output = JSON.parse(publisher.publish(file));
            expect(output.data_items).toBeUndefined();
        });
    });

    describe("publish — flow data_item_refs", () => {
        it("projects data_item_refs onto the edge when refs are present", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;

            // Create two blocks connected by a flow.
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            const flow  = factory.createNewDiagramObject("data_flow", Line);

            canvas.addObject(procA);
            canvas.addObject(procB);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            const refGuid1 = "item-guid-1";
            const refGuid2 = "item-guid-2";
            addDataItemRef(flow, refGuid1);
            addDataItemRef(flow, refGuid2);

            const output = JSON.parse(publisher.publish(file));

            const edge = output.edges.find((e: Record<string, unknown>) => e.id === flow.instance);
            expect(edge).toBeDefined();
            expect(edge.data_item_refs).toEqual([refGuid1, refGuid2]);
        });

        it("omits data_item_refs from edge when refs list is empty", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;

            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            const flow  = factory.createNewDiagramObject("data_flow", Line);

            canvas.addObject(procA);
            canvas.addObject(procB);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            const output = JSON.parse(publisher.publish(file));

            const edge = output.edges.find((e: Record<string, unknown>) => e.id === flow.instance);
            expect(edge).toBeDefined();
            expect(edge.data_item_refs).toBeUndefined();
        });
    });

    describe("publish — combined canvas data_items + flow data_item_refs", () => {
        it("publishes expected minimal shape when both are populated", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;

            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            const flow  = factory.createNewDiagramObject("data_flow", Line);

            canvas.addObject(procA);
            canvas.addObject(procB);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            const item1Guid = "aaaaaaaa-0000-0000-0000-000000000001";
            const item2Guid = "aaaaaaaa-0000-0000-0000-000000000002";

            addDataItem(canvas, item1Guid, procA.instance, "D1", "Token", undefined, "secret");
            addDataItem(canvas, item2Guid, procB.instance, "D2", "Receipt");

            addDataItemRef(flow, item1Guid);

            const output = JSON.parse(publisher.publish(file));

            // data_items array
            expect(output.data_items).toHaveLength(2);
            const emittedItem1 = output.data_items.find(
                (i: Record<string, unknown>) => i.guid === item1Guid
            );
            expect(emittedItem1).toMatchObject({
                guid: item1Guid,
                parent: procA.instance,
                identifier: "D1",
                name: "Token",
                classification: "secret"
            });

            // flow data_item_refs
            const edge = output.edges.find((e: Record<string, unknown>) => e.id === flow.instance);
            expect(edge.data_item_refs).toEqual([item1Guid]);
        });
    });

    describe("getFileExtension", () => {
        it("returns 'json'", () => {
            expect(publisher.getFileExtension()).toBe("json");
        });
    });

});
