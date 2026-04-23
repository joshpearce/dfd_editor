/**
 * @file inferLineFaces.spec.ts
 *
 * Tests for `DiagramObjectViewFactory.inferLineFaces` — the post-processing
 * pass that reconciles line faces against handle counts after auto-layout
 * or file import.
 */

import { describe, it, expect } from "vitest";
import {
    DynamicLine,
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
    const factory = await createLinesTestingFactory();
    const line = factory.createNewDiagramObject("data_flow", LineView);
    // Factory hands back a line with one reference handle.  Add (n-1)
    // extras to reach the requested count.
    for (let i = 1; i < n; i++) {
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
    }
    if (n === 0) {
        line.dropHandles(0);
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
        // First grow to 2 handles + upgrade
        const { line, factory } = await buildLineWithHandleCount(2);
        factory.inferLineFaces([line]);
        expect(line.face).toBeInstanceOf(PolyLine);

        // Now drop back to 1 handle and re-infer
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

        // Same instance — no replacement happened on the second call.
        expect(line.face).toBe(polyFace);
    });

    it("traverses nested lines under a canvas root", async () => {
        // Build two independent multi-handle lines so we can verify the
        // pass walks the subtree, not just the supplied root.
        const { line: line1, factory } = await buildLineWithHandleCount(2);
        const line2 = factory.createNewDiagramObject("data_flow", LineView);
        line2.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));

        factory.inferLineFaces([line1, line2]);

        expect(line1.face).toBeInstanceOf(PolyLine);
        expect(line2.face).toBeInstanceOf(PolyLine);
    });

});
