/**
 * @file ViewLocators.spec.ts
 *
 * Unit tests for `findDeepestContainingGroup`, `findLowestCommonContainer`,
 * and `findUnlinkedObjectAt` / `findObjectAt`.
 *
 * Key contracts verified for findDeepestContainingGroup:
 *   - Returns the deepest (innermost) containing group for a nested tree.
 *   - Returns `null` when the point is outside every group.
 *   - `exclude` skips the excluded group itself (short-circuit: `g === exclude`).
 *   - `exclude` skips all descendants of the excluded group (`isDescendantOf`
 *     walker — critical self-exclusion contract used by GroupMover).
 *   - Last-added sibling wins when two overlapping groups both contain the
 *     point (draw-order / z-order).
 *
 * Additional boundary / edge-case coverage:
 *   - Empty canvas (no groups) returns `null`.
 *   - Exact-boundary point (inclusive edge) hits the group.
 *   - Mixed non-nested + nested tree — deepest group from last-added outer.
 *
 * Key contracts verified for findUnlinkedObjectAt (H1 regression):
 *   - Returns a `PolyLineSpanView` when the topmost hit is an interior span
 *     of a PolyLine (regression: previous code silently swallowed span hits
 *     with a `console.warn` + `continue`).
 *   - Returns a `DiagramObjectView` for non-line views (existing behavior).
 *
 * @see {@link findDeepestContainingGroup}
 *
 * pattern: Functional Core
 */

import { beforeAll, describe, it, expect } from "vitest";
import { findDeepestContainingGroup, findLowestCommonContainer, findUnlinkedObjectAt } from "./ViewLocators";
import {
    createGroupTestingFactory,
    makeEmptyCanvas,
    makeBlockView,
    makeGroupWithChildren
} from "./Faces/Bases/GroupFace.testing";
import {
    BlockView,
    HandleView,
    LineView,
    PolyLine,
    PolyLineSpanView
} from "@OpenChart/DiagramView";
import {
    createLinesTestingFactory,
    getDataFlowLineStyle
} from "./Faces/Lines/Lines.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("findDeepestContainingGroup", () => {

    let factory: DiagramObjectViewFactory;
    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });

    // -------------------------------------------------------------------------

    describe("empty canvas", () => {

        it("returns null when the canvas has no groups", () => {
            const canvas = makeEmptyCanvas(factory);
            expect(findDeepestContainingGroup(canvas, 0, 0)).toBeNull();
        });

        it("returns null for any coordinate when the canvas has no groups", () => {
            const canvas = makeEmptyCanvas(factory);
            expect(findDeepestContainingGroup(canvas, 9999, 9999)).toBeNull();
        });

    });

    // -------------------------------------------------------------------------

    describe("deepest containing group", () => {

        it("returns the innermost group when a point is inside three nested groups", () => {
            const canvas = makeEmptyCanvas(factory);

            // Three-level nesting: canvas → outer → inner → innermost
            const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
            const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            const innermost = makeGroupWithChildren(factory, [], [150, 150, 250, 250]);

            canvas.addObject(outer);
            outer.addObject(inner);
            inner.addObject(innermost);

            // Re-pin bounds after nesting. addObject doesn't currently re-run
            // calculateLayout on the parent, but future changes to Group's update
            // semantics could; pinning explicitly keeps the test deterministic.
            outer.face.setBounds(0, 0, 400, 400);
            inner.face.setBounds(100, 100, 300, 300);
            innermost.face.setBounds(150, 150, 250, 250);

            const result = findDeepestContainingGroup(canvas, 200, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(innermost.instance);
        });

        it("returns the single group when there is only one level of nesting", () => {
            const canvas = makeEmptyCanvas(factory);

            const group = makeGroupWithChildren(factory, [], [0, 0, 200, 200]);
            canvas.addObject(group);
            group.face.setBounds(0, 0, 200, 200);

            const result = findDeepestContainingGroup(canvas, 100, 100);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(group.instance);
        });

    });

    // -------------------------------------------------------------------------

    describe("point outside all groups", () => {

        it("returns null when the point is outside every group", () => {
            const canvas = makeEmptyCanvas(factory);

            const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
            const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            const innermost = makeGroupWithChildren(factory, [], [150, 150, 250, 250]);

            canvas.addObject(outer);
            outer.addObject(inner);
            inner.addObject(innermost);

            outer.face.setBounds(0, 0, 400, 400);
            inner.face.setBounds(100, 100, 300, 300);
            innermost.face.setBounds(150, 150, 250, 250);

            expect(findDeepestContainingGroup(canvas, 500, 500)).toBeNull();
        });

    });

    // -------------------------------------------------------------------------

    describe("exact-boundary point", () => {
        // BoundingBox.contains uses `xMin <= x && x <= xMax` (inclusive on both
        // edges).  These tests lock that behaviour through findDeepestContainingGroup
        // so a future change to contains() breaks a named test rather than
        // silently altering group-reparent logic.

        it("hits the group when the point is exactly at xMin", () => {
            const canvas = makeEmptyCanvas(factory);
            const group = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            canvas.addObject(group);
            group.face.setBounds(100, 100, 300, 300);

            const result = findDeepestContainingGroup(canvas, 100, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(group.instance);
        });

        it("hits the group when the point is exactly at xMax", () => {
            const canvas = makeEmptyCanvas(factory);
            const group = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            canvas.addObject(group);
            group.face.setBounds(100, 100, 300, 300);

            const result = findDeepestContainingGroup(canvas, 300, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(group.instance);
        });

        it("misses the group when the point is just past xMax", () => {
            const canvas = makeEmptyCanvas(factory);
            const group = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            canvas.addObject(group);
            group.face.setBounds(100, 100, 300, 300);

            expect(findDeepestContainingGroup(canvas, 301, 200)).toBeNull();
        });

    });

    // -------------------------------------------------------------------------

    describe("exclude parameter", () => {

        // ----- Short-circuit: g === exclude ----------------------------------
        // These tests exercise the `g === exclude` branch. The walker
        // (`isDescendantOf`) is NOT called here; the group is rejected before
        // the recursion ever descends into its subtree.

        describe("exclude short-circuit (g === exclude)", () => {

            it("skips the excluded inner group and returns the outer group", () => {
                const canvas = makeEmptyCanvas(factory);

                const outer = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
                const inner = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);

                canvas.addObject(outer);
                outer.addObject(inner);
                outer.face.setBounds(0, 0, 400, 400);
                inner.face.setBounds(100, 100, 300, 300);

                // Exclude inner: outer is not excluded nor is it a descendant of inner,
                // so the deepest group that still contains (200, 200) is outer.
                const result = findDeepestContainingGroup(canvas, 200, 200, inner);
                expect(result).not.toBeNull();
                expect(result!.instance).toBe(outer.instance);
            });

            it("returns null when the only top-level group is excluded (inner groups are its descendants)", () => {
                // `outer` is encountered first at the canvas level and is rejected via
                // `g === exclude`. Because outer is never recursed into, inner and
                // innermost are never visited. This is the short-circuit, not the
                // isDescendantOf walker.
                const canvas = makeEmptyCanvas(factory);

                const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
                const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
                const innermost = makeGroupWithChildren(factory, [], [150, 150, 250, 250]);

                canvas.addObject(outer);
                outer.addObject(inner);
                inner.addObject(innermost);

                outer.face.setBounds(0, 0, 400, 400);
                inner.face.setBounds(100, 100, 300, 300);
                innermost.face.setBounds(150, 150, 250, 250);

                // Exclude outer: the short-circuit fires at the canvas level.
                const result = findDeepestContainingGroup(canvas, 200, 200, outer);
                expect(result).toBeNull();
            });

            it("returns a sibling group that is not a descendant of the excluded group", () => {
                const canvas = makeEmptyCanvas(factory);

                // First top-level group with a nested child
                const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
                const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
                // Sibling group — not nested under outer
                const sibling   = makeGroupWithChildren(factory, [], [500, 500, 800, 800]);

                canvas.addObject(outer);
                outer.addObject(inner);
                canvas.addObject(sibling);

                outer.face.setBounds(0, 0, 400, 400);
                inner.face.setBounds(100, 100, 300, 300);
                sibling.face.setBounds(500, 500, 800, 800);

                // Query (600, 600) with outer excluded.
                // outer is rejected via g === exclude; sibling is not a descendant of
                // outer so it passes both the short-circuit and the walker.
                const result = findDeepestContainingGroup(canvas, 600, 600, outer);
                expect(result).not.toBeNull();
                expect(result!.instance).toBe(sibling.instance);
            });

            it("does not skip a group that is a sibling of (not a descendant of) the excluded group", () => {
                const canvas = makeEmptyCanvas(factory);

                const groupA = makeGroupWithChildren(factory, [], [0, 0, 200, 200]);
                const groupB = makeGroupWithChildren(factory, [], [300, 300, 500, 500]);

                canvas.addObject(groupA);
                canvas.addObject(groupB);

                groupA.face.setBounds(0, 0, 200, 200);
                groupB.face.setBounds(300, 300, 500, 500);

                // Exclude groupA — groupB is a sibling, not a descendant of groupA.
                const result = findDeepestContainingGroup(canvas, 400, 400, groupA);
                expect(result).not.toBeNull();
                expect(result!.instance).toBe(groupB.instance);
            });

        });

        // ----- Descendant walker: isDescendantOf returns true ----------------
        // This describe exercises the `isDescendantOf(g, exclude)` positive
        // branch. The test calls findDeepestContainingGroup with a non-canvas
        // root so the walker actually visits a group that is a descendant of
        // `exclude` (rather than being `exclude` itself).

        describe("exclude descendant walker (isDescendantOf)", () => {

            it("skips descendants of an excluded ancestor when called on a non-canvas root", () => {
                // Setup: canvas → outer → inner → innermost
                //
                // Call with root=inner (NOT canvas), exclude=outer (inner's parent).
                // The walker's positive branch fires here: `innermost` is not `outer`
                // itself but IS a descendant of `outer` via the parent chain, so it
                // must be skipped.
                //
                // Scratch-verification contract:
                //   - With `isDescendantOf` returning `false`: `innermost` is NOT
                //     skipped and is returned (test FAILS — regression detected).
                //   - With `isDescendantOf` correct: `innermost` is skipped and the
                //     call returns `null` (test PASSES).
                const canvas = makeEmptyCanvas(factory);

                const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
                const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
                const innermost = makeGroupWithChildren(factory, [], [150, 150, 250, 250]);

                canvas.addObject(outer);
                outer.addObject(inner);
                inner.addObject(innermost);

                // Re-pin bounds after nesting. addObject doesn't currently re-run
                // calculateLayout on the parent, but future changes to Group's update
                // semantics could; pinning explicitly keeps the test deterministic.
                outer.face.setBounds(0, 0, 400, 400);
                inner.face.setBounds(100, 100, 300, 300);
                innermost.face.setBounds(150, 150, 250, 250);

                // root=inner, exclude=outer: inner.groups = [innermost].
                // g=innermost, g === outer? no. isDescendantOf(innermost, outer)? YES
                // (outer is innermost's grandparent). → skip. No other siblings. → null.
                const hit = findDeepestContainingGroup(inner, 200, 200, outer);
                expect(hit).toBeNull();
            });

        });

    });

    // -------------------------------------------------------------------------

    describe("sibling z-order — last added wins", () => {

        it("returns the last-added group when two overlapping sibling groups both contain the point", () => {
            // groupA and groupB overlap. groupB is added after groupA, so it
            // sits on top in draw order and is iterated first (reverse scan).
            const canvas = makeEmptyCanvas(factory);

            const groupA = makeGroupWithChildren(factory, [], [0, 0, 200, 200]);
            const groupB = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);

            canvas.addObject(groupA);  // added first  → index 0
            canvas.addObject(groupB);  // added second → index 1 (iterated first in reverse)

            groupA.face.setBounds(0, 0, 200, 200);
            groupB.face.setBounds(100, 100, 300, 300);

            // (150, 150) is inside both.  Last-added (groupB) must win.
            const result = findDeepestContainingGroup(canvas, 150, 150);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(groupB.instance);
        });

        it("returns groupA when addition order is reversed (order drives the result, not identity)", () => {
            // Same geometry, opposite addition order — groupA must now win.
            const canvas = makeEmptyCanvas(factory);

            const groupA = makeGroupWithChildren(factory, [], [0, 0, 200, 200]);
            const groupB = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);

            canvas.addObject(groupB);  // added first  → index 0
            canvas.addObject(groupA);  // added second → index 1 (iterated first in reverse)

            groupA.face.setBounds(0, 0, 200, 200);
            groupB.face.setBounds(100, 100, 300, 300);

            const result = findDeepestContainingGroup(canvas, 150, 150);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(groupA.instance);
        });

    });

    // -------------------------------------------------------------------------

    describe("mixed non-nested + nested tree — sibling z-order propagates through nesting", () => {

        it("returns the deepest group from the last-added outer when two outer groups overlap", () => {
            // outerA contains innerA; outerB contains innerB.
            // outerA and outerB overlap at (200, 200).
            // outerB is added last, so it wins.  innerB is the deepest group
            // inside outerB that contains (200, 200).
            const canvas = makeEmptyCanvas(factory);

            const outerA = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
            const innerA = makeGroupWithChildren(factory, [], [50, 50, 350, 350]);
            const outerB = makeGroupWithChildren(factory, [], [100, 100, 500, 500]);
            const innerB = makeGroupWithChildren(factory, [], [150, 150, 450, 450]);

            canvas.addObject(outerA);   // index 0
            canvas.addObject(outerB);   // index 1 — last-added outer

            outerA.addObject(innerA);
            outerB.addObject(innerB);

            outerA.face.setBounds(0, 0, 400, 400);
            innerA.face.setBounds(50, 50, 350, 350);
            outerB.face.setBounds(100, 100, 500, 500);
            innerB.face.setBounds(150, 150, 450, 450);

            // (200, 200) is inside outerA, innerA, outerB, and innerB.
            // findDeepestContainingGroup iterates canvas.groups in reverse:
            // outerB is seen first, recurses into innerB (deepest in that branch).
            const result = findDeepestContainingGroup(canvas, 200, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(innerB.instance);
        });

    });

});


///////////////////////////////////////////////////////////////////////////////
//  findLowestCommonContainer  /////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("findLowestCommonContainer", () => {

    let factory: DiagramObjectViewFactory;
    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });

    // -------------------------------------------------------------------------

    it("returns the group when both views are children of the same group", () => {
        // canvas → G → { blockA, blockB }
        // LCC(blockA, blockB) must be G
        const canvas = makeEmptyCanvas(factory);
        const G = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
        canvas.addObject(G);
        G.face.setBounds(0, 0, 400, 400);

        const blockA = makeBlockView(factory);
        const blockB = makeBlockView(factory);
        G.addObject(blockA);
        G.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(G.instance);
    });

    // -------------------------------------------------------------------------

    it("returns the parent when both arguments are the same view", () => {
        // canvas → G → blockA
        // LCC(blockA, blockA) must be G (the parent), not blockA itself
        const canvas = makeEmptyCanvas(factory);
        const G = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
        canvas.addObject(G);
        G.face.setBounds(0, 0, 400, 400);

        const blockA = makeBlockView(factory);
        G.addObject(blockA);

        const result = findLowestCommonContainer(blockA, blockA);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(G.instance);
    });

    // -------------------------------------------------------------------------

    it("returns the canvas when one view is in a group and the other is a direct canvas child", () => {
        // canvas → { G → blockA, blockB }
        // LCC(blockA, blockB) must be canvas
        const canvas = makeEmptyCanvas(factory);
        const G = makeGroupWithChildren(factory, [], [0, 0, 200, 200]);
        canvas.addObject(G);
        G.face.setBounds(0, 0, 200, 200);

        const blockA = makeBlockView(factory);
        G.addObject(blockA);

        const blockB = makeBlockView(factory);
        canvas.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(canvas.instance);
    });

    // -------------------------------------------------------------------------

    it("returns the outer group when one view is in a nested group and the other is in the outer group", () => {
        // canvas → G0 → { G1 → blockA, blockB }
        // LCC(blockA, blockB) must be G0
        const canvas = makeEmptyCanvas(factory);
        const G0 = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
        const G1 = makeGroupWithChildren(factory, [], [50, 50, 200, 200]);
        canvas.addObject(G0);
        G0.addObject(G1);
        G0.face.setBounds(0, 0, 400, 400);
        G1.face.setBounds(50, 50, 200, 200);

        const blockA = makeBlockView(factory);
        G1.addObject(blockA);

        const blockB = makeBlockView(factory);
        G0.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(G0.instance);
    });

    // -------------------------------------------------------------------------

    it("returns the inner group when both views are in a nested group", () => {
        // canvas → G0 → G1 → { blockA, blockB }
        // LCC(blockA, blockB) must be G1, not G0 or canvas
        const canvas = makeEmptyCanvas(factory);
        const G0 = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
        const G1 = makeGroupWithChildren(factory, [], [50, 50, 300, 300]);
        canvas.addObject(G0);
        G0.addObject(G1);
        G0.face.setBounds(0, 0, 400, 400);
        G1.face.setBounds(50, 50, 300, 300);

        const blockA = makeBlockView(factory);
        const blockB = makeBlockView(factory);
        G1.addObject(blockA);
        G1.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(G1.instance);
    });

    // -------------------------------------------------------------------------

    it("returns the common parent when views are in sibling groups", () => {
        // canvas → G0 → { G1 → blockA, G2 → blockB }
        // LCC(blockA, blockB) must be G0
        const canvas = makeEmptyCanvas(factory);
        const G0 = makeGroupWithChildren(factory, [], [0, 0, 600, 400]);
        const G1 = makeGroupWithChildren(factory, [], [0, 0, 200, 400]);
        const G2 = makeGroupWithChildren(factory, [], [300, 0, 600, 400]);
        canvas.addObject(G0);
        G0.addObject(G1);
        G0.addObject(G2);
        G0.face.setBounds(0, 0, 600, 400);
        G1.face.setBounds(0, 0, 200, 400);
        G2.face.setBounds(300, 0, 600, 400);

        const blockA = makeBlockView(factory);
        G1.addObject(blockA);

        const blockB = makeBlockView(factory);
        G2.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(G0.instance);
    });

    // -------------------------------------------------------------------------

    it("returns the canvas when views are in separate top-level groups", () => {
        // canvas → { G1 → blockA, G2 → blockB }
        // LCC(blockA, blockB) must be canvas
        const canvas = makeEmptyCanvas(factory);
        const G1 = makeGroupWithChildren(factory, [], [0, 0, 200, 200]);
        const G2 = makeGroupWithChildren(factory, [], [300, 0, 500, 200]);
        canvas.addObject(G1);
        canvas.addObject(G2);
        G1.face.setBounds(0, 0, 200, 200);
        G2.face.setBounds(300, 0, 500, 200);

        const blockA = makeBlockView(factory);
        G1.addObject(blockA);

        const blockB = makeBlockView(factory);
        G2.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).not.toBeNull();
        expect(result!.instance).toBe(canvas.instance);
    });

    // -------------------------------------------------------------------------

    it("returns null when the two views share no ancestor", () => {
        // Two entirely separate trees (canvas1, canvas2).
        // blockA is in canvas1; blockB is in canvas2.
        // LCC must be null — no shared ancestor exists.
        const canvas1 = makeEmptyCanvas(factory);
        const canvas2 = makeEmptyCanvas(factory);

        const blockA = makeBlockView(factory);
        canvas1.addObject(blockA);

        const blockB = makeBlockView(factory);
        canvas2.addObject(blockB);

        const result = findLowestCommonContainer(blockA, blockB);
        expect(result).toBeNull();
    });

});


///////////////////////////////////////////////////////////////////////////////
//  findUnlinkedObjectAt — H1 regression (PolyLineSpanView pass-through)  ////
///////////////////////////////////////////////////////////////////////////////


/**
 * These tests verify the H1 regression fix: `findUnlinkedObjectAt` previously
 * swallowed `PolyLineSpanView` hits from `LineView.getObjectAt` with a
 * `console.warn` + `continue`.  After the fix the span flows through as-is so
 * callers that include `LineView` instances in their search array (e.g.
 * `CanvasFace.getObjectAt` and `GroupFace.getObjectAt` via `view.objects`) can
 * reach interior segment hits.
 */
describe("findUnlinkedObjectAt — PolyLineSpanView pass-through (H1 regression)", () => {

    /**
     * Builds a 3-handle PolyLine (H-V fixture) and links node1 to a block
     * anchor so `isAnchored()` returns true (required for the span-aware
     * branch of `PolyLine.getObjectAt`).
     *
     * handle layout:
     *   handles[0] = (100, 50)  — shared y with handles[1] → H span
     *   handles[1] = (200, 50)  — shared x with handles[2] → V span
     *   handles[2] = (200, 150)
     */
    async function createAnchoredPolyLine(): Promise<{
        line: LineView;
        spans: PolyLineSpanView[];
    }> {
        const factory = await createLinesTestingFactory();
        const line = factory.createNewDiagramObject("data_flow", LineView);
        line.node1.moveTo(0, 0);
        line.node2.moveTo(400, 400);

        for (let i = 1; i < 3; i++) {
            const h = factory.createNewDiagramObject("generic_handle", HandleView);
            line.addHandle(h);
        }

        line.replaceFace(new PolyLine(getDataFlowLineStyle(factory), factory.theme.grid));

        (line.handles[0] as HandleView).moveTo(100, 50);
        (line.handles[1] as HandleView).moveTo(200, 50);
        (line.handles[2] as HandleView).moveTo(200, 150);

        // Link node1 to a block anchor → activates the span-aware getObjectAt path.
        const block = factory.createNewDiagramObject("process", BlockView);
        block.moveTo(50, 50);
        const blockAnchor = block.anchors.values().next().value!;
        line.node1.link(blockAnchor);

        line.calculateLayout();

        const spans = (line.face as unknown as { spans: PolyLineSpanView[] }).spans;
        return { line, spans };
    }

    it("returns a PolyLineSpanView when the line array contains a PolyLine hit at an interior span", async () => {
        // This is the H1 regression: before the fix, findUnlinkedObjectAt
        // would silently swallow the PolyLineSpanView returned by
        // LineView.getObjectAt and return undefined instead.
        const { line, spans } = await createAnchoredPolyLine();

        // H span (hitboxes[1], h0→h1): midpoint (150, 50) is inside.
        const result = findUnlinkedObjectAt([line], 150, 50);

        expect(result).toBeInstanceOf(PolyLineSpanView);
        expect(result).toBe(spans[0]);
        expect((result as PolyLineSpanView).axis).toBe("H");
    });

    it("returns a PolyLineSpanView for the V span when the hit is in the vertical interior segment", async () => {
        const { line, spans } = await createAnchoredPolyLine();

        // V span (hitboxes[2], h1→h2): midpoint (200, 100) is inside.
        const result = findUnlinkedObjectAt([line], 200, 100);

        expect(result).toBeInstanceOf(PolyLineSpanView);
        expect(result).toBe(spans[1]);
        expect((result as PolyLineSpanView).axis).toBe("V");
    });

    it("returns a DiagramObjectView (the line view) when the hit is on an end segment", async () => {
        // End segments return this.view (the LineView), not a PolyLineSpanView.
        // findUnlinkedObjectAt must pass this through normally.
        const { line } = await createAnchoredPolyLine();

        // hitboxes[0]: end segment node1(0,0)→h0(100,50). Midpoint (50, 25).
        const result = findUnlinkedObjectAt([line], 50, 25);

        expect(result).toBe(line);
        expect(result instanceof PolyLineSpanView).toBe(false);
    });

    it("returns undefined when the point is outside all views", async () => {
        const { line } = await createAnchoredPolyLine();

        const result = findUnlinkedObjectAt([line], 9999, 9999);
        expect(result).toBeUndefined();
    });

});

