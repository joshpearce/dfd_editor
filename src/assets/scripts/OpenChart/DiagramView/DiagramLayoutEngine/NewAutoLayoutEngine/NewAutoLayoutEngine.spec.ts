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
 *
 * Per-entry `width` / `height` default to `100` / `50`; pass explicit
 * values to model TALA's auto-sized containers (whose size the engine uses
 * to convert top-left to center when calling moveTo).
 */
function makeTalaSvg(
    nodes: Array<{ id: string, x: number, y: number, width?: number, height?: number }>
): string {
    const groups = nodes.map(({ id, x, y, width = 100, height = 50 }) => {
        const encoded = btoa(id);
        return `<g class="${encoded}"><g class="shape"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></g></g>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg">${groups.join("")}</svg>`;
}


///////////////////////////////////////////////////////////////////////////////
//  Canvas stub helpers  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a minimal stub node with `instance`, `moveTo` spy, and the face
 * properties that `serializeToD2` needs (width, height, isDefined, toString).
 *
 * `instance` is the D2 node identifier (production uses the uuid from
 * `DiagramObject.instance`; tests use human-readable strings for legibility).
 */
function makeBlockStub(instance: string, label = "", width = 100, height = 50): SerializableBlock & { moveTo: ReturnType<typeof vi.fn> } {
    return {
        instance,
        properties: {
            isDefined: () => label.length > 0,
            toString:  () => label
        },
        face: { width, height },
        moveTo: vi.fn()
    };
}

type GroupStub = SerializableGroup & {
    moveTo: ReturnType<typeof vi.fn>;
    face: SerializableGroup["face"] & { setBounds: ReturnType<typeof vi.fn> };
};

/**
 * Creates a minimal group stub that satisfies `SerializableGroup` and
 * exposes `setBounds` (primary placement API the engine calls for groups)
 * and `moveTo` (used only in the cylinder-fallback path) as spies.
 */
function makeGroupStub(
    instance: string,
    label = "",
    childBlocks: ReturnType<typeof makeBlockStub>[] = [],
    childGroups: GroupStub[] = []
): GroupStub {
    return {
        instance,
        properties: {
            isDefined: () => label.length > 0,
            toString:  () => label
        },
        face: {
            boundingBox: { xMin: 0, yMin: 0, xMax: 200, yMax: 100 },
            setBounds:   vi.fn()
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
            // Top-level nodes: qualified path == leaf id.  The SVG's rect
            // width/height drive the center offset (TALA's reported size wins
            // over the block's own face dimensions).
            const svg = makeTalaSvg([
                { id: "block-a", x: 42,  y: 84,  width: 100, height: 50 },
                { id: "block-b", x: 300, y: 150, width: 80,  height: 40 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // TALA top-left + TALA half-dimensions = center passed to moveTo.
            expect(blockA.moveTo).toHaveBeenCalledWith(42 + 50, 84 + 25);
            expect(blockB.moveTo).toHaveBeenCalledWith(300 + 40, 150 + 20);
        });

    });

    describe("run — group with nested block", () => {

        it("writes TALA's exact bounds to the group via setBounds, and places the nested block via moveTo", async () => {
            const childBlock = makeBlockStub("child-block", "", 100, 50);
            const group      = makeGroupStub("my-group", "", [childBlock]);
            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };

            // The SVG must encode qualified paths:
            //   - "my-group"              for the group itself
            //   - "my-group.child-block"  for the nested block
            // The group's rect (x=10, y=20, w=200, h=100) is TALA's auto-
            // computed container size; the engine writes those exact bounds
            // into the group's user bounds rather than translating the
            // group's default 300×200 user bounds.
            const svg = makeTalaSvg([
                { id: "my-group",             x: 10, y: 20, width: 200, height: 100 },
                { id: "my-group.child-block", x: 30, y: 40, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // Group: setBounds with TALA's exact rectangle.
            expect(group.face.setBounds).toHaveBeenCalledWith(10, 20, 210, 120);
            expect(group.moveTo).not.toHaveBeenCalled();
            // Block: moveTo(top-left + half-dimensions).
            expect(childBlock.moveTo).toHaveBeenCalledWith(30 + 50, 40 + 25);
        });

    });

    describe("run — two-pass order: blocks before groups", () => {

        // Regression: BlockView.moveTo propagates via `parent.handleUpdate`,
        // which calls GroupFace.calculateLayout.  calculateLayout expands the
        // group's user bounds to include the children hull — so if group
        // setBounds runs BEFORE block moves, subsequent block moves ripple
        // into the group and expand its user bounds beyond TALA's reported
        // rectangle.  Running group setBounds AFTER all block moves pins
        // the group to TALA's exact bounds regardless of the ripple.
        it("applies all block moveTos before any group setBounds", async () => {
            const callOrder: string[] = [];

            const childBlock = makeBlockStub("child-block", "", 100, 50);
            const group      = makeGroupStub("my-group", "", [childBlock]);

            (childBlock.moveTo as ReturnType<typeof vi.fn>).mockImplementation(() => {
                callOrder.push("block:child-block");
            });
            (group.face.setBounds as ReturnType<typeof vi.fn>).mockImplementation(() => {
                callOrder.push("group:my-group");
            });

            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };
            const svg = makeTalaSvg([
                { id: "my-group",             x: 0, y: 0, width: 300, height: 200 },
                { id: "my-group.child-block", x: 10, y: 20, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            expect(callOrder).toEqual(["block:child-block", "group:my-group"]);
        });

    });

    describe("run — sibling groups: regression for boundary overlap", () => {

        it("writes non-overlapping bounds for two top-level sibling groups at TALA's reported positions", async () => {
            const aws      = makeGroupStub("aws-uuid",      "AWS Private Subnet");
            const internet = makeGroupStub("internet-uuid", "Internet");
            const canvas: SerializableCanvas = { blocks: [], groups: [aws, internet], lines: [] };
            // TALA stacks the two siblings vertically: AWS at y=0 with
            // height=518; Internet at y=538 with height=844 — a 20px gap.
            // Both ranges must be written verbatim into user bounds, not
            // translated onto the default 300×200 box.
            const svg = makeTalaSvg([
                { id: "aws-uuid",      x: 0, y: 0,   width: 973,  height: 518 },
                { id: "internet-uuid", x: 0, y: 538, width: 1204, height: 844 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            expect(aws.face.setBounds).toHaveBeenCalledWith(0, 0,   973,  518);
            expect(internet.face.setBounds).toHaveBeenCalledWith(0, 538, 1204, 1382);
        });

    });

    describe("run — TALA size missing (cylinder fallback)", () => {

        it("falls back to the node's own halfW/halfH when TALA emits no rect size", async () => {
            const block = makeBlockStub("block-a", "", 100, 50);
            const canvas: SerializableCanvas = { blocks: [block], groups: [], lines: [] };
            // D2 emits cylinders as <path> without a rect; parseTalaSvg returns
            // only { x, y } in that case, so the engine must fall back to the
            // block's own half-dimensions (derived from block.face).
            const cylinderSvg = `<svg xmlns="http://www.w3.org/2000/svg">
                <g class="${btoa("block-a")}">
                    <g class="shape">
                        <path d="M 42 84 C 0 0 0 0 0 0"/>
                    </g>
                </g>
            </svg>`;
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(cylinderSvg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // Block face is 100x50 → halfW=50, halfH=25; TALA x=42, y=84.
            expect(block.moveTo).toHaveBeenCalledWith(42 + 50, 84 + 25);
        });

    });

    describe("run — missing SVG node", () => {

        it("does not call moveTo for a node absent from the TALA SVG", async () => {
            const blockA = makeBlockStub("block-a");
            const blockB = makeBlockStub("block-b");   // will be absent from SVG
            const canvas: SerializableCanvas = { blocks: [blockA, blockB], groups: [], lines: [] };
            // Top-level nodes: qualified path == leaf id.  Default rect size
            // (100x50) drives the center offset in makeTalaSvg.
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
