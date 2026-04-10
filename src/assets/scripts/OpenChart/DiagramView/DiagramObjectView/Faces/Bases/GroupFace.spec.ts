/**
 * @file GroupFace.spec.ts
 *
 * Unit tests for GroupFace public methods.
 *
 * COVERAGE NOTE: renderTo and renderDebugTo are canvas-rendering methods that
 * require a live CanvasRenderingContext2D.  They are intentionally excluded
 * here because this test suite runs in a pure Node environment with no jsdom
 * or browser globals.  Those paths are validated by the manual smoke-test
 * checklist in trust-boundary-phase-a.md.
 *
 * @see {@link GroupFace}
 */

import { beforeAll, describe, it, expect } from "vitest";
import { AnchorView, GroupView, ResizeEdge } from "@OpenChart/DiagramView";
import {
    DEFAULT_HW,
    DEFAULT_HH,
    CHILD_PADDING,
    RESIZE_HALO
} from "./GroupFace";
import {
    createGroupTestingFactory,
    makeGroupView,
    makeBlockView,
    makeGroupWithChildren
} from "./GroupFace.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Tests                                                                    ///
///////////////////////////////////////////////////////////////////////////////


describe("GroupFace", () => {

    let factory: DiagramObjectViewFactory;
    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });

    describe("calculateLayout", () => {

        it("returns default bounds when group has no children", () => {
            const group = makeGroupWithChildren(factory, []);

            const [xMin, yMin, xMax, yMax] = group.face.userBounds;
            expect(xMin).toBe(-DEFAULT_HW);
            expect(yMin).toBe(-DEFAULT_HH);
            expect(xMax).toBe(DEFAULT_HW);
            expect(yMax).toBe(DEFAULT_HH);

            const bb = group.face.boundingBox;
            expect(bb.xMin).toBe(-DEFAULT_HW);
            expect(bb.yMin).toBe(-DEFAULT_HH);
            expect(bb.xMax).toBe(DEFAULT_HW);
            expect(bb.yMax).toBe(DEFAULT_HH);
        });

        it("grows userBounds when a child overflows, and bounds are stable across repeated calls", () => {
            // Use a nested GroupView as the child so the child's bounding box is
            // fully deterministic (controlled via setBounds).
            //
            // Child bounds extend well past the group's default east edge (150).
            const childBounds: [number, number, number, number] = [100, 0, 300, 50];
            const child = makeGroupWithChildren(factory, [], childBounds);

            const group = makeGroupWithChildren(factory, [child]);

            // The group must grow its east and south edges to contain the child.
            const [xMin, yMin, xMax, yMax] = group.face.userBounds;

            // West/north should remain at the default (child is well inside on those sides)
            expect(xMin).toBe(-DEFAULT_HW);
            expect(yMin).toBe(-DEFAULT_HH);

            // East: childBounds xMax=300, so xMax >= 300 + CHILD_PADDING = 320
            expect(xMax).toBeGreaterThanOrEqual(childBounds[2] + CHILD_PADDING);

            // South: childBounds yMax=50, so yMax >= 50 + CHILD_PADDING = 70
            // Default yMax=100 > 70, so the group should NOT grow south
            expect(yMax).toBe(DEFAULT_HH);

            // Second call must produce identical userBounds (written-back stability)
            group.face.calculateLayout();
            expect(group.face.userBounds).toEqual([xMin, yMin, xMax, yMax]);
        });

    });

    describe("resizeBy", () => {

        it("W edge +20 shifts xMin forward by 20 (no clamping)", () => {
            const group = makeGroupWithChildren(factory, []);
            // Default xMin = -150.  Moving W by +20 means xMin → -130.
            // Ceiling = min(xMax - MIN_SIZE, Infinity) = min(150 - 60, ∞) = 90.
            // target = -150 + 20 = -130, which is < 90, so no clamping.
            const [appliedDx, appliedDy] = group.face.resizeBy(ResizeEdge.W, 20, 0);
            expect(appliedDx).toBe(20);
            expect(appliedDy).toBe(0);
            const [xMin] = group.face.userBounds;
            expect(xMin).toBe(-DEFAULT_HW + 20);
        });

        it("E edge -200 clamps at children floor + CHILD_PADDING (not MIN_SIZE floor)", () => {
            // Child bounding box: xMin=50, yMin=-30, xMax=100, yMax=30
            // xMaxFloor = 100 + CHILD_PADDING = 120
            // MIN_SIZE floor = xMin + MIN_SIZE = -150 + 60 = -90
            // Overall floor = max(-90, 120) = 120
            // target = 150 + (-200) = -50
            // clamped = max(-50, 120) = 120
            // appliedDx = 120 - 150 = -30
            const childBounds: [number, number, number, number] = [50, -30, 100, 30];
            const child = makeGroupWithChildren(factory, [], childBounds);
            const group = makeGroupWithChildren(factory, [child]);

            // After adding child, group has auto-grown to fit.  Reset to a
            // predictable starting state for the resize operation.
            group.face.setBounds(-DEFAULT_HW, -DEFAULT_HH, DEFAULT_HW, DEFAULT_HH);

            const [appliedDx, appliedDy] = group.face.resizeBy(ResizeEdge.E, -200, 0);
            expect(appliedDy).toBe(0);

            // The returned dx must reflect the child floor (not -200 and not 0)
            const expectedXMax = childBounds[2] + CHILD_PADDING; // 120
            expect(appliedDx).toBe(expectedXMax - DEFAULT_HW);   // 120 - 150 = -30

            const [, , xMax] = group.face.userBounds;
            expect(xMax).toBe(expectedXMax);
        });

        it("NW corner shifts both xMin and yMin without clamping", () => {
            const group = makeGroupWithChildren(factory, []);

            const [appliedDx, appliedDy] = group.face.resizeBy(ResizeEdge.NW, -30, -40);
            expect(appliedDx).toBe(-30);
            expect(appliedDy).toBe(-40);

            const [xMin, yMin] = group.face.userBounds;
            expect(xMin).toBe(-DEFAULT_HW - 30);
            expect(yMin).toBe(-DEFAULT_HH - 40);
        });

        it("N edge +big_dy clamps yMin at childYMin - CHILD_PADDING", () => {
            // Child bounding box: xMin=-30, yMin=-50, xMax=30, yMax=50
            // yMinCeiling = -50 - CHILD_PADDING = -70  (wait: yMinCeiling = childYMin - CHILD_PADDING)
            // Actually per GroupFace.resizeBy:
            //   yMinCeiling = childYMin - CHILD_PADDING = -50 - 20 = -70
            //   ceiling = min(yMax - MIN_SIZE, yMinCeiling) = min(100 - 60, -70) = min(40, -70) = -70
            //   target = -100 + 500 = 400
            //   clamped = min(400, -70) = -70
            //   appliedDy = -70 - (-100) = 30  (shrink north side by 30)
            const childBounds: [number, number, number, number] = [-30, -50, 30, 50];
            const child = makeGroupWithChildren(factory, [], childBounds);
            const group = makeGroupWithChildren(factory, [child]);

            // Reset to predictable starting state: default bounds
            group.face.setBounds(-DEFAULT_HW, -DEFAULT_HH, DEFAULT_HW, DEFAULT_HH);

            const bigDy = 500; // try to shrink the north edge way inward
            const [appliedDx, appliedDy] = group.face.resizeBy(ResizeEdge.N, 0, bigDy);
            expect(appliedDx).toBe(0);

            // The N clamp must stop at childYMin - CHILD_PADDING = -50 - 20 = -70
            const expectedYMin = childBounds[1] - CHILD_PADDING; // -70
            const [, yMin] = group.face.userBounds;
            expect(yMin).toBe(expectedYMin);
            // appliedDy = expectedYMin - (-DEFAULT_HH) = -70 - (-100) = 30
            expect(appliedDy).toBe(expectedYMin - (-DEFAULT_HH));
        });

    });

    describe("getResizeEdgeAt", () => {

        it("classifies all 8 edges, interior, and outside-halo correctly", () => {
            const group = makeGroupWithChildren(factory, []);

            // Default group: [-DEFAULT_HW, -DEFAULT_HH, DEFAULT_HW, DEFAULT_HH]
            // halo = RESIZE_HALO
            const face = group.face;

            // Interior — well inside the bounding box, no edge
            expect(face.getResizeEdgeAt(0, 0)).toBe(ResizeEdge.None);

            // Cardinal edges — just outside the box but within the halo
            // West: x = -DEFAULT_HW - RESIZE_HALO/2, y = 0
            expect(face.getResizeEdgeAt(-DEFAULT_HW - RESIZE_HALO / 2, 0)).toBe(ResizeEdge.W);
            // East: x = DEFAULT_HW + RESIZE_HALO/2, y = 0
            expect(face.getResizeEdgeAt(DEFAULT_HW + RESIZE_HALO / 2, 0)).toBe(ResizeEdge.E);
            // North: x = 0, y = -DEFAULT_HH - RESIZE_HALO/2
            expect(face.getResizeEdgeAt(0, -DEFAULT_HH - RESIZE_HALO / 2)).toBe(ResizeEdge.N);
            // South: x = 0, y = DEFAULT_HH + RESIZE_HALO/2
            expect(face.getResizeEdgeAt(0, DEFAULT_HH + RESIZE_HALO / 2)).toBe(ResizeEdge.S);

            // Corners — just outside both axes
            expect(face.getResizeEdgeAt(-DEFAULT_HW - RESIZE_HALO / 2, -DEFAULT_HH - RESIZE_HALO / 2)).toBe(ResizeEdge.NW);
            expect(face.getResizeEdgeAt(DEFAULT_HW + RESIZE_HALO / 2, -DEFAULT_HH - RESIZE_HALO / 2)).toBe(ResizeEdge.NE);
            expect(face.getResizeEdgeAt(-DEFAULT_HW - RESIZE_HALO / 2, DEFAULT_HH + RESIZE_HALO / 2)).toBe(ResizeEdge.SW);
            expect(face.getResizeEdgeAt(DEFAULT_HW + RESIZE_HALO / 2, DEFAULT_HH + RESIZE_HALO / 2)).toBe(ResizeEdge.SE);

            // Far outside the halo — must return None
            expect(face.getResizeEdgeAt(-DEFAULT_HW - RESIZE_HALO - 1, 0)).toBe(ResizeEdge.None);
        });

    });

    describe("moveBy", () => {

        it("shifts group bounds, boundingBox, and child positions together", () => {
            const child = makeBlockView(factory);
            child.moveTo(50, 50);
            const initialChildX = child.x;
            const initialChildY = child.y;

            const group = makeGroupWithChildren(factory, [child]);
            const [xMin0, yMin0, xMax0, yMax0] = group.face.userBounds;

            group.face.moveBy(30, 40);

            const [xMin1, yMin1, xMax1, yMax1] = group.face.userBounds;
            expect(xMin1).toBe(xMin0 + 30);
            expect(yMin1).toBe(yMin0 + 40);
            expect(xMax1).toBe(xMax0 + 30);
            expect(yMax1).toBe(yMax0 + 40);

            // Child must also have moved by the same delta
            expect(child.x).toBeCloseTo(initialChildX + 30, 5);
            expect(child.y).toBeCloseTo(initialChildY + 40, 5);

            // boundingBox must be synced with the shifted user bounds
            const bb = group.face.boundingBox;
            expect(bb.xMin).toBe(xMin1);
            expect(bb.yMin).toBe(yMin1);
            expect(bb.xMax).toBe(xMax1);
            expect(bb.yMax).toBe(yMax1);
            expect(bb.x).toBeCloseTo((xMin1 + xMax1) / 2, 5);
            expect(bb.y).toBeCloseTo((yMin1 + yMax1) / 2, 5);
        });

    });

    describe("clone", () => {

        it("copies all four bounds from the source (regression: restyle must not drop bounds)", () => {
            const group = makeGroupWithChildren(factory, []);

            // Resize so the bounds differ from the default
            group.face.resizeBy(ResizeEdge.E, 50, 0);
            group.face.resizeBy(ResizeEdge.S, 0, 30);
            const originalBounds = group.face.userBounds;

            const cloned = group.face.clone();
            expect(cloned.userBounds).toEqual(originalBounds);
        });

        it("clone is independent of the original (mutation does not bleed through)", () => {
            const group = makeGroupWithChildren(factory, []);
            group.face.resizeBy(ResizeEdge.E, 50, 0);
            const boundsBeforeMutation = group.face.userBounds;

            // Attach clone to a real GroupView so its view back-reference is live
            const cloneGroup = makeGroupView(factory);
            const clonedFace = group.face.clone();
            cloneGroup.replaceFace(clonedFace);

            // Mutate the original — clone must not change
            group.face.resizeBy(ResizeEdge.W, -100, 0);

            expect(clonedFace.userBounds).toEqual(boundsBeforeMutation);
        });

    });

    describe("userBounds getter", () => {

        it("returns a fresh tuple each call (mutating the result must not affect the group)", () => {
            const group = makeGroupWithChildren(factory, []);

            const bounds1 = group.face.userBounds;
            // Mutate the returned array directly.
            bounds1[0] = 9999;

            // The group's stored xMin must be unchanged
            const bounds2 = group.face.userBounds;
            expect(bounds2[0]).toBe(-DEFAULT_HW);
        });

    });

    describe("setBounds", () => {

        it("syncs boundingBox xMin/yMin/xMax/yMax/x/y immediately", () => {
            const group = makeGroupWithChildren(factory, []);

            group.face.setBounds(-300, -200, 300, 200);

            expect(group.face.userBounds).toEqual([-300, -200, 300, 200]);

            const bb = group.face.boundingBox;
            expect(bb.xMin).toBe(-300);
            expect(bb.yMin).toBe(-200);
            expect(bb.xMax).toBe(300);
            expect(bb.yMax).toBe(200);
            expect(bb.x).toBe(0);
            expect(bb.y).toBe(0);
        });

    });

    describe("getObjectAt", () => {

        it("returns an AnchorView belonging to the child block when the point hits the block's center", () => {
            // In this factory configuration, schema anchor keys ("up"/"left"/…) do not
            // match AnchorPosition enum keys ("0"/"90"/…), so calculateAnchorPositions
            // cannot spread the anchors: all four remain at the block's moveTo
            // coordinate.  BlockFace.getObjectAt tries anchors before returning the
            // block itself, so probing the block's center always yields an AnchorView.
            //
            // The important invariant under test: the returned object belongs to the
            // child block's subtree, not to a foreign object or the group itself.
            const child = makeBlockView(factory);
            child.moveTo(50, 50);
            const group = makeGroupWithChildren(factory, [child]);

            const hit = group.face.getObjectAt(child.x, child.y);
            // Must be an anchor (not undefined and not the group)
            expect(hit).toBeInstanceOf(AnchorView);
            // The anchor's parent must be the child block (not some other object)
            expect(hit?.parent).toBe(child);
        });

        it("returns the group itself when the point is inside the group but not inside any child", () => {
            // Child is positioned in one corner; query the opposite corner
            const child = makeBlockView(factory);
            child.moveTo(100, 80);
            const group = makeGroupWithChildren(factory, [child]);

            // Query a point far from the child (near the opposite corner)
            const hit = group.face.getObjectAt(-100, -80);
            expect(hit).toBeInstanceOf(GroupView);
        });

        it("returns undefined when the point is outside the group's bounding box", () => {
            const group = makeGroupWithChildren(factory, []);

            // Default bounds are [-DEFAULT_HW,-DEFAULT_HH,DEFAULT_HW,DEFAULT_HH]
            const hit = group.face.getObjectAt(500, 500);
            expect(hit).toBeUndefined();
        });

    });

});
