/**
 * @file inferLineFaces.spec.ts
 *
 * Tests for `DiagramObjectViewFactory.inferLineFaces` — the post-processing
 * pass that reconciles line faces against handle counts after auto-layout
 * or file import.
 */

import { describe, it, expect } from "vitest";
import {
    BlockView,
    CanvasView,
    DynamicLine,
    GroupView,
    HandleView,
    LineView,
    PolyLine
} from "@OpenChart/DiagramView";
import {
    createLinesTestingFactory
} from "../DiagramObjectView/Faces/Lines/Lines.testing";

async function buildLineWithHandleCount(n: number): Promise<{
    line: LineView;
    factory: Awaited<ReturnType<typeof createLinesTestingFactory>>;
}> {
    if (n < 1) {
        throw new Error("buildLineWithHandleCount requires n >= 1 (a line always has a reference handle).");
    }
    const factory = await createLinesTestingFactory();
    const line = factory.createNewDiagramObject("data_flow", LineView);
    for (let i = 1; i < n; i++) {
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
    }
    return { line, factory };
}

describe("DiagramObjectViewFactory.inferLineFaces", () => {

    it("upgrades DynamicLine → PolyLine when a line has 2+ handles", async () => {
        const { line, factory } = await buildLineWithHandleCount(2);
        expect(line.face).toBeInstanceOf(DynamicLine);

        factory.inferLineFaces([line]);

        expect(line.face).toBeInstanceOf(PolyLine);
    });

    it("leaves DynamicLine alone when a line has 1 handle", async () => {
        const { line, factory } = await buildLineWithHandleCount(1);
        expect(line.face).toBeInstanceOf(DynamicLine);
        const originalFace = line.face;

        factory.inferLineFaces([line]);

        expect(line.face).toBe(originalFace);
        expect(line.face).toBeInstanceOf(DynamicLine);
    });

    it("downgrades PolyLine → DynamicLine when handle count falls below 2", async () => {
        const { line, factory } = await buildLineWithHandleCount(2);
        factory.inferLineFaces([line]);
        expect(line.face).toBeInstanceOf(PolyLine);

        line.dropHandles(1);
        factory.inferLineFaces([line]);

        expect(line.face).toBeInstanceOf(DynamicLine);
    });

    it("is idempotent — a second call after the first is a no-op", async () => {
        const { line, factory } = await buildLineWithHandleCount(3);
        factory.inferLineFaces([line]);
        const polyFace = line.face;
        expect(polyFace).toBeInstanceOf(PolyLine);

        factory.inferLineFaces([line]);

        expect(line.face).toBe(polyFace);
    });

    it("restyleDiagramObject keeps a PolyLine as a PolyLine even when the design declares DynamicLine", async () => {
        // Critical contract for applyTheme / clone: a multi-handle line
        // upgraded to PolyLine at runtime must NOT be silently demoted
        // back to DynamicLine when the schema's design says DynamicLine.
        // Demotion would trigger view.dropHandles(1) on the next layout
        // tick and erase the user's bends.
        const { line, factory } = await buildLineWithHandleCount(2);
        factory.inferLineFaces([line]);
        expect(line.face).toBeInstanceOf(PolyLine);

        // Apply restyle directly — same path applyTheme uses.
        factory.restyleDiagramObject([line]);

        expect(line.face).toBeInstanceOf(PolyLine);
        expect(line.handles.length).toBe(2);
    });

    it("restyleDiagramObject builds a DynamicLine for single-handle lines", async () => {
        // Inverse contract: a single-handle line restyles to DynamicLine
        // even though FaceType.DynamicLine and FaceType.PolyLine share
        // the same case branch.  Confirms the inferred face is selected
        // by handle count, not by the order the cases appear.
        const { line, factory } = await buildLineWithHandleCount(1);

        factory.restyleDiagramObject([line]);

        expect(line.face).toBeInstanceOf(DynamicLine);
    });

    it("preserves linked-latch positions across a theme swap", async () => {
        // Regression: before this test, `restyleDiagramObject` replaced
        // every face with a fresh instance whose boundingBox started at
        // (0, 0) and relied on `if (face.userSetPosition) object.moveTo(x, y)`
        // to restore position.  Linked latches have userSetPosition=False
        // (set by `Latch.link`), so nothing reseeded the new face's bb
        // — every line endpoint collapsed to the top-left corner of the
        // canvas on a theme swap.
        //
        // Scenario: two blocks + a one-handle line, both latches attached
        // to block anchors, then restyle.  Assertion: both latches stay
        // at the anchor positions the block layout places them at, not (0, 0).
        const factory = await createLinesTestingFactory();
        const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);

        const blockA = factory.createNewDiagramObject("process", BlockView);
        const blockB = factory.createNewDiagramObject("process", BlockView);
        const groupA = factory.createNewDiagramObject("trust_boundary", GroupView);
        const groupB = factory.createNewDiagramObject("trust_boundary", GroupView);
        canvas.addObject(groupA);
        canvas.addObject(groupB);
        groupA.addObject(blockA);
        groupB.addObject(blockB);

        const line = factory.createNewDiagramObject("data_flow", LineView);
        canvas.addObject(line);
        const anchorA = blockA.anchors.values().next().value!;
        const anchorB = blockB.anchors.values().next().value!;
        line.node1.link(anchorA);
        line.node2.link(anchorB);
        // Move blocks AFTER linking so the anchor→latch cascade syncs the
        // latch positions to the anchors.  Linking alone does not copy
        // position; it only establishes the reference for future moveBy
        // cascades.
        canvas.calculateLayout();
        blockA.moveTo(100, 100);
        blockB.moveTo(500, 300);

        const node1PosBefore = { x: line.node1.x, y: line.node1.y };
        const node2PosBefore = { x: line.node2.x, y: line.node2.y };

        // Sanity: latches landed somewhere meaningful (away from the origin
        // where a face reset would dump them).
        expect(Math.abs(node1PosBefore.x) + Math.abs(node1PosBefore.y))
            .toBeGreaterThan(50);
        expect(Math.abs(node2PosBefore.x) + Math.abs(node2PosBefore.y))
            .toBeGreaterThan(50);

        // Apply restyle — same path SetTheme uses.
        factory.restyleDiagramObject([canvas]);

        // Latch positions must be preserved across the face swap.  If the
        // regression returns, both latches collapse to (0, 0).
        expect(line.node1.x).toBe(node1PosBefore.x);
        expect(line.node1.y).toBe(node1PosBefore.y);
        expect(line.node2.x).toBe(node2PosBefore.x);
        expect(line.node2.y).toBe(node2PosBefore.y);
    });

    it("traverses lines nested under a group inside a canvas root", async () => {
        // Build a real canvas → group → line subtree so the test
        // exercises the postfix-traversal path that runLayout uses
        // via [this.canvas].  A flat siblings-of-roots test would not
        // catch a bug where the traversal stops at the root level.
        const factory = await createLinesTestingFactory();
        const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);

        // Create a group from any template whose face is FaceType.Group.
        // The shared theme registers `trust_boundary` as a Group; use it
        // (or any equivalent) since the inferLineFaces pass is concerned
        // only with traversal and Line membership, not the group's style.
        const group = factory.createNewDiagramObject("trust_boundary", GroupView);
        canvas.addObject(group);

        // Build the multi-handle line and put it inside the group.
        const line = factory.createNewDiagramObject("data_flow", LineView);
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        group.addObject(line);

        expect(line.face).toBeInstanceOf(DynamicLine);

        factory.inferLineFaces([canvas]);

        expect(line.face).toBeInstanceOf(PolyLine);
    });

});
