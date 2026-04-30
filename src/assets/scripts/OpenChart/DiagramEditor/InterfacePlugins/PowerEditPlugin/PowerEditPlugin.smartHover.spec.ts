/**
 * @file PowerEditPlugin.smartHover.spec.ts
 *
 * TB-14: Integration tests for PowerEditPlugin.smartHover's five-pass
 * priority order against nested trust-boundary scenarios (Phase D Step 2).
 */

import { describe, it, expect, beforeAll } from "vitest";

// @OpenChart/DiagramInterface is stubbed globally in PowerEditPlugin.testing.setup.ts
// (registered as vitest setupFiles). No inline vi.mock() is required here.

import { BlockView, GroupView, LineView, ResizeEdge } from "@OpenChart/DiagramView";
import { createGroupTestingFactory } from "../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import { createTestableEditor, findById } from "./PowerEditPlugin.testing";
import type { DiagramObjectView, DiagramObjectViewFactory, HitTarget } from "@OpenChart/DiagramView";


// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectHitToBe(hit: HitTarget | undefined, target: DiagramObjectView): void {
    expect(hit).toBeDefined();
    // Narrow to DiagramObjectView — these tests only hit blocks/lines/groups,
    // never PolyLineSpanView.  The assertion below will catch mismatches.
    let cursor: DiagramObjectView | null | undefined = hit as DiagramObjectView | undefined;
    while (cursor) {
        if (cursor === target) { return; }
        cursor = cursor.parent;
    }
    expect(hit).toBe(target); // will fail with readable diff
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("PowerEditPlugin.smartHover", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    // -----------------------------------------------------------------------
    // Pass 1
    // -----------------------------------------------------------------------

    it("pass 1 — canvas-level block beats enclosing group", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { bounds: [0, 0, 400, 400] }
            ],
            blocks: [
                { id: "b", x: 100, y: 100 }
            ]
        });

        const block = findById(canvas, "b") as BlockView;
        expect(block).toBeInstanceOf(BlockView);

        const hit = plugin.hoverAt(block.x, block.y);

        expectHitToBe(hit, block);
    });


    // -----------------------------------------------------------------------
    // Pass 2
    // -----------------------------------------------------------------------

    it("pass 2 — group resize halo wins over body", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "g", bounds: [0, 0, 400, 400] }
            ]
        });

        const group = findById(canvas, "g") as GroupView;
        expect(group).toBeInstanceOf(GroupView);

        // x = -5 is outside west edge (xMin=0) but within RESIZE_HALO (12).
        const hit = plugin.hoverAt(-5, 200);

        expect(hit).toBe(group);
        expect(group.hoveredEdge).toBe(ResizeEdge.W);
    });

    it("pass 2 — innermost group halo wins over outer group halo", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "outer",
                    bounds: [0, 0, 400, 400],
                    groups: [
                        { id: "inner", bounds: [100, 100, 300, 300] }
                    ]
                }
            ]
        });

        const inner = findById(canvas, "inner") as GroupView;
        expect(inner).toBeInstanceOf(GroupView);

        // x = 95: outside inner's west edge (xMin=100), within inner's halo
        // (100 - 12 = 88 ≤ 95 < 100), and still inside outer's body.
        const hit = plugin.hoverAt(95, 200);

        expect(hit).toBe(inner);
        expect(inner.hoveredEdge).toBe(ResizeEdge.W);
    });


    // -----------------------------------------------------------------------
    // Pass 3
    // -----------------------------------------------------------------------

    it("pass 3 — block inside group is returned instead of group body", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "g",
                    bounds: [0, 0, 400, 400],
                    blocks: [{ id: "b", x: 200, y: 200 }]
                }
            ]
        });

        const block = findById(canvas, "b") as BlockView;
        expect(block).toBeInstanceOf(BlockView);

        const hit = plugin.hoverAt(block.x, block.y);

        expectHitToBe(hit, block);
    });

    it("pass 3 — block nested two groups deep is returned", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "B0",
                    bounds: [0, 0, 500, 500],
                    groups: [
                        {
                            id: "B1",
                            bounds: [50, 50, 450, 450],
                            blocks: [{ id: "A", x: 200, y: 200 }]
                        }
                    ]
                }
            ]
        });

        const blockA = findById(canvas, "A") as BlockView;
        expect(blockA).toBeInstanceOf(BlockView);

        const hit = plugin.hoverAt(blockA.x, blockA.y);

        expectHitToBe(hit, blockA);
    });


    // -----------------------------------------------------------------------
    // Pass 4
    // -----------------------------------------------------------------------

    it("pass 4 — canvas-level line beats enclosing group body", () => {
        // Horizontal line from (10, 200) to (390, 200) inside the group bounds.
        // The line's midpoint (200, 200) lies inside the group, but Pass 4 runs
        // before Pass 5 (group body fallback), so the line wins.
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "g", bounds: [0, 0, 400, 400] }
            ],
            lines: [
                { id: "l", source: [10, 200], target: [390, 200] }
            ]
        });

        const line = findById(canvas, "l") as LineView;
        expect(line).toBeInstanceOf(LineView);

        // Midpoint of the horizontal segment; well within hitbox_width=20.
        const hit = plugin.hoverAt(200, 200);

        expect(hit).toBe(line);
    });


    // -----------------------------------------------------------------------
    // Pass 5
    // -----------------------------------------------------------------------

    it("pass 5 — empty group body is the fallback", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                { id: "g", bounds: [0, 0, 400, 400] }
            ]
        });

        const group = findById(canvas, "g") as GroupView;
        expect(group).toBeInstanceOf(GroupView);

        // Interior click with no children → falls through to group body.
        const hit = plugin.hoverAt(200, 200);

        expect(hit).toBe(group);
    });

    it("pass 4 — canvas-level line beats a nested group body", () => {
        // Regression: an outer group containing an inner group (e.g. a trust
        // boundary enclosing a container).  Clicking on a canvas-level line
        // that visually crosses the empty interior of the inner group used
        // to select the inner group instead of the line — the outer group's
        // getObjectAt descended into the inner group, which returned itself
        // (no children were under the click), and smartHover misread that
        // as "real content" and short-circuited past the line check.
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "outer",
                    bounds: [0, 0, 600, 400],
                    groups: [
                        { id: "inner", bounds: [100, 100, 500, 300] }
                    ]
                }
            ],
            lines: [
                { id: "l", source: [50, 200], target: [550, 200] }
            ]
        });

        const line = findById(canvas, "l") as LineView;
        expect(line).toBeInstanceOf(LineView);

        // Midpoint of the line, inside both outer and inner group bounds.
        const hit = plugin.hoverAt(300, 200);

        expect(hit).toBe(line);
    });

    it("pass 5 — empty nested group body beats outer group body", () => {
        // Companion to the regression above: when there is no line to hit,
        // a click in the empty interior of a nested group should select the
        // innermost group, not fall through to the outer one.  This is the
        // existing UX contract for nested containers (click empty container
        // body → selects container, not its enclosing boundary).
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "outer",
                    bounds: [0, 0, 600, 400],
                    groups: [
                        { id: "inner", bounds: [100, 100, 500, 300] }
                    ]
                }
            ]
        });

        const inner = findById(canvas, "inner") as GroupView;
        expect(inner).toBeInstanceOf(GroupView);

        const hit = plugin.hoverAt(300, 200);

        expect(hit).toBe(inner);
    });


    // -----------------------------------------------------------------------
    // Halo state cleared each call
    // -----------------------------------------------------------------------

    it("hoveredEdge is cleared on every call before hit testing begins", () => {
        const { plugin, canvas } = createTestableEditor(factory, {
            groups: [
                {
                    id: "outer",
                    bounds: [0, 0, 400, 400],
                    groups: [
                        {
                            id: "inner",
                            bounds: [100, 100, 300, 300],
                            blocks: [{ id: "b", x: 200, y: 200 }]
                        }
                    ]
                }
            ]
        });

        const inner = findById(canvas, "inner") as GroupView;
        const block = findById(canvas, "b") as BlockView;
        expect(inner).toBeInstanceOf(GroupView);
        expect(block).toBeInstanceOf(BlockView);

        // First hover: sets inner.hoveredEdge = W (Pass 2 halo hit).
        plugin.hoverAt(95, 200);
        expect(inner.hoveredEdge).toBe(ResizeEdge.W);

        // Second hover: Pass 3 hits the block inside inner.
        // smartHover must clear hoveredEdge on all groups first.
        const hit = plugin.hoverAt(block.x, block.y);

        expectHitToBe(hit, block);
        expect(inner.hoveredEdge).toBe(ResizeEdge.None);
    });

});
