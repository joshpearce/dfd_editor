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
 *     (D0 right, D90 top, D180 left, D270 bottom). Straight-axis targets
 *     (dx==0 or dy==0, non-zero other coord) are boundary cases of the
 *     strict branches and are included in their own sub-suite.
 *   - All 4 tie-break diagonals (|dx| == |dy|, non-zero): priority order
 *     right → top → left → bottom determines the winner.
 *   - Center target (dx == 0 && dy == 0): falls through to the default
 *     priority rule → D0.
 *   - Asymmetric bbox: the center-based direction wins over the
 *     perpendicularly-nearest side.
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
    type LinkableAnchor
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
                yMax: cy + hh
            }
        }
    };
}

/**
 * Block centered at (100, 100) with bbox 80×40 (hw=40, hh=20).
 * bbox: xMin=60, xMax=140, yMin=80, yMax=120.
 * All pickCardinalAnchor tests use this fixture unless otherwise noted.
 */
const BLOCK = makeBlock(100, 100, 40, 20);

/**
 * Builds a minimal LinkableAnchor stub (satisfies the structural type).
 */
function makeAnchor(x: number = 0, y: number = 0): LinkableAnchor {
    return { x, y, link: vi.fn() };
}

/**
 * Builds a minimal RebindableLatch stub (satisfies the structural type).
 */
function makeLatch(anchor: LinkableAnchor | null): RebindableLatch {
    return { anchor, link: vi.fn(), moveTo: vi.fn() };
}


///////////////////////////////////////////////////////////////////////////////
//  pickCardinalAnchor — strict octants  ///////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("pickCardinalAnchor", () => {

    describe("strict octants — |dx| > |dy| or |dy| > |dx|", () => {

        // All coords are targets relative to BLOCK centered at (100, 100).
        // Each row covers exactly one of the 8 compass octants.
        // Compass: N=top=-y, E=right=+x (screen coords, y grows downward).
        const cases: Array<{ name: string, tx: number, ty: number, want: AnchorPosition }> = [
            {
                // ENE: dx>0, dy<0, |dx|>|dy| → right
                // dx=150, dy=-10 → D0
                name: "ENE (dx>0, dy<0, |dx|>|dy|)",
                tx: 250, ty: 90,
                want: AnchorPosition.D0
            },
            {
                // ESE: dx>0, dy>0, |dx|>|dy| → right
                // dx=150, dy=10 → D0
                name: "ESE (dx>0, dy>0, |dx|>|dy|)",
                tx: 250, ty: 110,
                want: AnchorPosition.D0
            },
            {
                // NNE: dx>0, dy<0, |dy|>|dx| → top
                // dx=10, dy=-100 → D90
                name: "NNE (dx>0, dy<0, |dy|>|dx|)",
                tx: 110, ty: 0,
                want: AnchorPosition.D90
            },
            {
                // NNW: dx<0, dy<0, |dy|>|dx| → top
                // dx=-10, dy=-100 → D90
                name: "NNW (dx<0, dy<0, |dy|>|dx|)",
                tx: 90, ty: 0,
                want: AnchorPosition.D90
            },
            {
                // WNW: dx<0, dy<0, |dx|>|dy| → left
                // dx=-100, dy=-10 → D180
                name: "WNW (dx<0, dy<0, |dx|>|dy|)",
                tx: 0, ty: 90,
                want: AnchorPosition.D180
            },
            {
                // WSW: dx<0, dy>0, |dx|>|dy| → left
                // dx=-100, dy=10 → D180
                name: "WSW (dx<0, dy>0, |dx|>|dy|)",
                tx: 0, ty: 110,
                want: AnchorPosition.D180
            },
            {
                // SSW: dx<0, dy>0, |dy|>|dx| → bottom
                // dx=-10, dy=200 → D270
                name: "SSW (dx<0, dy>0, |dy|>|dx|)",
                tx: 90, ty: 300,
                want: AnchorPosition.D270
            },
            {
                // SSE: dx>0, dy>0, |dy|>|dx| → bottom
                // dx=10, dy=200 → D270
                name: "SSE (dx>0, dy>0, |dy|>|dx|)",
                tx: 110, ty: 300,
                want: AnchorPosition.D270
            }
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

        const cases: Array<{ name: string, tx: number, ty: number, want: AnchorPosition }> = [
            {
                // dx=100, dy=-100 → NE diagonal → dx>0 wins → right
                name: "NE diagonal (dx>0, dy<0)",
                tx: 200, ty: 0,
                want: AnchorPosition.D0
            },
            {
                // dx=100, dy=100 → SE diagonal → dx>0 wins → right
                name: "SE diagonal (dx>0, dy>0)",
                tx: 200, ty: 200,
                want: AnchorPosition.D0
            },
            {
                // dx=-100, dy=-100 → NW diagonal → dx not >0, dy<0 wins → top
                name: "NW diagonal (dx<0, dy<0)",
                tx: 0, ty: 0,
                want: AnchorPosition.D90
            },
            {
                // dx=-100, dy=100 → SW diagonal → dx not >0, dy not <0, dx<0 wins → left
                name: "SW diagonal (dx<0, dy>0)",
                tx: 0, ty: 200,
                want: AnchorPosition.D180
            },
            {
                // dx=0, dy=0 → center → explicit guard returns right (priority-order winner)
                name: "center (4-way tie, dx=0,dy=0)",
                tx: 100, ty: 100,
                want: AnchorPosition.D0
            }
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

        const cases: Array<{ name: string, tx: number, ty: number, want: AnchorPosition }> = [
            {
                // dx=0, dy=-50 → |dy|>|dx| → top
                name: "directly above (dx=0, dy<0)",
                tx: 100, ty: 50,
                want: AnchorPosition.D90
            },
            {
                // dx=100, dy=0 → |dx|>|dy| → right
                name: "directly right (dx>0, dy=0)",
                tx: 200, ty: 100,
                want: AnchorPosition.D0
            },
            {
                // dx=0, dy=100 → |dy|>|dx| → bottom
                name: "directly below (dx=0, dy>0)",
                tx: 100, ty: 200,
                want: AnchorPosition.D270
            },
            {
                // dx=-100, dy=0 → |dx|>|dy| → left
                name: "directly left (dx<0, dy=0)",
                tx: 0, ty: 100,
                want: AnchorPosition.D180
            }
        ];

        for (const { name, tx, ty, want } of cases) {
            it(`returns ${want} for "${name}"`, () => {
                expect(pickCardinalAnchor(BLOCK, { x: tx, y: ty })).toBe(want);
            });
        }

    });


    ///////////////////////////////////////////////////////////////////////////////
    //  pickCardinalAnchor — asymmetric bbox (center-based vs nearest-side)  ///////
    ///////////////////////////////////////////////////////////////////////////////


    describe("asymmetric bbox — center direction beats perpendicularly-nearest side", () => {

        it(
            "asymmetric bbox: returns the side the target faces from center, not the " +
            "perpendicularly-nearest side (D0 for a target far right of a wide, short block)",
            () => {
                // Block centered at (0, 0), hw=500, hh=10 → bbox xMin=-500..500, yMin=-10..10.
                // Target at (600, 20):
                //   dx=600, dy=20 → |dx|=600 >> |dy|=20 → center direction = right (D0).
                //   Nearest side by distance: bottom edge at y=10, distance=|20-10|=10.
                //   This test asserts the center-based semantic wins: D0 (right), not D270 (bottom).
                const wideShortBlock = makeBlock(0, 0, 500, 10);
                expect(pickCardinalAnchor(wideShortBlock, { x: 600, y: 20 })).toBe(AnchorPosition.D0);
            }
        );

    });

});


///////////////////////////////////////////////////////////////////////////////
//  rebindLatchToAnchor  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("rebindLatchToAnchor", () => {

    it("calls link(newAnchor, true) exactly once when the latch is bound to a different anchor", () => {
        const oldAnchor = makeAnchor();
        const newAnchor = makeAnchor();
        const latch = makeLatch(oldAnchor);

        rebindLatchToAnchor(latch, newAnchor);

        expect(latch.link).toHaveBeenCalledExactlyOnceWith(newAnchor, true);
    });

    it("does NOT call link when the latch is already bound to newAnchor", () => {
        const anchor = makeAnchor();
        const latch = makeLatch(anchor);

        rebindLatchToAnchor(latch, anchor);

        expect(latch.link).not.toHaveBeenCalled();
        expect(latch.moveTo).not.toHaveBeenCalled();
    });

    it("calls link(newAnchor, true) once when latch.anchor starts as null", () => {
        const newAnchor = makeAnchor();
        const latch = makeLatch(null);

        rebindLatchToAnchor(latch, newAnchor);

        expect(latch.link).toHaveBeenCalledExactlyOnceWith(newAnchor, true);
    });

    it("snaps the latch's view position to the new anchor's (x, y) after linking", () => {
        const newAnchor = makeAnchor(42, 99);
        const latch = makeLatch(makeAnchor(0, 0));

        rebindLatchToAnchor(latch, newAnchor);

        expect(latch.moveTo).toHaveBeenCalledExactlyOnceWith(42, 99);
    });

});
