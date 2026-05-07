/**
 * @file SetLineFace.spec.ts
 *
 * Unit tests for the {@link SetLineFace} command.
 *
 * Contract under test:
 *  - execute: replaces `line.face` with a new instance of `faceCtor`
 *  - undo:    restores a new instance of the prior face class
 *  - redo:    execute after undo re-applies `faceCtor` (prior ctor is captured
 *             exactly once so undo/redo cycles remain symmetric)
 *  - Both directions are tested: DynamicLine → PolyLine and PolyLine → DynamicLine
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
    DynamicLine,
    HandleView,
    LineView,
    PolyLine
} from "@OpenChart/DiagramView";
import { createLinesTestingFactory } from "../../../DiagramView/DiagramObjectView/Faces/Lines/Lines.testing";
import { SetLineFace } from "./SetLineFace";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers  //////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Builds a {@link LineView} whose face is a {@link DynamicLine}.
 * A freshly created `data_flow` line has one handle by default, which
 * keeps the face as DynamicLine.
 */
function buildDynamicLineView(factory: DiagramObjectViewFactory): LineView {
    const line = factory.createNewDiagramObject("data_flow", LineView);
    // Precondition: verify the fixture is in the expected state.
    if (!(line.face instanceof DynamicLine)) {
        throw new Error("Fixture precondition failed: expected DynamicLine face.");
    }
    return line;
}

/**
 * Builds a {@link LineView} whose face is a {@link PolyLine}.
 * Adds a second handle so `inferLineFaces` upgrades the face.
 */
function buildPolyLineView(factory: DiagramObjectViewFactory): LineView {
    const line = factory.createNewDiagramObject("data_flow", LineView);
    line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
    factory.inferLineFaces([line]);
    if (!(line.face instanceof PolyLine)) {
        throw new Error("Fixture precondition failed: expected PolyLine face.");
    }
    return line;
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("SetLineFace", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createLinesTestingFactory();
    });


    ///////////////////////////////////////////////////////////////////////////
    //  DynamicLine → PolyLine  ////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    describe("DynamicLine → PolyLine", () => {

        describe("execute", () => {

            it("replaces the face with an instance of PolyLine", () => {
                const line = buildDynamicLineView(factory);
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();

                expect(line.face).toBeInstanceOf(PolyLine);
            });

            it("produces a new face instance (not the same object as before)", () => {
                const line = buildDynamicLineView(factory);
                const priorFace = line.face;
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();

                expect(line.face).not.toBe(priorFace);
            });

        });


        describe("undo", () => {

            it("restores the face to DynamicLine after undo", () => {
                const line = buildDynamicLineView(factory);
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();
                expect(line.face).toBeInstanceOf(PolyLine);

                cmd.undo();

                expect(line.face).toBeInstanceOf(DynamicLine);
            });

        });


        describe("redo (execute after undo)", () => {

            it("re-applies PolyLine on re-execute", () => {
                const line = buildDynamicLineView(factory);
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();
                expect(line.face).toBeInstanceOf(PolyLine);

                cmd.undo();
                expect(line.face).toBeInstanceOf(DynamicLine);

                cmd.execute();
                expect(line.face).toBeInstanceOf(PolyLine);
            });

            it("prior face ctor remains DynamicLine across multiple undo/redo cycles", () => {
                const line = buildDynamicLineView(factory);
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();
                cmd.undo();
                cmd.execute();
                cmd.undo();

                // After two full cycles, face must still be DynamicLine.
                expect(line.face).toBeInstanceOf(DynamicLine);
            });

        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  PolyLine → DynamicLine  ////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    describe("PolyLine → DynamicLine", () => {

        describe("execute", () => {

            it("replaces the face with an instance of DynamicLine", () => {
                const line = buildPolyLineView(factory);
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();

                expect(line.face).toBeInstanceOf(DynamicLine);
            });

        });


        describe("undo", () => {

            it("restores the face to PolyLine after undo", () => {
                const line = buildPolyLineView(factory);
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();
                expect(line.face).toBeInstanceOf(DynamicLine);

                cmd.undo();

                expect(line.face).toBeInstanceOf(PolyLine);
            });

        });


        describe("redo (execute after undo)", () => {

            it("re-applies DynamicLine on re-execute", () => {
                const line = buildPolyLineView(factory);
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();
                expect(line.face).toBeInstanceOf(DynamicLine);

                cmd.undo();
                expect(line.face).toBeInstanceOf(PolyLine);

                cmd.execute();
                expect(line.face).toBeInstanceOf(DynamicLine);
            });

            it("prior face ctor remains PolyLine across multiple undo/redo cycles", () => {
                const line = buildPolyLineView(factory);
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();
                cmd.undo();
                cmd.execute();
                cmd.undo();

                // After two full cycles, face must still be PolyLine.
                expect(line.face).toBeInstanceOf(PolyLine);
            });

        });

    });

});
