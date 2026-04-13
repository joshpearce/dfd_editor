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

// Environment shims (vi.stubGlobal window; see file for rationale on vi.mock).
import "./PowerEditPlugin.testing.setup";

import { DiagramViewFile, BlockView, CanvasView, GroupView, LatchView, LineView } from "@OpenChart/DiagramView";
import { DiagramViewEditor } from "../../DiagramViewEditor";
import { PowerEditPlugin } from "./PowerEditPlugin";
import { SubjectTrack } from "@OpenChart/DiagramInterface";
import { BlockMover, GenericMover, GroupMover, LatchMover } from "./ObjectMovers";
import { makeEmptyCanvas } from "../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { ObjectMover } from "./ObjectMovers";
import type { CommandExecutor } from "./CommandExecutor";
import type { SynchronousEditorCommand } from "../../Commands";
import type { PowerEditPluginSettings } from "./PowerEditPluginSettings";


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

/** Describes a canvas-level line to create. */
export type LineSpec = {
    id?: string;
    template?: string;
    source: [number, number];
    target: [number, number];
};

/** Top-level canvas description for {@link buildCanvas} and {@link createTestableEditor}. */
export type CanvasSpec = {
    groups?: GroupSpec[];
    blocks?: BlockSpec[];
    lines?: LineSpec[];
};

/** Collects commands emitted during a {@link driveDrag} or direct execute. */
export type SpyExecutor = {
    commands: SynchronousEditorCommand[];
    /**
     * Clears `commands` so the spy can be reused across multiple
     * {@link driveDrag} calls without constructing a new object each time.
     *
     * @example
     * ```ts
     * const spy = spyCommandExecutor();
     * driveDrag(editor, factory, path1, spy);
     * expect(spy.commands).toHaveLength(1);
     * spy.reset();
     * driveDrag(editor, factory, path2, spy);
     * expect(spy.commands).toHaveLength(1); // fresh recording
     * ```
     */
    reset(): void;
};

/**
 * A function that receives a {@link CommandExecutor} and returns a mover.
 * Renamed from `MoverFactory` to `MoverBuilder` to avoid confusion with
 * object-creation factories.
 */
export type MoverBuilder = (execute: CommandExecutor) => ObjectMover;

/**
 * An ordered list of `[x, y]` cursor positions for {@link driveDrag}.
 * Must contain at least one point.
 */
export type CursorPath = [number, number][];


///////////////////////////////////////////////////////////////////////////////
//  2. Template constants  ////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


const DEFAULT_GROUP_TEMPLATE = "generic_group";
const DEFAULT_BLOCK_TEMPLATE = "generic_block";
const DEFAULT_LINE_TEMPLATE = "dynamic_line";


///////////////////////////////////////////////////////////////////////////////
//  3. Internal helpers  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Assigns `id` to the runtime `instance` field of `view` when `id` is defined.
 * The cast is necessary because `instance` is a read-only model property;
 * test fixtures must override it to give objects stable IDs for `findById`.
 */
function attachInstanceId(view: DiagramObjectView, id: string | undefined): void {
    if (id !== undefined) {
        (view as unknown as { instance: string }).instance = id;
    }
}


///////////////////////////////////////////////////////////////////////////////
//  4. TestablePowerEditPlugin  ///////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Test-only subclass that exposes the `protected smartHover` method under a
 * public name so specs can call it directly without triggering the full
 * pointer-event dispatch chain.
 *
 * Also provides {@link dispatchHandle} and {@link moverFactoryFor} that
 * replicate the `instanceof` dispatch from `handleSelectStart` (lines 253-264
 * of PowerEditPlugin.ts) so Steps 3-6 can exercise the production selection
 * logic without access to the private handler methods.
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

    /**
     * Constructs the appropriate {@link ObjectMover} for `obj` using the same
     * `instanceof` dispatch as `handleSelectStart` in production, without
     * opening a command stream. The caller provides `execute` (typically from
     * inside {@link driveDrag}) so stream ownership stays with the caller.
     *
     * Supported types: `BlockView`, `GroupView`, `LatchView`, `LineView`.
     * For `AnchorView` (which creates a line on click) only the latch-creation
     * path is NOT replicated here — use {@link driveDrag} with a real anchor
     * event for that scenario.
     *
     * @param execute - The command executor for this drag session.
     * @param obj     - The diagram object to dispatch on.
     * @param _event  - Optional mouse event stub (currently unused by handlers).
     * @returns The constructed {@link ObjectMover}.
     */
    public dispatchHandle(
        execute: CommandExecutor,
        obj: DiagramObjectView,
        _event?: MouseEvent
    ): ObjectMover {
        // Replicate handleSelectStart's instanceof chain (PowerEditPlugin.ts:253-264).
        if (obj instanceof BlockView) {
            return new BlockMover(this, execute, obj);
        } else if (obj instanceof GroupView) {
            return new GroupMover(this, execute, obj);
        } else if (obj instanceof LatchView) {
            // LatchMover requires an array of LatchView; provide a single-element
            // array for the simple case.
            return new LatchMover(this, execute, [obj]);
        } else if (obj instanceof LineView) {
            return new GenericMover(this, execute, [obj]);
        } else {
            return new GenericMover(this, execute, [obj]);
        }
    }

    /**
     * Returns a {@link MoverBuilder} that, when called with an executor,
     * dispatches `obj` to the correct mover via {@link dispatchHandle}.
     *
     * Designed for use with {@link driveDrag}:
     * ```ts
     * driveDrag(editor, plugin.moverFactoryFor(block), path);
     * ```
     *
     * @param obj    - The diagram object to dispatch on.
     * @param event  - Optional mouse event stub.
     */
    public moverFactoryFor(
        obj: DiagramObjectView,
        event?: MouseEvent
    ): MoverBuilder {
        return (execute) => this.dispatchHandle(execute, obj, event);
    }

}


///////////////////////////////////////////////////////////////////////////////
//  5. createTestableEditor  //////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a {@link DiagramViewEditor} paired with a {@link TestablePowerEditPlugin}
 * whose canvas is pre-populated according to `spec`.
 *
 * The canvas is built directly into `DiagramViewFile.canvas` so the spec
 * never needs to transfer objects between standalone canvases: `DiagramViewFile`
 * constructs its own empty canvas in the constructor; `createTestableEditor`
 * populates it via `buildCanvas`'s internal helpers before handing it off.
 *
 * @param factory - The factory to use for all object creation.
 * @param spec    - Optional declarative canvas description. When omitted the
 *                  canvas starts empty.
 * @returns `{ editor, plugin, canvas }` — `canvas` is `editor.file.canvas`.
 */
export function createTestableEditor(
    factory: DiagramObjectViewFactory,
    spec?: CanvasSpec
): { editor: DiagramViewEditor, plugin: TestablePowerEditPlugin, canvas: CanvasView } {
    const file = new DiagramViewFile(factory);

    // Populate the file's own canvas directly instead of transferring from a
    // separately-built standalone canvas.
    if (spec) {
        buildCanvasInto(factory, spec, file.canvas);
    }
    file.canvas.calculateLayout();

    const editor = new DiagramViewEditor(file);

    const settings = {
        factory,
        lineTemplate      : DEFAULT_LINE_TEMPLATE,
        multiselectHotkey : "ctrl"
    } satisfies PowerEditPluginSettings;
    const plugin = new TestablePowerEditPlugin(editor, settings);

    return { editor, plugin, canvas: file.canvas };
}


///////////////////////////////////////////////////////////////////////////////
//  6. buildCanvas  ///////////////////////////////////////////////////////////
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

    // Wire optional id onto the instance field so findById can locate it.
    attachInstanceId(group, spec.id);

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

    // Wire optional id onto the instance field so findById can locate it.
    attachInstanceId(block, spec.id);

    return block;
}

/**
 * Creates a canvas-level {@link LineView} from a {@link LineSpec} and positions
 * its source and target latches.
 */
function buildLineFromSpec(
    factory: DiagramObjectViewFactory,
    spec: LineSpec
): LineView {
    const template = spec.template ?? DEFAULT_LINE_TEMPLATE;
    const line = factory.createNewDiagramObject(template, LineView);
    line.source.moveTo(spec.source[0], spec.source[1]);
    line.target.moveTo(spec.target[0], spec.target[1]);
    // top-level canvas.calculateLayout() recurses into children; this call
    // ensures the line has valid geometry before being added to the canvas.
    line.calculateLayout();

    attachInstanceId(line, spec.id);

    return line;
}

/**
 * Populates an existing `target` canvas with the objects described in `spec`.
 * Used internally by {@link createTestableEditor} to build directly into a
 * `DiagramViewFile`'s canvas without a transfer step.
 */
function buildCanvasInto(
    factory: DiagramObjectViewFactory,
    spec: CanvasSpec,
    target: CanvasView
): void {
    for (const groupSpec of spec.groups ?? []) {
        const group = buildGroupFromSpec(factory, groupSpec);
        target.addObject(group);
    }
    for (const blockSpec of spec.blocks ?? []) {
        const block = buildBlockFromSpec(factory, blockSpec);
        target.addObject(block);
    }
    for (const lineSpec of spec.lines ?? []) {
        const line = buildLineFromSpec(factory, lineSpec);
        target.addObject(line);
    }
}

/**
 * Builds a standalone {@link CanvasView} from a declarative {@link CanvasSpec}.
 *
 * Most specs should prefer {@link createTestableEditor} which accepts a
 * `CanvasSpec` directly. Use `buildCanvas` when you need a canvas independent
 * of an editor (e.g. asserting canvas structure before wiring it to an editor).
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
    buildCanvasInto(factory, spec, canvas);
    canvas.calculateLayout();
    return canvas;
}


///////////////////////////////////////////////////////////////////////////////
//  7. findById  ///////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Traverses `root` (canvas or group) and returns the first
 * {@link DiagramObjectView} whose `instance` field equals `id`, or `undefined`
 * if no match is found.
 *
 * The `instance` field is set by {@link buildBlockFromSpec} and
 * {@link buildGroupFromSpec} when a spec includes an `id` field.
 */
export function findById(
    root: CanvasView | GroupView,
    id: string
): DiagramObjectView | undefined {
    for (const obj of root.objects) {
        const view = obj as DiagramObjectView;
        if (view.instance === id) { return view; }
        if (view instanceof GroupView) {
            const found = findById(view, id);
            if (found) { return found; }
        }
    }
    return undefined;
}


///////////////////////////////////////////////////////////////////////////////
//  8. driveDrag  /////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/** Monotonic counter used for deterministic stream IDs. */
let _streamCounter = 0;

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
 * @param editor   - The editor whose command stream will be opened/closed.
 * @param factory  - Builder that, given an executor, returns an {@link ObjectMover}.
 * @param path     - Ordered cursor positions. Must be non-empty.
 * @param spy      - Optional spy; every command passed to the executor is
 *                   appended to `spy.commands` before being routed to the stream.
 * @throws If `path` is empty.
 */
export function driveDrag(
    editor: DiagramViewEditor,
    factory: MoverBuilder,
    path: CursorPath,
    spy?: SpyExecutor
): void {
    if (path.length === 0) {
        throw new Error("driveDrag: path must have at least one point");
    }

    const streamId = `drive-drag-stream-${++_streamCounter}`;
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
//  9. spyCommandExecutor  ////////////////////////////////////////////////////
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
