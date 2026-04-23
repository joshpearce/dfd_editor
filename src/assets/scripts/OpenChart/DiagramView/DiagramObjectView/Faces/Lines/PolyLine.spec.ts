import { describe, it, expect } from "vitest";
import {
    BlockView,
    HandleView,
    LineView,
    PolyLine
} from "@OpenChart/DiagramView";
import {
    createLinesTestingFactory,
    getDataFlowLineStyle
} from "./Lines.testing";
import type { GenericLineInternalState } from "./GenericLineInternalState";
import { PolyLineSpanView } from "./PolyLineSpanView";


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


/**
 * Builds a PolyLine with handle positions that are guaranteed to be exactly
 * the supplied coordinates after layout.
 *
 * `createPolyLineWithHandles` uses `HandleView.moveTo` which triggers the
 * active face's layout cascade.  While the DynamicLine face is active, that
 * cascade repositions the first handle to the node midpoint, corrupting the
 * desired axis classification.  This helper avoids the issue by:
 *
 *   1. Creating the line and attaching all handles (via the factory path so
 *      the handle count is correct before the face swap).
 *   2. Swapping to PolyLine (face swap only — no layout yet).
 *   3. Setting every handle's position via the face-level `moveTo` call
 *      (the same path the auto-layout engine uses), which does NOT trigger
 *      the parent `handleUpdate` cascade.
 *   4. Calling `line.calculateLayout()` once — so PolyLine reads the final
 *      positions and builds spans correctly.
 *
 * Use this helper whenever a test must assert on axis classification.
 */
async function createPolyLineWithExactCoords(
    handleCoords: Array<[number, number]>
): Promise<LineView> {
    if (handleCoords.length < 2) {
        throw new Error("createPolyLineWithExactCoords requires at least 2 handle coordinates.");
    }

    const factory = await createLinesTestingFactory();
    const line = factory.createNewDiagramObject("data_flow", LineView);
    line.node1.moveTo(0, 0);
    line.node2.moveTo(400, 400);

    // Add extra handles so the line has exactly handleCoords.length handles.
    for (let i = 1; i < handleCoords.length; i++) {
        const handle = factory.createNewDiagramObject("generic_handle", HandleView);
        line.addHandle(handle);
    }

    // Swap to PolyLine before setting positions — this prevents DynamicLine's
    // layout from clobbering the desired coordinates.
    line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));

    // Position every handle via the face-level path (no handleUpdate cascade).
    for (let i = 0; i < handleCoords.length; i++) {
        const [hx, hy] = handleCoords[i];
        (line.handles[i] as HandleView).face.moveTo(hx, hy);
    }

    // Single layout pass — PolyLine reads the final coordinates.
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

    it("link → unlink (the 'delete source block' reparent path) leaves PolyLine intact", async () => {
        // Build a line that mirrors the production reparent flow: link
        // node1 to a real block anchor (so isAnchored() returns true),
        // then unlink it (the equivalent of the source block being
        // deleted out from under the line).  PolyLine.calculateLayout
        // must run cleanly across the isAnchored true → false transition
        // without crashing or discarding the interior handles.
        const factory = await createLinesTestingFactory();
        const line = factory.createNewDiagramObject("data_flow", LineView);
        line.node1.moveTo(0, 0);
        line.node2.moveTo(400, 0);
        (line.handles[0] as HandleView).moveTo(100, 50);
        const h1 = factory.createNewDiagramObject("generic_handle", HandleView);
        h1.moveTo(200, 100);
        line.addHandle(h1);
        const h2 = factory.createNewDiagramObject("generic_handle", HandleView);
        h2.moveTo(300, 50);
        line.addHandle(h2);
        line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));

        // Link node1 to a real block anchor and lay out — exercises the
        // anchored branch of LineFace.isAnchored / PolyLine.getObjectAt.
        const block = factory.createNewDiagramObject("process", BlockView);
        block.moveTo(50, 50);
        const blockAnchor = block.anchors.values().next().value!;
        line.node1.link(blockAnchor);
        line.calculateLayout();
        expect(line.node1.isLinked()).toBe(true);

        // Snapshot handle positions, unlink (the reparent), and re-lay out.
        const handleSnapshot = line.handles.map(h => [h.x, h.y]);
        line.node1.unlink();
        expect(line.node1.isLinked()).toBe(false);

        expect(() => line.calculateLayout()).not.toThrow();
        expect(line.handles.length).toBe(3);
        expect(line.handles.map(h => [h.x, h.y])).toEqual(handleSnapshot);
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

    it("calculateLayout: 3-handle H-V-H layout produces 2 spans with correct axis classification", async () => {
        // handles[0]→[1] share y=50 (horizontal), handles[1]→[2] share x=200 (vertical).
        // We expect exactly two spans with axes ["H", "V"], referencing the real
        // handle views, and carrying an independent copy of the hitbox polygon.
        // createPolyLineWithExactCoords sets positions after the PolyLine face swap
        // so DynamicLine's layout cannot clobber the desired coordinates.
        const line = await createPolyLineWithExactCoords([
            [100, 50],
            [200, 50],
            [200, 150]
        ]);
        const face = line.face as unknown as GenericLineInternalState;

        expect(face.spans).toHaveLength(2);
        expect(face.spans![0]).toBeInstanceOf(PolyLineSpanView);
        expect(face.spans![1]).toBeInstanceOf(PolyLineSpanView);

        expect(face.spans![0].axis).toBe("H");
        expect(face.spans![1].axis).toBe("V");

        // Span handleA/handleB must be reference-equal to the actual handle views.
        expect(face.spans![0].handleA).toBe(line.handles[0]);
        expect(face.spans![0].handleB).toBe(line.handles[1]);
        expect(face.spans![1].handleA).toBe(line.handles[1]);
        expect(face.spans![1].handleB).toBe(line.handles[2]);

        // Each hitbox is a closed rectangle (8 numbers).
        expect(face.spans![0].hitbox).toHaveLength(8);
        expect(face.spans![1].hitbox).toHaveLength(8);

        // The span hitbox must be a copy — mutating it must not affect face.hitboxes.
        const originalHitbox1 = [...face.hitboxes[1]];
        face.spans![0].hitbox[0] = -9999;
        expect(face.hitboxes[1]).toEqual(originalHitbox1);
    });

    it("calculateLayout: N interior handles → N-1 spans", async () => {
        // A pure horizontal line with 2 or 4 handles must produce exactly
        // handles.length - 1 spans, all classified as "H".
        const cases: Array<{ coords: Array<[number, number]> }> = [
            { coords: [[100, 50], [200, 50]] },
            { coords: [[100, 50], [200, 50], [300, 50], [400, 50]] }
        ];

        for (const { coords } of cases) {
            const line = await createPolyLineWithExactCoords(coords);
            const face = line.face as unknown as GenericLineInternalState;

            expect(face.spans).toHaveLength(line.handles.length - 1);
            for (const span of face.spans!) {
                expect(span.axis).toBe("H");
            }
        }
    });

    it("calculateLayout: diagonal segment between interior handles is skipped", async () => {
        // handles[0]→[1] differs in both x and y — diagonal, no shared axis.
        // handles[1]→[2] share y=100 — horizontal and must produce one "H" span.
        // The diagonal pair must be skipped; total span count must be 1.
        const line = await createPolyLineWithExactCoords([
            [100, 50],
            [200, 100],
            [300, 100]
        ]);
        const face = line.face as unknown as GenericLineInternalState;

        expect(face.spans).toHaveLength(1);
        expect(face.spans![0].axis).toBe("H");
        expect(face.spans![0].handleA).toBe(line.handles[1]);
        expect(face.spans![0].handleB).toBe(line.handles[2]);
    });

    it("calculateLayout: rebuilds spans on re-layout after handle move", async () => {
        // Start with an H-then-V layout (handles share y, then x).
        // Move handles[1] so the first pair now shares x (V) and the second shares y (H).
        // After re-layout, span axes must reflect the new geometry and the span
        // instances must be fresh objects (not the same references as before).
        const line = await createPolyLineWithExactCoords([
            [100, 50],
            [200, 50],
            [200, 150]
        ]);
        const face = line.face as unknown as GenericLineInternalState;

        const spansBefore = [...face.spans!];
        expect(spansBefore[0].axis).toBe("H");
        expect(spansBefore[1].axis).toBe("V");

        // Move handles[1] via the face-level path so PolyLine reruns layout
        // without triggering a second cascading call.  We want to inspect the
        // axis classification after a single explicit calculateLayout().
        (line.handles[1] as HandleView).face.moveTo(100, 150);
        line.calculateLayout();

        const spansAfter = face.spans!;
        expect(spansAfter).toHaveLength(2);
        expect(spansAfter[0].axis).toBe("V");
        expect(spansAfter[1].axis).toBe("H");

        // Span instances must be freshly created, not the same objects as before.
        expect(spansAfter[0]).not.toBe(spansBefore[0]);
        expect(spansAfter[1]).not.toBe(spansBefore[1]);
    });

});
