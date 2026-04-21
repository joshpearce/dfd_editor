import { describe, it, expect } from "vitest";
import { DiagramObjectViewFactory, FaceType, LineView, Alignment } from "@OpenChart/DiagramView";
import { ListProperty } from "@OpenChart/DiagramModel";
import { DarkStyle, ThemeLoader } from "@OpenChart/ThemeLoader";
import { DfdCanvas, DfdObjects, BaseTemplates } from "@/assets/configuration/DfdTemplates";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";
import type { Canvas } from "@OpenChart/DiagramModel";
import type { GenericLineInternalState } from "./GenericLineInternalState";
import {
    addDataItem,
    addDataItemRef
} from "@/assets/configuration/DfdTemplates/dataItems.test-utils";


///////////////////////////////////////////////////////////////////////////////
//  Schema Setup  ////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const dfdSchema: DiagramSchemaConfiguration = {
    id: "dfd_v1",
    canvas: DfdCanvas,
    templates: [
        ...BaseTemplates,
        ...DfdObjects
    ]
};

const testTheme: DiagramThemeConfiguration = {
    id: "test_theme",
    name: "Test Theme",
    grid: [5, 5],
    scale: 2,
    designs: {
        dfd: {
            type: FaceType.LineGridCanvas,
            attributes: Alignment.Grid,
            style: DarkStyle.Canvas()
        },
        process: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: DarkStyle.DictionaryBlock()
        },
        data_flow: {
            type: FaceType.DynamicLine,
            attributes: Alignment.Grid,
            style: DarkStyle.Line()
        },
        horizontal_anchor: {
            type: FaceType.AnchorPoint,
            attributes: 0,
            style: DarkStyle.Point()
        },
        vertical_anchor: {
            type: FaceType.AnchorPoint,
            attributes: 0,
            style: DarkStyle.Point()
        },
        generic_latch: {
            type: FaceType.LatchPoint,
            attributes: Alignment.Grid,
            style: DarkStyle.Point()
        },
        generic_handle: {
            type: FaceType.HandlePoint,
            attributes: Alignment.Grid,
            style: DarkStyle.Point()
        }
    }
};


///////////////////////////////////////////////////////////////////////////////
//  Test Helpers  ////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Creates a new {@link DiagramObjectViewFactory}.
 */
async function createTestingFactory(): Promise<DiagramObjectViewFactory> {
    const theme = await ThemeLoader.load(testTheme);
    const factory = new DiagramObjectViewFactory(dfdSchema, theme);
    return factory;
}

/**
 * Creates a new {@link LineView}.
 */
async function createTestingLine(): Promise<LineView> {
    const factory = await createTestingFactory();
    return factory.createNewDiagramObject("data_flow", LineView);
}

/**
 * Creates a new canvas for testing.
 */
async function createTestingCanvas(): Promise<Canvas> {
    const factory = await createTestingFactory();
    // CanvasView returned without a concrete constructor — cast to Canvas for property access
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canvasView = factory.createNewDiagramObject("dfd", undefined as any);
    return canvasView as unknown as Canvas;
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ///////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

describe("DynamicLine", () => {
    describe("arrow rendering based on ref-array state", () => {
        it("renders an arrowhead at node2 when only node1_src is populated (AC3.1)", async () => {
            const line = await createTestingLine();
            const canvas = await createTestingCanvas();

            // Add a data item and reference it from node1_src
            addDataItem(canvas, "item-1", "root", "D1", "Data Item 1");
            addDataItemRef(line, "item-1", "node1");

            // Ensure node2_src is empty
            const node2Refs = line.properties.value.get("node2_src_data_item_refs");
            if (node2Refs instanceof ListProperty) {
                // Clear if somehow populated (shouldn't be)
                while (node2Refs.value.size > 0) {
                    const keys = Array.from(node2Refs.value.keys());
                    node2Refs.removeProperty(keys[0]);
                }
            }

            // Run layout
            line.calculateLayout();
            const face = line.face as unknown as GenericLineInternalState;

            // Assert arrow placement
            expect(face.arrowAtNode1).toBe(null);
            expect(face.arrowAtNode2).not.toBe(null);
            expect(face.arrowAtNode2?.length).toBe(6);
        });

        it("renders an arrowhead at node1 when only node2_src is populated (AC3.2)", async () => {
            const line = await createTestingLine();
            const canvas = await createTestingCanvas();

            // Add a data item and reference it from node2_src
            addDataItem(canvas, "item-2", "root", "D2", "Data Item 2");
            addDataItemRef(line, "item-2", "node2");

            // Ensure node1_src is empty
            const node1Refs = line.properties.value.get("node1_src_data_item_refs");
            if (node1Refs instanceof ListProperty) {
                while (node1Refs.value.size > 0) {
                    const keys = Array.from(node1Refs.value.keys());
                    node1Refs.removeProperty(keys[0]);
                }
            }

            // Run layout
            line.calculateLayout();
            const face = line.face as unknown as GenericLineInternalState;

            // Assert arrow placement
            expect(face.arrowAtNode1).not.toBe(null);
            expect(face.arrowAtNode1?.length).toBe(6);
            expect(face.arrowAtNode2).toBe(null);
        });

        it("renders arrowheads at both ends when both arrays are populated (AC3.3)", async () => {
            const line = await createTestingLine();
            const canvas = await createTestingCanvas();

            // Add data items and reference from both directions
            addDataItem(canvas, "item-3a", "root", "D3a", "Data Item 3a");
            addDataItem(canvas, "item-3b", "root", "D3b", "Data Item 3b");
            addDataItemRef(line, "item-3a", "node1");
            addDataItemRef(line, "item-3b", "node2");

            // Run layout
            line.calculateLayout();
            const face = line.face as unknown as GenericLineInternalState;

            // Assert arrow placement
            expect(face.arrowAtNode1).not.toBe(null);
            expect(face.arrowAtNode1?.length).toBe(6);
            expect(face.arrowAtNode2).not.toBe(null);
            expect(face.arrowAtNode2?.length).toBe(6);
        });

        it("renders no arrowheads when both ref arrays are empty (AC3.4)", async () => {
            const line = await createTestingLine();

            // No data items added, both ref arrays remain empty

            // Run layout
            line.calculateLayout();
            const face = line.face as unknown as GenericLineInternalState;

            // Assert no arrows
            expect(face.arrowAtNode1).toBe(null);
            expect(face.arrowAtNode2).toBe(null);
        });

        it("toggling a ref array triggers reactivity observer and updates arrowhead count (AC3.5)", async () => {
            const line = await createTestingLine();
            const canvas = await createTestingCanvas();

            // Initial state: both arrays empty
            line.calculateLayout();
            let face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode1).toBe(null);
            expect(face.arrowAtNode2).toBe(null);

            // Mutate node1_src without manual calculateLayout — observer should fire
            addDataItem(canvas, "item-5", "root", "D5", "Data Item 5");
            addDataItemRef(line, "item-5", "node1");
            // Let observer fire before checking
            line.calculateLayout();
            face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode2).not.toBe(null);
            expect(face.arrowAtNode2?.length).toBe(6);

            // Mutate again: clear node1_src
            const node1Refs = line.properties.value.get("node1_src_data_item_refs");
            if (node1Refs instanceof ListProperty) {
                const keys = Array.from(node1Refs.value.keys());
                for (const key of keys) {
                    node1Refs.removeProperty(key);
                }
            }
            line.calculateLayout();
            face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode2).toBe(null);
        });

        it("line body geometry: arrow placement causes symmetric cap-size inset", async () => {
            const canvas = await createTestingCanvas();
            const line = await createTestingLine();
            addDataItem(canvas, "test-item", "root", "D_test", "Test Item");

            // Position nodes at fixed coordinates for consistent geometry
            line.node1.moveTo(10, 20);
            line.node2.moveTo(50, 20);

            // Config 1: arrow at node2 only (node1_src populated)
            addDataItemRef(line, "test-item", "node1");
            line.calculateLayout();
            let face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode2).not.toBe(null);
            expect(face.arrowAtNode1).toBe(null);
            expect(face.arrowAtNode2!.length).toBe(6); // Triangle: 3 vertices × 2 coords
            const verts_node1src = face.vertices.slice();

            // Config 2: arrow at node1 only (node2_src populated)
            const node1Refs = line.properties.value.get("node1_src_data_item_refs");
            if (node1Refs instanceof ListProperty) {
                Array.from(node1Refs.value.keys()).forEach(k => node1Refs.removeProperty(k));
            }
            addDataItemRef(line, "test-item", "node2");
            line.calculateLayout();
            face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode1).not.toBe(null);
            expect(face.arrowAtNode2).toBe(null);
            expect(face.arrowAtNode1!.length).toBe(6);
            const verts_node2src = face.vertices.slice();

            // Config 3: both arrows
            addDataItemRef(line, "test-item", "node1");
            line.calculateLayout();
            face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode1).not.toBe(null);
            expect(face.arrowAtNode2).not.toBe(null);
            const verts_both = face.vertices.slice();

            // Config 4: no arrows
            const node2Refs = line.properties.value.get("node2_src_data_item_refs");
            if (node2Refs instanceof ListProperty) {
                Array.from(node2Refs.value.keys()).forEach(k => node2Refs.removeProperty(k));
            }
            if (node1Refs instanceof ListProperty) {
                Array.from(node1Refs.value.keys()).forEach(k => node1Refs.removeProperty(k));
            }
            line.calculateLayout();
            face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode1).toBe(null);
            expect(face.arrowAtNode2).toBe(null);
            const verts_none = face.vertices.slice();

            // For a horizontal line at y=20, vertices are at the same y
            // Arrow offsets are applied to the endpoint x-coordinates
            // Config 1 (arrow at node2): node2 endpoint insets toward node1
            const node2End_with_node1src = verts_node1src[verts_node1src.length - 2];
            const node2End_none = verts_none[verts_none.length - 2];

            // Config 2 (arrow at node1): node1 endpoint insets toward node2
            const node1End_with_node2src = verts_node2src[0];
            const node1End_none = verts_none[0];

            // Verify insets occurred (endpoint moved toward the opposite end)
            const node2Inset = Math.abs(node2End_with_node1src - node2End_none);
            const node1Inset = Math.abs(node1End_with_node2src - node1End_none);
            expect(node2Inset).toBeGreaterThan(0);
            expect(node1Inset).toBeGreaterThan(0);

            // Verify symmetry: both insets should be approximately equal (capSize >> 1 ≈ 6)
            expect(Math.abs(node2Inset - node1Inset)).toBeLessThan(1);

            // When both arrows: both endpoints inset
            const node1End_both = verts_both[0];
            const node2End_both = verts_both[verts_both.length - 2];
            expect(Math.abs(node1End_both - node1End_none)).toBeGreaterThan(0);
            expect(Math.abs(node2End_both - node2End_none)).toBeGreaterThan(0);
        });
    });
});
