/**
 * @file PowerEditPlugin.testing.spec.ts
 *
 * Smoke spec for the PowerEditPlugin test scaffold (Phase D Step 1b).
 * Verifies that `buildCanvas`, `createTestableEditor`, `hoverAt`, and
 * `driveDrag` all wire together correctly before deeper specs depend on them.
 *
 * Runs in the default `node` environment (same as all sibling specs).
 * `DiagramViewEditor` creates a `DiagramInterface` which accesses the DOM.
 * The interface module is mocked with a no-op stub so tests remain DOM-free.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

// Node env lacks `window`; AutosaveController and ScreenEventMonitor reference
// it at runtime. Provide a minimal shim before any test code runs.
if (typeof window === "undefined") {
    (globalThis as Record<string, unknown>).window = {
        setTimeout:  (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
        devicePixelRatio: 1,
        matchMedia: () => ({
            matches: false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        })
    };
}

// DiagramInterface accesses document (canvas element) and window (matchMedia)
// at construction time. Stub the entire class so DiagramViewEditor can be
// instantiated without a real browser environment.
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
    return {
        ...original,
        DiagramInterface: DiagramInterfaceStub
    };
});

import { BlockView } from "@OpenChart/DiagramView";
import { BlockMover } from "./ObjectMovers";
import { createGroupTestingFactory } from "../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import {
    buildCanvas,
    createTestableEditor,
    driveDrag
} from "./PowerEditPlugin.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";
import type { DiagramViewEditor } from "../../DiagramViewEditor";
import type { TestablePowerEditPlugin } from "./PowerEditPlugin.testing";


describe("PowerEditPlugin testing scaffold", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });

    it("hoverAt returns a block at its position", () => {
        const canvas = buildCanvas(factory, { blocks: [{ x: 0, y: 0 }] });
        const block = canvas.blocks[0] as BlockView;
        const { plugin } = createTestableEditor(canvas, factory);

        // Hover at the block's registered position. getObjectAt on a
        // DictionaryBlock face may return the block itself or an AnchorView
        // child; either result proves the scaffold routes to the right object.
        const hit = plugin.hoverAt(block.x, block.y);

        const hitBlock = hit === block || hit?.parent === block ? block : hit;
        expect(hitBlock).toBe(block);
    });

    it("driveDrag moves a block and grows undo stack by 1", () => {
        const canvas = buildCanvas(factory, { blocks: [{ x: 0, y: 0 }] });
        const block = canvas.blocks[0] as BlockView;
        const { editor, plugin } = createTestableEditor(canvas, factory);

        const startX = block.x;
        const startY = block.y;

        expect(editor.canUndo()).toBe(false);

        driveDragBlock(plugin, editor, block, [[startX, startY], [startX + 10, startY]]);

        expect(block.x).toBe(startX + 10);
        expect(block.y).toBe(startY);
        expect(editor.canUndo()).toBe(true);
    });

});


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function driveDragBlock(
    plugin: TestablePowerEditPlugin,
    editor: DiagramViewEditor,
    block: BlockView,
    path: [number, number][]
): void {
    driveDrag(editor, (execute) => new BlockMover(plugin, execute, block), path);
}
