/**
 * @file PolyLineSpanMover.spec.ts
 *
 * 9325: Unit tests for PolyLineSpanMover — axis-locked delta, invariant
 * preservation, and single-undo collapsing across a multi-tick drag.
 *
 * Construction: PolyLineSpanMover is instantiated directly via
 * `new PolyLineSpanMover(plugin, execute, span)` — plugin dispatch (Step 3)
 * does not yet exist. driveDrag is used for the full capture→move→release
 * cycle so the command stream is correctly opened and committed.
 *
 * The fixture produces a 3-handle PolyLine with axis-aligned vertices:
 *   handles[0] = (100, 50)
 *   handles[1] = (200, 50)   ← shared y with handles[0] → span[0] is "H"
 *   handles[2] = (200, 150)  ← shared x with handles[1] → span[1] is "V"
 * spans[0] is H (horizontal).
 * spans[1] is V (vertical).
 */

import { describe, it, expect, beforeAll } from "vitest";

// @OpenChart/DiagramInterface is stubbed globally via PowerEditPlugin.testing.setup.ts

// Test infrastructure
import {
    createTestableEditor,
    driveDrag,
    spyCommandExecutor
} from "../PowerEditPlugin.testing";
import {
    createLinesTestingFactory,
    getDataFlowLineStyle
} from "../../../../DiagramView/DiagramObjectView/Faces/Lines/Lines.testing";

// View types
import { HandleView, LineView, PolyLine } from "@OpenChart/DiagramView";

// The mover under test
import { PolyLineSpanMover } from "./PolyLineSpanMover";

// Command types used in spy filtering
import { MoveObjectsBy } from "../../../Commands/View/MoveObjectsBy";
import { RestoreGroupBounds } from "../../../Commands/View/RestoreGroupBounds";

// Internal-state lens (local — do not export)
import type { GenericLineInternalState } from "../../../../DiagramView/DiagramObjectView/Faces/Lines/GenericLineInternalState";
import { PolyLineSpanView } from "../../../../DiagramView/DiagramObjectView/Faces/Lines/PolyLineSpanView";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";
import type { MoverBuilder } from "../PowerEditPlugin.testing";
import type { TestablePowerEditPlugin } from "../PowerEditPlugin.testing";
import type { DiagramViewEditor } from "../../../DiagramViewEditor";

/**
 * Extends `GenericLineInternalState` with the PolyLine-specific `spans` field.
 * Used only for casting to read face internals in assertions.
 */
type PolyLineInternalState = GenericLineInternalState & {
    spans: PolyLineSpanView[];
};


///////////////////////////////////////////////////////////////////////////////
//  Fixture helper  ////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Returns the standard 3-handle fixture used by all tests:
 *   handles[0] = (100,  50)
 *   handles[1] = (200,  50)  → span[0] axis "H"
 *   handles[2] = (200, 150)  → span[1] axis "V"
 *
 * The line is NOT added to the editor's canvas because doing so requires the
 * lines factory schema to declare a canvas template. Instead, `line.parent`
 * is null and `pinAncestorGroupBounds(null)` short-circuits without emitting
 * a RestoreGroupBounds command — exactly the simplest case the plan calls out.
 */
async function createFixture(factory: DiagramObjectViewFactory): Promise<{
    editor: DiagramViewEditor;
    plugin: TestablePowerEditPlugin;
    line: LineView;
    spans: PolyLineSpanView[];
}> {
    const { editor, plugin } = createTestableEditor(factory);

    const line = factory.createNewDiagramObject("data_flow", LineView);

    line.node1.moveTo(0, 0);
    line.node2.moveTo(400, 400);

    // Add two extra handles so the total count is 3.
    for (let i = 1; i < 3; i++) {
        const handle = factory.createNewDiagramObject("generic_handle", HandleView);
        line.addHandle(handle);
    }

    // Swap to PolyLine before positioning; once PolyLine is the active face
    // handle.moveTo cascades through PolyLine.calculateLayout which does not
    // drop handles (unlike DynamicLine.calculateLayout).
    line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));

    // Position the three handles at axis-aligned coordinates.
    (line.handles[0] as HandleView).moveTo(100, 50);
    (line.handles[1] as HandleView).moveTo(200, 50);
    (line.handles[2] as HandleView).moveTo(200, 150);

    // Final layout pass: guarantees spans are populated.
    line.calculateLayout();

    const face = line.face as unknown as PolyLineInternalState;
    return { editor, plugin, line, spans: face.spans };
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("PolyLineSpanMover", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createLinesTestingFactory();
    });


    // -------------------------------------------------------------------------
    // 1. H span: axis-locks dx to 0, translates both handles by the vertical delta
    // -------------------------------------------------------------------------

    it("H span: axis-locks dx to 0, translates both handles by the vertical delta", async () => {
        // spans[0] is "H": handles[0]→[1] share y=50.
        // A drag delta of (5, 3) must be collapsed to (0, 3) before being applied.
        // After the drag: handles[0] and handles[1] each shift by (0, 3).
        // handles[2] and both latches must be untouched.
        const { editor, plugin, line, spans } = await createFixture(factory);

        expect(spans[0].axis).toBe("H");

        const h0Before = [line.handles[0].x, line.handles[0].y];
        const h1Before = [line.handles[1].x, line.handles[1].y];
        const h2Before = [line.handles[2].x, line.handles[2].y];
        const node1Before = [line.node1.x, line.node1.y];
        const node2Before = [line.node2.x, line.node2.y];

        const span = spans[0];
        const spy = spyCommandExecutor();
        const builder: MoverBuilder = (execute) => new PolyLineSpanMover(plugin, execute, span);

        // Single-tick drag from (0, 0) to (5, 3): delta is (5, 3).
        driveDrag(editor, builder, [[0, 0], [5, 3]], spy);

        // handles[0] and [1] move only vertically: y += 3, x unchanged.
        expect(line.handles[0].x).toBe(h0Before[0]);
        expect(line.handles[0].y).toBe(h0Before[1] + 3);
        expect(line.handles[1].x).toBe(h1Before[0]);
        expect(line.handles[1].y).toBe(h1Before[1] + 3);

        // handles[2] and latches are untouched.
        expect([line.handles[2].x, line.handles[2].y]).toEqual(h2Before);
        expect([line.node1.x, line.node1.y]).toEqual(node1Before);
        expect([line.node2.x, line.node2.y]).toEqual(node2Before);

        // Exactly one MoveObjectsBy command (RestoreGroupBounds is not emitted
        // because line.parent is null → pinAncestorGroupBounds short-circuits).
        const moveCommands = spy.commands.filter(cmd => cmd instanceof MoveObjectsBy);
        const restoreCommands = spy.commands.filter(cmd => cmd instanceof RestoreGroupBounds);
        expect(restoreCommands).toHaveLength(0);
        expect(moveCommands).toHaveLength(1);

        // The axis-alternation invariant holds: recalculate and verify span count
        // and axes are the same as before the drag.
        line.calculateLayout();
        const faceAfter = line.face as unknown as PolyLineInternalState;
        expect(faceAfter.spans).toHaveLength(2);
        expect(faceAfter.spans[0].axis).toBe("H");
        expect(faceAfter.spans[1].axis).toBe("V");
    });


    // -------------------------------------------------------------------------
    // 2. V span: axis-locks dy to 0, translates both handles by the horizontal delta
    // -------------------------------------------------------------------------

    it("V span: axis-locks dy to 0, translates both handles by the horizontal delta", async () => {
        // spans[1] is "V": handles[1]→[2] share x=200.
        // A drag delta of (5, 3) must be collapsed to (5, 0) before being applied.
        // After the drag: handles[1] and handles[2] each shift by (5, 0).
        // handles[0] and both latches must be untouched.
        const { editor, plugin, line, spans } = await createFixture(factory);

        expect(spans[1].axis).toBe("V");

        const h0Before = [line.handles[0].x, line.handles[0].y];
        const h1Before = [line.handles[1].x, line.handles[1].y];
        const h2Before = [line.handles[2].x, line.handles[2].y];
        const node1Before = [line.node1.x, line.node1.y];
        const node2Before = [line.node2.x, line.node2.y];

        const span = spans[1];
        const spy = spyCommandExecutor();
        const builder: MoverBuilder = (execute) => new PolyLineSpanMover(plugin, execute, span);

        // Single-tick drag from (0, 0) to (5, 3): delta is (5, 3).
        driveDrag(editor, builder, [[0, 0], [5, 3]], spy);

        // handles[1] and [2] move only horizontally: x += 5, y unchanged.
        expect(line.handles[1].x).toBe(h1Before[0] + 5);
        expect(line.handles[1].y).toBe(h1Before[1]);
        expect(line.handles[2].x).toBe(h2Before[0] + 5);
        expect(line.handles[2].y).toBe(h2Before[1]);

        // handles[0] and latches are untouched.
        expect([line.handles[0].x, line.handles[0].y]).toEqual(h0Before);
        expect([line.node1.x, line.node1.y]).toEqual(node1Before);
        expect([line.node2.x, line.node2.y]).toEqual(node2Before);

        // Exactly one MoveObjectsBy command; no RestoreGroupBounds.
        const moveCommands = spy.commands.filter(cmd => cmd instanceof MoveObjectsBy);
        const restoreCommands = spy.commands.filter(cmd => cmd instanceof RestoreGroupBounds);
        expect(restoreCommands).toHaveLength(0);
        expect(moveCommands).toHaveLength(1);

        // The axis-alternation invariant holds after the drag.
        line.calculateLayout();
        const faceAfter = line.face as unknown as PolyLineInternalState;
        expect(faceAfter.spans).toHaveLength(2);
        expect(faceAfter.spans[0].axis).toBe("H");
        expect(faceAfter.spans[1].axis).toBe("V");
    });


    // -------------------------------------------------------------------------
    // 3. Single undo restores both flanking handles after a multi-tick drag
    // -------------------------------------------------------------------------

    it("single undo restores both flanking handles after a multi-tick drag", async () => {
        // Three-point path: start → mid → end, producing two move ticks.
        // After the drag, undo once and confirm both handles are at their
        // original positions. canUndo() must then be false — the drag was the
        // only command stream on the undo stack.
        const { editor, plugin, line, spans } = await createFixture(factory);

        const h0OrigX = line.handles[0].x;
        const h0OrigY = line.handles[0].y;
        const h1OrigX = line.handles[1].x;
        const h1OrigY = line.handles[1].y;

        const span = spans[0]; // "H" span
        const builder: MoverBuilder = (execute) => new PolyLineSpanMover(plugin, execute, span);

        // Multi-tick: start (0,0) → mid (0,5) → end (0,10).
        // Two move events fire; moveSubject locks dx=0 and applies dy each tick.
        driveDrag(editor, builder, [[0, 0], [0, 5], [0, 10]]);

        // After drag: handles[0] and [1] have moved by (0, 10) total.
        expect(line.handles[0].y).toBe(h0OrigY + 10);
        expect(line.handles[1].y).toBe(h1OrigY + 10);

        // Single undo: both handles must return to original positions.
        await editor.undo();

        expect(line.handles[0].x).toBe(h0OrigX);
        expect(line.handles[0].y).toBe(h0OrigY);
        expect(line.handles[1].x).toBe(h1OrigX);
        expect(line.handles[1].y).toBe(h1OrigY);

        // The drag was the only command stream; undo stack should now be empty.
        expect(editor.canUndo()).toBe(false);
    });

});
