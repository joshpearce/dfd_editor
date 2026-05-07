/**
 * @file RemoveHandleFromLine.spec.ts
 *
 * Unit tests for the {@link RemoveHandleFromLine} command.
 *
 * All test lines use a {@link PolyLine} face (via `inferLineFaces` after
 * building ≥2 handles) so that `deleteHandle(handle, true)` does not
 * trigger the `DynamicLine.calculateLayout → dropHandles(1)` cascade.
 * This mirrors production use: `RemoveHandleFromLine` operates on lines
 * that already carry ≥2 handles (otherwise there is nothing to remove).
 *
 * Contract under test:
 *  - execute: removes the handle at the given index, shortening the list
 *  - undo:    re-inserts the *exact same* handle reference at the original
 *             index, restoring list length and identity
 *  - redo:    removal is consistent with first execute (same handle gone,
 *             same length delta)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { HandleView, LineView, PolyLine } from "@OpenChart/DiagramView";
import { createLinesTestingFactory } from "../../../DiagramView/DiagramObjectView/Faces/Lines/Lines.testing";
import { RemoveHandleFromLine } from "./RemoveHandleFromLine";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers  //////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Builds a {@link LineView} with `n` handles and a {@link PolyLine} face.
 *
 * Requires n ≥ 2 so that `inferLineFaces` upgrades the face to `PolyLine`.
 * Handles are added without `update` so fixture setup runs without layout
 * side-effects; `inferLineFaces` below upgrades to PolyLine before the
 * command-under-test runs with `update=true`.
 */
function buildPolyLineWithHandles(factory: DiagramObjectViewFactory, n: number): LineView {
    if (n < 2) {
        throw new Error("n must be >= 2 to produce a PolyLine face.");
    }
    const line = factory.createNewDiagramObject("data_flow", LineView);
    for (let i = 1; i < n; i++) {
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
    }
    // Upgrade to PolyLine so calculateLayout does not drop added handles.
    factory.inferLineFaces([line]);
    return line;
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("RemoveHandleFromLine", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createLinesTestingFactory();
    });


    describe("execute", () => {

        it("decreases handle count by 1", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            expect(line.handles.length).toBe(3);
            expect(line.face).toBeInstanceOf(PolyLine);

            const cmd = new RemoveHandleFromLine(line, 1);
            cmd.execute();

            expect(line.handles.length).toBe(2);
        });

        it("removes the handle at the specified index", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            const targetRef = line.handles[1];

            const cmd = new RemoveHandleFromLine(line, 1);
            cmd.execute();

            // The removed handle must no longer appear in the list.
            const stillPresent = line.handles.some(h => h === targetRef);
            expect(stillPresent).toBe(false);
        });

        it("preserves handles that are not at the removed index", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            const ref0 = line.handles[0];
            const ref2 = line.handles[2];

            new RemoveHandleFromLine(line, 1).execute();

            // Index 0 is unchanged; the former index 2 is now at index 1.
            expect(line.handles[0]).toBe(ref0);
            expect(line.handles[1]).toBe(ref2);
        });

        it("handles removal from the last index", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const lastRef = line.handles[1];

            new RemoveHandleFromLine(line, 1).execute();

            expect(line.handles.length).toBe(1);
            expect(line.handles.some(h => h === lastRef)).toBe(false);
        });

    });


    describe("undo", () => {

        it("restores the original handle count", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            const cmd = new RemoveHandleFromLine(line, 1);
            cmd.execute();
            expect(line.handles.length).toBe(2);

            cmd.undo();

            expect(line.handles.length).toBe(3);
        });

        it("re-inserts the exact same handle reference at the original index", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            const capturedRef = line.handles[1];

            const cmd = new RemoveHandleFromLine(line, 1);
            cmd.execute();
            cmd.undo();

            // Same JS object back at index 1.
            expect(line.handles[1]).toBe(capturedRef);
        });

        it("restores all original handle references by identity", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            const originalRefs = [...line.handles];

            const cmd = new RemoveHandleFromLine(line, 1);
            cmd.execute();
            cmd.undo();

            expect(line.handles.length).toBe(originalRefs.length);
            for (let i = 0; i < originalRefs.length; i++) {
                expect(line.handles[i]).toBe(originalRefs[i]);
            }
        });

    });


    describe("redo (execute after undo)", () => {

        it("removes the same handle on redo that was removed on first execute", () => {
            const line = buildPolyLineWithHandles(factory, 3);
            const targetRef = line.handles[1];

            const cmd = new RemoveHandleFromLine(line, 1);
            cmd.execute();
            cmd.undo();
            cmd.execute();

            expect(line.handles.length).toBe(2);
            expect(line.handles.some(h => h === targetRef)).toBe(false);
        });

        it("post-redo handle array matches post-first-execute array by identity", () => {
            const line = buildPolyLineWithHandles(factory, 4);
            const targetRef = line.handles[2];
            const cmd = new RemoveHandleFromLine(line, 2);

            cmd.execute();
            const afterFirstExecute = [...line.handles];

            cmd.undo();
            cmd.execute();

            // The captured handle must still be absent after redo.
            expect(line.handles.some(h => h === targetRef)).toBe(false);

            // The post-redo array must match the post-first-execute array
            // element-by-element by identity.
            expect(line.handles.length).toBe(afterFirstExecute.length);
            for (let i = 0; i < afterFirstExecute.length; i++) {
                expect(line.handles[i]).toBe(afterFirstExecute[i]);
            }
        });

    });

});
