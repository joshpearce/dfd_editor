/**
 * @file AddHandleToLine.spec.ts
 *
 * Unit tests for the {@link AddHandleToLine} command.
 *
 * All test lines use a {@link PolyLine} face (via `inferLineFaces` after
 * building ≥2 handles) so that `insertHandle(handle, i, true)` does not
 * trigger the `DynamicLine.calculateLayout → dropHandles(1)` cascade that
 * would silently discard the newly inserted handle.  This mirrors production
 * use: `AddHandleToLine` is always preceded by `SetLineFace(PolyLine)` in
 * the `GroupCommand` emitted by `diffAutoLayout`.
 *
 * Contract under test:
 *  - execute: inserts a new handle at the given index with the given (x, y)
 *  - undo:    removes the inserted handle, restoring the original list by
 *             reference identity and length
 *  - redo:    re-inserts the *same* JS object that was inserted on first
 *             execute (referential symmetry)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { HandleView, LineView, PolyLine } from "@OpenChart/DiagramView";
import { createLinesTestingFactory } from "../../../DiagramView/DiagramObjectView/Faces/Lines/Lines.testing";
import { AddHandleToLine } from "./AddHandleToLine";
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


describe("AddHandleToLine", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createLinesTestingFactory();
    });


    describe("execute", () => {

        it("increases handle count by 1", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            expect(line.handles.length).toBe(2);
            expect(line.face).toBeInstanceOf(PolyLine);

            const cmd = new AddHandleToLine(line, 50, 75, 2);
            cmd.execute();

            expect(line.handles.length).toBe(3);
        });

        it("places the new handle at the specified index with the correct (x, y)", () => {
            const line = buildPolyLineWithHandles(factory, 2);

            const cmd = new AddHandleToLine(line, 42, 99, 2);
            cmd.execute();

            const inserted = line.handles[2];
            expect(inserted.x).toBe(42);
            expect(inserted.y).toBe(99);
        });

        it("inserts at an interior index, shifting later handles right", () => {
            // Start with 3 handles so we can insert in the middle.
            const line = buildPolyLineWithHandles(factory, 3);
            const originalRef1 = line.handles[1];
            const originalRef2 = line.handles[2];

            const cmd = new AddHandleToLine(line, 10, 20, 1);
            cmd.execute();

            expect(line.handles.length).toBe(4);
            expect(line.handles[1].x).toBe(10);
            expect(line.handles[1].y).toBe(20);
            // The handles that were at indices 1 and 2 shift right by one.
            expect(line.handles[2]).toBe(originalRef1);
            expect(line.handles[3]).toBe(originalRef2);
        });

        it("does not change handles outside the insertion index", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const originalRef0 = line.handles[0];
            const originalRef1 = line.handles[1];

            new AddHandleToLine(line, 5, 5, 1).execute();

            // Handle at index 0 is unchanged.
            expect(line.handles[0]).toBe(originalRef0);
            // Handle previously at index 1 is now at index 2.
            expect(line.handles[2]).toBe(originalRef1);
        });

    });


    describe("undo", () => {

        it("restores the original handle count", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const cmd = new AddHandleToLine(line, 30, 60, 2);
            cmd.execute();
            expect(line.handles.length).toBe(3);

            cmd.undo();

            expect(line.handles.length).toBe(2);
        });

        it("restores the original handle references by identity", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const originalRefs = [...line.handles];

            const cmd = new AddHandleToLine(line, 30, 60, 2);
            cmd.execute();
            cmd.undo();

            expect(line.handles.length).toBe(originalRefs.length);
            for (let i = 0; i < originalRefs.length; i++) {
                expect(line.handles[i]).toBe(originalRefs[i]);
            }
        });

        it("restores original handle positions after undo", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const positionsBefore = line.handles.map(h => ({ x: h.x, y: h.y }));

            const cmd = new AddHandleToLine(line, 100, 200, 2);
            cmd.execute();
            cmd.undo();

            for (let i = 0; i < positionsBefore.length; i++) {
                expect(line.handles[i].x).toBe(positionsBefore[i].x);
                expect(line.handles[i].y).toBe(positionsBefore[i].y);
            }
        });

    });


    describe("redo (execute after undo)", () => {

        it("re-inserts the same JS object that was inserted on first execute", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const cmd = new AddHandleToLine(line, 7, 14, 2);

            cmd.execute();
            const firstInsertedRef = line.handles[2];

            cmd.undo();
            expect(line.handles.length).toBe(2);

            cmd.execute();
            // The re-inserted handle must be the exact same JS object.
            expect(line.handles[2]).toBe(firstInsertedRef);
        });

        it("re-inserts at the same index with the same (x, y)", () => {
            const line = buildPolyLineWithHandles(factory, 2);
            const cmd = new AddHandleToLine(line, 55, 88, 1);

            cmd.execute();
            cmd.undo();
            cmd.execute();

            expect(line.handles.length).toBe(3);
            expect(line.handles[1].x).toBe(55);
            expect(line.handles[1].y).toBe(88);
        });

    });

});
