/**
 * @file GroupMover.spec.ts
 *
 * TB-13: Integration tests for GroupMover — reparent on drop, self-exclusion,
 * nested target, descendants-come-along, and undo collapsing (Phase D Step 4).
 *
 * All coordinates are multiples of 5 to satisfy the grid-snap setting
 * (canvas.grid=[5,5]) used by the test theme.
 */

import { describe, it, expect, beforeAll } from "vitest";

// @OpenChart/DiagramInterface is stubbed globally in PowerEditPlugin.testing.setup.ts
// (registered as vitest setupFiles). No inline vi.mock() is required here.

// Scaffold imports
import { createGroupTestingFactory } from "../../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import {
    createTestableEditor,
    driveDrag,
    findById,
    spyCommandExecutor
} from "../PowerEditPlugin.testing";

// View types
import { BlockView, CanvasView, GroupView } from "@OpenChart/DiagramView";

// Command types for spy filtering
import { AddObjectToGroup } from "../../../Commands/Model/AddObjectToGroup";
import { RemoveObjectFromGroup } from "../../../Commands/Model/RemoveObjectFromGroup";

import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


describe("GroupMover", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    // -------------------------------------------------------------------------
    // 1. Drop into another boundary
    // -------------------------------------------------------------------------

    it("drops into another boundary on release", () => {
        // G1: [0, 0, 200, 200] — center (100, 100)
        // G2: [400, 400, 800, 800] — center (600, 600)
        // Drag G1's cursor from (100, 100) to (600, 600) → delta (+500, +500).
        // G1's center moves to (600, 600), which lies inside G2.
        // releaseSubject finds G2 as the deepest containing group and reparents G1.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "g1", bounds: [0, 0, 200, 200] },
                { id: "g2", bounds: [400, 400, 800, 800] }
            ]
        });

        const g1 = findById(canvas, "g1") as GroupView;
        const g2 = findById(canvas, "g2") as GroupView;
        expect(g1).toBeInstanceOf(GroupView);
        expect(g2).toBeInstanceOf(GroupView);
        expect(g1.parent).toBeInstanceOf(CanvasView);

        driveDrag(editor, plugin.moverFactoryFor(g1), [[100, 100], [600, 600]]);

        expect(g1.parent).toBe(g2);
    });


    // -------------------------------------------------------------------------
    // 2. Self-exclusion
    // -------------------------------------------------------------------------

    it("does not reparent a group into its own descendant", () => {
        // G: [0, 0, 400, 400] contains G': [100, 100, 300, 300].
        // G starts at canvas level.
        // Drag G so its center lands at (200, 200) — inside G'.
        //
        // releaseSubject calls findDeepestContainingGroup(canvas, cx, cy, G).
        // G' is a descendant of G and is excluded by the walker.
        // No other group contains (200, 200), so target === canvas.
        // G.parent is already canvas → no reparent command fires.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "g",
                    bounds: [0, 0, 400, 400],
                    groups: [
                        { id: "gprime", bounds: [100, 100, 300, 300] }
                    ]
                }
            ]
        });

        const g = findById(canvas, "g") as GroupView;
        const gprime = findById(canvas, "gprime") as GroupView;
        expect(g).toBeInstanceOf(GroupView);
        expect(gprime).toBeInstanceOf(GroupView);
        expect(g.parent).toBeInstanceOf(CanvasView);

        // G center starts at (200, 200). Drag to keep it at (200, 200) —
        // a trivial zero-delta drag still triggers releaseSubject.
        const spy = spyCommandExecutor();
        driveDrag(editor, plugin.moverFactoryFor(g), [[200, 200], [200, 200]], spy);

        // G should remain at canvas level — no reparent into gprime.
        expect(g.parent).toBeInstanceOf(CanvasView);

        // No reparent commands should have been emitted.
        const reparentCmds = spy.commands.filter(
            cmd => cmd instanceof AddObjectToGroup || cmd instanceof RemoveObjectFromGroup
        );
        expect(reparentCmds).toHaveLength(0);
    });


    // -------------------------------------------------------------------------
    // 3. Drop into nested target
    // -------------------------------------------------------------------------

    it("drops into the deepest nested target group on release", () => {
        // B0: [0, 0, 500, 500] contains B1: [100, 100, 400, 400].
        // G: [600, 600, 700, 700] — center (650, 650).
        // Drag G center from (650, 650) to (200, 200) — inside B1.
        // releaseSubject finds B1 as the deepest non-self, non-descendant group.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    groups: [
                        { id: "B1", bounds: [100, 100, 400, 400] }
                    ]
                },
                { id: "g", bounds: [600, 600, 700, 700] }
            ]
        });

        const g = findById(canvas, "g") as GroupView;
        const b1 = findById(canvas, "B1") as GroupView;
        expect(g).toBeInstanceOf(GroupView);
        expect(b1).toBeInstanceOf(GroupView);

        driveDrag(editor, plugin.moverFactoryFor(g), [[650, 650], [200, 200]]);

        expect(g.parent).toBe(b1);
    });


    // -------------------------------------------------------------------------
    // 4. Descendants come along
    // -------------------------------------------------------------------------

    it("moves the group's children along without independently reparenting them", () => {
        // G: [0, 0, 100, 100] contains block A.
        // T: [400, 400, 700, 700] — target group.
        // Drag G into T. G.parent should be T and A.parent should still be G.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "g",
                    bounds: [0, 0, 100, 100],
                    blocks: [{ id: "a", x: 50, y: 50 }]
                },
                { id: "t", bounds: [400, 400, 700, 700] }
            ]
        });

        const g = findById(canvas, "g") as GroupView;
        const a = findById(canvas, "a") as BlockView;
        const t = findById(canvas, "t") as GroupView;
        expect(g).toBeInstanceOf(GroupView);
        expect(a).toBeInstanceOf(BlockView);
        expect(t).toBeInstanceOf(GroupView);
        // A starts inside G.
        expect(a.parent).toBe(g);

        // G center is at (50, 50). Drag to (550, 550) — inside T.
        driveDrag(editor, plugin.moverFactoryFor(g), [[50, 50], [550, 550]]);

        // G was reparented into T.
        expect(g.parent).toBe(t);
        // A was NOT independently reparented — it remains inside G.
        expect(a.parent).toBe(g);
    });


    // -------------------------------------------------------------------------
    // 5. Command stream is one undo step
    // -------------------------------------------------------------------------

    it("restores the group to its original parent in a single undo", async () => {
        // Same setup as case 1: G1 dropped into G2.
        // After driveDrag, editor.canUndo() === true.
        // A single undo should restore G1.parent to canvas.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "g1", bounds: [0, 0, 200, 200] },
                { id: "g2", bounds: [400, 400, 800, 800] }
            ]
        });

        const g1 = findById(canvas, "g1") as GroupView;
        expect(g1).toBeInstanceOf(GroupView);
        const originalParent = g1.parent;
        expect(originalParent).toBeInstanceOf(CanvasView);

        driveDrag(editor, plugin.moverFactoryFor(g1), [[100, 100], [600, 600]]);

        // After drag: G1 is inside G2.
        expect(g1.parent).not.toBe(originalParent);
        expect(editor.canUndo()).toBe(true);

        // One undo should restore G1 to canvas.
        await editor.undo();

        expect(g1.parent).toBeInstanceOf(CanvasView);
        // The entire drag was a single undo unit.
        expect(editor.canUndo()).toBe(false);
    });

});
