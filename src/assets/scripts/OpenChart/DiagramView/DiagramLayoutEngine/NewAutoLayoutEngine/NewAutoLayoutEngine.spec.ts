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
import { AnchorPosition } from "../../DiagramObjectView/Faces/Blocks/AnchorPosition";


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

    ///////////////////////////////////////////////////////////////////////////
    //  Shared stub types and factories for the anchor-rebind tests  //////////
    //  (used by both the "geometric" and "tala" describe blocks)  ////////////
    ///////////////////////////////////////////////////////////////////////////

    /**
     * Minimal anchor shape: a `parent` pointing back to a `BlockStubWithAnchors`
     * and a `link` spy.  Declared as an interface to break the mutual recursion
     * with `BlockStubWithAnchors`.
     */
    interface AnchorStub {
        parent: BlockStubWithAnchors | null;
        link:   ReturnType<typeof vi.fn>;
    }

    /** Minimal latch shape: a mutable `anchor` (updated by the `link` spy). */
    interface LatchStub {
        anchor: AnchorStub | null;
        link:   ReturnType<typeof vi.fn>;
    }

    /**
     * Block shape visible to the anchor rebind pass: `face.boundingBox`
     * (mutable so `moveTo` can update it), `anchors` map, and a `moveTo` spy.
     */
    interface BlockStubWithAnchors {
        instance:   string;
        properties: { isDefined: () => boolean, toString: () => string };
        face: {
            width:  number;
            height: number;
            boundingBox: { xMin: number, xMax: number, yMin: number, yMax: number };
        };
        moveTo:  ReturnType<typeof vi.fn>;
        anchors: Map<AnchorPosition, AnchorStub>;
    }

    function makeAnchorStub(): AnchorStub {
        return { parent: null, link: vi.fn() };
    }

    function makeLatchStub(anchor: AnchorStub | null): LatchStub {
        const latch: LatchStub = {
            anchor,
            link: vi.fn((newAnchor: AnchorStub, _update?: boolean) => {
                latch.anchor = newAnchor;
            })
        };
        return latch;
    }

    /**
     * Creates a block stub whose `moveTo` updates `face.boundingBox` in place
     * so the rebind pass reads the post-TALA positions.  Each block is
     * pre-populated with all four cardinal anchors, each wired back to the block.
     */
    function makeBlockWithAnchors(instance: string, x: number, y: number, w: number, h: number): BlockStubWithAnchors {
        const anchors = new Map<AnchorPosition, AnchorStub>();
        const block: BlockStubWithAnchors = {
            instance,
            properties: { isDefined: () => false, toString: () => "" },
            face: {
                width:  w,
                height: h,
                boundingBox: {
                    xMin: x - w / 2,
                    xMax: x + w / 2,
                    yMin: y - h / 2,
                    yMax: y + h / 2
                }
            },
            moveTo: vi.fn((cx: number, cy: number) => {
                block.face.boundingBox.xMin = cx - w / 2;
                block.face.boundingBox.xMax = cx + w / 2;
                block.face.boundingBox.yMin = cy - h / 2;
                block.face.boundingBox.yMax = cy + h / 2;
            }),
            anchors
        };
        for (const pos of [AnchorPosition.D0, AnchorPosition.D90, AnchorPosition.D180, AnchorPosition.D270]) {
            const anchor = makeAnchorStub();
            anchor.parent = block;
            anchors.set(pos, anchor);
        }
        return block;
    }

    /**
     * Creates a line stub whose `source` / `target` getters throw when null —
     * mirroring `LineView`'s runtime semantics.
     */
    function makeLineStub(
        sourceLatch: LatchStub | null,
        targetLatch: LatchStub | null
    ) {
        return {
            get source() {
                if (sourceLatch === null) {
                    throw new Error("LineView: source latch is null");
                }
                return sourceLatch;
            },
            get target() {
                if (targetLatch === null) {
                    throw new Error("LineView: target latch is null");
                }
                return targetLatch;
            }
        };
    }

    /**
     * Assembles a `SerializableCanvas` from pre-built anchor-rebind stubs.
     */
    function makeGeometricCanvas(
        blocks: BlockStubWithAnchors[],
        groups: GroupStub[],
        lines:  ReturnType<typeof makeLineStub>[]
    ): SerializableCanvas {
        return {
            blocks: blocks as unknown as SerializableBlock[],
            groups: groups as unknown as SerializableGroup[],
            lines:  lines  as unknown as SerializableCanvas["lines"]
        };
    }

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

        // Stronger form of the invariant: with multiple blocks AND multiple
        // groups in play, EVERY block move must happen before ANY group
        // setBounds.  The one-block/one-group case above doesn't disprove
        // an interleaved ordering (a bug that moved one block, bounded one
        // group, moved the next block, etc. would still pass that test).
        it("applies every block moveTo before any group setBounds (multi-block / multi-group)", async () => {
            const callOrder: string[] = [];

            // Two top-level groups, each with two child blocks, so we have
            // 4 block moves + 2 group setBounds to observe.
            const blockA1 = makeBlockStub("blockA1", "", 100, 50);
            const blockA2 = makeBlockStub("blockA2", "", 100, 50);
            const blockB1 = makeBlockStub("blockB1", "", 100, 50);
            const blockB2 = makeBlockStub("blockB2", "", 100, 50);
            const groupA  = makeGroupStub("groupA", "", [blockA1, blockA2]);
            const groupB  = makeGroupStub("groupB", "", [blockB1, blockB2]);

            for (const b of [blockA1, blockA2, blockB1, blockB2]) {
                (b.moveTo as ReturnType<typeof vi.fn>).mockImplementation(() => {
                    callOrder.push(`block:${b.instance}`);
                });
            }
            for (const g of [groupA, groupB]) {
                (g.face.setBounds as ReturnType<typeof vi.fn>).mockImplementation(() => {
                    callOrder.push(`group:${g.instance}`);
                });
            }

            const canvas: SerializableCanvas = { blocks: [], groups: [groupA, groupB], lines: [] };
            const svg = makeTalaSvg([
                { id: "groupA",         x: 0,   y: 0,   width: 300, height: 200 },
                { id: "groupA.blockA1", x: 10,  y: 20,  width: 100, height: 50 },
                { id: "groupA.blockA2", x: 120, y: 20,  width: 100, height: 50 },
                { id: "groupB",         x: 400, y: 0,   width: 300, height: 200 },
                { id: "groupB.blockB1", x: 410, y: 20,  width: 100, height: 50 },
                { id: "groupB.blockB2", x: 520, y: 20,  width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // Every block entry must come before every group entry.
            const lastBlockIdx  = callOrder.findLastIndex((e) => e.startsWith("block:"));
            const firstGroupIdx = callOrder.findIndex((e) => e.startsWith("group:"));
            expect(lastBlockIdx).toBeGreaterThan(-1);
            expect(firstGroupIdx).toBeGreaterThan(-1);
            expect(lastBlockIdx).toBeLessThan(firstGroupIdx);
            // And we exercised all four blocks + both groups.
            expect(callOrder.filter((e) => e.startsWith("block:"))).toHaveLength(4);
            expect(callOrder.filter((e) => e.startsWith("group:"))).toHaveLength(2);
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
            const awsX      = 0, awsY      = 0,   awsW      = 973,  awsH      = 518;
            const internetX = 0, internetY = 538, internetW = 1204, internetH = 844;
            const svg = makeTalaSvg([
                { id: "aws-uuid",      x: awsX,      y: awsY,      width: awsW,      height: awsH },
                { id: "internet-uuid", x: internetX, y: internetY, width: internetW, height: internetH }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // setBounds takes (xMin, yMin, xMax, yMax); xMax = x + width, yMax = y + height.
            expect(aws.face.setBounds).toHaveBeenCalledWith(
                awsX, awsY, awsX + awsW, awsY + awsH
            );
            expect(internet.face.setBounds).toHaveBeenCalledWith(
                internetX, internetY, internetX + internetW, internetY + internetH
            );
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

        // Groups are not rendered as cylinders in the current DFD schema, but
        // the engine should still translate correctly (and not crash) if TALA
        // ever emits a rect-less node for a group.  `placeGroup` must
        // convert TALA's top-left to center using the group's own bounding
        // box before calling `moveTo` — not pass (x, y) verbatim.
        it("group fallback: translates to center using the group's own bounding box when TALA emits no rect size", async () => {
            const group  = makeGroupStub("my-group", "");
            // makeGroupStub defaults the face bounding box to 200x100.
            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };
            const cylinderSvg = `<svg xmlns="http://www.w3.org/2000/svg">
                <g class="${btoa("my-group")}">
                    <g class="shape">
                        <path d="M 10 20 C 0 0 0 0 0 0"/>
                    </g>
                </g>
            </svg>`;
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(cylinderSvg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // No rect → no setBounds; moveTo receives center = (x + halfW, y + halfH).
            expect(group.face.setBounds).not.toHaveBeenCalled();
            expect(group.moveTo).toHaveBeenCalledWith(10 + 100, 20 + 50);
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

        // Missing-path aggregation: a block missing in pass 1 AND a group
        // missing in pass 2 must be collected into a single console.warn at
        // the end of `run`, not two separate warnings (one per pass).
        it("aggregates missing paths from both passes into a single warning", async () => {
            const blockA       = makeBlockStub("block-a");          // absent
            const missingGroup = makeGroupStub("missing-group");    // absent
            const canvas: SerializableCanvas = {
                blocks: [blockA],
                groups: [missingGroup],
                lines: []
            };
            // SVG contains neither node — both are missing.
            const svg = makeTalaSvg([]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

                expect(warnSpy).toHaveBeenCalledOnce();
                const warning = warnSpy.mock.calls[0][0] as string;
                expect(warning).toContain("2 canvas node(s)");
                expect(warning).toContain("\"block-a\"");
                expect(warning).toContain("\"missing-group\"");
                expect(blockA.moveTo).not.toHaveBeenCalled();
                expect(missingGroup.face.setBounds).not.toHaveBeenCalled();
                expect(missingGroup.moveTo).not.toHaveBeenCalled();
            } finally {
                warnSpy.mockRestore();
            }
        });

        // Skipped-group aggregation: a group with a rect-less TALA placement
        // AND a zero-sized bounding box (the "would re-introduce sibling
        // overlap" path) must flow into the SAME single end-of-run warning
        // as missing paths, not produce a separate per-group console line.
        it("aggregates groups skipped for zero-bbox rect-less placement into the same warning", async () => {
            // Build a group whose face bounding box is all zeros (pre-layout
            // default).  makeGroupStub defaults to a 200×100 box; we build
            // the stub by hand here to override that default without
            // mutating a readonly field after construction.
            const zeroGroup: GroupStub = {
                instance: "zero-group",
                properties: {
                    isDefined: () => false,
                    toString:  () => ""
                },
                face: {
                    boundingBox: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
                    setBounds:   vi.fn()
                },
                blocks: [],
                groups: [],
                lines:  [],
                moveTo: vi.fn()
            };
            const canvas: SerializableCanvas = {
                blocks: [],
                groups: [zeroGroup],
                lines:  []
            };
            // TALA emits a <path> (not a <rect>) for this group — placeGroup's
            // rect-less fallback kicks in; with a zero bbox it must skip.
            const cylinderSvg = `<svg xmlns="http://www.w3.org/2000/svg">
                <g class="${btoa("zero-group")}">
                    <g class="shape">
                        <path d="M 10 20 C 0 0 0 0 0 0"/>
                    </g>
                </g>
            </svg>`;
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(cylinderSvg);

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

                // Exactly one aggregated warning (not one per group).
                expect(warnSpy).toHaveBeenCalledOnce();
                const warning = warnSpy.mock.calls[0][0] as string;
                expect(warning).toContain("1 canvas node(s)");
                expect(warning).toContain("\"zero-group\"");
                // Bucketed cause label identifies the rect-less branch and
                // does NOT conflate it with the non-positive-dimensions bucket.
                expect(warning).toContain("rect-less placement with zero bbox");
                expect(warning).not.toContain("non-positive rect dimensions");
                // Neither moveTo nor setBounds should be called — the group
                // was skipped, not placed at the default 300×200 user bounds.
                expect(zeroGroup.moveTo).not.toHaveBeenCalled();
                expect(zeroGroup.face.setBounds).not.toHaveBeenCalled();
            } finally {
                warnSpy.mockRestore();
            }
        });

        // Non-positive-rect skip: TALA reliably emits positive dimensions,
        // but placeGroup has a defensive backstop for a degenerate rect
        // (width or height <= 0) that would otherwise write inverted or
        // zero-area user bounds.  The skipped path must flow into the
        // same aggregated warning under its OWN cause label so a reader
        // can distinguish it from the rect-less bucket above.
        it("aggregates groups skipped for non-positive rect dimensions under a distinct cause label", async () => {
            const group  = makeGroupStub("degenerate-group", "");
            const canvas: SerializableCanvas = { blocks: [], groups: [group], lines: [] };
            // TALA's rect has width=0, height=0 — placeGroup must skip
            // rather than call setBounds with an inverted/zero-area rect.
            const svg = makeTalaSvg([
                { id: "degenerate-group", x: 10, y: 20, width: 0, height: 0 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

                expect(warnSpy).toHaveBeenCalledOnce();
                const warning = warnSpy.mock.calls[0][0] as string;
                expect(warning).toContain("1 canvas node(s)");
                expect(warning).toContain("\"degenerate-group\"");
                // Bucketed cause label identifies the non-positive-dims
                // branch specifically; the rect-less bucket must not fire.
                expect(warning).toContain("non-positive rect dimensions");
                expect(warning).not.toContain("rect-less placement with zero bbox");
                // Nothing must be called — the group was skipped.
                expect(group.face.setBounds).not.toHaveBeenCalled();
                expect(group.moveTo).not.toHaveBeenCalled();
            } finally {
                warnSpy.mockRestore();
            }
        });

        // Cross-bucket aggregation: a single run with one missing path,
        // one rect-less skip, AND one non-positive-dims skip must produce
        // ONE aggregated warning with all THREE bucket clauses distinctly
        // labeled — so an operator diagnosing "why did these three
        // specific nodes get left alone?" can answer the question from
        // the single log line.
        it("reports each skip cause under its own clause when both skip buckets fire in one run", async () => {
            // Group 1 — missing from SVG entirely.
            const missingGroup = makeGroupStub("missing-group", "");
            // Group 2 — TALA emits a <path> (no rect) and bbox is zero.
            const rectLessGroup: GroupStub = {
                instance: "rect-less-group",
                properties: { isDefined: () => false, toString: () => "" },
                face: {
                    boundingBox: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
                    setBounds:   vi.fn()
                },
                blocks: [],
                groups: [],
                lines:  [],
                moveTo: vi.fn()
            };
            // Group 3 — TALA emits a rect but with non-positive dims.
            const degenerateGroup = makeGroupStub("degenerate-group", "");

            const canvas: SerializableCanvas = {
                blocks: [],
                groups: [missingGroup, rectLessGroup, degenerateGroup],
                lines:  []
            };
            // SVG: omit `missing-group`; emit a <path> for `rect-less-group`;
            // emit a zero-size <rect> for `degenerate-group`.
            const svg = `<svg xmlns="http://www.w3.org/2000/svg">
                <g class="${btoa("rect-less-group")}">
                    <g class="shape"><path d="M 10 20 C 0 0 0 0 0 0"/></g>
                </g>
                <g class="${btoa("degenerate-group")}">
                    <g class="shape"><rect x="10" y="20" width="0" height="0"/></g>
                </g>
            </svg>`;
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

                expect(warnSpy).toHaveBeenCalledOnce();
                const warning = warnSpy.mock.calls[0][0] as string;
                expect(warning).toContain("3 canvas node(s)");
                // All three cause labels present.
                expect(warning).toContain("not found in the TALA SVG");
                expect(warning).toContain("rect-less placement with zero bbox");
                expect(warning).toContain("non-positive rect dimensions");
                // Each path appears exactly once and under the right clause.
                expect(warning).toContain("\"missing-group\"");
                expect(warning).toContain("\"rect-less-group\"");
                expect(warning).toContain("\"degenerate-group\"");
            } finally {
                warnSpy.mockRestore();
            }
        });

        // Elision path: when more than MAX_MISSING_DISPLAYED paths are
        // missing, the warning must truncate the enumerated list and
        // append `", ... and N more"` — not dump every path verbatim
        // (which would produce a megabyte-wide console line for a
        // badly-malformed canvas).  Uses 12 missing blocks to exercise
        // the truncation from both the first-N side and the elided count.
        it("truncates the enumerated list when more than MAX_MISSING_DISPLAYED paths are missing", async () => {
            const N = 12;
            const blocks = Array.from({ length: N }, (_, i) =>
                makeBlockStub(`block-${i}`)
            );
            const canvas: SerializableCanvas = {
                blocks,
                groups: [],
                lines:  []
            };
            const svg = makeTalaSvg([]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

                expect(warnSpy).toHaveBeenCalledOnce();
                const warning = warnSpy.mock.calls[0][0] as string;
                expect(warning).toContain(`${N} canvas node(s)`);
                // MAX_MISSING_DISPLAYED = 10: paths 0-9 shown, 10-11 elided.
                expect(warning).toContain("\"block-0\"");
                expect(warning).toContain("\"block-9\"");
                // block-10 and block-11 must NOT appear in the verbatim list;
                // they're represented by the elision suffix.
                expect(warning).not.toContain("\"block-10\"");
                expect(warning).not.toContain("\"block-11\"");
                expect(warning).toContain("... and 2 more");
            } finally {
                warnSpy.mockRestore();
            }
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

    describe("run — geometric anchor strategy", () => {

        ///////////////////////////////////////////////////////////////////////////
        //  Tests  /////////////////////////////////////////////////////////////////
        ///////////////////////////////////////////////////////////////////////////

        it("blocks side-by-side on x-axis: source latch rebinds to right anchor, target to left anchor", async () => {
            // Source block centered at (100, 100), target centered at (400, 100).
            // Geometric pass: source faces right (D0) toward target; target faces left (D180) toward source.
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            // Wire latches to the D90 anchor of each block (an arbitrary starting anchor).
            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            // TALA places src at top-left (50, 75) with w=100, h=50 → center (100, 100).
            // TALA places tgt at top-left (350, 75) with w=100, h=50 → center (400, 100).
            const svg = makeTalaSvg([
                { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "geometric").run(makeObjects(canvas));

            // Source is to the left of target → source's D0 (right) faces target.
            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D0), true);
            // Target is to the right of source → target's D180 (left) faces source.
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D180), true);
        });

        it("blocks stacked on y-axis: source latch rebinds to bottom anchor, target to top anchor", async () => {
            // Source block centered at (100, 100), target centered at (100, 400).
            // Geometric pass: source faces bottom (D270) toward target; target faces top (D90) toward source.
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 100, 400, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D0)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D0)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            // TALA places src at top-left (50, 75) → center (100, 100).
            // TALA places tgt at top-left (50, 375) → center (100, 400).
            const svg = makeTalaSvg([
                { id: "src-block", x: 50, y:  75, width: 100, height: 50 },
                { id: "tgt-block", x: 50, y: 375, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "geometric").run(makeObjects(canvas));

            // Source is above target → source's D270 (bottom) faces target.
            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D270), true);
            // Target is below source → target's D90 (top) faces source.
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D90), true);
        });

        it("block placement passes (moveTo) still run when geometric rebind also runs", async () => {
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D0)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D0)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvg([
                { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "geometric").run(makeObjects(canvas));

            // TALA top-left + half-dims = center.  50 + 50 = 100; 75 + 25 = 100.
            expect(srcBlock.moveTo).toHaveBeenCalledWith(100, 100);
            // 350 + 50 = 400; 75 + 25 = 100.
            expect(tgtBlock.moveTo).toHaveBeenCalledWith(400, 100);
        });

        it("lines with a null source latch are skipped silently — no crash, no link calls", async () => {
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            // Null source latch → line.source getter throws → asRebindableLine returns null.
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D0)!);

            const line   = makeLineStub(null, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvg([
                { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            try {
                // Must not throw.
                await expect(
                    new NewAutoLayoutEngine(layoutSource, "geometric").run(makeObjects(canvas))
                ).resolves.toBeUndefined();

                // Target latch's link spy must not fire — the line was skipped entirely.
                expect(tgtLatch.link).not.toHaveBeenCalled();
                // No console.error — silent skip.
                expect(errorSpy).not.toHaveBeenCalled();
            } finally {
                errorSpy.mockRestore();
            }
        });

        // [M4] A latch whose anchor property is non-null but whose anchor.parent
        // is null (e.g. a latch attached to a canvas-level anchor rather than a
        // block anchor) must be skipped silently — no link call, no error.
        it("latch with non-null anchor but null anchor.parent is skipped silently", async () => {
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            // Build a latch whose anchor exists but whose parent is null
            // (canvas-level anchor, not a block anchor).
            const canvasLevelAnchor: AnchorStub = { parent: null, link: vi.fn() };
            const srcLatch = makeLatchStub(canvasLevelAnchor);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D0)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvg([
                { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            // Must not throw.
            await expect(
                new NewAutoLayoutEngine(layoutSource, "geometric").run(makeObjects(canvas))
            ).resolves.toBeUndefined();

            // Neither latch must be rebound — the source endpoint block could
            // not be resolved so the entire line is skipped.
            expect(srcLatch.link).not.toHaveBeenCalled();
            expect(tgtLatch.link).not.toHaveBeenCalled();
        });

        // [H1]+[M3] Line nested inside a group between two child blocks.
        // Verifies that:
        //   (a) collectLines descends into groups and finds the nested line;
        //   (b) the rebind pass reads post-TALA block centers (moveTo updates
        //       face.boundingBox, so the rebind sees the post-layout positions);
        //   (c) both block placement pass and group placement pass still run;
        //   (d) source latch is rebound to the cardinal anchor facing the target,
        //       and target latch to the anchor facing the source.
        it("nested line inside a group: rebinds using post-TALA block centers, both placement passes run", async () => {
            // Two sibling blocks inside a group.  Pre-TALA they share the same
            // center (0, 0) so the rebind would be a no-op if it used pre-layout
            // positions — the test relies on moveTo updating face.boundingBox.
            //
            // Post-TALA:
            //   src-block → center (100, 100) — TALA top-left (50, 75) w=100 h=50
            //   tgt-block → center (400, 100) — TALA top-left (350, 75) w=100 h=50
            // Expected rebind: src D0 (right) → tgt, tgt D180 (left) → src.
            const srcBlock = makeBlockWithAnchors("src-block", 0, 0, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 0, 0, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);
            const nestedLine = makeLineStub(srcLatch, tgtLatch);

            // Build a group stub whose `lines` array contains the nested line.
            // The cast is required because GroupStub.lines is typed as
            // SerializableLine[] (the D2-bridge read surface), while the
            // runtime guard in collectLines only needs the source/target getters.
            const group: GroupStub = {
                instance:   "my-group",
                properties: { isDefined: () => false, toString: () => "" },
                face: {
                    boundingBox: { xMin: 0, yMin: 0, xMax: 500, yMax: 200 },
                    setBounds:   vi.fn()
                },
                blocks: [srcBlock, tgtBlock] as unknown as ReturnType<typeof makeBlockStub>[],
                groups: [],
                lines:  [nestedLine] as unknown as GroupStub["lines"],
                moveTo: vi.fn()
            };

            const canvas = makeGeometricCanvas([], [group], []);

            // TALA SVG encodes the nested blocks as qualified paths "my-group.src-block"
            // and "my-group.tgt-block", mirroring what collectNodes emits.
            const svg = makeTalaSvg([
                { id: "my-group",             x:   0, y:   0, width: 500, height: 200 },
                { id: "my-group.src-block",   x:  50, y:  75, width: 100, height:  50 },
                { id: "my-group.tgt-block",   x: 350, y:  75, width: 100, height:  50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "geometric").run(makeObjects(canvas));

            // --- block placement pass ran ---
            // src-block: TALA top-left (50, 75) + half-dims (50, 25) → center (100, 100).
            expect(srcBlock.moveTo).toHaveBeenCalledWith(100, 100);
            // tgt-block: TALA top-left (350, 75) + half-dims (50, 25) → center (400, 100).
            expect(tgtBlock.moveTo).toHaveBeenCalledWith(400, 100);

            // --- group placement pass ran ---
            expect(group.face.setBounds).toHaveBeenCalledWith(0, 0, 500, 200);

            // --- nested line rebind used post-TALA centers ---
            // src center (100, 100) is to the left of tgt center (400, 100) → D0 (right).
            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D0), true);
            // tgt center (400, 100) is to the right of src center (100, 100) → D180 (left).
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D180), true);
        });

        it("default strategy 'geometric' rebinds to faces perpendicular to inter-block direction", async () => {
            // Default strategy is "geometric": picks the face whose outward
            // normal points toward the other block, ensuring connectors exit
            // perpendicular to the face they attach to.
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvg([
                { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas));

            // src is left of tgt → src gets D0 (right), tgt gets D180 (left).
            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D0), true);
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D180), true);
        });

        it("explicit strategy 'none' is a no-op for rebinding", async () => {
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvg([
                { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
            ]);
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "none").run(makeObjects(canvas));

            expect(srcLatch.link).not.toHaveBeenCalled();
            expect(tgtLatch.link).not.toHaveBeenCalled();
        });

    });

    describe("run — tala anchor strategy", () => {

        ///////////////////////////////////////////////////////////////////////////
        //  SVG helper with connection elements  ///////////////////////////////////
        ///////////////////////////////////////////////////////////////////////////

        /**
         * Extends {@link makeTalaSvg} with `<g class="connection">` elements so
         * the TALA edge-endpoint parser finds real connection paths.
         */
        function makeTalaSvgWithConnections(
            nodes:       Array<{ id: string, x: number, y: number, width?: number, height?: number }>,
            connections: Array<{ d: string }>
        ): string {
            const nodeGroups = nodes.map(({ id, x, y, width = 100, height = 50 }) => {
                const encoded = btoa(id);
                return `<g class="${encoded}"><g class="shape"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></g></g>`;
            });
            const connGroups = connections.map(({ d }) =>
                `<g class="connection"><path d="${d}"/></g>`
            );
            return `<svg xmlns="http://www.w3.org/2000/svg">${[...nodeGroups, ...connGroups].join("")}</svg>`;
        }

        ///////////////////////////////////////////////////////////////////////////
        //  Tests  /////////////////////////////////////////////////////////////////
        ///////////////////////////////////////////////////////////////////////////

        it("tala edge whose start/end are on block perimeters → picks TALA-derived anchors (different from geometric)", async () => {
            // src-block center (100, 100), tgt-block center (400, 100) — side-by-side.
            //
            // Geometric would pick: src → D0 (right), tgt → D180 (left).
            //
            // TALA connection: start at top of src-block (100, 75), end at top of
            // tgt-block (400, 75).  From the center of each block:
            //   src: dx=0, dy=75−100=−25  → D90 (top)
            //   tgt: dx=0, dy=75−100=−25  → D90 (top)
            // So TALA strategy picks D90/D90, which differs from geometric D0/D180.
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D0)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D0)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            // TALA connection has start at (100, 75) on the top edge of src-block
            // and end at (400, 75) on the top edge of tgt-block.
            const svg = makeTalaSvgWithConnections(
                [
                    { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                    { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
                ],
                [{ d: "M 100 75 L 400 75" }]
            );
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "tala").run(makeObjects(canvas));

            // TALA-derived anchor: both endpoints are on the TOP face → D90.
            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D90), true);
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D90), true);
        });

        it("tala with right-to-left connection: src D0 (right), tgt D180 (left)", async () => {
            // Classic case: connection exits the right side of src, enters the left side of tgt.
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            // Connection: start (150, 100) on right edge of src-block, end (350, 100) on left edge of tgt-block.
            const svg = makeTalaSvgWithConnections(
                [
                    { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                    { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
                ],
                [{ d: "M 150 100 L 350 100" }]
            );
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "tala").run(makeObjects(canvas));

            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D0),   true);
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D180), true);
        });

        it("tala connection far from blocks (distance > threshold) → falls back to geometric", async () => {
            // src center (100, 100), tgt center (400, 100) — threshold = max(50, 25) = 50.
            // Connection start (100, 900) is 775 units below src-block → dStart >> threshold.
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvgWithConnections(
                [
                    { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                    { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
                ],
                [{ d: "M 100 900 L 400 900" }]   // both points far below either block
            );
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "tala").run(makeObjects(canvas));

            // Geometric fallback: src left of tgt → D0 / D180.
            expect(srcLatch.link).toHaveBeenCalledWith(srcBlock.anchors.get(AnchorPosition.D0),   true);
            expect(tgtLatch.link).toHaveBeenCalledWith(tgtBlock.anchors.get(AnchorPosition.D180), true);
        });

        it("explicit 'none' strategy → no rebinding regardless of connections in SVG", async () => {
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            const srcLatch = makeLatchStub(srcBlock.anchors.get(AnchorPosition.D90)!);
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D90)!);

            const line   = makeLineStub(srcLatch, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvgWithConnections(
                [
                    { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                    { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
                ],
                [{ d: "M 150 100 L 350 100" }]
            );
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "none").run(makeObjects(canvas));

            expect(srcLatch.link).not.toHaveBeenCalled();
            expect(tgtLatch.link).not.toHaveBeenCalled();
        });

        it("tala: line with null source latch is skipped silently", async () => {
            const srcBlock = makeBlockWithAnchors("src-block", 100, 100, 100, 50);
            const tgtBlock = makeBlockWithAnchors("tgt-block", 400, 100, 100, 50);

            // Null source latch → line.source getter throws → asRebindableLine returns null.
            const tgtLatch = makeLatchStub(tgtBlock.anchors.get(AnchorPosition.D0)!);
            const line   = makeLineStub(null, tgtLatch);
            const canvas = makeGeometricCanvas([srcBlock, tgtBlock], [], [line]);

            const svg = makeTalaSvgWithConnections(
                [
                    { id: "src-block", x: 50,  y: 75, width: 100, height: 50 },
                    { id: "tgt-block", x: 350, y: 75, width: 100, height: 50 }
                ],
                [{ d: "M 150 100 L 350 100" }]
            );
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await expect(
                new NewAutoLayoutEngine(layoutSource, "tala").run(makeObjects(canvas))
            ).resolves.toBeUndefined();

            expect(tgtLatch.link).not.toHaveBeenCalled();
        });

        it("tala: two independent lines each match their own TALA edge", async () => {
            // Line 1: blockA → blockB (side-by-side at y=100)
            // Line 2: blockC → blockD (side-by-side at y=500 — different block pair, different row)
            //
            // Two TALA edges:
            //   edge1: M 150 100 L 350 100  (exits right of blockA, enters left of blockB)
            //   edge2: M 750 500 L 950 500  (exits right of blockC, enters left of blockD)
            //
            // Each line's nearest-neighbor search picks the edge closest to its own blocks.
            const blockA = makeBlockWithAnchors("block-a", 100, 100, 100, 50);
            const blockB = makeBlockWithAnchors("block-b", 400, 100, 100, 50);
            const blockC = makeBlockWithAnchors("block-c", 700, 500, 100, 50);
            const blockD = makeBlockWithAnchors("block-d", 1000, 500, 100, 50);

            const latchA = makeLatchStub(blockA.anchors.get(AnchorPosition.D90)!);
            const latchB = makeLatchStub(blockB.anchors.get(AnchorPosition.D90)!);
            const latchC = makeLatchStub(blockC.anchors.get(AnchorPosition.D90)!);
            const latchD = makeLatchStub(blockD.anchors.get(AnchorPosition.D90)!);

            const line1 = makeLineStub(latchA, latchB);
            const line2 = makeLineStub(latchC, latchD);
            const canvas = makeGeometricCanvas([blockA, blockB, blockC, blockD], [], [line1, line2]);

            const svg = makeTalaSvgWithConnections(
                [
                    { id: "block-a", x:  50, y:  75, width: 100, height: 50 },
                    { id: "block-b", x: 350, y:  75, width: 100, height: 50 },
                    { id: "block-c", x: 650, y: 475, width: 100, height: 50 },
                    { id: "block-d", x: 950, y: 475, width: 100, height: 50 }
                ],
                [
                    { d: "M 150 100 L 350 100" },   // line1's TALA edge (right-of-A → left-of-B)
                    { d: "M 750 500 L 950 500" }    // line2's TALA edge (right-of-C → left-of-D)
                ]
            );
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(svg);

            await new NewAutoLayoutEngine(layoutSource, "tala").run(makeObjects(canvas));

            // Line 1: edge1 → A gets D0 (right), B gets D180 (left).
            expect(latchA.link).toHaveBeenCalledWith(blockA.anchors.get(AnchorPosition.D0),   true);
            expect(latchB.link).toHaveBeenCalledWith(blockB.anchors.get(AnchorPosition.D180), true);

            // Line 2: edge2 → C gets D0 (right), D gets D180 (left).
            expect(latchC.link).toHaveBeenCalledWith(blockC.anchors.get(AnchorPosition.D0),   true);
            expect(latchD.link).toHaveBeenCalledWith(blockD.anchors.get(AnchorPosition.D180), true);
        });

    });

    // The `SerializableBlock` / `SerializableGroup` interfaces describe only
    // the read-side surface that D2Bridge touches.  The engine additionally
    // requires `moveTo` on blocks and groups, and `setBounds` on group
    // faces — real BlockView / GroupView instances provide those, but a
    // test or integration fixture that supplies only the serializable
    // surface would crash deep inside `placeBlock` / `placeGroup`.  The
    // `asPositionable*` runtime guards convert that deep crash into a
    // targeted diagnostic error that names the offending qualified path,
    // so the fixture (not the engine) is identified as the source of the
    // problem.
    describe("run — bad fixture diagnostics (asPositionable* guards)", () => {

        // collectNodes runs after parseTalaSvg, so the layoutSource must
        // return a parseable SVG even though the guards fire before any
        // placement is applied.  An empty <svg> satisfies parseTalaSvg.
        const emptySvg = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";

        it("throws naming the qualified path when a top-level block lacks moveTo", async () => {
            // Build a block stub that is a valid SerializableBlock but has
            // no `moveTo` method.  makeBlockStub adds `moveTo`, so we
            // construct the stub by hand.
            const badBlock = {
                instance: "bad-block",
                properties: { isDefined: () => false, toString: () => "" },
                face:       { width: 100, height: 50 }
            } as unknown as SerializableBlock;
            const canvas: SerializableCanvas = { blocks: [badBlock], groups: [], lines: [] };
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(emptySvg);

            await expect(
                new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas))
            ).rejects.toThrow(/block "bad-block".*missing moveTo method/);
        });

        it("throws naming the qualified path when a nested block lacks moveTo", async () => {
            // The guard must surface the qualified path (parent.child), not
            // just the leaf instance — so a reader of the error knows where
            // to look in a tree with reused leaf ids.
            const badNestedBlock = {
                instance: "child",
                properties: { isDefined: () => false, toString: () => "" },
                face:       { width: 100, height: 50 }
            } as unknown as SerializableBlock;
            // Cast the positionable group stub to the plain SerializableGroup
            // surface so we can stuff the bad-block into its readonly blocks
            // array via the type system's perspective.
            const parent = makeGroupStub("parent", "",
                [badNestedBlock as unknown as ReturnType<typeof makeBlockStub>]);
            const canvas: SerializableCanvas = { blocks: [], groups: [parent], lines: [] };
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(emptySvg);

            await expect(
                new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas))
            ).rejects.toThrow(/block "parent\.child".*missing moveTo method/);
        });

        it("throws naming the qualified path when a top-level group lacks moveTo", async () => {
            // Group stub with no `moveTo` method on the group itself.
            const badGroup = {
                instance: "bad-group",
                properties: { isDefined: () => false, toString: () => "" },
                face: {
                    boundingBox: { xMin: 0, yMin: 0, xMax: 200, yMax: 100 },
                    setBounds:   vi.fn()
                },
                blocks: [],
                groups: [],
                lines:  []
            } as unknown as SerializableGroup;
            const canvas: SerializableCanvas = { blocks: [], groups: [badGroup], lines: [] };
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(emptySvg);

            await expect(
                new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas))
            ).rejects.toThrow(/group "bad-group".*missing moveTo method/);
        });

        it("throws naming the qualified path when a group face lacks setBounds", async () => {
            // Group stub WITH a moveTo method but whose face lacks
            // setBounds — the guard must distinguish this case and point
            // at the face, not the group.
            const badFaceGroup = {
                instance: "bad-face-group",
                properties: { isDefined: () => false, toString: () => "" },
                face: {
                    boundingBox: { xMin: 0, yMin: 0, xMax: 200, yMax: 100 }
                },
                blocks: [],
                groups: [],
                lines:  [],
                moveTo: vi.fn()
            } as unknown as SerializableGroup;
            const canvas: SerializableCanvas = { blocks: [], groups: [badFaceGroup], lines: [] };
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(emptySvg);

            await expect(
                new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas))
            ).rejects.toThrow(/group "bad-face-group" face.*missing setBounds method/);
        });

        it("throws naming the qualified path when a nested group lacks moveTo", async () => {
            // Similar to the nested-block case: the guard must emit the
            // full parent.child path so a tree with reused ids is
            // debuggable from the error alone.
            const badNested = {
                instance: "nested",
                properties: { isDefined: () => false, toString: () => "" },
                face: {
                    boundingBox: { xMin: 0, yMin: 0, xMax: 200, yMax: 100 },
                    setBounds:   vi.fn()
                },
                blocks: [],
                groups: [],
                lines:  []
            } as unknown as SerializableGroup;
            const parent = makeGroupStub("parent", "", [], [badNested as unknown as GroupStub]);
            const canvas: SerializableCanvas = { blocks: [], groups: [parent], lines: [] };
            const layoutSource: LayoutSource = vi.fn().mockResolvedValue(emptySvg);

            await expect(
                new NewAutoLayoutEngine(layoutSource).run(makeObjects(canvas))
            ).rejects.toThrow(/group "parent\.nested".*missing moveTo method/);
        });

    });

});
