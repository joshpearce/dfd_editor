import { describe, it, expect } from "vitest";
import {
    DiagramObjectViewFactory,
    FaceType,
    HandleView,
    LineView,
    Alignment,
    PolyLine
} from "@OpenChart/DiagramView";
import { DarkStyle, ThemeLoader } from "@OpenChart/ThemeLoader";
import { DfdCanvas, DfdObjects, BaseTemplates } from "@/assets/configuration/DfdTemplates";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";


///////////////////////////////////////////////////////////////////////////////
//  Schema / theme  ///////////////////////////////////////////////////////////
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
//  Helpers  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

async function createTestingFactory(): Promise<DiagramObjectViewFactory> {
    const theme = await ThemeLoader.load(testTheme);
    return new DiagramObjectViewFactory(dfdSchema, theme);
}

/**
 * Builds a PolyLine-backed line with `interiorHandleCount` interior
 * handles positioned at the supplied coordinates.  The factory hands back a
 * line with one default handle attached (the reference handle for the
 * standard DynamicLine flow); we move it to the first coordinate, then add
 * `interiorHandleCount - 1` extras at the remaining coordinates.  Finally we
 * swap the face to PolyLine and run a layout pass — the production path the
 * auto-layout engine and import inference both follow.
 */
async function createPolyLineWithHandles(
    handleCoords: Array<[number, number]>
): Promise<LineView> {
    expect(handleCoords.length).toBeGreaterThan(0);

    const factory = await createTestingFactory();
    const line = factory.createNewDiagramObject("data_flow", LineView);

    // Position the latches so the line has volume.
    line.node1.moveTo(0, 0);
    line.node2.moveTo(400, 0);

    // The first handle is attached by the factory; reposition it to the
    // first requested coordinate.
    const [hx0, hy0] = handleCoords[0];
    const refHandle = line.handles[0] as HandleView;
    refHandle.moveTo(hx0, hy0);

    // Add additional handles for the remaining coordinates.
    for (let i = 1; i < handleCoords.length; i++) {
        const [hx, hy] = handleCoords[i];
        const handle = factory.createNewDiagramObject("generic_handle", HandleView);
        handle.moveTo(hx, hy);
        line.addHandle(handle);
    }

    // Swap to PolyLine — the runtime upgrade hook the engine and import
    // path both call once a line accumulates two or more handles.
    const design = factory.resolveDesign("data_flow");
    if (design.type !== FaceType.DynamicLine && design.type !== FaceType.PolyLine) {
        throw new Error("Test theme must use a line face for data_flow.");
    }
    const polyFace = new PolyLine(design.style, factory.theme.grid);
    line.replaceFace(polyFace);
    line.calculateLayout();

    return line;
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

describe("PolyLine", () => {

    it("calculateLayout: 3 handles → 5 points (src + h0 + h1 + h2 + trg) and 4 segment hitboxes", async () => {
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 50]
        ]);

        const face = line.face as PolyLine;
        // Points are: src latch, three handles in order, trg latch.
        expect(face.points.length).toBe(5);
        expect(face.points[0]).toBe(line.node1);
        expect(face.points[1]).toBe(line.handles[0]);
        expect(face.points[2]).toBe(line.handles[1]);
        expect(face.points[3]).toBe(line.handles[2]);
        expect(face.points[4]).toBe(line.node2);

        // Four segments → four hitboxes.  runMultiElbowLayout's invariant
        // is `hitboxes.length === (rawVertices.length / 2) - 1`; for five
        // points (ten coordinates) that's exactly four hitboxes.
        expect(face.hitboxes.length).toBe(4);
        for (const hb of face.hitboxes) {
            // Each hitbox is a closed rectangle (4 vertices, 8 numbers).
            expect(hb.length).toBe(8);
        }
    });

    it("calculateLayout: 2 handles → 4 points and 3 hitboxes (smallest PolyLine case)", async () => {
        // Two interior handles is the minimum count at which a line gets
        // upgraded from DynamicLine to PolyLine.  Confirm the geometry
        // bookkeeping holds at the boundary.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [300, 50]
        ]);

        const face = line.face as PolyLine;
        expect(face.points.length).toBe(4);
        expect(face.hitboxes.length).toBe(3);
    });

    it("clone: returns a new PolyLine with the same style / grid", async () => {
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100]
        ]);
        const original = line.face as PolyLine;
        const cloned = original.clone();
        expect(cloned).toBeInstanceOf(PolyLine);
        expect(cloned).not.toBe(original);
        expect(cloned.style).toBe(original.style);
        expect(cloned.grid).toBe(original.grid);
    });

});
