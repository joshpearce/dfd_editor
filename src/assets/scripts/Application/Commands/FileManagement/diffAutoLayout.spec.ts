/**
 * @file diffAutoLayout.spec.ts
 *
 * Unit tests for {@link diffAutoLayout}.
 *
 * Each test builds a live {@link DiagramViewFile}, clones it (capturing the
 * live→planned instance-id map), mutates the clone's canvas directly via raw
 * model/view APIs, and then asserts that {@link diffAutoLayout} emits the
 * expected {@link SynchronousEditorCommand}s with:
 *   - the correct type,
 *   - references to **live** JS objects (identity assertions),
 *   - the correct target coordinates / indices, and
 *   - the correct dependency order.
 *
 * The tests deliberately do NOT execute the returned commands — that would
 * defeat the purpose of testing the diff walker in isolation.  Only the
 * command list is inspected.
 *
 * Mutation helpers used:
 *   - `block.moveTo(x, y)`          — reposition a block on the clone canvas
 *   - `line.addHandle(handle)`       — add an extra handle to the clone's line
 *   - `factory.inferLineFaces([line])` — upgrade DynamicLine → PolyLine
 *   - `latch.link(anchor)`           — rebind a clone latch to a different anchor
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
    AnchorView,
    BlockView,
    CanvasView,
    HandleView,
    LineView,
    PolyLine,
    DynamicLine,
    DiagramViewFile,
    PositionSetByUser
} from "@OpenChart/DiagramView";
import { AddHandleToLine } from "@OpenChart/DiagramEditor/Commands/Model/AddHandleToLine";
import { RemoveHandleFromLine } from "@OpenChart/DiagramEditor/Commands/Model/RemoveHandleFromLine";
import { SetLineFace } from "@OpenChart/DiagramEditor/Commands/View/SetLineFace";
import { DetachLatchFromAnchor } from "@OpenChart/DiagramEditor/Commands/Model/DetachLatchFromAnchor";
import { AttachLatchToAnchor } from "@OpenChart/DiagramEditor/Commands/Model/AttachLatchToAnchor";
import { MoveObjectsTo } from "@OpenChart/DiagramEditor/Commands/View/MoveObjectsTo";
import { createLinesTestingFactory } from "@OpenChart/DiagramView/DiagramObjectView/Faces/Lines/Lines.testing";
import { diffAutoLayout } from "./diffAutoLayout";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers                                                           //
///////////////////////////////////////////////////////////////////////////////


/**
 * Builds a minimal {@link DiagramViewFile} containing two blocks (A, B)
 * connected by a single-handle data-flow line (node1 → blockA anchor,
 * node2 → blockB anchor).
 *
 * Returns the live file together with the raw JS objects so tests can
 * locate them after a clone.
 */
async function buildTwoBlockFile(factory: DiagramObjectViewFactory): Promise<{
    file: DiagramViewFile;
    blockA: BlockView;
    blockB: BlockView;
    line: LineView;
    anchorA: AnchorView;
    anchorB: AnchorView;
}> {
    const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
    const blockA = factory.createNewDiagramObject("process", BlockView);
    const blockB = factory.createNewDiagramObject("process", BlockView);
    const line   = factory.createNewDiagramObject("data_flow", LineView);

    canvas.addObject(blockA);
    canvas.addObject(blockB);
    canvas.addObject(line);

    // Position blocks far apart so latches land at different coordinates.
    blockA.moveTo(100, 100);
    blockB.moveTo(500, 300);

    // Grab one anchor from each block.
    const anchorA = blockA.anchors.values().next().value! as AnchorView;
    const anchorB = blockB.anchors.values().next().value! as AnchorView;

    // Link latches to anchors so the line has proper endpoints.
    line.node1.link(anchorA);
    line.node2.link(anchorB);

    canvas.calculateLayout();

    // Wrap in a DiagramViewFile so clone() is available.
    const file = new DiagramViewFile(factory, {
        schema  : factory.id,
        theme   : factory.theme.id,
        objects : import_objects_from_canvas(canvas, factory),
        layout  : generate_layout(canvas)
    });

    // Return the live objects from the file's canvas (not the raw canvas).
    const liveBlockA = [...file.canvas.blocks].find(b => b.instance === blockA.instance)! as BlockView;
    const liveBlockB = [...file.canvas.blocks].find(b => b.instance === blockB.instance)! as BlockView;
    const liveLine   = [...file.canvas.lines].find(l => l.instance === line.instance)! as LineView;
    const liveAnchorA = liveBlockA.anchors.values().next().value! as AnchorView;
    const liveAnchorB = liveBlockB.anchors.values().next().value! as AnchorView;

    return {
        file,
        blockA: liveBlockA,
        blockB: liveBlockB,
        line: liveLine,
        anchorA: liveAnchorA,
        anchorB: liveAnchorB
    };
}

// Helpers to build the minimal export structure used inside buildTwoBlockFile.
import { DiagramObjectSerializer } from "@OpenChart/DiagramModel";
import { ManualLayoutEngine } from "@OpenChart/DiagramView/DiagramLayoutEngine";

function import_objects_from_canvas(canvas: CanvasView, _factory: DiagramObjectViewFactory) {
    return DiagramObjectSerializer.exportObjects([canvas]);
}

function generate_layout(canvas: CanvasView) {
    return ManualLayoutEngine.generatePositionMap([canvas]);
}

/**
 * Clones a {@link DiagramViewFile} and returns the clone together with the
 * live→planned instance-id map that {@link diffAutoLayout} needs.
 */
function cloneFile(file: DiagramViewFile): {
    clone: DiagramViewFile;
    instanceMap: Map<string, string>;
} {
    const instanceMap = new Map<string, string>();
    const clone = file.clone(undefined, instanceMap);
    return { clone, instanceMap };
}

/**
 * Finds a {@link LineView} in a canvas whose live instance corresponds to
 * `liveInstance` (via the instanceMap).
 */
function findClonedLine(cloneCanvas: CanvasView, liveInstance: string, instanceMap: Map<string, string>): LineView {
    const plannedId = instanceMap.get(liveInstance)!;
    const found = [...cloneCanvas.lines].find(l => l.instance === plannedId);
    if (!found) { throw new Error(`Could not find cloned line for live instance ${liveInstance}`); }
    return found as LineView;
}

/**
 * Finds a {@link BlockView} in a canvas whose live instance corresponds to
 * `liveInstance`.
 */
function findClonedBlock(cloneCanvas: CanvasView, liveInstance: string, instanceMap: Map<string, string>): BlockView {
    const plannedId = instanceMap.get(liveInstance)!;
    const found = [...cloneCanvas.blocks].find(b => b.instance === plannedId);
    if (!found) { throw new Error(`Could not find cloned block for live instance ${liveInstance}`); }
    return found as BlockView;
}


///////////////////////////////////////////////////////////////////////////////
//  Tests                                                                     //
///////////////////////////////////////////////////////////////////////////////


describe("diffAutoLayout", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createLinesTestingFactory();
    });


    ///////////////////////////////////////////////////////////////////////////
    //  No-op case                                                           //
    ///////////////////////////////////////////////////////////////////////////

    describe("no-op", () => {

        it("returns an empty array when live and planned canvases are identical", async () => {
            const { file } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            expect(cmds).toHaveLength(0);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Block move                                                            //
    ///////////////////////////////////////////////////////////////////////////

    describe("block move", () => {

        it("returns one MoveObjectsTo for a block whose position changed", async () => {
            const { file, blockA } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            // Mutate the clone: move blockA to a new position.
            const clonedBlockA = findClonedBlock(clone.canvas, blockA.instance, instanceMap);
            clonedBlockA.moveTo(999, 888);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const moveCmds = cmds.filter(c => c instanceof MoveObjectsTo);
            // Exactly one move for blockA (latches may also move, but the
            // block move is required).
            const blockMove = moveCmds.find(c => (c as MoveObjectsTo).object === blockA);
            expect(blockMove).toBeDefined();
            expect((blockMove as MoveObjectsTo).nx).toBe(999);
            expect((blockMove as MoveObjectsTo).ny).toBe(888);
        });

        it("MoveObjectsTo references the live block JS instance, not the clone", async () => {
            const { file, blockA } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedBlockA = findClonedBlock(clone.canvas, blockA.instance, instanceMap);
            clonedBlockA.moveTo(200, 300);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const blockMove = cmds
                .filter(c => c instanceof MoveObjectsTo)
                .find(c => (c as MoveObjectsTo).object === blockA);

            // Identity: must be the live object, not the clone.
            expect((blockMove as MoveObjectsTo).object).toBe(blockA);
            expect((blockMove as MoveObjectsTo).object).not.toBe(clonedBlockA);
        });

        it("does not emit a move command when block positions are unchanged", async () => {
            const { file, blockA } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            // Only move blockB, not blockA.
            const clonedBlockB = findClonedBlock(
                clone.canvas,
                [...file.canvas.blocks].find(b => b.instance !== blockA.instance)!.instance,
                instanceMap
            );
            clonedBlockB.moveTo(42, 42);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const blockAMove = cmds
                .filter(c => c instanceof MoveObjectsTo)
                .find(c => (c as MoveObjectsTo).object === blockA);
            expect(blockAMove).toBeUndefined();
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Handle add                                                            //
    ///////////////////////////////////////////////////////////////////////////

    describe("handle add", () => {

        it("returns one AddHandleToLine when the clone's line has an extra handle", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            const extraHandle = factory.createNewDiagramObject("generic_handle", HandleView);
            extraHandle.face.moveTo(300, 200);
            clonedLine.addHandle(extraHandle, false);
            // inferLineFaces is not needed here because we're only comparing
            // handle counts in the diff — the line on the clone still has a
            // DynamicLine face (the live line also does), so the face-swap
            // branch won't trigger for this test.

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const addCmds = cmds.filter(c => c instanceof AddHandleToLine);
            expect(addCmds).toHaveLength(1);
        });

        it("AddHandleToLine references the live line instance", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            const extraHandle = factory.createNewDiagramObject("generic_handle", HandleView);
            extraHandle.face.moveTo(350, 250);
            clonedLine.addHandle(extraHandle, false);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const addCmd = cmds.find(c => c instanceof AddHandleToLine) as AddHandleToLine;
            expect(addCmd).toBeDefined();
            expect(addCmd.line).toBe(line);
        });

        it("AddHandleToLine carries the planned handle's (x, y) and atIndex", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            const extraHandle = factory.createNewDiagramObject("generic_handle", HandleView);
            extraHandle.face.moveTo(123, 456);
            clonedLine.addHandle(extraHandle, false);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const addCmd = cmds.find(c => c instanceof AddHandleToLine) as AddHandleToLine;
            expect(addCmd.x).toBe(123);
            expect(addCmd.y).toBe(456);
            // The live line starts with 1 handle; the new one sits at index 1.
            expect(addCmd.atIndex).toBe(1);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Face swap                                                             //
    ///////////////////////////////////////////////////////////////////////////

    describe("face swap", () => {

        it("returns a SetLineFace when the clone's line is upgraded to PolyLine", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);

            // Add 2 extra handles then infer to upgrade DynamicLine → PolyLine.
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            factory.inferLineFaces([clonedLine]);

            expect(clonedLine.face).toBeInstanceOf(PolyLine);
            expect(line.face).toBeInstanceOf(DynamicLine);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceSwapCmds = cmds.filter(c => c instanceof SetLineFace);
            expect(faceSwapCmds).toHaveLength(1);
        });

        it("SetLineFace references the live line instance", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            factory.inferLineFaces([clonedLine]);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceSwapCmd = cmds.find(c => c instanceof SetLineFace) as SetLineFace;
            expect(faceSwapCmd.line).toBe(line);
        });

        it("SetLineFace targets PolyLine when the planned line has a PolyLine face", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            factory.inferLineFaces([clonedLine]);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceSwapCmd = cmds.find(c => c instanceof SetLineFace) as SetLineFace;
            expect(faceSwapCmd.faceCtor).toBe(PolyLine);
        });

        it("SetLineFace appears before AddHandleToLine commands in the returned list", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            factory.inferLineFaces([clonedLine]);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceSwapIdx = cmds.findIndex(c => c instanceof SetLineFace);
            const handleAddIdxes = cmds
                .map((c, i) => ({ c, i }))
                .filter(({ c }) => c instanceof AddHandleToLine)
                .map(({ i }) => i);

            expect(faceSwapIdx).toBeGreaterThanOrEqual(0);
            for (const addIdx of handleAddIdxes) {
                expect(faceSwapIdx).toBeLessThan(addIdx);
            }
        });

        it("does not emit SetLineFace when both canvases have the same face class", async () => {
            const { file } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            // Both live and clone have DynamicLine — no face difference.
            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceSwapCmds = cmds.filter(c => c instanceof SetLineFace);
            expect(faceSwapCmds).toHaveLength(0);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Latch reanchor + move                                                 //
    ///////////////////////////////////////////////////////////////////////////

    describe("latch reanchor", () => {

        it("emits DetachLatchFromAnchor and AttachLatchToAnchor when the clone latch is rebound", async () => {
            const { file, blockB, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            // On the clone canvas, rebind node1 (currently on blockA) to blockB's anchor.
            const clonedLine  = findClonedLine(clone.canvas, line.instance, instanceMap);
            const clonedBlockB = findClonedBlock(clone.canvas, blockB.instance, instanceMap);
            const clonedAnchorB = clonedBlockB.anchors.values().next().value! as AnchorView;

            // Rebind: detach from clonedBlockA's anchor, attach to clonedBlockB's anchor.
            // latch.link() handles the unlink from the old anchor automatically.
            clonedLine.node1.link(clonedAnchorB, false);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const detachCmds = cmds.filter(c => c instanceof DetachLatchFromAnchor);
            const attachCmds = cmds.filter(c => c instanceof AttachLatchToAnchor);

            expect(detachCmds).toHaveLength(1);
            expect(attachCmds).toHaveLength(1);
        });

        it("DetachLatchFromAnchor and AttachLatchToAnchor reference live objects", async () => {
            const { file, blockB, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine   = findClonedLine(clone.canvas, line.instance, instanceMap);
            const clonedBlockB = findClonedBlock(clone.canvas, blockB.instance, instanceMap);
            const clonedAnchorB = clonedBlockB.anchors.values().next().value! as AnchorView;

            clonedLine.node1.link(clonedAnchorB, false);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const detachCmd = cmds.find(c => c instanceof DetachLatchFromAnchor) as DetachLatchFromAnchor;
            const attachCmd = cmds.find(c => c instanceof AttachLatchToAnchor)   as AttachLatchToAnchor;

            // The latch referenced must be the live latch.
            expect(detachCmd.latch).toBe(line.node1);
            // The new anchor must be the live blockB's anchor (not the clone's).
            const liveAnchorB = blockB.anchors.values().next().value! as AnchorView;
            expect((attachCmd as AttachLatchToAnchor).nextAnchor).toBe(liveAnchorB);
        });

        it("detach appears before attach in the returned command list", async () => {
            const { file, blockB, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine   = findClonedLine(clone.canvas, line.instance, instanceMap);
            const clonedBlockB = findClonedBlock(clone.canvas, blockB.instance, instanceMap);
            const clonedAnchorB = clonedBlockB.anchors.values().next().value! as AnchorView;
            clonedLine.node1.link(clonedAnchorB, false);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const detachIdx = cmds.findIndex(c => c instanceof DetachLatchFromAnchor);
            const attachIdx = cmds.findIndex(c => c instanceof AttachLatchToAnchor);

            expect(detachIdx).toBeGreaterThanOrEqual(0);
            expect(attachIdx).toBeGreaterThanOrEqual(0);
            expect(detachIdx).toBeLessThan(attachIdx);
        });

        it("attach appears before any latch MoveObjectsTo in the returned command list", async () => {
            const { file, blockB, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine   = findClonedLine(clone.canvas, line.instance, instanceMap);
            const clonedBlockB = findClonedBlock(clone.canvas, blockB.instance, instanceMap);
            const clonedAnchorB = clonedBlockB.anchors.values().next().value! as AnchorView;
            clonedLine.node1.link(clonedAnchorB, false);
            // Move the clone latch to coordinates guaranteed to differ from the
            // live latch position, so diffAutoLayout emits MoveObjectsTo for it.
            clonedLine.node1.moveTo(999, 999);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const attachIdx = cmds.findIndex(c => c instanceof AttachLatchToAnchor);
            const node1 = line.node1;
            const latchMoveIdx = cmds.findIndex(
                c => c instanceof MoveObjectsTo && (c as MoveObjectsTo).object === node1
            );

            // attach must be present.
            expect(attachIdx).toBeGreaterThanOrEqual(0);
            // MoveObjectsTo(latch) must be present (clone latch is at 999,999;
            // live latch is at a different position from buildTwoBlockFile).
            expect(latchMoveIdx).toBeGreaterThanOrEqual(0);
            // attach precedes any latch move.
            expect(attachIdx).toBeLessThan(latchMoveIdx);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Identity invariant                                                    //
    ///////////////////////////////////////////////////////////////////////////

    describe("identity invariant", () => {

        it("all commands reference live objects (block move identity)", async () => {
            // Spot-check: the MoveObjectsTo emitted for blockA must carry the
            // live JS reference, not the clone's object.
            const { file, blockA } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedBlockA = findClonedBlock(clone.canvas, blockA.instance, instanceMap);
            clonedBlockA.moveTo(777, 888);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const blockMove = cmds
                .filter(c => c instanceof MoveObjectsTo)
                .find(c => (c as MoveObjectsTo).object === blockA) as MoveObjectsTo | undefined;

            expect(blockMove).toBeDefined();
            // The referenced object is the live block JS instance.
            expect((blockMove as MoveObjectsTo).object).toBe(blockA);
            // It is NOT the clone's object.
            expect((blockMove as MoveObjectsTo).object).not.toBe(clonedBlockA);
        });

        it("SetLineFace.line is the live line (not the clone line)", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            factory.inferLineFaces([clonedLine]);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceCmd = cmds.find(c => c instanceof SetLineFace) as SetLineFace;
            expect(faceCmd.line).toBe(line);
            expect(faceCmd.line).not.toBe(clonedLine);
        });

        it("AddHandleToLine.line is the live line (not the clone line)", async () => {
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            const extraHandle = factory.createNewDiagramObject("generic_handle", HandleView);
            clonedLine.addHandle(extraHandle, false);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const addCmd = cmds.find(c => c instanceof AddHandleToLine) as AddHandleToLine;
            expect(addCmd.line).toBe(line);
            expect(addCmd.line).not.toBe(clonedLine);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Handle remove                                                         //
    ///////////////////////////////////////////////////////////////////////////

    describe("handle remove", () => {

        it("returns RemoveHandleFromLine commands when the clone has fewer handles than live", async () => {
            // Build a live file whose line already has 3 handles (PolyLine),
            // then clone it and drop one handle from the clone's line.
            const liveFactory = factory;
            const canvas = liveFactory.createNewDiagramObject(liveFactory.canvas.name, CanvasView);
            const lineRaw = liveFactory.createNewDiagramObject("data_flow", LineView);
            const h1 = liveFactory.createNewDiagramObject("generic_handle", HandleView);
            const h2 = liveFactory.createNewDiagramObject("generic_handle", HandleView);
            lineRaw.addHandle(h1, false);
            lineRaw.addHandle(h2, false);
            // Mark all handles as user-set and give them positions so the
            // ManualLayoutEngine includes them in the position map and they
            // survive the export/import round-trip through DiagramViewFile.
            const handlePositions: Array<[number, number]> = [
                [100, 50],
                [200, 100],
                [300, 50]
            ];
            for (let i = 0; i < lineRaw.handles.length; i++) {
                lineRaw.handles[i].userSetPosition = PositionSetByUser.True;
                lineRaw.handles[i].face.moveTo(handlePositions[i][0], handlePositions[i][1]);
            }
            liveFactory.inferLineFaces([lineRaw]);
            canvas.addObject(lineRaw);
            canvas.calculateLayout();

            const liveFile = new DiagramViewFile(liveFactory, {
                schema  : liveFactory.id,
                theme   : liveFactory.theme.id,
                objects : DiagramObjectSerializer.exportObjects([canvas]),
                layout  : ManualLayoutEngine.generatePositionMap([canvas])
            });

            // The live line should now have 3 handles and be PolyLine after
            // DiagramViewFile's constructor infers faces.
            const liveLine = [...liveFile.canvas.lines][0] as LineView;
            expect(liveLine.handles.length).toBe(3);

            const instanceMap = new Map<string, string>();
            const cloned = liveFile.clone(undefined, instanceMap);

            // Remove one handle from the clone's line.
            const clonedLine = findClonedLine(cloned.canvas, liveLine.instance, instanceMap);
            expect(clonedLine.handles.length).toBe(3);
            clonedLine.deleteHandle(clonedLine.handles[2], false);
            expect(clonedLine.handles.length).toBe(2);

            const cmds = diffAutoLayout(liveFile.canvas, cloned.canvas, instanceMap);

            const removeCmds = cmds.filter(c => c instanceof RemoveHandleFromLine);
            expect(removeCmds).toHaveLength(1);
            expect((removeCmds[0] as RemoveHandleFromLine).line).toBe(liveLine);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Combined scenario: block move + handle add + face swap                //
    ///////////////////////////////////////////////////////////////////////////

    describe("combined mutations", () => {

        it("emits SetLineFace, AddHandleToLine, and MoveObjectsTo in dependency order", async () => {
            const { file, blockA, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            // 1. Move blockA on the clone.
            const clonedBlockA = findClonedBlock(clone.canvas, blockA.instance, instanceMap);
            clonedBlockA.moveTo(50, 60);

            // 2. Add handles to the clone's line and upgrade to PolyLine.
            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            clonedLine.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            factory.inferLineFaces([clonedLine]);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const faceSwapIdx  = cmds.findIndex(c => c instanceof SetLineFace);
            const handleAddIdx = cmds.findIndex(c => c instanceof AddHandleToLine);
            const blockMoveIdx = cmds.findIndex(
                c => c instanceof MoveObjectsTo && (c as MoveObjectsTo).object === blockA
            );

            expect(faceSwapIdx).toBeGreaterThanOrEqual(0);
            expect(handleAddIdx).toBeGreaterThanOrEqual(0);
            expect(blockMoveIdx).toBeGreaterThanOrEqual(0);

            // Dependency order: face swap < handle add < block move.
            expect(faceSwapIdx).toBeLessThan(handleAddIdx);
            // The move bucket comes after face swaps and handle adds.
            expect(handleAddIdx).toBeLessThan(blockMoveIdx);
        });

        it("returns an empty array for two identical canvases with PolyLine lines", async () => {
            // Build a live file with a multi-handle line, clone it without
            // any mutations — should still be a no-op.
            const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
            const lineRaw = factory.createNewDiagramObject("data_flow", LineView);
            lineRaw.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            lineRaw.addHandle(factory.createNewDiagramObject("generic_handle", HandleView), false);
            canvas.addObject(lineRaw);
            canvas.calculateLayout();

            const liveFile = new DiagramViewFile(factory, {
                schema  : factory.id,
                theme   : factory.theme.id,
                objects : DiagramObjectSerializer.exportObjects([canvas]),
                layout  : ManualLayoutEngine.generatePositionMap([canvas])
            });

            const instanceMap = new Map<string, string>();
            const cloned = liveFile.clone(undefined, instanceMap);

            const cmds = diffAutoLayout(liveFile.canvas, cloned.canvas, instanceMap);

            expect(cmds).toHaveLength(0);
        });

    });

});
