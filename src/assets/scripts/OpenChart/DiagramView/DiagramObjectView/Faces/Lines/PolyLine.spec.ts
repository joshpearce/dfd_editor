import { describe, it, expect, beforeAll } from "vitest";
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
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";

/**
 * A scoped lens that extends `GenericLineInternalState` with the
 * `PolyLine`-specific `spans` field.  Use this type (not
 * `GenericLineInternalState`) for casts that need to read `face.spans`.
 * Casts that only read `points`, `hitboxes`, etc. should keep using
 * `GenericLineInternalState` directly.
 */
type PolyLineInternalState = GenericLineInternalState & {
    spans: PolyLineSpanView[];
};


/**
 * Builds a PolyLine-backed line with one handle per supplied coordinate.
 *
 * The face is swapped to PolyLine BEFORE handles are positioned.  Once
 * PolyLine is the active face, `handle.moveTo` cascades through
 * `PolyLine.calculateLayout` (which does not clobber or drop handles),
 * so axis-aligned positions survive the cascade correctly.
 *
 *   1. Create the line via factory.
 *   2. Add extra handles so the total count matches `handleCoords.length`.
 *   3. Swap to PolyLine face (before setting positions).
 *   4. Position each handle via `handle.moveTo(x, y)` (high-level path).
 *   5. Call `line.calculateLayout()` once to guarantee spans are populated
 *      with the final positions.
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
    line.node2.moveTo(400, 400);

    // Add extra handles so the line has exactly handleCoords.length handles.
    for (let i = 1; i < handleCoords.length; i++) {
        const handle = factory.createNewDiagramObject("generic_handle", HandleView);
        line.addHandle(handle);
    }

    // Swap to PolyLine before positioning — once PolyLine is the active face,
    // handle.moveTo cascades through PolyLine.calculateLayout which does not
    // drop or clobber handles (unlike DynamicLine.calculateLayout).
    line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));

    // Position each handle via the high-level path.
    for (let i = 0; i < handleCoords.length; i++) {
        const [hx, hy] = handleCoords[i];
        (line.handles[i] as HandleView).moveTo(hx, hy);
    }

    // Final layout pass to guarantee spans are up to date.
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
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 50],
            [200, 150]
        ]);
        const face = line.face as unknown as PolyLineInternalState;

        expect(face.spans).toHaveLength(2);
        expect(face.spans[0]).toBeInstanceOf(PolyLineSpanView);
        expect(face.spans[1]).toBeInstanceOf(PolyLineSpanView);

        expect(face.spans[0].axis).toBe("H");
        expect(face.spans[1].axis).toBe("V");

        // Span handleA/handleB must be reference-equal to the actual handle views.
        expect(face.spans[0].handleA).toBe(line.handles[0]);
        expect(face.spans[0].handleB).toBe(line.handles[1]);
        expect(face.spans[1].handleA).toBe(line.handles[1]);
        expect(face.spans[1].handleB).toBe(line.handles[2]);

        // Each hitbox is a closed rectangle (8 numbers).
        expect(face.spans[0].hitbox).toHaveLength(8);
        expect(face.spans[1].hitbox).toHaveLength(8);

        // The span hitbox must be a copy — mutating it must not affect face.hitboxes.
        const originalHitbox1 = [...face.hitboxes[1]];
        face.spans[0].hitbox[0] = -9999;
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
            const line = await createPolyLineWithHandles(coords);
            const face = line.face as unknown as PolyLineInternalState;

            expect(face.spans).toHaveLength(line.handles.length - 1);
            for (const span of face.spans) {
                expect(span.axis).toBe("H");
            }
        }
    });

    it("calculateLayout: diagonal segment between interior handles is skipped", async () => {
        // handles[0]→[1] differs in both x and y — diagonal, no shared axis.
        // handles[1]→[2] share y=100 — horizontal and must produce one "H" span.
        // The diagonal pair must be skipped; total span count must be 1.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 100],
            [300, 100]
        ]);
        const face = line.face as unknown as PolyLineInternalState;

        expect(face.spans).toHaveLength(1);
        expect(face.spans[0].axis).toBe("H");
        expect(face.spans[0].handleA).toBe(line.handles[1]);
        expect(face.spans[0].handleB).toBe(line.handles[2]);
    });

    it("calculateLayout: rebuilds spans on re-layout after handle move", async () => {
        // After moving an interior handle so the axis classification flips H↔V,
        // `calculateLayout()` produces fresh span instances with the new axes.
        const line = await createPolyLineWithHandles([
            [100, 50],
            [200, 50],
            [200, 150]
        ]);
        const face = line.face as unknown as PolyLineInternalState;

        const spansBefore = [...face.spans];
        expect(spansBefore[0].axis).toBe("H");
        expect(spansBefore[1].axis).toBe("V");

        // Move handles[1] via the face-level path so PolyLine reruns layout
        // without triggering a second cascading call.
        (line.handles[1] as HandleView).face.moveTo(100, 150);
        line.calculateLayout();

        const spansAfter = face.spans;
        expect(spansAfter).toHaveLength(2);
        expect(spansAfter[0].axis).toBe("V");
        expect(spansAfter[1].axis).toBe("H");

        // Span instances must be freshly created, not the same objects as before.
        expect(spansAfter[0]).not.toBe(spansBefore[0]);
        expect(spansAfter[1]).not.toBe(spansBefore[1]);
    });


    ///////////////////////////////////////////////////////////////////////////
    //  getObjectAt (Step 3 hit-test cutover)  ////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    /*
     * Fixture used by all four getObjectAt tests:
     *
     *   handles[0] = (100,  50)
     *   handles[1] = (200,  50)  → span[0] axis "H"  (shared y)
     *   handles[2] = (200, 150)  → span[1] axis "V"  (shared x)
     *
     *   node1 = (0, 0)   node2 = (400, 400)
     *
     * Hitbox layout (hitboxWidth = 20, w = 10):
     *
     *   hitboxes[0]:  node1 → h0  (end segment, diagonal)
     *   hitboxes[1]:  h0   → h1  (interior, H-axis)
     *                   hitbox bounds: minX=100 maxX=200, minY=40 maxY=60
     *   hitboxes[2]:  h1   → h2  (interior, V-axis)
     *                   hitbox bounds: minX=190 maxX=210, minY=50 maxY=150
     *   hitboxes[3]:  h2   → node2 (end segment, diagonal)
     *
     * Tests 1 and 2 (span returns) require isAnchored()=true, so node1 is
     * linked to a real block anchor.  Tests 3 and 4 work with unlinked lines.
     */

    describe("getObjectAt", () => {

        let factory: DiagramObjectViewFactory;

        beforeAll(async () => {
            factory = await createLinesTestingFactory();
        });

        /**
         * Helper: builds the standard 3-handle PolyLine and links node1 to a
         * block anchor so isAnchored() returns true (required for the
         * span-aware hitbox path in getObjectAt).
         */
        async function createAnchoredFixture(): Promise<{
            line: LineView;
            spans: PolyLineSpanView[];
        }> {
            const line = factory.createNewDiagramObject("data_flow", LineView);
            line.node1.moveTo(0, 0);
            line.node2.moveTo(400, 400);

            // Add two extra handles so total count is 3.
            for (let i = 1; i < 3; i++) {
                const h = factory.createNewDiagramObject("generic_handle", HandleView);
                line.addHandle(h);
            }

            line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));

            (line.handles[0] as HandleView).moveTo(100, 50);
            (line.handles[1] as HandleView).moveTo(200, 50);
            (line.handles[2] as HandleView).moveTo(200, 150);

            // Link node1 to a block anchor so isAnchored() → true, which
            // activates the span-aware branch of getObjectAt.
            const block = factory.createNewDiagramObject("process", BlockView);
            block.moveTo(50, 50);
            const blockAnchor = block.anchors.values().next().value!;
            line.node1.link(blockAnchor);

            line.calculateLayout();

            const spans = (line.face as unknown as PolyLineInternalState).spans;
            return { line, spans };
        }

        it("interior-segment hitbox returns the matching PolyLineSpanView", async () => {
            // A click in the middle of an interior segment must return the
            // PolyLineSpanView for that segment, not a handle view and not
            // the line view.
            //
            // H span (hitboxes[1], h0→h1): hitbox bounds minX=100 maxX=200, minY=40 maxY=60.
            //   Midpoint (150, 50) is strictly inside.
            //
            // V span (hitboxes[2], h1→h2): hitbox bounds minX=190 maxX=210, minY=50 maxY=150.
            //   Midpoint (200, 100) is strictly inside.
            const { line, spans } = await createAnchoredFixture();

            // H span midpoint.
            const hitH = line.face.getObjectAt(150, 50);
            expect(hitH).toBeInstanceOf(PolyLineSpanView);
            expect(hitH).toBe(spans[0]);
            expect(spans[0].axis).toBe("H");

            // V span midpoint.
            const hitV = line.face.getObjectAt(200, 100);
            expect(hitV).toBeInstanceOf(PolyLineSpanView);
            expect(hitV).toBe(spans[1]);
            expect(spans[1].axis).toBe("V");
        });

        it("interior-handle-dot coordinates resolve to the span beneath, not the handle", async () => {
            // Interior handle dots are not drag targets (Step 3 design
            // decision). A click at the exact coordinate of an interior
            // handle must return the adjacent span, not a HandleView.
            //
            // handles[1] is at (200, 50), the H/V corner.  Without the
            // dead-zone fix the strict-inequality hitbox check
            // (`minX < x < maxX`) excludes x=200 from both adjacent hitboxes,
            // leaving a dead zone.  The dead-zone fix in getObjectAt catches
            // clicks within the handle's visible dot radius (6 px) and resolves
            // them to the flanking span, so exact-coord clicks now work.
            const { line, spans } = await createAnchoredFixture();

            // handles[1] is at (200, 50).  HandleFace.isInsideHandleDot renders
            // the marker at (handle.x + markerOffset, handle.y + markerOffset)
            // = (201, 51).  We click at the exact marker centre so the test
            // uses the same geometry as the helper (no implicit offset arithmetic).
            const h1MarkerX = (line.handles[1] as HandleView).x + 1; // + markerOffset
            const h1MarkerY = (line.handles[1] as HandleView).y + 1;
            const hit = line.face.getObjectAt(h1MarkerX, h1MarkerY);
            expect(hit).toBeInstanceOf(PolyLineSpanView);
            // Must be a span, not a handle.  The dead-zone fix prefers the span
            // whose handleB === handles[1], which is spans[0] (the H span).
            expect(hit).toBe(spans[0]);
        });

        it("end-segment hitbox returns the line view (unanchored)", async () => {
            // End hitboxes (the first and last segments connecting the
            // latches to the outermost interior handles) still return the
            // LineView, matching DynamicLine parity.  This test uses an
            // unlinked line — both branches of getObjectAt return this.view
            // for end hitboxes, so anchoring is not required here.
            const line = factory.createNewDiagramObject("data_flow", LineView);
            line.node1.moveTo(0, 0);
            line.node2.moveTo(400, 400);
            for (let i = 1; i < 3; i++) {
                const h = factory.createNewDiagramObject("generic_handle", HandleView);
                line.addHandle(h);
            }
            line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));
            (line.handles[0] as HandleView).moveTo(100, 50);
            (line.handles[1] as HandleView).moveTo(200, 50);
            (line.handles[2] as HandleView).moveTo(200, 150);
            line.calculateLayout();

            // hitboxes[0]: end segment node1(0,0)→h0(100,50).
            // Midpoint (50, 25) is well inside the end hitbox.
            const hitStart = line.face.getObjectAt(50, 25);
            expect(hitStart).toBe(line);

            // hitboxes[3]: end segment h2(200,150)→node2(400,400).
            // Midpoint (300, 275) is well inside the tail end hitbox.
            const hitEnd = line.face.getObjectAt(300, 275);
            expect(hitEnd).toBe(line);
        });

        it("end-segment hitbox returns the line view (anchored)", async () => {
            // Companion to the unanchored test: verify the anchored branch of
            // getObjectAt (isAnchored() === true) also returns the LineView for
            // end-segment clicks, not a PolyLineSpanView.
            const { line } = await createAnchoredFixture();

            // hitboxes[0]: end segment node1(0,0)→h0(100,50).
            // node1 is linked (anchored), so the anchored branch of getObjectAt runs.
            // Midpoint (50, 25) must return the line view.
            const hitStart = line.face.getObjectAt(50, 25);
            expect(hitStart).toBe(line);

            // hitboxes[3]: end segment h2(200,150)→node2(400,400).
            // Midpoint (300, 275) must also return the line view.
            const hitEnd = line.face.getObjectAt(300, 275);
            expect(hitEnd).toBe(line);
        });

        it("unlinked src/trg latch still returns the latch view", async () => {
            // The findUnlinkedObjectAt([node1, node2], ...) call runs before
            // any hitbox check, so clicking near an unlinked latch marker
            // always returns that latch — regardless of whether the line is
            // anchored.  LatchPoint.getObjectAt uses a circular radius check
            // (r=6, markerOffset=1), so clicking at the raw latch coordinate
            // (dx=-1, dy=-1 from the marker centre → distance²=2 < 36) hits.
            const line = factory.createNewDiagramObject("data_flow", LineView);
            line.node1.moveTo(0, 0);
            line.node2.moveTo(400, 400);
            for (let i = 1; i < 3; i++) {
                const h = factory.createNewDiagramObject("generic_handle", HandleView);
                line.addHandle(h);
            }
            line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));
            (line.handles[0] as HandleView).moveTo(100, 50);
            (line.handles[1] as HandleView).moveTo(200, 50);
            (line.handles[2] as HandleView).moveTo(200, 150);
            line.calculateLayout();

            // Both latches are unlinked in this fixture.
            expect(line.node1.isLinked()).toBe(false);
            expect(line.node2.isLinked()).toBe(false);

            // LatchPoint.getObjectAt uses a circular hit-test centred at
            // (latch.x + markerOffset, latch.y + markerOffset) with strict `<`
            // radius.  markerOffset = DiagramFace.markerOffset = 1, radius = 6.
            // Click at the exact marker centre — guaranteed inside regardless of
            // floating-point details.
            const node1MarkerX = line.node1.x + 1; // + markerOffset
            const node1MarkerY = line.node1.y + 1;
            const hitNode1 = line.face.getObjectAt(node1MarkerX, node1MarkerY);
            expect(hitNode1).toBe(line.node1);

            const node2MarkerX = line.node2.x + 1;
            const node2MarkerY = line.node2.y + 1;
            const hitNode2 = line.face.getObjectAt(node2MarkerX, node2MarkerY);
            expect(hitNode2).toBe(line.node2);
        });

    });

});
