// pattern: Functional Core
import { AnchorPosition } from "../../DiagramObjectView/Faces/Blocks/AnchorPosition";

/**
 * A point in 2-D screen space (y increases downward).
 */
export type Point = {
    readonly x: number;
    readonly y: number;
};

/**
 * Minimal structural surface needed by {@link pickCardinalAnchor}.
 * Only the bounding-box corners are required; the full BlockView shape
 * is intentionally not imported here so this module stays free of any
 * view-layer coupling beyond AnchorPosition.
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
 * {@link rebindLatchToAnchor}. Intentionally empty so that any AnchorView
 * instance satisfies it without importing the concrete class.
 */
export type LinkableAnchor = object;

/**
 * Minimal structural type for a latch that can be rebound to a different
 * anchor via {@link rebindLatchToAnchor}.
 */
export interface RebindableLatch {
    readonly anchor: LinkableAnchor | null;
    link(anchor: LinkableAnchor, update?: boolean): void;
}

/**
 * Returns the cardinal anchor side of `block` that faces toward `target`.
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
 * - `|dx| > |dy|`  → right (dx ≥ 0) or left (dx < 0)
 * - `|dy| > |dx|`  → top (dy ≤ 0) or bottom (dy > 0)
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
        return dx >= 0 ? AnchorPosition.D0 : AnchorPosition.D180;
    }

    if (absDy > absDx) {
        // y increases downward, so negative dy means target is above (toward top)
        return dy <= 0 ? AnchorPosition.D90 : AnchorPosition.D270;
    }

    // Tie-break: right → top → left → bottom
    if (dx > 0) return AnchorPosition.D0;
    if (dy < 0) return AnchorPosition.D90;
    if (dx < 0) return AnchorPosition.D180;
    return AnchorPosition.D270;
}

/**
 * Detaches `latch` from its current anchor and attaches it to `newAnchor`.
 *
 * The underlying `link(anchor, update)` implementation on the latch model
 * already handles the full detach-then-attach cycle: it unlinks the old
 * anchor, sets `_anchor` to the new one, and notifies `newAnchor` to
 * register the back-reference. Passing `update = true` triggers the
 * `handleUpdate` propagation so the view recomputes immediately.
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
}
