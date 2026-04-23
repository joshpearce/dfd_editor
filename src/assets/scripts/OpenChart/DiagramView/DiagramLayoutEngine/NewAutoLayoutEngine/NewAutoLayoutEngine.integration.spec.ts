/**
 * @file NewAutoLayoutEngine.integration.spec.ts
 *
 * Integration-style tests covering the engine ↔ view contract that the
 * stub-based `NewAutoLayoutEngine.spec.ts` cannot exercise.
 *
 * The unit tests stub `RebindableLineSurface` and `RebindableHandleSurface`
 * with plain spies, which short-circuits the real production cascade:
 *
 *   `HandleView.moveTo(x, y)` →
 *     `LineView.handleUpdate(Movement)` →
 *     `face.calculateLayout()` →
 *     `DynamicLine` strategy → `view.dropHandles(1)`
 *
 * For a multi-handle line whose face is still `DynamicLine` (the face
 * swap happens after the engine returns), the cascade would discard
 * every handle past index 0 mid-loop.  The engine works around this by
 * writing positions to `handle.face` instead of `handle.view`, which
 * skips the `parent.handleUpdate(Movement)` call.
 *
 * These tests verify that property end-to-end on real `LineView` /
 * `HandleView` instances.
 */

import { describe, it, expect } from "vitest";
import {
    DynamicLine,
    HandleView,
    LineView,
    PolyLine
} from "@OpenChart/DiagramView";
import { createLinesTestingFactory } from "../../DiagramObjectView/Faces/Lines/Lines.testing";


describe("NewAutoLayoutEngine ↔ view-layer contract (real LineView)", () => {

    it("`handle.face.moveTo` bypasses the parent-update cascade — multi-handle list survives", async () => {
        // Reproduce the scenario the engine creates mid-loop: a line with
        // a DynamicLine face and three handles.  Writing to
        // `handle.face.moveTo` must NOT trigger a calculateLayout that
        // calls dropHandles(1) — otherwise the multi-handle population
        // pass would lose every handle past index 0.
        const factory = await createLinesTestingFactory();
        const line = factory.createNewDiagramObject("data_flow", LineView);
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        expect(line.handles.length).toBe(3);
        expect(line.face).toBeInstanceOf(DynamicLine);

        line.handles[0].face.moveTo(123, 456);

        expect(line.handles.length).toBe(3);
    });

    it("`handle.moveTo` triggers the cascade — confirms why the engine must use face.moveTo", async () => {
        // Negative control: the high-level HandleView.moveTo bubbles to
        // LineView.handleUpdate → DynamicLine.calculateLayout →
        // dropHandles(1).  This documents WHY the engine uses face.moveTo:
        // if it called the high-level moveTo, the multi-handle population
        // pass would corrupt the handle list mid-loop.
        //
        // Note: dropHandles(1) is a per-call operation and the engine's
        // loop runs N times, so the corruption compounds — the assertion
        // here only needs to show that the count changed, not predict
        // the exact final count.
        const factory = await createLinesTestingFactory();
        const line = factory.createNewDiagramObject("data_flow", LineView);
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        expect(line.handles.length).toBe(3);

        line.handles[0].moveTo(123, 456);

        expect(line.handles.length).toBeLessThan(3);
    });

    it("inferLineFaces + canvas calculateLayout: 2-handle line renders via PolyLine", async () => {
        // Verify the post-engine path: with handles already populated
        // (as the engine would leave them via face.moveTo), inferLineFaces
        // upgrades the face and the next calculateLayout produces
        // PolyLine geometry without dropping the cloned handles.
        const factory = await createLinesTestingFactory();
        const line = factory.createNewDiagramObject("data_flow", LineView);
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        line.handles[0].face.moveTo(100, 50);
        line.handles[1].face.moveTo(200, 100);

        factory.inferLineFaces([line]);
        line.calculateLayout();

        expect(line.face).toBeInstanceOf(PolyLine);
        expect(line.handles.length).toBe(2);
    });

});
