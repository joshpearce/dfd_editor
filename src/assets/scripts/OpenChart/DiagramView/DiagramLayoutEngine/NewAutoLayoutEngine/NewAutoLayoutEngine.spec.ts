// @vitest-environment jsdom

/**
 * @file NewAutoLayoutEngine.spec.ts
 *
 * Unit tests for `NewAutoLayoutEngine.run`.
 *
 * Key contracts verified:
 *
 * - The engine calls the injected `layoutSource` with the serialized D2 source
 *   and applies the returned SVG coordinates to each matching canvas node
 *   via `moveTo(x + halfW, y + halfH)` (TALA gives top-left; moveTo expects center).
 * - Nodes absent from the TALA SVG are left alone (no moveTo call).
 * - When `layoutSource` rejects, `run` rejects with the same error.
 * - An empty canvas (no objects) completes without calling `layoutSource`.
 * - I4 — parent-before-descendant invariant: the group's moveTo is called
 *   before its child's moveTo.
 *
 * SVG fixtures encode the TALA-assigned node id as base64 of the **qualified
 * D2 path** (e.g. `btoa("my-group.child-block")` for a nested block), which
 * is what `parseTalaSvg` returns and what `collectNodes` uses as the map key.
 *
 * pattern: Imperative Shell test — engine has side effects (moveTo calls),
 * so we stub the canvas nodes with moveTo spies.
 */

import { describe, it, expect, vi } from "vitest";
import { NewAutoLayoutEngine } from "./NewAutoLayoutEngine";
import type { LayoutSource } from "./NewAutoLayoutEngine";
import type { SerializableCanvas, SerializableBlock, SerializableGroup } from "./D2Bridge";
import type { DiagramObjectView } from "../../DiagramObjectView";


///////////////////////////////////////////////////////////////////////////////
//  SVG fixture helpers  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Builds a minimal TALA-style SVG that contains one node per entry in
 * `nodes`.  The `id` in each entry is the **qualified D2 path** that the
 * engine expects (e.g. `"my-group.child-block"` for a nested block).
 * `parseTalaSvg` uses `atob(class)` as the map key directly, so we encode
 * the qualified path as base64.
 */
function makeTalaSvg(nodes: Array<{ id: string, x: number, y: number }>): string {
    const groups = nodes.map(({ id, x, y }) => {
        const encoded = btoa(id);
        return `<g class="${encoded}"><g class="shape"><rect x="${x}" y="${y}" width="100" height="50"/></g></g>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg">${groups.join("")}</svg>`;
}


///////////////////////////////////////////////////////////////////////////////
//  Canvas stub helpers  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a minimal stub node with `id`, `moveTo` spy, and the face
 * properties that `serializeToD2` needs (width, height, isDefined, toString).
 */
function makeBlockStub(id: string, label = "", width = 100, height = 50): SerializableBlock & { moveTo: ReturnType<typeof vi.fn> } {
    return {
        id,
        properties: {
            isDefined: () => label.length > 0,
            toString:  () => label
        },
        face: { width, height },
        moveTo: vi.fn()
    };
}

type GroupStub = SerializableGroup & { moveTo: ReturnType<typeof vi.fn> };

/**
 * Creates a minimal group stub that satisfies `SerializableGroup` and
 * exposes a `moveTo` spy.
 */
function makeGroupStub(
    id: string,
    label = "",
    childBlocks: ReturnType<typeof makeBlockStub>[] = [],
    childGroups: GroupStub[] = []
): GroupStub {
    return {
        id,
        properties: {
            isDefined: () => label.length > 0,
            toString:  () => label
        },
        face: {
            boundingBox: { xMin: 0, yMin: 0, xMax: 200, yMax: 100 }
        },
        blocks: childBlocks,
        groups: childGroups,
        lines:  [],
        moveTo: vi.fn()
    };
}

/**
 * Wraps a canvas stub as the `objects[0]` argument that the engine receives.
 */
function makeObjects(canvas: SerializableCanvas): DiagramObjectView[] {
    return [canvas as unknown as DiagramObjectView];
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  ////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("NewAutoLayoutEngine", () => {

    describe("run — happy path: two top-level blocks", () => {

        it("calls layoutSource once with the serialized D2 source", async () => {
            const blockA = makeBlockStub("block-a", "A");
            const blockB = makeBlockStub("block-b", "B");
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            // Top-level nodes: qualified path == leaf id
            const svg = makeTalaSvg([
                { id: "block-a", x: 10, y: 20 },
                { id: "block-b", x: 200, y: 20 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            expect(layoutSource).toHaveBeenCalledOnce();
            const d2Source = (layoutSource as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(d2Source).toContain("block-a");
            expect(d2Source).toContain("block-b");
        });

        it("applies TALA top-left coordinates offset to center via moveTo", async () => {
            const blockA = makeBlockStub("block-a", "", 100, 50);
            const blockB = makeBlockStub("block-b", "", 80, 40);
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            // Top-level nodes: qualified path == leaf id
            const svg = makeTalaSvg([
                { id: "block-a", x: 42, y: 84 },
                { id: "block-b", x: 300, y: 150 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // TALA top-left + half-dimensions = center passed to moveTo
            expect(blockA.moveTo).toHaveBeenCalledWith(42 + 50, 84 + 25);   // +50, +25
            expect(blockB.moveTo).toHaveBeenCalledWith(300 + 40, 150 + 20); // +40, +20
        });

    });

    describe("run — group with nested block", () => {

        it("applies center-offset coordinates to the group and its nested block", async () => {
            const childBlock = makeBlockStub("child-block", "", 100, 50);
            const group      = makeGroupStub("my-group", "", [childBlock]);
            // group bounding box: xMin=0, yMin=0, xMax=200, yMax=100 → halfW=100, halfH=50
            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };

            // The SVG must encode qualified paths:
            //   - "my-group"              for the group itself
            //   - "my-group.child-block"  for the nested block
            const svg = makeTalaSvg([
                { id: "my-group",             x: 10, y: 20 },
                { id: "my-group.child-block", x: 30, y: 40 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            expect(group.moveTo).toHaveBeenCalledWith(10 + 100, 20 + 50);  // +halfW, +halfH
            expect(childBlock.moveTo).toHaveBeenCalledWith(30 + 50, 40 + 25);
        });

    });

    // I4 — parent-before-descendant ordering invariant
    describe("run — parent-before-descendant call order", () => {

        it("calls moveTo on the group before calling moveTo on its child block", async () => {
            const callOrder: string[] = [];

            const childBlock = makeBlockStub("child-block", "", 100, 50);
            const group      = makeGroupStub("my-group", "", [childBlock]);

            // Override the moveTo spies to also record call order.
            (group.moveTo as ReturnType<typeof vi.fn>).mockImplementation(() => {
                callOrder.push("group");
            });
            (childBlock.moveTo as ReturnType<typeof vi.fn>).mockImplementation(() => {
                callOrder.push("child");
            });

            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };
            const svg = makeTalaSvg([
                { id: "my-group",             x: 0, y: 0 },
                { id: "my-group.child-block", x: 10, y: 10 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // Group must be moved before its child.
            expect(callOrder).toEqual(["group", "child"]);
        });

    });

    describe("run — missing SVG node", () => {

        it("does not call moveTo for a node absent from the TALA SVG", async () => {
            const blockA = makeBlockStub("block-a");
            const blockB = makeBlockStub("block-b");   // will be absent from SVG
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            // Top-level nodes: qualified path == leaf id
            const svg = makeTalaSvg([{ id: "block-a", x: 10, y: 20 }]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            expect(blockA.moveTo).toHaveBeenCalledWith(10 + 50, 20 + 25);
            expect(blockB.moveTo).not.toHaveBeenCalled();
        });

    });

    describe("run — layoutSource rejection", () => {

        it("rejects with the same error when layoutSource rejects", async () => {
            const block  = makeBlockStub("block-a");
            const canvas: SerializableCanvas = { blocks: [block], groups: [], lines: [] };
            const boom   = new Error("layout backend unavailable");
            const layoutSource: LayoutSource = vi.fn().mockRejectedValue(boom);

            await expect(
                new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas))
            ).rejects.toThrow("layout backend unavailable");

            expect(block.moveTo).not.toHaveBeenCalled();
        });

    });

    describe("run — empty canvas", () => {

        it("returns without calling layoutSource when objects array is empty", async () => {
            const layoutSource: LayoutSource = vi.fn();

            await new NewAutoLayoutEngine(layoutSource).run([]);

            expect(layoutSource).not.toHaveBeenCalled();
        });

    });

});
