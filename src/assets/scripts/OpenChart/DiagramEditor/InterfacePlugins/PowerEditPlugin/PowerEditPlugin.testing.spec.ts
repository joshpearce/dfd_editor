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
 *
 * Note: the globalThis.window shim lives in PowerEditPlugin.testing.setup.ts
 * and is applied automatically when PowerEditPlugin.testing.ts is imported.
 * The vi.mock() call below must remain in this file — vitest hoists vi.mock()
 * calls per spec file at compile time and cannot move them to shared modules.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

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
    createTestableEditor,
    driveDrag
} from "./PowerEditPlugin.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";
import type { DiagramViewEditor } from "../../DiagramViewEditor";
import type { TestablePowerEditPlugin } from "./PowerEditPlugin.testing";
import type { CursorPath } from "./PowerEditPlugin.testing";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function driveDragBlock(
    plugin: TestablePowerEditPlugin,
    editor: DiagramViewEditor,
    block: BlockView,
    path: CursorPath
): void {
    driveDrag(editor, (execute) => new BlockMover(plugin, execute, block), path);
}


describe("PowerEditPlugin testing scaffold", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });

    it("hoverAt returns a block at its position", () => {
        const { plugin, canvas } = createTestableEditor(
            factory,
            { blocks: [{ x: 0, y: 0 }] }
        );
        const block = canvas.blocks[0] as BlockView;

        // Hover at the block's registered position. BlockFace.getObjectAt
        // may return the block itself or an AnchorView child (if an anchor
        // sits exactly at that pixel). Either result confirms the scaffold
        // routes hit-testing to the right object in the tree.
        const hit = plugin.hoverAt(block.x, block.y);

        expect(hit).toBeDefined();
        expect(hit === block || hit?.parent === block).toBe(true);
        expect(
            hit instanceof BlockView || (hit?.parent instanceof BlockView)
        ).toBe(true);
    });

    it("driveDrag moves a block and grows undo stack by 1", () => {
        const { editor, plugin, canvas } = createTestableEditor(
            factory,
            { blocks: [{ x: 0, y: 0 }] }
        );
        const block = canvas.blocks[0] as BlockView;

        const startX = block.x;
        const startY = block.y;

        expect(editor.canUndo()).toBe(false);

        driveDragBlock(plugin, editor, block, [[startX, startY], [startX + 10, startY]]);

        expect(block.x).toBe(startX + 10);
        expect(block.y).toBe(startY);
        expect(editor.canUndo()).toBe(true);
    });

});
