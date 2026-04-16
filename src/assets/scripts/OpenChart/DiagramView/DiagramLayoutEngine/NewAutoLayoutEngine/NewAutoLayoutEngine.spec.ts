// @vitest-environment jsdom

/**
 * @file NewAutoLayoutEngine.spec.ts
 *
 * Unit tests for `NewAutoLayoutEngine.run`.
 *
 * Key contracts verified:
 *
 * - The engine calls the injected `fetchSvg` with the serialized D2 source
 *   and applies the returned SVG coordinates to each matching canvas node
 *   via `moveTo(x, y)`.
 * - Nodes absent from the TALA SVG are left alone (no moveTo call).
 * - When `fetchSvg` rejects, `run` rejects with the same error.
 * - An empty canvas (no objects) completes without calling `fetchSvg`.
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
 * `nodes`.  Each node id is base64-encoded as the class of an outer <g>,
 * with a nested <g class="shape"><rect x="..." y="..."/></g>.
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
    const face = Object.create({ constructor: { name: "DictionaryBlock" } }) as {
        constructor: { name: string };
        width: number;
        height: number;
    };
    face.width  = width;
    face.height = height;

    return {
        id,
        properties: {
            isDefined: () => label.length > 0,
            toString:  () => label
        },
        face,
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

        it("calls fetchSvg once with the serialized D2 source", async () => {
            const blockA = makeBlockStub("block-a", "A");
            const blockB = makeBlockStub("block-b", "B");
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            const svg = makeTalaSvg([
                { id: "block-a", x: 10, y: 20 },
                { id: "block-b", x: 200, y: 20 }
            ]);
            const fetchSvg: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(fetchSvg).run(makeObjects(canvas));

            expect(fetchSvg).toHaveBeenCalledOnce();
            const d2Source = (fetchSvg as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(d2Source).toContain("block-a");
            expect(d2Source).toContain("block-b");
        });

        it("applies TALA coordinates to each block via moveTo", async () => {
            const blockA = makeBlockStub("block-a");
            const blockB = makeBlockStub("block-b");
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            const svg = makeTalaSvg([
                { id: "block-a", x: 42, y: 84 },
                { id: "block-b", x: 300, y: 150 }
            ]);
            const fetchSvg: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(fetchSvg).run(makeObjects(canvas));

            expect(blockA.moveTo).toHaveBeenCalledWith(42, 84);
            expect(blockB.moveTo).toHaveBeenCalledWith(300, 150);
        });

    });

    describe("run — group with nested block", () => {

        it("applies coordinates to the group and its nested block", async () => {
            const childBlock = makeBlockStub("child-block");
            const group      = makeGroupStub("my-group", "", [childBlock]);
            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };
            const svg = makeTalaSvg([
                { id: "my-group",    x: 10, y: 20 },
                { id: "child-block", x: 30, y: 40 }
            ]);
            const fetchSvg: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(fetchSvg).run(makeObjects(canvas));

            expect(group.moveTo).toHaveBeenCalledWith(10, 20);
            expect(childBlock.moveTo).toHaveBeenCalledWith(30, 40);
        });

    });

    describe("run — missing SVG node", () => {

        it("does not call moveTo for a node absent from the TALA SVG", async () => {
            const blockA = makeBlockStub("block-a");
            const blockB = makeBlockStub("block-b");   // will be absent from SVG
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            const svg = makeTalaSvg([{ id: "block-a", x: 10, y: 20 }]);
            const fetchSvg: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(fetchSvg).run(makeObjects(canvas));

            expect(blockA.moveTo).toHaveBeenCalledWith(10, 20);
            expect(blockB.moveTo).not.toHaveBeenCalled();
        });

    });

    describe("run — fetchSvg rejection", () => {

        it("rejects with the same error when fetchSvg rejects", async () => {
            const block  = makeBlockStub("block-a");
            const canvas: SerializableCanvas = { blocks: [block], groups: [], lines: [] };
            const boom   = new Error("layout backend unavailable");
            const fetchSvg: LayoutSource = vi.fn().mockRejectedValue(boom);

            await expect(
                new NewAutoLayoutEngine(fetchSvg).run(makeObjects(canvas))
            ).rejects.toThrow("layout backend unavailable");

            expect(block.moveTo).not.toHaveBeenCalled();
        });

    });

    describe("run — empty canvas", () => {

        it("returns without calling fetchSvg when objects array is empty", async () => {
            const fetchSvg: LayoutSource = vi.fn();

            await new NewAutoLayoutEngine(fetchSvg).run([]);

            expect(fetchSvg).not.toHaveBeenCalled();
        });

    });

});
