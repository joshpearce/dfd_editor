/**
 * @file SetLineFace.spec.ts
 *
 * Unit tests for the {@link SetLineFace} command.
 *
 * Contract under test:
 *  - execute: replaces `line.face` with a new instance of `faceCtor`
 *  - undo:    restores a new instance of the prior face class
 *  - redo:    execute after undo re-applies `faceCtor` (prior ctor is captured
 *             in the constructor so undo/redo cycles remain symmetric)
 *  - Both directions are tested: DynamicLine → PolyLine and PolyLine → DynamicLine
 *  - style and grid are preserved across execute/undo/redo cycles
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
import type { DiagramObjectViewFactory, LineFace } from "@OpenChart/DiagramView";
import type { GenericLineInternalState } from "../../../DiagramView/DiagramObjectView/Faces/Lines/GenericLineInternalState";


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers  //////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Reads the internal style and grid from a {@link LineFace}.
 * Uses the {@link GenericLineInternalState} escape hatch, mirroring the
 * production code.
 */
function readFaceState(face: LineFace) {
    return face as unknown as GenericLineInternalState;
}

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

            it("new face carries the same style as the original face", () => {
                const line = buildDynamicLineView(factory);
                const originalStyle = readFaceState(line.face).style;
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();

                expect(readFaceState(line.face).style).toBe(originalStyle);
            });

            it("new face carries the same grid as the original face", () => {
                const line = buildDynamicLineView(factory);
                const originalGrid = readFaceState(line.face).grid;
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();

                expect(readFaceState(line.face).grid).toEqual(originalGrid);
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

            it("restored face carries the same style as the original face", () => {
                const line = buildDynamicLineView(factory);
                const originalStyle = readFaceState(line.face).style;
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();
                cmd.undo();

                expect(readFaceState(line.face).style).toBe(originalStyle);
            });

            it("restored face carries the same grid as the original face", () => {
                const line = buildDynamicLineView(factory);
                const originalGrid = readFaceState(line.face).grid;
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();
                cmd.undo();

                expect(readFaceState(line.face).grid).toEqual(originalGrid);
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

            it("redo face carries the same style and grid across a full undo/redo cycle", () => {
                const line = buildDynamicLineView(factory);
                const originalStyle = readFaceState(line.face).style;
                const originalGrid = readFaceState(line.face).grid;
                const cmd = new SetLineFace(line, PolyLine);

                cmd.execute();
                cmd.undo();
                cmd.execute();

                expect(readFaceState(line.face).style).toBe(originalStyle);
                expect(readFaceState(line.face).grid).toEqual(originalGrid);
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

            it("new face carries the same style as the original face", () => {
                const line = buildPolyLineView(factory);
                const originalStyle = readFaceState(line.face).style;
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();

                expect(readFaceState(line.face).style).toBe(originalStyle);
            });

            it("new face carries the same grid as the original face", () => {
                const line = buildPolyLineView(factory);
                const originalGrid = readFaceState(line.face).grid;
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();

                expect(readFaceState(line.face).grid).toEqual(originalGrid);
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

            it("restored face carries the same style and grid after undo", () => {
                const line = buildPolyLineView(factory);
                const originalStyle = readFaceState(line.face).style;
                const originalGrid = readFaceState(line.face).grid;
                const cmd = new SetLineFace(line, DynamicLine);

                cmd.execute();
                cmd.undo();

                expect(readFaceState(line.face).style).toBe(originalStyle);
                expect(readFaceState(line.face).grid).toEqual(originalGrid);
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
