/**
 * @file AnchorRebind.spec.ts
 *
 * Unit tests for `pickCardinalAnchor` and `rebindLatchToAnchor`.
 *
 * Key contracts verified:
 *
 * pickCardinalAnchor:
 *   - All 8 strict octants: a target strictly further horizontally or
 *     vertically from the block center maps to the correct cardinal side
 *     (D0 right, D90 top, D180 left, D270 bottom).
 *   - All 4 tie-break diagonals (|dx| == |dy|, non-zero): priority order
 *     right → top → left → bottom determines the winner.
 *   - Straight-axis targets (dx == 0 or dy == 0): each axis maps to the
 *     expected cardinal.
 *   - Center target (dx == 0 && dy == 0): falls through to the default
 *     priority rule → D0.
 *
 * rebindLatchToAnchor:
 *   - Happy path: calls `latch.link(newAnchor, true)` exactly once when
 *     the latch is currently bound to a different anchor.
 *   - No-op when already linked: does NOT call `link` when `latch.anchor`
 *     is already `newAnchor`.
 *   - Null starting anchor: rebinds successfully when `latch.anchor` is
 *     `null`, calling `link(newAnchor, true)` once.
 *
 * pattern: Functional Core
 */

import { describe, it, expect, vi } from "vitest";

import {
    pickCardinalAnchor,
    rebindLatchToAnchor,
    type CardinalBlockSurface,
    type RebindableLatch,
    type LinkableAnchor,
} from "./AnchorRebind";
import { AnchorPosition } from "../../DiagramObjectView/Faces/Blocks/AnchorPosition";


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Builds a minimal CardinalBlockSurface stub centered at (cx, cy) with
 * bounding-box half-widths hw and hh.
 *
 * The center is at (cx, cy), so:
 *   xMin = cx - hw, xMax = cx + hw, yMin = cy - hh, yMax = cy + hh
 */
function makeBlock(
    cx: number,
    cy: number,
    hw: number,
    hh: number
): CardinalBlockSurface {
    return {
        face: {
            boundingBox: {
                xMin: cx - hw,
                xMax: cx + hw,
                yMin: cy - hh,
                yMax: cy + hh,
            },
        },
    };
}

/**
 * Block centered at (100, 100) with bbox 80×40 (hw=40, hh=20).
 * All pickCardinalAnchor tests use this fixture.
 */
const BLOCK = makeBlock(100, 100, 40, 20);


///////////////////////////////////////////////////////////////////////////////
//  pickCardinalAnchor — strict octants  ///////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("pickCardinalAnchor", () => {

    describe("strict octants — |dx| > |dy| or |dy| > |dx|", () => {

        const cases: Array<{ name: string; tx: number; ty: number; want: AnchorPosition }> = [
            {
                // dx=100, dy=10  → |dx| > |dy| → right
                name: "strict right (dx>0, dy>0 small)",
                tx: 200, ty: 110,
                want: AnchorPosition.D0,
            },
            {
                // dx=100, dy=-10 → |dx| > |dy| → right
                name: "strict right-up (dx>0, dy<0 small)",
                tx: 200, ty: 90,
                want: AnchorPosition.D0,
            },
            {
                // dx=10, dy=-100 → |dy| > |dx| → top (dy<0 means above)
                name: "strict up (dy<0, dx>0 small)",
                tx: 110, ty: 0,
                want: AnchorPosition.D90,
            },
            {
                // dx=-10, dy=-100 → |dy| > |dx| → top
                name: "strict up-left (dy<0, dx<0 small)",
                tx: 90, ty: 0,
                want: AnchorPosition.D90,
            },
            {
                // dx=-100, dy=10 → |dx| > |dy| → left
                name: "strict left (dx<0, dy>0 small)",
                tx: 0, ty: 110,
                want: AnchorPosition.D180,
            },
            {
                // dx=-100, dy=30 → |dx|=100 > |dy|=30 → left
                name: "strict left-down (dx<0, dy>0, |dx|>|dy|)",
                tx: 0, ty: 130,
                want: AnchorPosition.D180,
            },
            {
                // dx=10, dy=200 → |dy| > |dx| → bottom (dy>0 means below)
                name: "strict down (dy>0, dx>0 small)",
                tx: 110, ty: 300,
                want: AnchorPosition.D270,
            },
            {
                // dx=20, dy=200 → |dy| > |dx| → bottom
                name: "strict down-right (dy>0, dx>0, |dy|>|dx|)",
                tx: 120, ty: 300,
                want: AnchorPosition.D270,
            },
        ];

        for (const { name, tx, ty, want } of cases) {
            it(`returns ${want} for "${name}"`, () => {
                expect(pickCardinalAnchor(BLOCK, { x: tx, y: ty })).toBe(want);
            });
        }

    });


    ///////////////////////////////////////////////////////////////////////////////
    //  pickCardinalAnchor — tie-break cases  //////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////////


    describe("tie-break cases — |dx| == |dy|", () => {

        const cases: Array<{ name: string; tx: number; ty: number; want: AnchorPosition }> = [
            {
                // dx=100, dy=-100 → NE diagonal → dx>0 wins → right
                name: "NE diagonal (dx>0, dy<0)",
                tx: 200, ty: 0,
                want: AnchorPosition.D0,
            },
            {
                // dx=100, dy=100 → SE diagonal → dx>0 wins → right
                name: "SE diagonal (dx>0, dy>0)",
                tx: 200, ty: 200,
                want: AnchorPosition.D0,
            },
            {
                // dx=-100, dy=-100 → NW diagonal → dx not >0, dy<0 wins → top
                name: "NW diagonal (dx<0, dy<0)",
                tx: 0, ty: 0,
                want: AnchorPosition.D90,
            },
            {
                // dx=-100, dy=100 → SW diagonal → dx not >0, dy not <0, dx<0 wins → left
                name: "SW diagonal (dx<0, dy>0)",
                tx: 0, ty: 200,
                want: AnchorPosition.D180,
            },
            {
                // dx=0, dy=0 → center → explicit guard returns right (priority-order winner)
                name: "returns right when the target sits exactly at the block center (4-way tie resolves to priority-order winner)",
                tx: 100, ty: 100,
                want: AnchorPosition.D0,
            },
        ];

        for (const { name, tx, ty, want } of cases) {
            it(`returns ${want} for "${name}"`, () => {
                expect(pickCardinalAnchor(BLOCK, { x: tx, y: ty })).toBe(want);
            });
        }

    });


    ///////////////////////////////////////////////////////////////////////////////
    //  pickCardinalAnchor — straight-axis cases  //////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////////


    describe("straight-axis cases — dx==0 or dy==0 (non-zero other coord)", () => {

        const cases: Array<{ name: string; tx: number; ty: number; want: AnchorPosition }> = [
            {
                // dx=0, dy=-50 → |dy|>|dx| → top
                name: "directly above (dx=0, dy<0)",
                tx: 100, ty: 50,
                want: AnchorPosition.D90,
            },
            {
                // dx=100, dy=0 → |dx|>|dy| → right
                name: "directly right (dx>0, dy=0)",
                tx: 200, ty: 100,
                want: AnchorPosition.D0,
            },
            {
                // dx=0, dy=100 → |dy|>|dx| → bottom
                name: "directly below (dx=0, dy>0)",
                tx: 100, ty: 200,
                want: AnchorPosition.D270,
            },
            {
                // dx=-100, dy=0 → |dx|>|dy| → left
                name: "directly left (dx<0, dy=0)",
                tx: 0, ty: 100,
                want: AnchorPosition.D180,
            },
        ];

        for (const { name, tx, ty, want } of cases) {
            it(`returns ${want} for "${name}"`, () => {
                expect(pickCardinalAnchor(BLOCK, { x: tx, y: ty })).toBe(want);
            });
        }

    });

});


///////////////////////////////////////////////////////////////////////////////
//  rebindLatchToAnchor  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("rebindLatchToAnchor", () => {

    it("calls link(newAnchor, true) exactly once when the latch is bound to a different anchor", () => {
        const oldAnchor: LinkableAnchor = {};
        const newAnchor: LinkableAnchor = {};

        const latch: RebindableLatch = {
            anchor: oldAnchor,
            link: vi.fn(),
        };

        rebindLatchToAnchor(latch, newAnchor);

        expect(latch.link).toHaveBeenCalledOnce();
        expect(latch.link).toHaveBeenCalledWith(newAnchor, true);
    });

    it("does NOT call link when the latch is already bound to newAnchor", () => {
        const anchor: LinkableAnchor = {};

        const latch: RebindableLatch = {
            anchor,
            link: vi.fn(),
        };

        rebindLatchToAnchor(latch, anchor);

        expect(latch.link).not.toHaveBeenCalled();
    });

    it("calls link(newAnchor, true) once when latch.anchor starts as null", () => {
        const newAnchor: LinkableAnchor = {};

        const latch: RebindableLatch = {
            anchor: null,
            link: vi.fn(),
        };

        rebindLatchToAnchor(latch, newAnchor);

        expect(latch.link).toHaveBeenCalledOnce();
        expect(latch.link).toHaveBeenCalledWith(newAnchor, true);
    });

});
