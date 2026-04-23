import { describe, it, expect } from "vitest";
import {
    HandleView,
    LineView,
    PolyLine
} from "@OpenChart/DiagramView";
import {
    createLinesTestingFactory,
    getDataFlowLineStyle
} from "./Lines.testing";
import type { GenericLineInternalState } from "./GenericLineInternalState";


/**
 * Builds a PolyLine-backed line with one handle per supplied coordinate.
 *
 * The factory hands back a line with one default handle attached (the
 * reference handle for the standard DynamicLine flow); we move it to the
 * first coordinate, then add `handleCoords.length - 1` extras at the
 * remaining coordinates.  Finally we swap the face to PolyLine and run a
 * layout pass — the production path the auto-layout engine and import
 * inference both follow.
 */
async function createPolyLineWithHandles(
    handleCoords: Array<[number, number]>
): Promise<LineView> {
    if (handleCoords.length === 0) {
        throw new Error("createPolyLineWithHandles requires at least one handle coordinate.");
    }

    const factory = await createLinesTestingFactory();
    const line = factory.createNewDiagramObject("data_flow", LineView);

    line.node1.moveTo(0, 0);
    line.node2.moveTo(400, 0);

    const [hx0, hy0] = handleCoords[0];
    (line.handles[0] as HandleView).moveTo(hx0, hy0);

    for (let i = 1; i < handleCoords.length; i++) {
        const [hx, hy] = handleCoords[i];
        const handle = factory.createNewDiagramObject("generic_handle", HandleView);
        handle.moveTo(hx, hy);
        line.addHandle(handle);
    }

    // Swap to PolyLine — the runtime upgrade hook the engine and import
    // path both call once a line accumulates two or more handles.
    line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));
    line.calculateLayout();

    return line;
}


describe("PolyLine", () => {

    it("calculateLayout: 3 handles → 5 points (src + h0 + h1 + h2 + trg) and 4 segment hitboxes", async () => {
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 50]
        ]);

        const face = line.face as unknown as GenericLineInternalState;
        expect(face.points.length).toBe(5);
        expect(face.points[0]).toBe(line.node1);
        expect(face.points[1]).toBe(line.handles[0]);
        expect(face.points[2]).toBe(line.handles[1]);
        expect(face.points[3]).toBe(line.handles[2]);
        expect(face.points[4]).toBe(line.node2);

        // runMultiElbowLayout's invariant: hitboxes.length === (rawVertices.length / 2) - 1.
        // For five points (ten coordinates) that's exactly four hitboxes.
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

        const face = line.face as unknown as GenericLineInternalState;
        expect(face.points.length).toBe(4);
        expect(face.hitboxes.length).toBe(3);
    });

    it("clone: returns a new PolyLine carrying the same style/grid", async () => {
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100]
        ]);
        const original = line.face as PolyLine;
        const cloned = original.clone();
        expect(cloned).toBeInstanceOf(PolyLine);
        expect(cloned).not.toBe(original);
        // A fresh clone has not been linked to a view yet, so we can only
        // check structural equivalence via the GenericLineInternalState lens.
        const originalState = original as unknown as GenericLineInternalState;
        const clonedState = cloned as unknown as GenericLineInternalState;
        expect(clonedState.style).toBe(originalState.style);
        expect(clonedState.grid).toBe(originalState.grid);
    });

});
