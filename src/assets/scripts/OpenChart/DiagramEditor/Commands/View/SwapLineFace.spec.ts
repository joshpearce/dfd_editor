/**
 * @file SwapLineFace.spec.ts
 *
 * Unit tests for the {@link SwapLineFace} command (issue #15).
 *
 * Step 4 amendment: each undo assertion is followed by a `calculateLayout`
 * call to confirm that `orthogonalizeEndElbow` (issue #19) is a no-op on
 * fully orthogonal restored geometry — i.e. exact handle positions are
 * pinned after layout, not just immediately after undo().
 */

import { describe, it, expect } from "vitest";
import { SwapLineFace } from "./SwapLineFace";
import {
    DynamicLine,
    HandleView,
    LineView,
    PolyLine
} from "@OpenChart/DiagramView";
import {
    createLinesTestingFactory,
    getDataFlowLineStyle
} from "../../../DiagramView/DiagramObjectView/Faces/Lines/Lines.testing";

/**
 * Builds a PolyLine-backed LineView with `n` handles total (n ≥ 2 so it
 * qualifies as a PolyLine).  All handles and latches are placed at
 * axis-aligned positions so that `calculateLayout` → `orthogonalizeEndElbow`
 * is a no-op (TALA-route parity): the test pins positions AFTER layout.
 *
 * Handle placement:
 *   node1  = (0,   0)
 *   h[0]   = (0,   100)    ← V-aligned with node1
 *   h[i]   = (i*100, 100)  ← H span across remaining handles
 *   node2  = (n*100, 100)  ← H-aligned with last handle
 */
async function buildPolyLineWithHandles(n: number): Promise<{
    line: LineView;
    polyFace: PolyLine;
    dynFace: DynamicLine;
    factory: Awaited<ReturnType<typeof createLinesTestingFactory>>;
}> {
    if (n < 2) {
        throw new Error("buildPolyLineWithHandles requires n >= 2.");
    }
    const factory = await createLinesTestingFactory();
    const style = getDataFlowLineStyle(factory);
    const grid = factory.theme.grid;

    const line = factory.createNewDiagramObject("data_flow", LineView);

    // Add n-1 extra handles (factory creates 1 by default → total n).
    for (let i = 1; i < n; i++) {
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
    }

    // Build both face instances so we can swap back and forth.
    const polyFace = new PolyLine(style, grid);
    const dynFace  = new DynamicLine(style, grid);

    // Swap to PolyLine so handle positions are preserved by calculateLayout.
    line.replaceFace(polyFace);

    // Place node1 and node2 so all segments are axis-aligned.
    //   node1 = (0, 0),  h[0] = (0, 100) → first end-segment is V
    //   last handle = ((n-1)*100, 100), node2 = (n*100, 100) → last end-segment is H
    line.node1.face.moveTo(0, 0);
    line.node2.face.moveTo(n * 100, 100);
    line.handles[0].face.moveTo(0, 100);
    for (let i = 1; i < n; i++) {
        (line.handles[i] as HandleView).face.moveTo(i * 100, 100);
    }

    line.calculateLayout();

    return { line, polyFace, dynFace, factory };
}

/** Returns a snapshot of each handle's {x, y}. */
function captureHandlePositions(line: LineView): Array<{ x: number, y: number }> {
    return line.handles.map(h => ({ x: h.x, y: h.y }));
}


describe("SwapLineFace", () => {

    it("execute() swaps the face to toFace", async () => {
        const { line, polyFace, dynFace } = await buildPolyLineWithHandles(2);
        expect(line.face).toBe(polyFace);

        const cmd = new SwapLineFace(line, polyFace, dynFace);
        cmd.execute();

        expect(line.face).toBe(dynFace);
    });

    it("redo() re-applies execute (same effect as execute)", async () => {
        const { line, polyFace, dynFace } = await buildPolyLineWithHandles(2);
        const cmd = new SwapLineFace(line, polyFace, dynFace);
        cmd.execute();
        cmd.undo();

        cmd.redo();

        expect(line.face).toBe(dynFace);
    });

    it("merge() always returns null — face swaps do not coalesce", async () => {
        const { line, polyFace, dynFace, factory } = await buildPolyLineWithHandles(2);
        const style = getDataFlowLineStyle(factory);
        const grid  = factory.theme.grid;
        const cmd1  = new SwapLineFace(line, polyFace, dynFace);
        const cmd2  = new SwapLineFace(line, dynFace, new PolyLine(style, grid));

        expect(cmd1.merge(cmd2)).toBeNull();
        expect(cmd2.merge(cmd1)).toBeNull();
    });

    describe("PolyLine → DynamicLine → calculateLayout → undo cycle", () => {

        it("undo() restores the PolyLine face after a DynamicLine calculateLayout drops handles (2-handle line)", async () => {
            const { line, polyFace, dynFace } = await buildPolyLineWithHandles(2);

            // Snapshot positions BEFORE the swap (all orthogonal).
            const positionsBefore = captureHandlePositions(line);
            expect(line.handles.length).toBe(2);

            const cmd = new SwapLineFace(line, polyFace, dynFace);
            cmd.execute();

            // DynamicLine.calculateLayout calls dropHandles(1) — destroys handles[1].
            line.calculateLayout();
            expect(line.handles.length).toBe(1);

            cmd.undo();

            // Handle count restored.
            expect(line.handles.length).toBe(2);

            // Face restored.
            expect(line.face).toBeInstanceOf(PolyLine);

            // Run calculateLayout after undo (Step 4 amendment):
            // orthogonalizeEndElbow must be a no-op on fully-orthogonal geometry.
            line.calculateLayout();

            // Positions must be exact after the post-undo layout.
            const positionsAfter = captureHandlePositions(line);
            for (let i = 0; i < positionsBefore.length; i++) {
                expect(positionsAfter[i].x).toBe(positionsBefore[i].x);
                expect(positionsAfter[i].y).toBe(positionsBefore[i].y);
            }
        });

        it("undo() restores ALL 3 handles and PolyLine face after DynamicLine dropHandles (3-handle line)", async () => {
            const { line, polyFace, dynFace } = await buildPolyLineWithHandles(3);

            const positionsBefore = captureHandlePositions(line);
            expect(line.handles.length).toBe(3);

            const cmd = new SwapLineFace(line, polyFace, dynFace);
            cmd.execute();

            // DynamicLine.calculateLayout drops handles[1] and handles[2].
            line.calculateLayout();
            expect(line.handles.length).toBe(1);

            cmd.undo();

            expect(line.handles.length).toBe(3);
            expect(line.face).toBeInstanceOf(PolyLine);

            // Step 4 amendment: calculateLayout after undo must be a no-op on
            // the restored orthogonal route.
            line.calculateLayout();

            const positionsAfter = captureHandlePositions(line);
            for (let i = 0; i < positionsBefore.length; i++) {
                expect(positionsAfter[i].x).toBe(positionsBefore[i].x);
                expect(positionsAfter[i].y).toBe(positionsBefore[i].y);
            }
        });

        it("keptHandles are captured at construction time (before execute)", async () => {
            const { line, polyFace, dynFace } = await buildPolyLineWithHandles(3);

            const cmd = new SwapLineFace(line, polyFace, dynFace);

            // Snapshot captured at construction — should see all 3 handles.
            expect(cmd.keptHandles.length).toBe(3);
            // keptHandles holds the exact same instances as line.handles.
            for (let i = 0; i < cmd.keptHandles.length; i++) {
                expect(cmd.keptHandles[i]).toBe(line.handles[i]);
            }
        });

        it("redo() after undo() re-applies the DynamicLine swap", async () => {
            const { line, polyFace, dynFace } = await buildPolyLineWithHandles(2);

            const cmd = new SwapLineFace(line, polyFace, dynFace);
            cmd.execute();
            line.calculateLayout();  // drops handles[1]
            cmd.undo();
            cmd.redo();

            expect(line.face).toBe(dynFace);
        });

        it("undo() is idempotent for handles already present (no duplicates)", async () => {
            // If undo() is called when no handles have been dropped (e.g.
            // calculateLayout was never called after execute), it must not
            // add duplicate handles.
            const { line, polyFace, dynFace } = await buildPolyLineWithHandles(2);
            const cmd = new SwapLineFace(line, polyFace, dynFace);
            cmd.execute();

            // Do NOT run calculateLayout — handles are still present.
            expect(line.handles.length).toBe(2);

            cmd.undo();

            // Still 2 handles — no duplicates added.
            expect(line.handles.length).toBe(2);
            expect(line.face).toBeInstanceOf(PolyLine);
        });

    });

});
