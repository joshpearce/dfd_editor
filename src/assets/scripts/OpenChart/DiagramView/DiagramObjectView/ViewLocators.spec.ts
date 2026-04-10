/**
 * @file ViewLocators.spec.ts
 *
 * Unit tests for `findDeepestContainingGroup` and the private
 * `isDescendantOf` walker that backs its `exclude` parameter.
 *
 * Key contracts verified:
 *   - Returns the deepest (innermost) containing group for a nested tree.
 *   - Returns `null` when the point is outside every group.
 *   - `exclude` skips the excluded group itself.
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
 * @see {@link findDeepestContainingGroup}
 *
 * pattern: Functional Core
 */

import { beforeAll, describe, it, expect } from "vitest";
import { DiagramViewFile } from "@OpenChart/DiagramView";
import { findDeepestContainingGroup } from "./ViewLocators";
import {
    createGroupTestingFactory,
    makeGroupWithChildren
} from "./Faces/Bases/GroupFace.testing";
import type { DiagramObjectViewFactory, CanvasView } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Helpers  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a fresh empty canvas backed by a group-capable factory.
 * Each call returns a new, independent canvas so tests do not share state.
 */
function makeCanvas(factory: DiagramObjectViewFactory): CanvasView {
    return new DiagramViewFile(factory).canvas;
}


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
            const canvas = makeCanvas(factory);
            expect(findDeepestContainingGroup(canvas, 0, 0)).toBeNull();
        });

        it("returns null for any coordinate when the canvas has no groups", () => {
            const canvas = makeCanvas(factory);
            expect(findDeepestContainingGroup(canvas, 9999, 9999)).toBeNull();
        });

    });

    // -------------------------------------------------------------------------

    describe("deepest containing group", () => {

        it("returns the innermost group when a point is inside three nested groups", () => {
            const canvas = makeCanvas(factory);

            // Three-level nesting: canvas → outer → inner → innermost
            const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
            const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            const innermost = makeGroupWithChildren(factory, [], [150, 150, 250, 250]);

            canvas.addObject(outer);
            outer.addObject(inner);
            inner.addObject(innermost);

            // Pin bounds so auto-grow from addObject does not shift the hit regions.
            outer.face.setBounds(0, 0, 400, 400);
            inner.face.setBounds(100, 100, 300, 300);
            innermost.face.setBounds(150, 150, 250, 250);

            const result = findDeepestContainingGroup(canvas, 200, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(innermost.instance);
        });

        it("returns the single group when there is only one level of nesting", () => {
            const canvas = makeCanvas(factory);

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
            const canvas = makeCanvas(factory);

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
            const canvas = makeCanvas(factory);
            const group = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            canvas.addObject(group);
            group.face.setBounds(100, 100, 300, 300);

            const result = findDeepestContainingGroup(canvas, 100, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(group.instance);
        });

        it("hits the group when the point is exactly at xMax", () => {
            const canvas = makeCanvas(factory);
            const group = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            canvas.addObject(group);
            group.face.setBounds(100, 100, 300, 300);

            const result = findDeepestContainingGroup(canvas, 300, 200);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(group.instance);
        });

        it("misses the group when the point is just past xMax", () => {
            const canvas = makeCanvas(factory);
            const group = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            canvas.addObject(group);
            group.face.setBounds(100, 100, 300, 300);

            expect(findDeepestContainingGroup(canvas, 301, 200)).toBeNull();
        });

    });

    // -------------------------------------------------------------------------

    describe("exclude parameter — skips the excluded group itself", () => {

        it("skips the excluded inner group and returns the outer group (excluded group itself)", () => {
            const canvas = makeCanvas(factory);

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

    });

    // -------------------------------------------------------------------------

    describe("exclude parameter — skips descendants of the excluded group", () => {
        // This is the isDescendantOf walker case used by GroupMover's
        // self-exclusion.  Regressing this function would let a group be
        // reparented into one of its own descendants.

        it("returns null when the only top-level group is excluded (inner groups are its descendants)", () => {
            const canvas = makeCanvas(factory);

            const outer     = makeGroupWithChildren(factory, [], [0, 0, 400, 400]);
            const inner     = makeGroupWithChildren(factory, [], [100, 100, 300, 300]);
            const innermost = makeGroupWithChildren(factory, [], [150, 150, 250, 250]);

            canvas.addObject(outer);
            outer.addObject(inner);
            inner.addObject(innermost);

            outer.face.setBounds(0, 0, 400, 400);
            inner.face.setBounds(100, 100, 300, 300);
            innermost.face.setBounds(150, 150, 250, 250);

            // Exclude outer: inner and innermost are its descendants, so all
            // three are skipped.  The canvas has no other top-level groups.
            const result = findDeepestContainingGroup(canvas, 200, 200, outer);
            expect(result).toBeNull();
        });

        it("returns a sibling group that is not a descendant of the excluded group", () => {
            const canvas = makeCanvas(factory);

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
            // outer and inner are excluded; sibling is not a descendant of outer.
            const result = findDeepestContainingGroup(canvas, 600, 600, outer);
            expect(result).not.toBeNull();
            expect(result!.instance).toBe(sibling.instance);
        });

        it("does not skip a group that is a sibling of (not a descendant of) the excluded group", () => {
            const canvas = makeCanvas(factory);

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

    // -------------------------------------------------------------------------

    describe("sibling z-order — last added wins", () => {

        it("returns the last-added group when two overlapping sibling groups both contain the point", () => {
            // groupA and groupB overlap. groupB is added after groupA, so it
            // sits on top in draw order and is iterated first (reverse scan).
            const canvas = makeCanvas(factory);

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
            const canvas = makeCanvas(factory);

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
            const canvas = makeCanvas(factory);

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
