/**
 * @file PowerEditPlugin.testing.ts
 *
 * Test-only fixture helpers for PowerEditPlugin and ObjectMover unit tests.
 * NOT production code — do not add to any production barrel (index.ts).
 * Import via direct relative path from spec files only.
 *
 * Reused by:
 *   - PowerEditPlugin.testing.spec.ts (Step 1b smoke)
 *   - PowerEditPlugin.smartHover.spec.ts (Step 2 TB-14)
 *   - ObjectMovers/BlockMover.spec.ts (Step 3 TB-13)
 *   - ObjectMovers/GroupMover.spec.ts (Step 4 TB-13)
 *   - ObjectMovers/LatchMover.spec.ts (Step 5 TB-13)
 *   - ObjectMovers/GenericMover.spec.ts (Step 6 TB-13)
 */

import { Crypto } from "@OpenChart/Utilities";
import { DiagramViewFile } from "@OpenChart/DiagramView";
import { DiagramViewEditor } from "../../DiagramViewEditor";
import { PowerEditPlugin } from "./PowerEditPlugin";
import { SubjectTrack } from "@OpenChart/DiagramInterface";
import { BlockView, CanvasView, GroupView } from "@OpenChart/DiagramView";
import {
    makeEmptyCanvas
} from "../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { ObjectMover } from "./ObjectMovers";
import type { CommandExecutor } from "./CommandExecutor";
import type { SynchronousEditorCommand } from "../../Commands";


///////////////////////////////////////////////////////////////////////////////
//  1. Types  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/** Describes a block to place on a canvas or inside a group. */
export type BlockSpec = {
    id?: string;
    template?: string;
    x: number;
    y: number;
};

/**
 * Describes a group (and its optional nested groups / blocks).
 *
 * Note: the plan's example spec used a mixed `children` array; we use
 * explicit `groups` / `blocks` fields for structured, type-safe recursion.
 */
export type GroupSpec = {
    id?: string;
    template?: string;
    bounds: [number, number, number, number];
    groups?: GroupSpec[];
    blocks?: BlockSpec[];
};

/** Top-level canvas description for {@link buildCanvas}. */
export type CanvasSpec = {
    groups?: GroupSpec[];
    blocks?: BlockSpec[];
};

/** Collects commands emitted during a {@link driveDrag} or direct execute. */
export type SpyExecutor = {
    commands: SynchronousEditorCommand[];
    reset(): void;
};

/** Factory function that receives a {@link CommandExecutor} and returns a mover. */
export type MoverFactory = (execute: CommandExecutor) => ObjectMover;


///////////////////////////////////////////////////////////////////////////////
//  2. Template constants  ////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


const DEFAULT_GROUP_TEMPLATE = "generic_group";
const DEFAULT_BLOCK_TEMPLATE = "generic_block";


///////////////////////////////////////////////////////////////////////////////
//  3. TestablePowerEditPlugin  ///////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Test-only subclass that exposes the `protected smartHover` method under a
 * public name so specs can call it directly without triggering the full
 * pointer-event dispatch chain.
 *
 * The `MouseEvent` parameter is typed in the production signature but
 * currently unused (`_event`), so a minimal cast-to-MouseEvent stub suffices.
 */
export class TestablePowerEditPlugin extends PowerEditPlugin {

    /**
     * Calls `smartHover(x, y, stubEvent)` and returns the result.
     * @param x - Canvas x coordinate to query.
     * @param y - Canvas y coordinate to query.
     */
    public hoverAt(x: number, y: number): DiagramObjectView | undefined {
        return this.smartHover(x, y, {} as MouseEvent);
    }

}


///////////////////////////////////////////////////////////////////////////////
//  4. createTestableEditor  //////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a {@link DiagramViewEditor} paired with a {@link TestablePowerEditPlugin}
 * whose canvas is pre-populated with the objects in `canvas`.
 *
 * Canvas wiring note: `DiagramViewFile.canvas` is set in the constructor and
 * is `readonly`, so we create a fresh `DiagramViewFile(factory)` — which
 * makes its own empty canvas — then transfer every top-level object from the
 * caller-supplied `canvas` into `file.canvas` via `addObject`. Because
 * `addObject` calls `removeObject` on the previous parent first, the objects
 * are cleanly re-parented without duplication.
 *
 * @param canvas  - A canvas produced by {@link buildCanvas}.
 * @param factory - The factory that was used to build `canvas`.
 */
export function createTestableEditor(
    canvas: CanvasView,
    factory: DiagramObjectViewFactory
): { editor: DiagramViewEditor, plugin: TestablePowerEditPlugin } {
    // Create a fresh file whose canvas starts empty.
    const file = new DiagramViewFile(factory);

    // Transfer every top-level child from the spec-built canvas into the
    // file's canvas. Group.addObject calls this.removeObject on itself (the
    // new parent), not on the child's existing parent, so we must explicitly
    // remove each object from the standalone canvas first.
    const topLevelObjects = [...canvas.objects];
    for (const obj of topLevelObjects) {
        canvas.removeObject(obj as DiagramObjectView);
        file.canvas.addObject(obj as DiagramObjectView);
    }
    // Recalculate the file canvas layout after bulk insertion.
    file.canvas.calculateLayout();

    const editor = new DiagramViewEditor(file);

    const settings = {
        factory,
        lineTemplate      : "dynamic_line",
        multiselectHotkey : "ctrl"
    };
    const plugin = new TestablePowerEditPlugin(editor, settings);

    return { editor, plugin };
}


///////////////////////////////////////////////////////////////////////////////
//  5. buildCanvas  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Recursively builds a {@link GroupView} from a {@link GroupSpec}.
 */
function buildGroupFromSpec(
    factory: DiagramObjectViewFactory,
    spec: GroupSpec
): GroupView {
    const template = spec.template ?? DEFAULT_GROUP_TEMPLATE;
    const group = factory.createNewDiagramObject(template, GroupView);
    group.face.setBounds(...spec.bounds);

    // Recurse: nested groups first, then blocks.
    for (const childGroupSpec of spec.groups ?? []) {
        const childGroup = buildGroupFromSpec(factory, childGroupSpec);
        group.addObject(childGroup);
    }
    for (const blockSpec of spec.blocks ?? []) {
        const block = buildBlockFromSpec(factory, blockSpec);
        group.addObject(block);
    }

    group.face.calculateLayout();
    return group;
}

/**
 * Creates a {@link BlockView} from a {@link BlockSpec} and positions it.
 */
function buildBlockFromSpec(
    factory: DiagramObjectViewFactory,
    spec: BlockSpec
): BlockView {
    const template = spec.template ?? DEFAULT_BLOCK_TEMPLATE;
    const block = factory.createNewDiagramObject(template, BlockView);
    block.moveTo(spec.x, spec.y);
    return block;
}

/**
 * Builds a {@link CanvasView} from a declarative {@link CanvasSpec}.
 *
 * Uses `makeEmptyCanvas` as the root and `factory.createNewDiagramObject`
 * to mint child objects, mirroring the patterns in `GroupFace.testing.ts`.
 *
 * @param factory - Factory produced by {@link createGroupTestingFactory}.
 * @param spec    - Declarative description of the canvas contents.
 * @returns A populated {@link CanvasView}.
 */
export function buildCanvas(
    factory: DiagramObjectViewFactory,
    spec: CanvasSpec
): CanvasView {
    const canvas = makeEmptyCanvas(factory);

    for (const groupSpec of spec.groups ?? []) {
        const group = buildGroupFromSpec(factory, groupSpec);
        canvas.addObject(group);
    }
    for (const blockSpec of spec.blocks ?? []) {
        const block = buildBlockFromSpec(factory, blockSpec);
        canvas.addObject(block);
    }

    canvas.calculateLayout();
    return canvas;
}


///////////////////////////////////////////////////////////////////////////////
//  6. driveDrag  /////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Simulates a complete drag cycle: `captureSubject → moveSubject* → releaseSubject`.
 *
 * A fresh command stream is opened on `editor` before `captureSubject` and
 * closed (committed to the undo stack) after `releaseSubject`, matching
 * exactly what the production `handleSelectStart / handleSelectEnd` pair does.
 *
 * The first element of `path` is the starting cursor position; `moveSubject`
 * is called once per subsequent element using the delta from the previous
 * point. If `path.length === 1`, capture and release run with no move steps.
 *
 * @param editor  - The editor whose command stream will be opened/closed.
 * @param factory - Factory that, given an executor, returns an {@link ObjectMover}.
 * @param path    - Ordered cursor positions as `[x, y]` pairs. Must be non-empty.
 * @param spy     - Optional spy; every command passed to the executor is appended
 *                  to `spy.commands` before being routed into the stream.
 * @throws If `path` is empty.
 */
export function driveDrag(
    editor: DiagramViewEditor,
    factory: MoverFactory,
    path: [number, number][],
    spy?: SpyExecutor
): void {
    if (path.length === 0) {
        throw new Error("driveDrag: path must have at least one point");
    }

    const streamId = Crypto.randomUUID();
    editor.beginCommandStream(streamId);

    const execute: CommandExecutor = (cmd: SynchronousEditorCommand) => {
        spy?.commands.push(cmd);
        editor.execute(cmd, streamId);
    };

    const mover = factory(execute);
    mover.captureSubject();

    // Drive moveSubject for each step after the starting position.
    let [prevX, prevY] = path[0];
    const track = new SubjectTrack();
    track.reset(prevX, prevY);

    for (let i = 1; i < path.length; i++) {
        const [x, y] = path[i];
        track.applyCursorDelta(x - prevX, y - prevY);
        mover.moveSubject(track);
        prevX = x;
        prevY = y;
    }

    mover.releaseSubject();

    if (mover.discardStream) {
        editor.discardCommandStream(streamId);
    } else {
        editor.endCommandStream(streamId);
    }
}


///////////////////////////////////////////////////////////////////////////////
//  7. spyCommandExecutor  ////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Returns a {@link SpyExecutor} that accumulates commands for later assertion.
 *
 * Pass the spy as the fourth argument to {@link driveDrag} to record every
 * command the mover emits into the stream. The spy itself is passive — it
 * records but does not execute; execution happens inside the driveDrag
 * executor closure.
 */
export function spyCommandExecutor(): SpyExecutor {
    const commands: SynchronousEditorCommand[] = [];
    return {
        commands,
        reset() { commands.length = 0; }
    };
}
