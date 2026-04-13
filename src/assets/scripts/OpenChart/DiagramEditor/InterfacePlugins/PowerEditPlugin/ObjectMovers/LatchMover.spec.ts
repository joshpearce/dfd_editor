/**
 * @file LatchMover.spec.ts
 *
 * TB-13: Unit tests for LatchMover.getBlocksAndAnchorsAt — the nested-group
 * walker that makes anchor hover-affordances discoverable from outside a trust
 * boundary (Phase D Step 5).
 *
 * The method is `protected` (relaxed from `private` in Phase D Step 5) so a
 * test-only subclass can expose it without modifying the logic itself.
 *
 * Querying an anchor: AnchorPoint.getObjectAt checks distance from
 * (anchor.boundingBox.x + markerOffset, …+markerOffset). In the test
 * environment the blocks have zero computed dimensions (font measurement
 * returns 0 in JSDOM), so all anchors are placed at the block's origin
 * (anchor.x === block.x, anchor.y === block.y). Querying at exactly
 * (anchor.x, anchor.y) satisfies both:
 *   - BlockFace.contains(x, y): true because xMin=x=xMax (point bbox)
 *   - AnchorPoint.getObjectAt: dx = 0 - markerOffset = -1, dy = -1,
 *     dx²+dy² = 2 < r² = 36 (radius=6). Hit confirmed.
 */

import { describe, it, expect, beforeAll } from "vitest";

// @OpenChart/DiagramInterface is stubbed globally in PowerEditPlugin.testing.setup.ts
// (registered as vitest setupFiles). No inline vi.mock() is required here.

// Scaffold imports
import { createGroupTestingFactory } from "../../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import { createTestableEditor, findById } from "../PowerEditPlugin.testing";

// View types
import { AnchorView, BlockView, GroupView } from "@OpenChart/DiagramView";
import type { CanvasView, DiagramObjectView } from "@OpenChart/DiagramView";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";

// Mover types
import { LatchMover } from "./LatchMover";
import type { CommandExecutor } from "../CommandExecutor";


///////////////////////////////////////////////////////////////////////////////
//  Test-only subclass  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Exposes `getBlocksAndAnchorsAt` (protected in Phase D Step 5) as a public
 * method for assertions, without touching the method's logic.
 */
class TestableLatchMover extends LatchMover {
    public exposeGetBlocksAndAnchorsAt(
        x: number,
        y: number,
        group: CanvasView | GroupView
    ): DiagramObjectView | undefined {
        return this.getBlocksAndAnchorsAt(x, y, group);
    }
}


///////////////////////////////////////////////////////////////////////////////
//  Helpers  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Returns a no-op command executor for use in TestableLatchMover construction.
 * LatchMover.getBlocksAndAnchorsAt does not call execute, so a no-op is safe.
 */
function noopExecute(): CommandExecutor {
    return () => { /* no-op */ };
}

/**
 * Returns the first AnchorView from `block.anchors`, or throws if none exist.
 */
function firstAnchor(block: BlockView): AnchorView {
    const anchor = [...block.anchors.values()][0];
    if (!anchor) {
        throw new Error("Block has no anchors — factory did not create any");
    }
    return anchor;
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("LatchMover.getBlocksAndAnchorsAt", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    // -------------------------------------------------------------------------
    // 1. Direct child of canvas
    // -------------------------------------------------------------------------

    it("finds an anchor on a block that is a direct child of the canvas", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            blocks: [{ id: "block", x: 100, y: 100 }]
        });

        const block = findById(canvas, "block") as BlockView;
        expect(block).toBeInstanceOf(BlockView);

        // Pick the first anchor. In the test environment blocks have zero
        // computed dimensions, so all anchors sit at the block's origin.
        // Querying at (anchor.x, anchor.y) satisfies BlockFace.contains
        // (point bbox) and AnchorPoint.getObjectAt (distance < radius).
        // Query at (anchor.x, anchor.y). All anchors in the test environment are
        // at the block's origin (zero block dimensions). Any anchor from the
        // block's anchors map suffices to get the hit coordinate.
        const anchor = firstAnchor(block);
        const hitX = anchor.x;
        const hitY = anchor.y;

        const mover = new TestableLatchMover(plugin, noopExecute(), []);
        const result = mover.exposeGetBlocksAndAnchorsAt(hitX, hitY, canvas);

        // The walker should return an AnchorView belonging to this block.
        // (findUnlinkedObjectAt returns the topmost hit, which may be any of
        // the block's anchors since they all coincide at the block's origin.)
        expect(result).toBeInstanceOf(AnchorView);
        expect((result as AnchorView).parent).toBe(block);
        // Tighter: the returned AnchorView must be one of block's own anchors.
        expect([...block.anchors.values()].includes(result as AnchorView)).toBe(true);
    });


    // -------------------------------------------------------------------------
    // 2. Block inside one group
    // -------------------------------------------------------------------------

    it("finds an anchor on a block nested inside one group", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "G",
                    bounds: [0, 0, 400, 400],
                    blocks: [{ id: "block", x: 100, y: 100 }]
                }
            ]
        });

        const block = findById(canvas, "block") as BlockView;
        expect(block).toBeInstanceOf(BlockView);

        // Query at (anchor.x, anchor.y): satisfies point-bbox contains check
        // and AnchorPoint hit-test (see class-level comment for geometry).
        const anchor = firstAnchor(block);
        const hitX = anchor.x;
        const hitY = anchor.y;

        const mover = new TestableLatchMover(plugin, noopExecute(), []);
        const result = mover.exposeGetBlocksAndAnchorsAt(hitX, hitY, canvas);

        // The walker must recurse into G and return an AnchorView from the block.
        expect(result).toBeInstanceOf(AnchorView);
        expect((result as AnchorView).parent).toBe(block);
        // Tighter: the returned AnchorView must be one of block's own anchors.
        expect([...block.anchors.values()].includes(result as AnchorView)).toBe(true);
    });


    // -------------------------------------------------------------------------
    // 3. Block inside nested groups (locks in the §2.3 recursion fix)
    // -------------------------------------------------------------------------

    it("finds an anchor on a block nested two groups deep (§2.3 recursion fix)", () => {
        // B0 contains B1 contains block.
        // Pre-fix the walker only searched canvas.blocks — it would miss this block.
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    groups: [
                        {
                            id: "B1",
                            bounds: [50, 50, 450, 450],
                            blocks: [{ id: "block", x: 200, y: 200 }]
                        }
                    ]
                }
            ]
        });

        const block = findById(canvas, "block") as BlockView;
        expect(block).toBeInstanceOf(BlockView);

        // Query at (anchor.x, anchor.y): satisfies point-bbox contains check
        // and AnchorPoint hit-test (see class-level comment for geometry).
        const anchor = firstAnchor(block);
        const hitX = anchor.x;
        const hitY = anchor.y;

        const mover = new TestableLatchMover(plugin, noopExecute(), []);
        const result = mover.exposeGetBlocksAndAnchorsAt(hitX, hitY, canvas);

        // Must find an AnchorView from the nested block through two levels of
        // group recursion. This locks in the §2.3 nested-group walker fix.
        expect(result).toBeInstanceOf(AnchorView);
        expect((result as AnchorView).parent).toBe(block);
        // Tighter: the returned AnchorView must be one of block's own anchors.
        expect([...block.anchors.values()].includes(result as AnchorView)).toBe(true);
    });


    // -------------------------------------------------------------------------
    // 4. Query outside all anchors returns undefined
    // -------------------------------------------------------------------------

    it("returns undefined when the query coordinate is not on any anchor or block", () => {
        // Same nested setup — block at (200, 200) inside B0 > B1.
        // Query at (-1000, -1000) which is far outside all objects.
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    groups: [
                        {
                            id: "B1",
                            bounds: [50, 50, 450, 450],
                            blocks: [{ id: "block", x: 200, y: 200 }]
                        }
                    ]
                }
            ]
        });

        const mover = new TestableLatchMover(plugin, noopExecute(), []);
        const result = mover.exposeGetBlocksAndAnchorsAt(-1000, -1000, canvas);

        expect(result).toBeUndefined();
    });

});
