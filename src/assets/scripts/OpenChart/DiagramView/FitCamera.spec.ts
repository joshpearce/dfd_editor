import { describe, it, expect } from "vitest";
import { computeFitCamera } from "./FitCamera";
import type { DiagramObjectView } from "./DiagramObjectView";

/**
 * Builds a stub view exposing only the surface {@link computeFitCamera}
 * reads: `face.boundingBox.{xMin,yMin,xMax,yMax}`. Nothing else is touched.
 */
function view(xMin: number, yMin: number, xMax: number, yMax: number): DiagramObjectView {
    return { face: { boundingBox: { xMin, yMin, xMax, yMax } } } as unknown as DiagramObjectView;
}

describe("computeFitCamera", () => {
    it("returns a camera centered on the union's centroid", () => {
        const camera = computeFitCamera(
            [view(-100, -50, 300, 150)],
            1000,
            500
        );
        expect(camera).not.toBeNull();
        expect(camera!.x).toBe(100);
        expect(camera!.y).toBe(50);
    });

    it("scales to fill 90% of the viewport's limiting dimension", () => {
        // 400-wide region, 200-tall region.  Viewport 1000 × 500.
        //   relW = 400/1000 = 0.4, relH = 200/500 = 0.4.  Width dominates.
        //   k = 0.9 / 0.4 = 2.25, capped at 1.5.
        const tight = computeFitCamera(
            [view(0, 0, 400, 200)],
            1000,
            500
        );
        expect(tight!.k).toBe(1.5);

        // Bigger region so the cap doesn't kick in: relW = 1000/1000 = 1.
        // k = 0.9 / 1 = 0.9.
        const scaled = computeFitCamera(
            [view(0, 0, 1000, 500)],
            1000,
            500
        );
        expect(scaled!.k).toBeCloseTo(0.9);
    });

    it("returns null when no view has a non-empty bounding box", () => {
        expect(computeFitCamera([], 100, 100)).toBeNull();
        // Degenerate box (xMin >= xMax) is ignored.
        expect(computeFitCamera([view(10, 10, 10, 10)], 100, 100)).toBeNull();
    });

    it("skips degenerate boxes but uses the rest", () => {
        const camera = computeFitCamera(
            [
                view(10, 10, 10, 10),       // ignored
                view(-100, -50, 100, 50)    // counted
            ],
            1000,
            500
        );
        expect(camera).not.toBeNull();
        expect(camera!.x).toBe(0);
        expect(camera!.y).toBe(0);
    });

    it("returns null for zero-sized viewport (guards against /0)", () => {
        expect(computeFitCamera([view(0, 0, 100, 100)], 0, 100)).toBeNull();
        expect(computeFitCamera([view(0, 0, 100, 100)], 100, 0)).toBeNull();
    });
});
