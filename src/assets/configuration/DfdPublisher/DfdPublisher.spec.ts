/**
 * @file DfdPublisher.spec.ts
 *
 * Verifies that DfdPublisher correctly projects canvas data_items and
 * flow ref arrays (node1_src_data_item_refs / node2_src_data_item_refs)
 * onto the minimal-format JSON output.
 */

import { describe, it, expect, beforeEach } from "vitest";
import DfdPublisher from "./DfdPublisher";
import { DiagramObjectFactory } from "@OpenChart/DiagramModel";
import { DiagramModelFile } from "@OpenChart/DiagramModel";
import { Block, Line } from "@OpenChart/DiagramModel";
import { DfdCanvas } from "../DfdTemplates/DfdCanvas";
import { DfdObjects } from "../DfdTemplates/DfdObjects";
import { BaseTemplates } from "../DfdTemplates/BaseTemplates";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import { addDataItem, addDataItemRef } from "../DfdTemplates/dataItems.test-utils";

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
 * Connects a Line's source to blockA's first anchor and target to blockB's
 * first anchor so SemanticAnalyzer can resolve the edge.
 */
function connect(line: Line, blockA: Block, blockB: Block): void {
    const srcAnchor = [...blockA.anchors.values()][0];
    const tgtAnchor = [...blockB.anchors.values()][0];
    line.node1.link(srcAnchor);
    line.node2.link(tgtAnchor);
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
                name: "User Email",
                classification: "unclassified"
            });
            // description is absent when not set
            expect(item2.description).toBeUndefined();
        });

        it("emits nothing when canvas has no data items", () => {
            const file = new DiagramModelFile(factory);
            const output = JSON.parse(publisher.publish(file));
            expect(output.data_items).toBeUndefined();
        });
    });

    describe("publish — bidirectional flow ref arrays", () => {
        it("projects both ref arrays when node1 direction is populated", () => {
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
            addDataItemRef(flow, refGuid1, "node1");
            addDataItemRef(flow, refGuid2, "node1");

            const output = JSON.parse(publisher.publish(file));

            const edge = output.edges.find((e: Record<string, unknown>) => e.id === flow.instance);
            expect(edge).toBeDefined();
            // Endpoint keys are node1/node2 (not legacy source/target). Phase 5 rename guard.
            expect(edge.node1).toBe(procA.instance);
            expect(edge.node2).toBe(procB.instance);
            expect(edge.source).toBeUndefined();
            expect(edge.target).toBeUndefined();
            // Both arrays always present (AC2.4)
            expect(edge.node1_src_data_item_refs).toEqual([refGuid1, refGuid2]);
            expect(edge.node2_src_data_item_refs).toEqual([]);
        });

        it("emits both arrays always, even when both are empty (AC2.4)", () => {
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
            // Both arrays present even when empty
            expect(edge.node1_src_data_item_refs).toEqual([]);
            expect(edge.node2_src_data_item_refs).toEqual([]);
        });

        it("emits correct arrays when both directions are populated", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;

            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            const flow  = factory.createNewDiagramObject("data_flow", Line);

            canvas.addObject(procA);
            canvas.addObject(procB);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            const refA = "guid-a";
            const refB = "guid-b";
            const refC = "guid-c";
            addDataItemRef(flow, refA, "node1");
            addDataItemRef(flow, refB, "node1");
            addDataItemRef(flow, refC, "node2");

            const output = JSON.parse(publisher.publish(file));

            const edge = output.edges.find((e: Record<string, unknown>) => e.id === flow.instance);
            expect(edge).toBeDefined();
            expect(edge.node1_src_data_item_refs).toEqual([refA, refB]);
            expect(edge.node2_src_data_item_refs).toEqual([refC]);
        });
    });

    describe("publish — combined canvas data_items + bidirectional flow refs", () => {
        it("publishes expected minimal shape when both data_items and flow refs are populated", () => {
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

            addDataItemRef(flow, item1Guid, "node1");
            addDataItemRef(flow, item2Guid, "node2");

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

            // flow bidirectional ref arrays
            const edge = output.edges.find((e: Record<string, unknown>) => e.id === flow.instance);
            expect(edge.node1_src_data_item_refs).toEqual([item1Guid]);
            expect(edge.node2_src_data_item_refs).toEqual([item2Guid]);
        });
    });

    describe("getFileExtension", () => {
        it("returns 'json'", () => {
            expect(publisher.getFileExtension()).toBe("json");
        });
    });

    // -----------------------------------------------------------------------
    // I2: Partial items are published rather than silently dropped
    // -----------------------------------------------------------------------

    describe("publish — partial items (I2)", () => {

        it("emits an item with an empty identifier instead of dropping it", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;

            // Add a data item with a missing identifier (empty string)
            const itemGuid = "partial-item-guid";
            const parentGuid = "some-parent-guid";
            addDataItem(canvas, itemGuid, parentGuid, "", "A partial item");

            const output = JSON.parse(publisher.publish(file));

            // Item must be present in the published output — not silently dropped
            expect(output.data_items).toHaveLength(1);
            const emitted = output.data_items[0];
            expect(emitted.guid).toBe(itemGuid);
            expect(emitted.parent).toBe(parentGuid);
            // Identifier is empty string — emitted as-is
            expect(emitted.identifier).toBe("");
            expect(emitted.name).toBe("A partial item");
        });

    });

});

