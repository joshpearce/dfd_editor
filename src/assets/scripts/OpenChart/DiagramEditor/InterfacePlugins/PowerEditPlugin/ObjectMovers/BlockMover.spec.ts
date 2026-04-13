/**
 * @file BlockMover.spec.ts
 *
 * TB-13: Integration tests for BlockMover — reparent on drop, mid-drag eject
 * chain, command output, and undo collapsing (Phase D Step 3).
 *
 * All coordinates are multiples of 10 so grid-snapping (canvas.grid=[5,5],
 * meaning snap increments of 5) does not alter expected positions.
 * Multiples of 10 are also multiples of 5, so no snap rounding occurs.
 */

import { describe, it, expect, beforeAll } from "vitest";

// @OpenChart/DiagramInterface is stubbed globally in PowerEditPlugin.testing.setup.ts
// (registered as vitest setupFiles). No inline vi.mock() is required here.

// Scaffold imports
import { createGroupTestingFactory } from "../../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import {
    createTestableEditor,
    driveDrag,
    driveDragStepwise,
    findById,
    spyCommandExecutor
} from "../PowerEditPlugin.testing";

// View types
import { BlockView, CanvasView, GroupView } from "@OpenChart/DiagramView";

// Editor / command types
import { ReparentObject } from "../../../Commands/Model/ReparentObject";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


describe("BlockMover", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    // -------------------------------------------------------------------------
    // 1. Drop into deepest nested boundary
    // -------------------------------------------------------------------------

    it("drops into the deepest nested boundary on release", () => {
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    groups: [
                        { id: "B1", bounds: [50, 50, 450, 450] }
                    ]
                }
            ],
            blocks: [
                { id: "drag", x: 600, y: 600 }
            ]
        });

        const block = findById(canvas, "drag") as BlockView;
        const b1 = findById(canvas, "B1") as GroupView;
        expect(block).toBeInstanceOf(BlockView);
        expect(b1).toBeInstanceOf(GroupView);

        // Drag from canvas (600,600) to inside B1 at (200,200).
        driveDrag(editor, plugin.moverFactoryFor(block), [[600, 600], [200, 200]]);

        expect(block.parent).toBe(b1);
    });


    // -------------------------------------------------------------------------
    // 2. Auto-expand-reparent lock-in: block dragged outside a group's user
    //    bounds ends up back inside that group because GroupFace.calculateLayout
    //    auto-expands the group's live bounds to contain the child's new
    //    position, and BlockMover.releaseSubject (BlockMover.ts:254) queries
    //    findDeepestContainingGroup against those *live* expanded bounds
    //    (GroupFace.ts:400-402). This test locks in that behavior so a future
    //    refactor that snapshots bounds at capture time will be caught here.
    // -------------------------------------------------------------------------

    it("releases back into a group whose bounds auto-expanded during the drag", () => {
        // Setup: block starts as a structural child of B0 at (200, 200).
        // B0's original user bounds are [0, 0, 500, 500].
        //
        // During the drag to (900, 900):
        //   1. captureSubject snapshots B0's bbox as [0, 0, 500, 500].
        //   2. moveSubject moves the block to (900, 900) while it is still a
        //      child of B0, so GroupFace.calculateLayout writes expanded bounds
        //      back to B0._userXMin/_userXMax (GroupFace.ts:400-402).
        //   3. The eject loop detects 900 > 500 (snapshot xMax) and reparents
        //      the block to canvas; currentGroup becomes null.
        //   4. releaseSubject calls findDeepestContainingGroup against the
        //      *live* bounds (BlockMover.ts:254). B0's live bbox now contains
        //      (900, 900), so the block is reparented back into B0.
        //
        // This locks in the release-time live-bounds lookup. If a future
        // refactor snapshots bounds at capture time and uses those for the
        // release query, the block would end up at canvas level instead — this
        // test would catch that regression.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    blocks: [{ id: "drag", x: 200, y: 200 }]
                }
            ]
        });

        const block = findById(canvas, "drag") as BlockView;
        const b0 = findById(canvas, "B0") as GroupView;
        expect(block).toBeInstanceOf(BlockView);
        expect(b0).toBeInstanceOf(GroupView);
        // Block starts structurally inside B0.
        expect(block.parent).toBe(b0);

        driveDrag(editor, plugin.moverFactoryFor(block), [[200, 200], [900, 900]]);

        // The group auto-expanded to contain (900, 900); release-side lookup
        // finds B0 as the deepest containing group and reparents back to it.
        expect(block.parent).toBe(b0);
    });


    // -------------------------------------------------------------------------
    // 3. During-drag eject chain: one level at a time
    // -------------------------------------------------------------------------

    it("ejects one level at a time as block leaves each containing group", () => {
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    groups: [
                        {
                            id: "B1",
                            bounds: [100, 100, 400, 400],
                            blocks: [{ id: "A", x: 200, y: 200 }]
                        }
                    ]
                }
            ]
        });

        const blockA = findById(canvas, "A") as BlockView;
        const b0 = findById(canvas, "B0") as GroupView;
        const b1 = findById(canvas, "B1") as GroupView;
        expect(blockA).toBeInstanceOf(BlockView);
        expect(b0).toBeInstanceOf(GroupView);
        expect(b1).toBeInstanceOf(GroupView);

        // Use driveDragStepwise to observe block.parent after each move tick.
        //
        // Tick 1: (200,200) → (300,300) — still inside B1 (100 ≤ 300 ≤ 400)
        // Tick 2: (300,300) → (80,80)   — outside B1, inside B0
        // Tick 3: (80,80)   → (900,900) — outside B0 entirely
        const parents = driveDragStepwise(
            editor,
            plugin.moverFactoryFor(blockA),
            [[200, 200], [300, 300], [80, 80], [900, 900]],
            () => blockA.parent
        );

        // Tick 1: block still in B1
        expect(parents[0]).toBe(b1);
        // Tick 2: ejected from B1 into B0 (one level at a time)
        expect(parents[1]).toBe(b0);
        // Tick 3: ejected from B0 to canvas
        expect(parents[2]).toBeInstanceOf(CanvasView);
    });


    // -------------------------------------------------------------------------
    // 4. Release-side reparent uses findDeepestContainingGroup (last-added wins)
    // -------------------------------------------------------------------------

    it("reparents to the last-added sibling when two groups overlap the drop point", () => {
        // G1 added first, G2 added second.
        // findDeepestContainingGroup iterates groups from last to first,
        // so G2 (last-added) wins when both contain the drop point.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "G1", bounds: [150, 150, 300, 300] },
                { id: "G2", bounds: [100, 100, 300, 300] }
            ],
            blocks: [
                { id: "drag", x: 600, y: 600 }
            ]
        });

        const block = findById(canvas, "drag") as BlockView;
        const g2 = findById(canvas, "G2") as GroupView;
        expect(block).toBeInstanceOf(BlockView);
        expect(g2).toBeInstanceOf(GroupView);

        // Drop at (200,200) — inside both G1 and G2.
        driveDrag(editor, plugin.moverFactoryFor(block), [[600, 600], [200, 200]]);

        expect(block.parent).toBe(g2);
    });


    // -------------------------------------------------------------------------
    // 5. Commands emitted inside stream
    // -------------------------------------------------------------------------

    it("emits a ReparentObject command when the block crosses a boundary", () => {
        // NOTE: BlockMover uses reparentObject (ReparentObject command), not
        // removeObjectFromGroup + addObjectToGroup. The plan spec text describes
        // the logical intent; the actual implementation chooses ReparentObject
        // to preserve external latch connections. See BlockMover.ts:143 and
        // BlockMover.ts:254 for the call sites.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "G", bounds: [300, 300, 500, 500] }
            ],
            blocks: [
                { id: "block", x: 100, y: 100 }
            ]
        });

        const block = findById(canvas, "block") as BlockView;
        expect(block).toBeInstanceOf(BlockView);
        // Confirm block starts at canvas level.
        expect(block.parent).toBeInstanceOf(CanvasView);

        const spy = spyCommandExecutor();
        driveDrag(editor, plugin.moverFactoryFor(block), [[100, 100], [400, 400]], spy);

        // Filter for reparent commands only (move and other housekeeping are emitted too).
        const reparents = spy.commands.filter(cmd => cmd instanceof ReparentObject);
        expect(reparents).toHaveLength(1);

        // GroupView extends Group, so toGroup (a Group model) === the GroupView instance.
        const g = findById(canvas, "G") as GroupView;
        const reparent = reparents[0] as ReparentObject;
        expect(reparent.toGroup).toBe(g);
        expect(block.parent).toBe(g);
    });


    // -------------------------------------------------------------------------
    // 6. Undo collapses to one step
    // -------------------------------------------------------------------------

    it("undo restores the block to its original parent in one step", async () => {
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "G", bounds: [300, 300, 500, 500] }
            ],
            blocks: [
                { id: "block", x: 100, y: 100 }
            ]
        });

        const block = findById(canvas, "block") as BlockView;
        expect(block).toBeInstanceOf(BlockView);
        const originalParent = block.parent;
        expect(originalParent).toBeInstanceOf(CanvasView);

        driveDrag(editor, plugin.moverFactoryFor(block), [[100, 100], [400, 400]]);

        // After drag: block is inside G, undo stack is non-empty.
        expect(block.parent).not.toBe(originalParent);
        expect(editor.canUndo()).toBe(true);

        // Single undo should restore the block to canvas.
        await editor.undo();

        expect(block.parent).toBeInstanceOf(CanvasView);
        // The entire drag was a single undo unit.
        expect(editor.canUndo()).toBe(false);
    });

});
