import { describe, it, expect } from "vitest";
// Import the full view barrel first so the class inheritance chain initialises
// in the correct order before LineLayoutStrategies is accessed directly.
import "@OpenChart/DiagramView";
import { AXIS_EPSILON, orthogonalizeEndElbow } from "./LineLayoutStrategies";

describe("orthogonalizeEndElbow", () => {

    ///////////////////////////////////////////////////////////////////////////
    //  1. Neighbor-axis preservation — H/V alternation rule               ///
    ///////////////////////////////////////////////////////////////////////////

    describe("neighbor-axis preservation (H/V alternation)", () => {

        // When elbow→neighbor is horizontal (same y), the next segment is H,
        // so the end segment must be V: snap result.x = endpoint.x, keep result.y = elbow.y.
        // When elbow→neighbor is vertical  (same x), the next segment is V,
        // so the end segment must be H: snap result.y = endpoint.y, keep result.x = elbow.x.
        //
        // All cases below have endpoint differing from elbow in BOTH x and y
        // (otherwise the end segment would already be axis-aligned and the
        // no-op path fires instead).

        it("H neighbor: diagonal endpoint (|dx|>|dy|) → end segment becomes V (snap result.x = endpoint.x)", () => {
            // dx=-50 dy=40; H neighbor overrides the fallback axis selection.
            const result = orthogonalizeEndElbow(
                { x: 50,  y: 140 },   // endpoint
                { x: 100, y: 100 },   // elbow
                { x: 200, y: 100 }    // H neighbor (same y)
            );
            expect(result.x).toBeCloseTo(50,  9);   // snapped to endpoint.x
            expect(result.y).toBeCloseTo(100, 9);   // elbow.y unchanged
        });

        it("H neighbor: diagonal endpoint (|dy|>|dx|) → end segment becomes V (snap result.x = endpoint.x)", () => {
            // dx=-20 dy=60; H neighbor still forces V snap regardless of which dx/dy is larger.
            const result = orthogonalizeEndElbow(
                { x: 80,  y: 160 },
                { x: 100, y: 100 },
                { x: 250, y: 100 }
            );
            expect(result.x).toBeCloseTo(80,  9);
            expect(result.y).toBeCloseTo(100, 9);
        });

        it("H neighbor: endpoint moved primarily in Y → end segment becomes V (snap result.x = endpoint.x)", () => {
            // dx=-15 dy=100; H neighbor overrides the displacement-axis fallback.
            const result = orthogonalizeEndElbow(
                { x: 85,  y: 200 },
                { x: 100, y: 100 },
                { x: 300, y: 100 }
            );
            expect(result.x).toBeCloseTo(85,  9);
            expect(result.y).toBeCloseTo(100, 9);
        });

        it("V neighbor: diagonal endpoint (|dy|>|dx|) → end segment becomes H (snap result.y = endpoint.y)", () => {
            // dx=40 dy=100; V neighbor overrides the fallback axis selection.
            const result = orthogonalizeEndElbow(
                { x: 140, y: 200 },
                { x: 100, y: 100 },
                { x: 100, y: 300 }    // V neighbor (same x)
            );
            expect(result.x).toBeCloseTo(100, 9);   // elbow.x unchanged
            expect(result.y).toBeCloseTo(200, 9);   // snapped to endpoint.y
        });

        it("V neighbor: diagonal endpoint (|dx|>|dy|) → end segment becomes H (snap result.y = endpoint.y)", () => {
            // dx=80 dy=40; V neighbor still forces H snap regardless of displacement axis.
            const result = orthogonalizeEndElbow(
                { x: 180, y: 140 },
                { x: 100, y: 100 },
                { x: 100, y: 250 }
            );
            expect(result.x).toBeCloseTo(100, 9);
            expect(result.y).toBeCloseTo(140, 9);
        });

        it("V neighbor: endpoint moved primarily in X → end segment becomes H (snap result.y = endpoint.y)", () => {
            // dx=100 dy=15; V neighbor overrides the displacement-axis fallback.
            const result = orthogonalizeEndElbow(
                { x: 200, y: 115 },
                { x: 100, y: 100 },
                { x: 100, y: 300 }
            );
            expect(result.x).toBeCloseTo(100, 9);
            expect(result.y).toBeCloseTo(115, 9);
        });

        it("degenerate neighbor-snap: endpoint already aligned with H neighbor on Y → elbow coincides with neighbor", () => {
            // endpoint.y (160) !== elbow.y (100), so the end segment is not aligned.
            // H neighbor at {x:50, y:100} (same y as elbow) → neighborIsH → snap elbow.x = endpoint.x.
            // Resulting elbow = {x:50, y:100} which is coincident with the neighbor.
            // The elbow→neighbor segment degenerates to zero length; de-duplication is
            // the caller's responsibility (Step 2 / #18). This is the documented
            // degenerate case — pinned here so Step 2 has an explicit contract to rely on.
            const result = orthogonalizeEndElbow(
                { x: 50,  y: 160 },   // endpoint: y differs from elbow.y
                { x: 100, y: 100 },   // elbow
                { x: 50,  y: 100 }    // H neighbor (same y as elbow; same x as endpoint)
            );
            expect(result.x).toBeCloseTo(50,  9);   // coincident with neighbor.x
            expect(result.y).toBeCloseTo(100, 9);   // elbow.y unchanged (elbow→neighbor degenerate)
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  2. Fallback rule — null neighbor or diagonal neighbor               ///
    ///////////////////////////////////////////////////////////////////////////

    describe("fallback rule (null neighbor)", () => {

        // When neighbor is null: snap on the axis of the larger displacement.
        // |dx| >= |dy| → horizontal end segment: result.y = endpoint.y, result.x = elbow.x
        // |dy| >  |dx| → vertical   end segment: result.x = endpoint.x, result.y = elbow.y

        it("|dx| > |dy|, null neighbor → horizontal end segment (snap result.y = endpoint.y)", () => {
            // dx=-50 dy=-5
            const result = orthogonalizeEndElbow(
                { x: 50,  y: 95  },
                { x: 100, y: 100 },
                null
            );
            expect(result.y).toBeCloseTo(95,  9);   // endpoint.y
            expect(result.x).toBeCloseTo(100, 9);   // elbow.x unchanged
        });

        it("|dy| > |dx|, null neighbor → vertical end segment (snap result.x = endpoint.x)", () => {
            // dx=-5 dy=-50
            const result = orthogonalizeEndElbow(
                { x: 95,  y: 50  },
                { x: 100, y: 100 },
                null
            );
            expect(result.x).toBeCloseTo(95,  9);   // endpoint.x
            expect(result.y).toBeCloseTo(100, 9);   // elbow.y unchanged
        });

        it("|dx| === |dy|, null neighbor → horizontal end segment (>= rule)", () => {
            // dx=-50 dy=-50; >= rule picks horizontal
            const result = orthogonalizeEndElbow(
                { x: 50,  y: 50  },
                { x: 100, y: 100 },
                null
            );
            expect(result.y).toBeCloseTo(50,  9);   // endpoint.y
            expect(result.x).toBeCloseTo(100, 9);   // elbow.x unchanged
        });

    });

    describe("fallback rule (diagonal neighbor)", () => {

        // A diagonal elbow→neighbor segment is not H or V, so the function
        // falls back to the displacement-axis rule exactly as with null neighbor.

        it("|dx| > |dy|, diagonal neighbor → horizontal end segment", () => {
            const result = orthogonalizeEndElbow(
                { x: 50,  y: 95  },
                { x: 100, y: 100 },
                { x: 200, y: 200 }   // diagonal neighbor → fallback
            );
            expect(result.y).toBeCloseTo(95,  9);
            expect(result.x).toBeCloseTo(100, 9);
        });

        it("|dy| > |dx|, diagonal neighbor → vertical end segment", () => {
            const result = orthogonalizeEndElbow(
                { x: 95,  y: 50  },
                { x: 100, y: 100 },
                { x: 200, y: 200 }   // diagonal neighbor → fallback
            );
            expect(result.x).toBeCloseTo(95,  9);
            expect(result.y).toBeCloseTo(100, 9);
        });

        it("|dy|>|dx|, near-vertical (not V) neighbor → displacement fallback picks vertical, not H-snap", () => {
            // neighbor {x:105, y:200}: ndx=5 >= AXIS_EPSILON so NOT classified V.
            // Falls through to displacement fallback.
            // dx=-5, dy=-50 → |dy|>|dx| → vertical end segment:
            //   result = {x: endpoint.x, y: elbow.y} = {x:95, y:100}.
            // A wrong V-misclassification would return {x:elbow.x, y:endpoint.y}
            //   = {x:100, y:50} — a clearly different outcome, so this case
            //   DISTINGUISHES "correct fallback" from "incorrect V-branch".
            const result = orthogonalizeEndElbow(
                { x: 95,  y: 50  },
                { x: 100, y: 100 },
                { x: 105, y: 200 }   // near-vertical but |ndx|=5 >= AXIS_EPSILON → NOT V
            );
            expect(result.x).toBeCloseTo(95,  9);   // endpoint.x (vertical snap)
            expect(result.y).toBeCloseTo(100, 9);   // elbow.y unchanged
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  3. Axis-alignment guarantee — every non-degenerate case             ///
    ///////////////////////////////////////////////////////////////////////////

    describe("axis-alignment guarantee", () => {

        // For any input, the returned point must be axis-aligned with the
        // endpoint: result.x === endpoint.x OR result.y === endpoint.y
        // (within AXIS_EPSILON).  This holds for both snap paths and no-ops.

        it.each([
            // endpoint moved in X only (already H-aligned → no-op, still aligned)
            {
                label: "endpoint moved in X, H neighbor (already H-aligned no-op)",
                endpoint: { x: 50,  y: 100 },
                elbow:    { x: 100, y: 100 },
                neighbor: { x: 200, y: 100 } as { x: number, y: number } | null
            },
            // endpoint moved in Y only (already V-aligned → no-op, still aligned)
            {
                label: "endpoint moved in Y, V neighbor (already V-aligned no-op)",
                endpoint: { x: 100, y: 200 },
                elbow:    { x: 100, y: 100 },
                neighbor: { x: 100, y: 300 } as { x: number, y: number } | null
            },
            // diagonal endpoint → snap path, null neighbor
            {
                label: "diagonal endpoint, null neighbor",
                endpoint: { x: 60,  y: 160 },
                elbow:    { x: 100, y: 100 },
                neighbor: null as { x: number, y: number } | null
            },
            // diagonal endpoint → H neighbor overrides fallback
            {
                label: "diagonal endpoint, H neighbor",
                endpoint: { x: 60,  y: 160 },
                elbow:    { x: 100, y: 100 },
                neighbor: { x: 250, y: 100 } as { x: number, y: number } | null
            },
            // diagonal endpoint → V neighbor overrides fallback
            {
                label: "diagonal endpoint, V neighbor",
                endpoint: { x: 60,  y: 160 },
                elbow:    { x: 100, y: 100 },
                neighbor: { x: 100, y: 250 } as { x: number, y: number } | null
            }
        ])("$label → result is axis-aligned with endpoint", ({ endpoint, elbow, neighbor }) => {
            const result = orthogonalizeEndElbow(endpoint, elbow, neighbor);
            const alignedX = Math.abs(result.x - endpoint.x) < AXIS_EPSILON;
            const alignedY = Math.abs(result.y - endpoint.y) < AXIS_EPSILON;
            expect(alignedX || alignedY).toBe(true);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  4. Already-axis-aligned no-op (TALA round-trip case)                ///
    ///////////////////////////////////////////////////////////////////////////

    describe("already-axis-aligned no-op", () => {

        // When the end segment is already H or V aligned with the endpoint,
        // the returned object must have the same x/y as the original elbow
        // AND be a fresh object (not the same reference as elbow).

        it("already H-aligned (endpoint.y === elbow.y), null neighbor → elbow coords unchanged", () => {
            const elbow = { x: 100, y: 100 };
            const result = orthogonalizeEndElbow({ x: 50, y: 100 }, elbow, null);
            expect(result.x).toBe(elbow.x);
            expect(result.y).toBe(elbow.y);
            expect(result).not.toBe(elbow);
        });

        it("already V-aligned (endpoint.x === elbow.x), null neighbor → elbow coords unchanged", () => {
            const elbow = { x: 100, y: 100 };
            const result = orthogonalizeEndElbow({ x: 100, y: 50 }, elbow, null);
            expect(result.x).toBe(elbow.x);
            expect(result.y).toBe(elbow.y);
            expect(result).not.toBe(elbow);
        });

        it("already H-aligned, H neighbor → elbow coords unchanged (TALA round-trip no-op)", () => {
            const elbow = { x: 100, y: 100 };
            const result = orthogonalizeEndElbow({ x: 50, y: 100 }, elbow, { x: 200, y: 100 });
            expect(result.x).toBe(elbow.x);
            expect(result.y).toBe(elbow.y);
            expect(result).not.toBe(elbow);
        });

        it("already V-aligned, V neighbor → elbow coords unchanged (TALA round-trip no-op)", () => {
            const elbow = { x: 100, y: 100 };
            const result = orthogonalizeEndElbow({ x: 100, y: 50 }, elbow, { x: 100, y: 300 });
            expect(result.x).toBe(elbow.x);
            expect(result.y).toBe(elbow.y);
            expect(result).not.toBe(elbow);
        });

        it("within AXIS_EPSILON of H-aligned (sub-pixel TALA float) → elbow coords unchanged", () => {
            const elbow = { x: 100, y: 100 };
            // endpoint.y is within half AXIS_EPSILON of elbow.y → treated as aligned
            const result = orthogonalizeEndElbow({ x: 50, y: 100 + AXIS_EPSILON * 0.5 }, elbow, null);
            expect(result.x).toBe(elbow.x);
            expect(result.y).toBe(elbow.y);
            expect(result).not.toBe(elbow);
        });

    });


    ///////////////////////////////////////////////////////////////////////////
    //  5. Purity — elbow argument not mutated, fresh return object         ///
    ///////////////////////////////////////////////////////////////////////////

    describe("purity", () => {

        it("does not mutate the elbow argument (endpoint moved in X, H neighbor)", () => {
            const endpoint = { x: 50,  y: 100 };
            const elbow    = { x: 100, y: 200 };
            const neighbor = { x: 200, y: 200 };

            const elbowXBefore = elbow.x;
            const elbowYBefore = elbow.y;

            orthogonalizeEndElbow(endpoint, elbow, neighbor);

            expect(elbow.x).toBe(elbowXBefore);
            expect(elbow.y).toBe(elbowYBefore);
        });

        it("does not mutate the elbow argument (endpoint moved in Y, V neighbor)", () => {
            const endpoint = { x: 100, y: 50  };
            const elbow    = { x: 200, y: 100 };
            const neighbor = { x: 200, y: 300 };

            const elbowXBefore = elbow.x;
            const elbowYBefore = elbow.y;

            orthogonalizeEndElbow(endpoint, elbow, neighbor);

            expect(elbow.x).toBe(elbowXBefore);
            expect(elbow.y).toBe(elbowYBefore);
        });

        it("does not mutate the elbow argument (diagonal endpoint, null neighbor)", () => {
            const endpoint = { x: 60,  y: 160 };
            const elbow    = { x: 100, y: 100 };

            const elbowXBefore = elbow.x;
            const elbowYBefore = elbow.y;

            orthogonalizeEndElbow(endpoint, elbow, null);

            expect(elbow.x).toBe(elbowXBefore);
            expect(elbow.y).toBe(elbowYBefore);
        });

        it("returns a distinct object reference from elbow in every case", () => {
            const subcases = [
                // already-aligned (no-op path)
                { endpoint: { x: 50, y: 100 }, elbow: { x: 100, y: 100 }, neighbor: null },
                // snap path, null neighbor
                { endpoint: { x: 50, y: 160 }, elbow: { x: 100, y: 100 }, neighbor: null },
                // snap path, H neighbor
                { endpoint: { x: 50, y: 160 }, elbow: { x: 100, y: 100 }, neighbor: { x: 200, y: 100 } },
                // snap path, V neighbor
                { endpoint: { x: 50, y: 160 }, elbow: { x: 100, y: 100 }, neighbor: { x: 100, y: 200 } }
            ];

            for (const c of subcases) {
                const result = orthogonalizeEndElbow(c.endpoint, c.elbow, c.neighbor);
                expect(result).not.toBe(c.elbow);
            }
        });

    });

});
