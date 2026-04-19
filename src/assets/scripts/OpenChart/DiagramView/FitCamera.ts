// pattern: Functional Core
import type { CameraLocation } from "./CameraLocation";
import type { DiagramObjectView } from "./DiagramObjectView";

/**
 * Computes a camera that fits the union bounding box of `views` inside a
 * viewport of `viewportWidth` × `viewportHeight`, centered on the union's
 * centroid. Returns `null` when there are no views with a non-empty
 * bounding box — the caller is expected to fall back to a sensible default
 * (e.g. origin at 1× zoom) in that case.
 *
 * Padding is implicit: the union is scaled to fill 90% of the viewport in
 * its larger relative dimension (matching {@link MoveCameraToObjects}).
 * Zoom is capped at 1.5 so tiny single-node diagrams don't land at an
 * uncomfortable magnification.
 */
export function computeFitCamera(
    views: Iterable<DiagramObjectView>,
    viewportWidth: number,
    viewportHeight: number
): CameraLocation | null {
    if (viewportWidth <= 0 || viewportHeight <= 0) {
        return null;
    }
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    let any = false;
    for (const view of views) {
        const bb = view.face.boundingBox;
        if (bb.xMin >= bb.xMax || bb.yMin >= bb.yMax) {
            continue;
        }
        xMin = Math.min(xMin, bb.xMin);
        yMin = Math.min(yMin, bb.yMin);
        xMax = Math.max(xMax, bb.xMax);
        yMax = Math.max(yMax, bb.yMax);
        any = true;
    }
    if (!any) {
        return null;
    }
    const regionW = xMax - xMin;
    const regionH = yMax - yMin;
    const x = Math.round((xMin + xMax) / 2);
    const y = Math.round((yMin + yMax) / 2);
    const relW = regionW / viewportWidth;
    const relH = regionH / viewportHeight;
    const r = Math.max(relW, relH);
    // Divisor of 0 is impossible here (both region dimensions are strictly
    // positive since we only counted boxes where xMin<xMax and yMin<yMax).
    const k = Math.min(0.9 / r, 1.5);
    return { x, y, k };
}
