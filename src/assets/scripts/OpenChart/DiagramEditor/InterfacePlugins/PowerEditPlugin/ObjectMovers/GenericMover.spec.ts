/**
 * @file GenericMover.spec.ts
 *
 * TB-13: Integration tests for GenericMover — multi-block reparent on release
 * (TB-5), the TB-7 guard that prevents double-reparenting descendants, per-
 * object independent targets, and no-reparent when the block stays in its
 * current parent (Phase D Step 6).
 *
 * Construction: GenericMover(plugin, execute, objects[]) is called directly via
 * a MoverBuilder lambda passed to driveDrag.  The scaffold's `createTestableEditor`
 * provides both the editor and plugin required by the constructor.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

// DiagramInterface accesses document and window at construction time.
// Stub the entire class so DiagramViewEditor can be instantiated without a
// real browser environment.
vi.mock("@OpenChart/DiagramInterface", async (importOriginal) => {
    const original = await importOriginal<typeof import("@OpenChart/DiagramInterface")>();
    class DiagramInterfaceStub {
        on() { return this; }
        off() { return this; }
        emit() { return this; }
        render() { /* no-op */ }
        registerPlugin() { /* no-op */ }
        deregisterPlugin() { /* no-op */ }
    }
    return { ...original, DiagramInterface: DiagramInterfaceStub };
});

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
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";

// Mover
import { GenericMover } from "./GenericMover";

// Command types for spy filtering
import { ReparentObject } from "../../../Commands/Model/ReparentObject";

import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CommandExecutor } from "../CommandExecutor";
import type { MoverBuilder } from "../PowerEditPlugin.testing";


///////////////////////////////////////////////////////////////////////////////
//  Helper  ///////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Returns a MoverBuilder that constructs a GenericMover over `objects`.
 * Allows driveDrag to exercise multi-object reparenting.
 */
function genericMoverFor(
    plugin: PowerEditPlugin,
    objects: DiagramObjectView[]
): MoverBuilder {
    return (execute: CommandExecutor) => new GenericMover(
        plugin,
        execute,
        objects
    );
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("GenericMover", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    // -------------------------------------------------------------------------
    // 1. Multi-block reparent on release (TB-5)
    // -------------------------------------------------------------------------

    it("reparents all selected blocks into the target group on release", () => {
        // Canvas: blocks A, B, C at (100,100), (150,100), (200,100).
        // Group G at [400,400,800,800] — center (600,600).
        // Drag selection by delta (+500, +500) so all blocks land inside G.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "G", bounds: [400, 400, 800, 800] }
            ],
            blocks: [
                { id: "A", x: 100, y: 100 },
                { id: "B", x: 150, y: 100 },
                { id: "C", x: 200, y: 100 }
            ]
        });

        const a = findById(canvas, "A") as BlockView;
        const b = findById(canvas, "B") as BlockView;
        const c = findById(canvas, "C") as BlockView;
        const g = findById(canvas, "G") as GroupView;
        expect(a).toBeInstanceOf(BlockView);
        expect(b).toBeInstanceOf(BlockView);
        expect(c).toBeInstanceOf(BlockView);
        expect(g).toBeInstanceOf(GroupView);
        expect(a.parent).toBeInstanceOf(CanvasView);
        expect(b.parent).toBeInstanceOf(CanvasView);
        expect(c.parent).toBeInstanceOf(CanvasView);

        // Drive a drag from the selection's anchor point to a position inside G.
        // The delta is chosen so all three block centers (100–200, 100) land
        // at (600–700, 600) — well inside G [400,400,800,800].
        driveDrag(
            editor,
            genericMoverFor(plugin, [a, b, c]),
            [[100, 100], [600, 600]]
        );

        // After release: all three blocks should be inside G.
        expect(a.parent).toBe(g);
        expect(b.parent).toBe(g);
        expect(c.parent).toBe(g);
    });


    // -------------------------------------------------------------------------
    // 2. Mixed selection: block + its containing group (TB-7 guard)
    // -------------------------------------------------------------------------

    it("does not independently reparent a block whose parent group is also selected", () => {
        // Canvas: group G at [0,0,200,200] containing block A at (50,50).
        // Target T: [500,500,800,800].
        // Select [G, A] — the TB-7 guard detects that A is a descendant of G
        // in the selection and skips independently reparenting A.
        //
        // Note on GenericMover bounds-restoration behavior: captureSubject
        // snapshots G's userBounds (because G is A's ancestor in the selection),
        // and releaseSubject restores them before the containment check. After
        // restoration, G's center is at its pre-drag position (100, 100), which
        // is NOT inside T — so G also stays at canvas level. The observable
        // invariant locked in here is: A is never independently reparented to T
        // even though its release position is inside T. This is the TB-7 guard.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "G",
                    bounds: [0, 0, 200, 200],
                    blocks: [{ id: "A", x: 50, y: 50 }]
                },
                { id: "T", bounds: [500, 500, 800, 800] }
            ]
        });

        const g = findById(canvas, "G") as GroupView;
        const a = findById(canvas, "A") as BlockView;
        const t = findById(canvas, "T") as GroupView;
        expect(g).toBeInstanceOf(GroupView);
        expect(a).toBeInstanceOf(BlockView);
        expect(t).toBeInstanceOf(GroupView);
        expect(a.parent).toBe(g);
        expect(g.parent).toBeInstanceOf(CanvasView);

        // Selection is [G, A] — ancestor before descendant.
        const spy = spyCommandExecutor();
        // Drag G center from (100,100) to inside T at (650,650).
        driveDrag(
            editor,
            genericMoverFor(plugin, [g, a]),
            [[100, 100], [650, 650]],
            spy
        );

        // A must NOT be independently reparented into T (TB-7 guard).
        // A rides along with G as G's structural child.
        expect(a.parent).toBe(g);

        // No reparent command for A should have fired (TB-7 guard).
        // G's reparent is also suppressed by the bounds-restoration behavior
        // described above; the key invariant is that A is not independently moved.
        const reparentsToT = spy.commands.filter(
            cmd => cmd instanceof ReparentObject && (cmd as ReparentObject).toGroup === t
        );
        expect(reparentsToT).toHaveLength(0);

        // Lock-in: G stays at canvas level and its bounds reflect the
        // groupSnapshots restore pass. releaseSubject calls setBounds([0,0,200,200])
        // then calculateLayout(), which expands to contain A (now at its dragged
        // position ~(600,600)). Without the restore pass, G's bounds would be
        // whatever auto-expanded value the drag left behind. The resulting value
        // [0,0,620,620] locks in that: (a) setBounds was called with pre-drag
        // values, and (b) calculateLayout correctly expanded to include A.
        expect(g.parent).toBeInstanceOf(CanvasView);
        expect(g.face.userBounds).toEqual([0, 0, 620, 620]);
    });


    // -------------------------------------------------------------------------
    // 3. Per-object independent targets
    // -------------------------------------------------------------------------

    it("reparents each block to its own target when two blocks land in different groups", () => {
        // A at (100,100) will end up in G1 [300,300,500,500].
        // B at (600,100) will end up in G2 [700,300,900,500].
        // The drag moves the selection as a whole — A moves right by +300, B
        // also moves right by +300 — but their release positions land in
        // different groups so they reparent independently.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "G1", bounds: [300, 300, 500, 500] },
                { id: "G2", bounds: [700, 300, 900, 500] }
            ],
            blocks: [
                { id: "A", x: 100, y: 100 },
                { id: "B", x: 600, y: 100 }
            ]
        });

        const a = findById(canvas, "A") as BlockView;
        const b = findById(canvas, "B") as BlockView;
        const g1 = findById(canvas, "G1") as GroupView;
        const g2 = findById(canvas, "G2") as GroupView;
        expect(a).toBeInstanceOf(BlockView);
        expect(b).toBeInstanceOf(BlockView);
        expect(g1).toBeInstanceOf(GroupView);
        expect(g2).toBeInstanceOf(GroupView);
        expect(a.parent).toBeInstanceOf(CanvasView);
        expect(b.parent).toBeInstanceOf(CanvasView);

        // Drag by delta (+300, +300).
        // A goes: (100,100) → (400,400) — inside G1 [300,300,500,500].
        // B goes: (600,100) → (900,400) — inside G2 [700,300,900,500].
        driveDrag(
            editor,
            genericMoverFor(plugin, [a, b]),
            [[100, 100], [400, 400]]
        );

        expect(a.parent).toBe(g1);
        expect(b.parent).toBe(g2);
    });


    // -------------------------------------------------------------------------
    // 4. No reparent when release stays in same parent
    // -------------------------------------------------------------------------

    it("emits no reparent command when the block ends inside its original parent", () => {
        // Block inside G; short drag that keeps it inside G.
        const { editor, plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "G",
                    bounds: [0, 0, 400, 400],
                    blocks: [{ id: "block", x: 100, y: 100 }]
                }
            ]
        });

        const block = findById(canvas, "block") as BlockView;
        const g = findById(canvas, "G") as GroupView;
        expect(block).toBeInstanceOf(BlockView);
        expect(block.parent).toBe(g);

        const spy = spyCommandExecutor();
        // Short drag: (100,100) → (110,100) — still inside G [0,0,400,400].
        driveDrag(
            editor,
            genericMoverFor(plugin, [block]),
            [[100, 100], [110, 100]],
            spy
        );

        // Block should still be inside G.
        expect(block.parent).toBe(g);

        // No reparent commands should have been emitted.
        const reparents = spy.commands.filter(cmd => cmd instanceof ReparentObject);
        expect(reparents).toHaveLength(0);
    });

});
