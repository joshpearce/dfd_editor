// pattern: Functional Core
import { AnchorPosition } from "../../DiagramObjectView/Faces/Blocks/AnchorPosition";

/**
 * A point in 2-D screen space (y increases downward).
 *
 * @public Re-used in the engine for target-point arguments passed to
 * {@link pickCardinalAnchor}; named explicitly so Step 2 readers have a
 * stable vocabulary instead of inline object literals.
 */
export type Point = {
    readonly x: number;
    readonly y: number;
};

/**
 * Minimal structural surface needed by {@link pickCardinalAnchor}.
 * Only the bounding-box corners are required; the full `BlockView` shape
 * is intentionally NOT imported here (deliberate decoupling) so this module
 * stays free of any view-layer coupling beyond AnchorPosition.
 */
export interface CardinalBlockSurface {
    readonly face: {
        readonly boundingBox: {
            readonly xMin: number;
            readonly xMax: number;
            readonly yMin: number;
            readonly yMax: number;
        };
    };
}

/**
 * Minimal structural type for an anchor object that can be the target of
 * {@link rebindLatchToAnchor}. Requires the `link` method and a readable
 * (x, y) position — the position is used to move the rebound latch to
 * the anchor's location (anchors do not automatically drag newly-linked
 * latches to their position, only latches linked *before* the anchor
 * moves).  `AnchorView` itself is NOT imported here (deliberate decoupling).
 */
export interface LinkableAnchor {
    readonly x: number;
    readonly y: number;
    link(latch: RebindableLatch, update?: boolean): void;
}

/**
 * Minimal structural type for a latch that can be rebound to a different
 * anchor via {@link rebindLatchToAnchor}. `LatchView` is NOT imported here
 * (deliberate decoupling) — only the structural contract is captured.
 * `moveTo` is required so the rebind pass can snap the latch's view face
 * to the new anchor's position (the model-level `link` does not move the
 * view).
 */
export interface RebindableLatch {
    readonly anchor: LinkableAnchor | null;
    link(anchor: LinkableAnchor, update?: boolean): void;
    moveTo(x: number, y: number): void;
}

/**
 * A block surface that exposes every anchor's position — used by
 * {@link pickNearestAnchor} so it can pick from the full anchor grid
 * (12 positions: 4 cardinal midpoints plus 8 face-quarter positions) rather
 * than only the 4 cardinals that {@link pickCardinalAnchor} returns.
 *
 * Only structural — concrete `BlockView` / `AnchorView` types are not
 * imported here (deliberate decoupling).
 */
export interface AnchoredBlockSurface {
    /**
     * Map key is the string value of an `AnchorPosition` enum member
     * (e.g. `"0"`, `"30"`, `"60"`, … `"330"`).
     */
    readonly anchors: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

/**
 * Returns the anchor on `block` whose (x, y) position is Euclidean-closest
 * to `target`. Considers every anchor in `block.anchors` — typically all 12
 * positions a block carries (cardinals + face quarters), so the returned
 * anchor can land on any of the three positions along any face rather than
 * only the face midpoints that {@link pickCardinalAnchor} picks from.
 *
 * Used by the TALA rebind pass to align a latch with TALA's actual edge
 * endpoint on a block's perimeter, which often lies at a quarter rather
 * than the midpoint.
 *
 * Ties (two anchors at the same distance) are broken by iteration order
 * of the `anchors` map — insertion order in practice, which mirrors the
 * order in `AnchorPosition`.
 *
 * @param block  - Block whose anchors to consider.
 * @param target - Point in the same coordinate space as the anchor positions.
 * @returns The key of the closest anchor (an `AnchorPosition` enum string),
 *          or `null` if `block.anchors` is empty.
 */
export function pickNearestAnchor(
    block: AnchoredBlockSurface,
    target: Point
): AnchorPosition | null {
    let bestKey: string | null = null;
    let bestDistSq = Infinity;
    for (const [key, anchor] of block.anchors) {
        const dx = anchor.x - target.x;
        const dy = anchor.y - target.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestKey = key;
        }
    }
    return bestKey as AnchorPosition | null;
}

/**
 * Returns the cardinal anchor side of `block` that faces toward `target`.
 *
 * **Design note — center-based direction, not nearest-side:**
 * The helper picks the side that faces the target *from the block center*
 * (i.e. the cardinal direction of `target − center`), NOT the
 * perpendicularly-nearest side of the bounding box. This is deliberate and is
 * the semantic required by both the "geometric" (Step 2) and "TALA" (Step 4)
 * strategies: for non-overlapping blocks the geometric case reduces to
 * center-to-center direction, and TALA endpoints on the perimeter are
 * resolved correctly by this rule too. The nearest-side interpretation would
 * be wrong — for example a target at (600, 20) relative to a wide, short
 * block centered at (0, 0) with hw=500/hh=10 is nearest the bottom face
 * (|dy−10|=10) yet should be anchored on the right (|dx|=600 >> |dy|=20).
 *
 * The four cardinal positions map as follows (screen coordinates, y grows
 * downward):
 * - `D0`   — right  (east)
 * - `D90`  — top    (north, because y is smaller toward the top of the screen)
 * - `D180` — left   (west)
 * - `D270` — bottom (south)
 *
 * **Selection logic:**
 * Compute `dx = target.x − center.x` and `dy = target.y − center.y`.
 * - `|dx| > |dy|`  → right (dx > 0) or left (dx < 0)
 * - `|dy| > |dx|`  → top (dy < 0) or bottom (dy > 0)
 * - Tie (`|dx| == |dy|` or `dx == 0 && dy == 0`) → first matching rule in
 *   the priority order **right → top → left → bottom**:
 *   - dx > 0         → right
 *   - dy < 0 (dx ≤ 0) → top
 *   - dx < 0 (dy ≥ 0) → left
 *   - else            → bottom
 *
 * @param block  - Block whose anchor side to pick.
 * @param target - Point in the same coordinate space as `block.face.boundingBox`.
 * @returns One of the four cardinal {@link AnchorPosition} values.
 */
export function pickCardinalAnchor(
    block: CardinalBlockSurface,
    target: Point
): AnchorPosition {
    const { xMin, xMax, yMin, yMax } = block.face.boundingBox;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;

    const dx = target.x - cx;
    const dy = target.y - cy;

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Center (dx == 0 && dy == 0) → right (first in tie order)
    if (absDx === 0 && absDy === 0) {
        return AnchorPosition.D0;
    }

    if (absDx > absDy) {
        // Inside absDx > absDy, dx cannot be zero, so strict comparison is exact.
        return dx > 0 ? AnchorPosition.D0 : AnchorPosition.D180;
    }

    if (absDy > absDx) {
        // y increases downward, so negative dy means target is above (toward top).
        // Inside absDy > absDx, dy cannot be zero, so strict comparison is exact.
        return dy < 0 ? AnchorPosition.D90 : AnchorPosition.D270;
    }

    // Tie-break: right → top → left → bottom
    if (dx > 0) { return AnchorPosition.D0; }
    if (dy < 0) { return AnchorPosition.D90; }
    if (dx < 0) { return AnchorPosition.D180; }
    return AnchorPosition.D270;
}

/**
 * Detaches `latch` from its current anchor and attaches it to `newAnchor`.
 *
 * Delegates to `LatchView.link(newAnchor, true)`, which performs a full
 * detach+attach (see DiagramModel's Latch).
 *
 * @param latch     - The latch to rebind.
 * @param newAnchor - The anchor to attach the latch to.
 */
export function rebindLatchToAnchor(
    latch: RebindableLatch,
    newAnchor: LinkableAnchor
): void {
    // No-op when already linked — avoids firing unnecessary handleUpdate
    // events and triggering unrelated view recalculations.
    if (latch.anchor === newAnchor) {
        return;
    }
    latch.link(newAnchor, true);
    // `link` only updates the model association; anchors drag linked
    // latches on `moveBy`, but do NOT snap a newly-linked latch to
    // their own position.  Without this move, the line keeps rendering
    // from the old anchor's coordinates — which looks like the rebind
    // did nothing.
    latch.moveTo(newAnchor.x, newAnchor.y);
}
