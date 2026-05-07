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
    GroupView,
    HandleView,
    LineView,
    PolyLine,
    DynamicLine,
    DiagramViewFile,
    PositionSetByUser
} from "@OpenChart/DiagramView";
import { DiagramObjectSerializer } from "@OpenChart/DiagramModel";
import { ManualLayoutEngine } from "@OpenChart/DiagramView/DiagramLayoutEngine";
import { AddHandleToLine } from "@OpenChart/DiagramEditor/Commands/Model/AddHandleToLine";
import { RemoveHandleFromLine } from "@OpenChart/DiagramEditor/Commands/Model/RemoveHandleFromLine";
import { ResizeGroupBy } from "@OpenChart/DiagramEditor/Commands/View/ResizeGroupBy";
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
        objects : import_objects_from_canvas(canvas),
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

function import_objects_from_canvas(canvas: CanvasView) {
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

/**
 * Finds a {@link GroupView} in a canvas (top-level groups only) whose live
 * instance corresponds to `liveInstance`.
 */
function findClonedGroup(cloneCanvas: CanvasView, liveInstance: string, instanceMap: Map<string, string>): GroupView {
    const plannedId = instanceMap.get(liveInstance)!;
    const found = (cloneCanvas.groups as readonly GroupView[]).find(g => g.instance === plannedId);
    if (!found) { throw new Error(`Could not find cloned group for live instance ${liveInstance}`); }
    return found;
}

/**
 * Builds a live {@link DiagramViewFile} that contains a single empty
 * {@link GroupView} with the given explicit bounds.
 *
 * Returns the live file and the live GroupView.
 */
async function buildGroupFile(
    factory: DiagramObjectViewFactory,
    bounds: [number, number, number, number]
): Promise<{ file: DiagramViewFile, group: GroupView }> {
    const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
    const group  = factory.createNewDiagramObject("trust_boundary", GroupView);
    group.face.setBounds(...bounds);
    canvas.addObject(group);
    canvas.calculateLayout();

    const file = new DiagramViewFile(factory, {
        schema  : factory.id,
        theme   : factory.theme.id,
        objects : import_objects_from_canvas(canvas),
        layout  : generate_layout(canvas)
    });

    const liveGroup = (file.canvas.groups as readonly GroupView[])[0];
    return { file, group: liveGroup };
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

        it("returns an empty array for two identical canvases with multi-handle DynamicLine lines", async () => {
            // Build a live file with a multi-handle line whose face stays
            // DynamicLine (only 1 extra handle, not 2+), clone it without
            // any mutations — should be a no-op.
            const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
            const lineRaw = factory.createNewDiagramObject("data_flow", LineView);
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

        it("does not emit MoveObjectsTo for linked latches when only the parent block moves (cascade no-op)", async () => {
            // When a block moves, its linked latches' positions are cascaded by
            // MoveObjectsTo(block).  Emitting separate MoveObjectsTo commands
            // for the latches would be redundant on execute and corrupt undo.
            const { file, blockA, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            // Move blockA on the clone; node1 is linked to blockA's anchor.
            const clonedBlockA = findClonedBlock(clone.canvas, blockA.instance, instanceMap);
            clonedBlockA.moveTo(200, 200);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            // Must have exactly one MoveObjectsTo: for blockA.
            const moveCmds = cmds.filter(c => c instanceof MoveObjectsTo);
            const blockAMove = moveCmds.find(c => (c as MoveObjectsTo).object === blockA);
            expect(blockAMove).toBeDefined();

            // node1 is linked to blockA's anchor — no explicit move for it.
            const latchMove = moveCmds.find(c => (c as MoveObjectsTo).object === line.node1);
            expect(latchMove).toBeUndefined();
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
    //  Handle move (per-index)                                               //
    ///////////////////////////////////////////////////////////////////////////

    describe("handle move", () => {

        it("emits exactly one MoveObjectsTo for a handle whose position changed", async () => {
            // Build a live file whose line has 3 handles (PolyLine), then
            // clone it and move only the interior handle (index 1).
            const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
            const lineRaw = factory.createNewDiagramObject("data_flow", LineView);
            const h1 = factory.createNewDiagramObject("generic_handle", HandleView);
            const h2 = factory.createNewDiagramObject("generic_handle", HandleView);
            lineRaw.addHandle(h1, false);
            lineRaw.addHandle(h2, false);
            for (let i = 0; i < lineRaw.handles.length; i++) {
                lineRaw.handles[i].userSetPosition = PositionSetByUser.True;
                lineRaw.handles[i].face.moveTo([100, 200, 300][i], 50);
            }
            factory.inferLineFaces([lineRaw]);
            canvas.addObject(lineRaw);
            canvas.calculateLayout();

            const liveFile = new DiagramViewFile(factory, {
                schema  : factory.id,
                theme   : factory.theme.id,
                objects : DiagramObjectSerializer.exportObjects([canvas]),
                layout  : ManualLayoutEngine.generatePositionMap([canvas])
            });

            const liveLine = [...liveFile.canvas.lines][0] as LineView;
            expect(liveLine.handles.length).toBe(3);

            const instanceMap = new Map<string, string>();
            const cloned = liveFile.clone(undefined, instanceMap);

            const clonedLine = findClonedLine(cloned.canvas, liveLine.instance, instanceMap);

            // Move only the interior handle (index 1) on the clone.
            clonedLine.handles[1].face.moveTo(999, 777);

            const cmds = diffAutoLayout(liveFile.canvas, cloned.canvas, instanceMap);

            const moveCmds = cmds.filter(c => c instanceof MoveObjectsTo);
            // Exactly one MoveObjectsTo for the handle at index 1.
            expect(moveCmds).toHaveLength(1);
            const moveCmd = moveCmds[0] as MoveObjectsTo;
            // Must reference the live handle at index 1, not the clone's.
            expect(moveCmd.object).toBe(liveLine.handles[1]);
            expect(moveCmd.nx).toBe(999);
            expect(moveCmd.ny).toBe(777);
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

        it("emits RemoveHandleFromLine in descending index order when multiple handles are removed", async () => {
            // Build a live file with a 4-handle line, clone it, remove 2
            // handles from the clone, and assert the emitted Remove commands
            // are ordered with higher indices first so that earlier indices
            // are not shifted by later removes.
            const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
            const lineRaw = factory.createNewDiagramObject("data_flow", LineView);
            for (let i = 0; i < 3; i++) {
                const h = factory.createNewDiagramObject("generic_handle", HandleView);
                lineRaw.addHandle(h, false);
            }
            for (let i = 0; i < lineRaw.handles.length; i++) {
                lineRaw.handles[i].userSetPosition = PositionSetByUser.True;
                lineRaw.handles[i].face.moveTo(100 + i * 100, 50);
            }
            factory.inferLineFaces([lineRaw]);
            canvas.addObject(lineRaw);
            canvas.calculateLayout();

            const liveFile = new DiagramViewFile(factory, {
                schema  : factory.id,
                theme   : factory.theme.id,
                objects : DiagramObjectSerializer.exportObjects([canvas]),
                layout  : ManualLayoutEngine.generatePositionMap([canvas])
            });

            const liveLine = [...liveFile.canvas.lines][0] as LineView;
            expect(liveLine.handles.length).toBe(4);

            const instanceMap = new Map<string, string>();
            const cloned = liveFile.clone(undefined, instanceMap);

            // Clone has 4 handles; remove non-adjacent indices 3 and 1 from the
            // clone so it retains handles at original positions 0 and 2.
            // Remove from the clone preserving the handles we want to keep.
            const clonedLine = findClonedLine(cloned.canvas, liveLine.instance, instanceMap);
            // Remove index 3 first (end), then index 1 (now index 1 of the
            // 3-handle remainder) to avoid shifting.
            clonedLine.deleteHandle(clonedLine.handles[3], false);
            clonedLine.deleteHandle(clonedLine.handles[1], false);
            expect(clonedLine.handles.length).toBe(2);

            const cmds = diffAutoLayout(liveFile.canvas, cloned.canvas, instanceMap);

            const removeCmds = cmds.filter(c => c instanceof RemoveHandleFromLine) as RemoveHandleFromLine[];
            expect(removeCmds).toHaveLength(2);

            // Descending order: index 3 must come before index 1.
            // Emitting [1, 3] would corrupt the handle list — removing index 1
            // first shifts index 3 down to 2, so the second remove targets the
            // wrong handle. Emitting [3, 1] correctly removes 3 first (leaving
            // 0,1,2), then 1 (leaving 0,2).
            expect(removeCmds[0].atIndex).toBe(3);
            expect(removeCmds[1].atIndex).toBe(1);

            // Execute both remove commands sequentially against the live line and
            // verify that the two surviving handles are the originals at indices 0 and 2.
            const liveHandle0 = liveLine.handles[0];
            const liveHandle2 = liveLine.handles[2];
            for (const cmd of removeCmds) { cmd.execute(); }
            expect(liveLine.handles).toHaveLength(2);
            expect(liveLine.handles[0]).toBe(liveHandle0);
            expect(liveLine.handles[1]).toBe(liveHandle2);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Handle add — non-tail (identity-based)                               //
    ///////////////////////////////////////////////////////////////////////////

    describe("handle add non-tail", () => {

        it("emits AddHandleToLine in ascending atIndex order for non-tail insertions", async () => {
            // Build a live file whose line already has 2 handles (indices 0 and 1).
            // The clone inserts a fresh handle at index 1 (between orig0 and orig1)
            // and another fresh handle at index 3 (after orig1), so the clone ends
            // up as [orig0, new1, orig1, new2].  diffAutoLayout must emit the two
            // AddHandleToLine commands in ascending atIndex order (1 then 3).
            const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
            const lineRaw = factory.createNewDiagramObject("data_flow", LineView);
            const h0 = factory.createNewDiagramObject("generic_handle", HandleView);
            lineRaw.addHandle(h0, false);
            for (let i = 0; i < lineRaw.handles.length; i++) {
                lineRaw.handles[i].userSetPosition = PositionSetByUser.True;
                lineRaw.handles[i].face.moveTo(100 + i * 200, 50);
            }
            factory.inferLineFaces([lineRaw]);
            canvas.addObject(lineRaw);
            canvas.calculateLayout();

            const liveFile = new DiagramViewFile(factory, {
                schema  : factory.id,
                theme   : factory.theme.id,
                objects : DiagramObjectSerializer.exportObjects([canvas]),
                layout  : ManualLayoutEngine.generatePositionMap([canvas])
            });

            const liveLine = [...liveFile.canvas.lines][0] as LineView;
            expect(liveLine.handles.length).toBe(2);

            const instanceMap = new Map<string, string>();
            const cloned = liveFile.clone(undefined, instanceMap);

            // The clone starts as [cloneOfH0, cloneOfH1] (indices 0 and 1).
            // Insert new1 at index 1: splice so clone becomes [cloneOfH0, new1, cloneOfH1].
            // Insert new2 at index 3: splice so clone becomes [cloneOfH0, new1, cloneOfH1, new2].
            const clonedLine = findClonedLine(cloned.canvas, liveLine.instance, instanceMap);
            expect(clonedLine.handles.length).toBe(2);

            // Insert new1 at index 1 (between cloneOfH0 and cloneOfH1).
            const new1 = factory.createNewDiagramObject("generic_handle", HandleView);
            new1.face.moveTo(150, 75);
            clonedLine.insertHandle(new1, 1, false);
            // Clone is now [cloneOfH0, new1, cloneOfH1].

            // Insert new2 at index 3 (after cloneOfH1 at the tail).
            const new2 = factory.createNewDiagramObject("generic_handle", HandleView);
            new2.face.moveTo(450, 25);
            clonedLine.insertHandle(new2, 3, false);
            // Clone is now [cloneOfH0, new1, cloneOfH1, new2].

            expect(clonedLine.handles.length).toBe(4);
            expect(clonedLine.handles[1]).toBe(new1);
            expect(clonedLine.handles[3]).toBe(new2);

            const cmds = diffAutoLayout(liveFile.canvas, cloned.canvas, instanceMap);

            const addCmds = cmds.filter(c => c instanceof AddHandleToLine) as AddHandleToLine[];
            expect(addCmds).toHaveLength(2);

            // Commands must be in ascending atIndex order.
            expect(addCmds[0].atIndex).toBe(1);
            expect(addCmds[1].atIndex).toBe(3);

            // Each command carries the correct planned (x, y).
            expect(addCmds[0].x).toBe(150);
            expect(addCmds[0].y).toBe(75);
            expect(addCmds[1].x).toBe(450);
            expect(addCmds[1].y).toBe(25);

            // Both commands target the live line.
            expect(addCmds[0].line).toBe(liveLine);
            expect(addCmds[1].line).toBe(liveLine);

            // Execute sequentially: live line should gain two handles at the
            // correct positions while the original live handle references survive.
            const liveHandle0 = liveLine.handles[0];
            const liveHandle1 = liveLine.handles[1];
            for (const cmd of addCmds) { cmd.execute(); }
            expect(liveLine.handles).toHaveLength(4);
            // Original handles still present at their new indices.
            expect(liveLine.handles[0]).toBe(liveHandle0);
            expect(liveLine.handles[2]).toBe(liveHandle1);
            // Newly inserted handles land at the positions specified.
            expect(liveLine.handles[1].x).toBeCloseTo(150, 1);
            expect(liveLine.handles[1].y).toBeCloseTo(75, 1);
            expect(liveLine.handles[3].x).toBeCloseTo(450, 1);
            expect(liveLine.handles[3].y).toBeCloseTo(25, 1);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Throw paths                                                           //
    ///////////////////////////////////////////////////////////////////////////

    describe("throw paths", () => {

        it("emits Detach (no Attach) when live latch is linked but planned latch is unlinked", async () => {
            // TALA can produce an unlinked planned latch when it cannot find an
            // anchor for an endpoint — the diff must emit a Detach so the live
            // canvas matches the planned one, not throw.
            const { file, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine = findClonedLine(clone.canvas, line.instance, instanceMap);
            // Unlink node1 from its anchor without re-linking it.
            clonedLine.node1.unlink(false);
            expect(clonedLine.node1.anchor).toBeNull();
            expect(line.node1.anchor).not.toBeNull();

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const detaches = cmds.filter(c => c instanceof DetachLatchFromAnchor);
            const attaches = cmds.filter(c => c instanceof AttachLatchToAnchor);
            expect(detaches).toHaveLength(1);
            expect(attaches).toHaveLength(0);
            expect((detaches[0] as DetachLatchFromAnchor).latch).toBe(line.node1);
        });

        it("throws when planned latch references an anchor with no live counterpart", async () => {
            // Build the standard two-block file and clone it.  Then deliberately
            // corrupt the liveToPlanned map by removing the entry for one of the
            // anchors so that when diffAutoLayout tries to resolve the planned
            // anchor back to a live anchor it fails to find one.
            //
            // Steps:
            //  1. Clone the file to get a valid instanceMap.
            //  2. On the clone, rebind node1 to blockB's anchor (so anchorChanged=true).
            //  3. Find the planned anchor id that node1 now points to in the clone.
            //  4. Remove that anchor's live→planned entry from instanceMap so
            //     plannedToLive no longer contains it, causing the lookup to fail.
            const { file, blockB, line } = await buildTwoBlockFile(factory);
            const { clone, instanceMap } = cloneFile(file);

            const clonedLine   = findClonedLine(clone.canvas, line.instance, instanceMap);
            const clonedBlockB = findClonedBlock(clone.canvas, blockB.instance, instanceMap);
            const clonedAnchorB = clonedBlockB.anchors.values().next().value! as AnchorView;

            // Rebind node1 to blockB's anchor (anchorChanged=true path).
            clonedLine.node1.link(clonedAnchorB, false);

            // The planned anchor the diff walker will look up is clonedAnchorB.
            // Remove the live→planned mapping for blockB's live anchor so that
            // plannedToLive.get(clonedAnchorB.instance) returns the live anchor id,
            // but liveById won't contain it — achieved by erasing the forward entry
            // from instanceMap (so plannedToLive won't map clonedAnchorB.instance
            // back to any live id, making plannedAnchorLiveId === undefined which
            // means anchorChanged === false; instead we need a different corruption).
            //
            // The correct corruption: keep plannedToLive's entry for clonedAnchorB
            // intact (so anchorChanged is true and plannedAnchorLiveId is defined),
            // but remove blockB's anchor from liveById by erasing its instanceMap
            // entry, making liveById.get(plannedAnchorLiveId) === undefined.
            //
            // liveById is internal; we corrupt instanceMap differently:
            // Insert a fake mapping so plannedToLive.get(clonedAnchorB.instance)
            // returns a nonexistent live id — this is the simplest way.
            instanceMap.set("__nonexistent_live_anchor__", clonedAnchorB.instance);

            expect(() => diffAutoLayout(file.canvas, clone.canvas, instanceMap))
                .toThrow(/no live counterpart/i);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  Group bounds                                                          //
    ///////////////////////////////////////////////////////////////////////////

    describe("group bounds", () => {

        it("emits the right commands when only the group center moves (size unchanged)", async () => {
            // Live group at [-100,-80,100,80]; planned group shifted +50,+30
            // so it is at [-50,-50,150,110].  Size is the same (200×160).
            // After executing the two ResizeGroupBy commands, the live group's
            // xMin/yMin/xMax/yMax must equal the planned group's.
            const liveBounds: [number, number, number, number] = [-100, -80, 100, 80];
            const { file, group } = await buildGroupFile(factory, liveBounds);
            const { clone, instanceMap } = cloneFile(file);

            const clonedGroup = findClonedGroup(clone.canvas, group.instance, instanceMap);
            // Shift both corners by (+50, +30) — preserves size.
            clonedGroup.face.setBounds(-50, -50, 150, 110);
            clonedGroup.face.calculateLayout();

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            // Execute commands and verify final state.
            for (const cmd of cmds) { cmd.execute(); }

            expect(group.face.boundingBox.xMin).toBeCloseTo(-50, 1);
            expect(group.face.boundingBox.yMin).toBeCloseTo(-50, 1);
            expect(group.face.boundingBox.xMax).toBeCloseTo(150, 1);
            expect(group.face.boundingBox.yMax).toBeCloseTo(110, 1);
        });

        it("emits the right commands when only the group size changes (center unchanged)", async () => {
            // Live group at [-100,-80,100,80]; planned group expanded symmetrically
            // to [-150,-120,150,120].  Center is still (0,0).
            const liveBounds: [number, number, number, number] = [-100, -80, 100, 80];
            const { file, group } = await buildGroupFile(factory, liveBounds);
            const { clone, instanceMap } = cloneFile(file);

            const clonedGroup = findClonedGroup(clone.canvas, group.instance, instanceMap);
            clonedGroup.face.setBounds(-150, -120, 150, 120);
            clonedGroup.face.calculateLayout();

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            for (const cmd of cmds) { cmd.execute(); }

            expect(group.face.boundingBox.xMin).toBeCloseTo(-150, 1);
            expect(group.face.boundingBox.yMin).toBeCloseTo(-120, 1);
            expect(group.face.boundingBox.xMax).toBeCloseTo(150, 1);
            expect(group.face.boundingBox.yMax).toBeCloseTo(120, 1);
        });

        it("emits the right commands when both center and size change", async () => {
            // Live group at [-100,-80,100,80].
            // Planned group at [0,20,300,220] — both center shifted and size changed.
            const liveBounds: [number, number, number, number] = [-100, -80, 100, 80];
            const { file, group } = await buildGroupFile(factory, liveBounds);
            const { clone, instanceMap } = cloneFile(file);

            const clonedGroup = findClonedGroup(clone.canvas, group.instance, instanceMap);
            clonedGroup.face.setBounds(0, 20, 300, 220);
            clonedGroup.face.calculateLayout();

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            for (const cmd of cmds) { cmd.execute(); }

            expect(group.face.boundingBox.xMin).toBeCloseTo(0, 1);
            expect(group.face.boundingBox.yMin).toBeCloseTo(20, 1);
            expect(group.face.boundingBox.xMax).toBeCloseTo(300, 1);
            expect(group.face.boundingBox.yMax).toBeCloseTo(220, 1);
        });

        it("emits ResizeGroupBy commands for the group (not MoveObjectsTo)", async () => {
            const liveBounds: [number, number, number, number] = [-100, -80, 100, 80];
            const { file, group } = await buildGroupFile(factory, liveBounds);
            const { clone, instanceMap } = cloneFile(file);

            const clonedGroup = findClonedGroup(clone.canvas, group.instance, instanceMap);
            clonedGroup.face.setBounds(-50, -40, 200, 160);
            clonedGroup.face.calculateLayout();

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            const resizeCmds = cmds.filter(c => c instanceof ResizeGroupBy) as ResizeGroupBy[];
            const moveCmdsForGroup = cmds.filter(
                c => c instanceof MoveObjectsTo && (c as MoveObjectsTo).object === group
            );

            expect(resizeCmds.length).toBeGreaterThan(0);
            expect(moveCmdsForGroup).toHaveLength(0);

            // All resize commands must reference the live group.
            for (const rc of resizeCmds) {
                expect(rc.group).toBe(group);
            }
        });

        it("returns an empty array when group bounds are unchanged", async () => {
            const liveBounds: [number, number, number, number] = [-100, -80, 100, 80];
            const { file } = await buildGroupFile(factory, liveBounds);
            const { clone, instanceMap } = cloneFile(file);

            const cmds = diffAutoLayout(file.canvas, clone.canvas, instanceMap);

            expect(cmds).toHaveLength(0);
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

    });

});
