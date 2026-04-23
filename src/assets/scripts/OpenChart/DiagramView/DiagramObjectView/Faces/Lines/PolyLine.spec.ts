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

    it("dragging an interior handle moves only that handle's contribution to the polyline", async () => {
        // Capture the layout, drag handle[1] (the middle interior handle),
        // and verify only handle[1]'s coordinates change in the points
        // list while handles[0] / handles[2] / latches stay put.  This
        // is the user-facing interaction from the design doc — every
        // bend remains independently addressable.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 50]
        ]);
        const face = line.face as unknown as GenericLineInternalState;

        const beforeH0 = [line.handles[0].x, line.handles[0].y];
        const beforeH2 = [line.handles[2].x, line.handles[2].y];
        const beforeNode1 = [line.node1.x, line.node1.y];
        const beforeNode2 = [line.node2.x, line.node2.y];

        (line.handles[1] as HandleView).moveTo(220, 180);

        // Moved handle reflects its new coordinate.
        expect(line.handles[1].x).toBe(220);
        expect(line.handles[1].y).toBe(180);
        // Other handles and latches are untouched.
        expect([line.handles[0].x, line.handles[0].y]).toEqual(beforeH0);
        expect([line.handles[2].x, line.handles[2].y]).toEqual(beforeH2);
        expect([line.node1.x, line.node1.y]).toEqual(beforeNode1);
        expect([line.node2.x, line.node2.y]).toEqual(beforeNode2);

        // Layout rebuilt with the moved handle slotted into the points list.
        expect(face.points[2]).toBe(line.handles[1]);
        expect(face.points.length).toBe(5);
        expect(face.hitboxes.length).toBe(4);
    });

    it("dragging a latch endpoint leaves interior handles in place", async () => {
        // The complement of the previous test: moving an endpoint must
        // not perturb interior handle coordinates.  PolyLine reads the
        // handles' own positions, so endpoint motion only changes the
        // first/last segment of the polyline.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 50]
        ]);

        const beforeHandles = line.handles.map(h => [h.x, h.y]);

        line.node2.moveTo(450, 75);

        expect(line.node2.x).toBe(450);
        expect(line.node2.y).toBe(75);
        const afterHandles = line.handles.map(h => [h.x, h.y]);
        expect(afterHandles).toEqual(beforeHandles);
    });

    it("moveBy translates every handle and unlinked latch by the same delta", async () => {
        // LineFace.moveBy sweeps every handle and any unlinked latch.
        // PolyLine inherits this behavior unchanged from DynamicLine,
        // but the test pins it down in case a future PolyLine override
        // forgets to translate a vertex.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 50]
        ]);

        const beforeHandles = line.handles.map(h => [h.x, h.y]);
        const beforeNode1 = [line.node1.x, line.node1.y];
        const beforeNode2 = [line.node2.x, line.node2.y];

        line.moveBy(40, 30);

        for (let i = 0; i < line.handles.length; i++) {
            expect(line.handles[i].x).toBe(beforeHandles[i][0] + 40);
            expect(line.handles[i].y).toBe(beforeHandles[i][1] + 30);
        }
        // Latches are unlinked in this fixture, so they translate too.
        expect(line.node1.x).toBe(beforeNode1[0] + 40);
        expect(line.node1.y).toBe(beforeNode1[1] + 30);
        expect(line.node2.x).toBe(beforeNode2[0] + 40);
        expect(line.node2.y).toBe(beforeNode2[1] + 30);
    });

    it("calculateLayout survives an unlinked endpoint without throwing or losing handles", async () => {
        // Approximates the "delete the source block" reparent path: a
        // line whose latch was previously linked to a block anchor ends
        // up with `latch.anchor === null`.  PolyLine.calculateLayout
        // (and the underlying LineFace.isAnchored guard) must handle
        // this without crashing or discarding interior handles.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 50]
        ]);
        // Sanity: latches are unlinked in this fixture, so calculateLayout
        // already runs through the unlinked path.  Re-running it after a
        // hypothetical reparent must remain stable.
        const beforeHandleCount = line.handles.length;

        expect(() => line.calculateLayout()).not.toThrow();
        expect(line.handles.length).toBe(beforeHandleCount);
        expect(line.face).toBeInstanceOf(PolyLine);
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
