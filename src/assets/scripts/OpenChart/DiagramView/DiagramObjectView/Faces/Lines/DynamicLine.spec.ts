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

            // Establish baseline layout so the observer has a prior state to re-layout from.
            line.calculateLayout();
            let face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode1).toBe(null);
            expect(face.arrowAtNode2).toBe(null);

            // Mutate the node1_src ref array. LineView's property-change observer (wired in its
            // constructor) must bubble the update from the nested ListProperty → RootProperty
            // subscribers → LineView.handleUpdate(PropUpdate) → face.calculateLayout(). No manual
            // calculateLayout() trigger here — this is the reactivity gate for AC3.5.
            addDataItem(canvas, "item-5", "root", "D5", "Data Item 5");
            addDataItemRef(line, "item-5", "node1");
            face = line.face as unknown as GenericLineInternalState;
            expect(face.arrowAtNode2).not.toBe(null);
            expect(face.arrowAtNode2?.length).toBe(6);

            // Removing the entry from the ListProperty must likewise cascade through the observer
            // chain and re-layout to clear the arrow slot.
            const node1Refs = line.properties.value.get("node1_src_data_item_refs");
            if (node1Refs instanceof ListProperty) {
                const keys = Array.from(node1Refs.value.keys());
                for (const key of keys) {
                    node1Refs.removeProperty(key);
                }
            }
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

            // Horizontal line at y=20: arrow insets modify endpoint x-coordinates only.
            // vertices[0..1] is the node1 endpoint; vertices[len-2..len-1] is the node2 endpoint.
            const lastX = (v: number[]): number => v[v.length - 2];

            // Byte-identical: non-arrow endpoints must match the all-empty baseline exactly.
            //   Config 1 (arrow at node2): node1 endpoint identical to baseline.
            expect(verts_node1src[0]).toBe(verts_none[0]);
            expect(verts_node1src[1]).toBe(verts_none[1]);
            //   Config 2 (arrow at node1): node2 endpoint identical to baseline.
            expect(lastX(verts_node2src)).toBe(lastX(verts_none));
            expect(verts_node2src[verts_node2src.length - 1]).toBe(verts_none[verts_none.length - 1]);

            // Exact symmetric inset: cap-size inset is capSize >> 1; both ends must shift by the
            // same signed magnitude (toward the opposite end). For a horizontal x=10→x=50 line:
            //   node2 end shifts negative (toward node1), node1 end shifts positive (toward node2).
            const node2Inset = lastX(verts_none) - lastX(verts_node1src);
            const node1Inset = verts_node2src[0] - verts_none[0];
            expect(node2Inset).toBeGreaterThan(0);
            expect(node1Inset).toBe(node2Inset);

            // Both-arrows config applies the same inset to both ends.
            expect(verts_both[0] - verts_none[0]).toBe(node1Inset);
            expect(lastX(verts_none) - lastX(verts_both)).toBe(node2Inset);
        });
    });
});
