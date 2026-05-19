import { LineFace } from "../Bases";
import { Orientation, PositionSetByUser } from "../../ViewAttributes";
import {
    getAbsoluteArrowHead,
    getAbsoluteMultiElbowPath,
    getLineHitbox,
    round,
    roundNearestMultiple
} from "@OpenChart/Utilities";
import { ListProperty } from "@OpenChart/DiagramModel";
import type { LineView } from "../../Views";
import type { GenericLineInternalState } from "./GenericLineInternalState";

// Handle positions originate from TALA's `parseFloat`'d SVG vertices; snap
// equality to an epsilon so fractional-pixel outputs classify as axis-aligned.
export const AXIS_EPSILON = 1e-6;

/**
 * Applies a horizontal two-elbow layout to a line.
 * @param view
 *  The line's view.
 * @param face
 *  The line's face.
 */
export function runHorizontalTwoElbowLayout(
    view: LineView,
    face: GenericLineInternalState
) {
    const
        src = view.node1,
        hdl = view.handles[0],
        trg = view.node2,
        sx = src.x,
        sy = src.y,
        tx = trg.x,
        ty = trg.y,
        mx = roundNearestMultiple((sx + tx) / 2, face.grid[0]),
        my = round((sy + ty) / 2);

    // Retain the reference handle, drop all others
    view.dropHandles(1);

    // Adjust handle
    hdl.orientation = Orientation.D0;
    hdl.userSetPosition &= PositionSetByUser.xAxis;
    if (!hdl.userSetPosition) {
        hdl.face.moveBy(mx - hdl.x, 0);
    }
    hdl.face.moveBy(0, my - hdl.y);
    const hx = hdl.x;

    // Apply cap space toward the handle — not toward the other endpoint — so
    // that when both anchors sit on the same face (both left or both right),
    // the source's first segment exits away from its block instead of back
    // through it.  Only the exit-from-source and approach-to-target cap
    // offsets matter for whether the segment clears the block.
    const bx = axisCapTowards(sx, hx, face.style.capSpace);
    const ex = axisCapTowards(tx, hx, face.style.capSpace);

    // Define vertices
    let vertices;
    if (sy === ty) {
        vertices = [bx, sy, ex, ty];
    } else if (sx === hx) {
        vertices = [bx, sy, hx, ty, ex, ty];
    } else if (tx === hx) {
        vertices = [bx, sy, hx, sy, ex, ty];
    } else {
        vertices = [bx, sy, hx, sy, hx, ty, ex, ty];
    }

    // Update latches
    src.orientation = Orientation.D0;
    trg.orientation = Orientation.D0;

    // Update points
    if (vertices.length === 4 && face.points.length !== 2) {
        face.points = [src, trg];
    } else if (4 < vertices.length && face.points.length !== 3) {
        face.points = [src, hdl, trg];
    }

    // Run layout
    runMultiElbowLayout(view, face, vertices);

}

/**
 * Applies a vertical two-elbow layout to a line.
 * @param view
 *  The line's view.
 * @param face
 *  The line's face.
 */
export function runVerticalTwoElbowLayout(
    view: LineView,
    face: GenericLineInternalState
) {
    const
        src = view.node1,
        hdl = view.handles[0],
        trg = view.node2,
        sx = src.x,
        sy = src.y,
        tx = trg.x,
        ty = trg.y,
        mx = round((sx + tx) / 2),
        my = roundNearestMultiple((sy + ty) / 2, face.grid[1]);

    // Retain the reference handle, drop all others
    view.dropHandles(1);

    // Adjust handle
    hdl.orientation = Orientation.D90;
    hdl.userSetPosition &= PositionSetByUser.yAxis;
    if (!hdl.userSetPosition) {
        hdl.face.moveBy(0, my - hdl.y);
    }
    hdl.face.moveBy(mx - hdl.x, 0);
    const hy = hdl.y;

    // Update points
    if (face.points.length !== 3) {
        face.points = [src, hdl, trg];
    }

    // Apply cap space toward the handle — mirror of the horizontal case,
    // applied on the y-axis.  Both anchors on the same face (both top or both
    // bottom) would otherwise cause the source's first segment to reverse into
    // its own block.
    const by = axisCapTowards(sy, hy, face.style.capSpace);
    const ey = axisCapTowards(ty, hy, face.style.capSpace);

    // Define vertices
    let vertices;
    if (sx === tx) {
        vertices = [sx, by, tx, ey];
    } else if (sy === hy) {
        vertices = [sx, by, tx, hy, tx, ey];
    } else if (ty === hy) {
        vertices = [sx, by, sx, hy, tx, ey];
    } else {
        vertices = [sx, by, sx, hy, tx, hy, tx, ey];
    }

    // Update latches
    src.orientation = Orientation.D90;
    trg.orientation = Orientation.D90;

    // Update points
    if (vertices.length === 4 && face.points.length !== 2) {
        face.points = [src, trg];
    } else if (4 < vertices.length && face.points.length !== 3) {
        face.points = [src, hdl, trg];
    }

    // Run layout
    runMultiElbowLayout(view, face, vertices);
}

/**
 * Applies a horizontal elbow layout to a line.
 * @param view
 *  The line's view.
 * @param face
 *  The line's face.
 */
export function runHorizontalElbowLayout(
    view: LineView,
    face: GenericLineInternalState
) {
    const
        src = view.node1,
        hdl = view.handles[0],
        trg = view.node2,
        sx = src.x,
        sy = src.y,
        tx = trg.x,
        ty = trg.y;

    // Retain the reference handle, drop all others
    view.dropHandles(1);

    // Adjust handle
    hdl.orientation = Orientation.Unknown;
    hdl.userSetPosition = PositionSetByUser.False;
    hdl.face.moveTo(tx, ty);

    // Update points
    if (face.points.length !== 2) {
        face.points = [src, trg];
    }

    // Calculate vertices
    let vertices;
    if (sx === tx) {
        // Apply cap space
        const [by, ey] = oneAxisCapSpace(sy, ty, face.style.capSpace);
        // Define vertices
        vertices = [sx, by, tx, ey];
    } else if (sy === ty) {
        // Apply cap space
        const [bx, ex] = oneAxisCapSpace(sx, tx, face.style.capSpace);
        // Define vertices
        vertices = [bx, sy, ex, ty];
    } else {
        // Apply cap space
        const [bx, ey] = twoAxisCapSpace(sx, tx, sy, ty, face.style.capSpace);
        // Define vertices
        vertices = [bx, sy, tx, sy, tx, ey];
    }

    // Update latches
    src.orientation = Orientation.D0;
    trg.orientation = Orientation.D90;

    // Run layout
    runMultiElbowLayout(view, face, vertices);

}

/**
 * Applies a vertical elbow layout to a line.
 * @param view
 *  The line's view.
 * @param face
 *  The line's face.
 */
export function runVerticalElbowLayout(
    view: LineView,
    face: GenericLineInternalState
) {
    const
        src = view.node1,
        hdl = view.handles[0],
        trg = view.node2,
        sx = src.x,
        sy = src.y,
        tx = trg.x,
        ty = trg.y;

    // Retain the reference handle, drop all others
    view.dropHandles(1);

    // Adjust handle
    hdl.orientation = Orientation.Unknown;
    hdl.userSetPosition = PositionSetByUser.False;
    hdl.face.moveTo(tx, ty);

    // Update points
    if (face.points.length !== 2) {
        face.points = [src, trg];
    }

    // Calculate vertices
    let vertices;
    if (sx === tx) {
        // Apply cap space
        const [by, ey] = oneAxisCapSpace(sy, ty, face.style.capSpace);
        // Calculate vertices
        vertices = [sx, by, tx, ey];
    } else if (sy === ty) {
        // Apply cap space
        const [bx, ex] = oneAxisCapSpace(sx, tx, face.style.capSpace);
        // Calculate vertices
        vertices = [bx, sy, ex, ty];
    } else {
        // Apply cap space
        const [ex, by] = twoAxisCapSpace(tx, sx, ty, sy, face.style.capSpace);
        // Calculate vertices
        vertices = [sx, by, sx, ty, ex, ty];
    }

    // Update latches
    src.orientation = Orientation.D90;
    trg.orientation = Orientation.D0;

    // Run layout
    runMultiElbowLayout(view, face, vertices);

}

/**
 * Applies a multi-elbow layout to a line.
 * @remarks
 *  This function takes a set of raw vertices, derived from a collection of
 *  handles and latches, and adjusts their positions to ensure they are
 *  properly centered within these elements when the line is rendered. After
 *  aligning the vertices, the function uses `getAbsoluteMultiElbowPath()` to
 *  generate the final set of vertices which curve the line's corners. These
 *  final vertices are then applied to the provided `face`.
 *
 *  Consumers: the four DynamicLine layout strategies in this file, and the
 *  PolyLine face (`PolyLine.calculateLayout` feeds an N+2-point vertex list
 *  built from `[src, ...handles, trg]`).  The `face` argument must satisfy
 *  the {@link GenericLineInternalState} structural shape — both faces hold
 *  matching private fields and pass `this as unknown as GenericLineInternalState`.
 * @param view
 *  The line's view (for reading ref array properties).
 * @param face
 *  The line's face.
 * @param vertices
 *  The line's raw vertices.
 *
 *  For best results, deduplicate consecutive vertices.
 *   - `[0,0, 0,1, 0,0]` is acceptable.
 *   - `[0,0, 0,1, 0,1, 1,1]` should be simplified to `[0,0, 0,1, 1,1]`.
 */
export function runMultiElbowLayout(
    view: LineView,
    face: GenericLineInternalState,
    vertices: number[]
) {
    const v = vertices;
    const offset = LineFace.markerOffset;

    // Update hitboxes
    const hitboxes = (v.length >> 1) - 1;
    face.hitboxes
        = face.hitboxes.length === hitboxes
            ? face.hitboxes : new Array(hitboxes);
    const h = face.hitboxes;

    // Prepare transform
    const t = new Array(v.length);

    // Calculate start vertex
    let lx = 0, ly = 1, nx = 2, ny = 3;
    if (v[lx] === v[nx]) {
        t[lx] = v[lx] + offset;
        t[ly] = v[ly] < v[ny] ? v[ly] + (offset << 1) : v[ly];
    } else {
        t[lx] = v[lx] < v[nx] ? v[lx] + (offset << 1) : v[lx];
        t[ly] = v[ly] + offset;
    }

    // Calculate mid-vertices
    const length = v.length - 2;
    for (; nx < length; lx += 2, ly += 2, nx += 2, ny += 2) {
        // Calculate hitbox
        h[lx >> 1] = getLineHitbox(
            v[lx], v[ly],
            v[nx], v[ny],
            face.style.hitboxWidth
        );
        // Calculate mid-vertex
        t[nx] = v[nx] + offset;
        t[ny] = v[ny] + offset;
    }

    // Calculate hitbox
    h[lx >> 1] = getLineHitbox(
        v[lx], v[ly],
        v[nx], v[ny],
        face.style.hitboxWidth
    );

    // Calculate end vertex
    if (v[lx] === v[nx]) {
        t[nx] = v[nx] + offset;
        t[ny] = v[ly] < v[ny] ? v[ny] : v[ny] + (offset << 1);
    } else {
        t[nx] = v[lx] < v[nx] ? v[nx] : v[nx] + (offset << 1);
        t[ny] = v[ny] + offset;
    }

    // Read the Line's two ref arrays to determine arrow placement
    const props = view.properties.value;
    const node1Refs = props.get("node1_src_data_item_refs");
    const node2Refs = props.get("node2_src_data_item_refs");
    const hasNode1Src = node1Refs instanceof ListProperty && node1Refs.value.size > 0;
    const hasNode2Src = node2Refs instanceof ListProperty && node2Refs.value.size > 0;

    // Arrow at node2 end (data flowing node1 → node2)
    if (hasNode1Src) {
        face.arrowAtNode2 = getAbsoluteArrowHead(
            t[lx], t[ly],
            t[nx], t[ny],
            face.style.capSize
        );
    } else {
        face.arrowAtNode2 = null;
    }

    // Arrow at node1 end (data flowing node2 → node1)
    if (hasNode2Src) {
        face.arrowAtNode1 = getAbsoluteArrowHead(
            t[2], t[3],
            t[0], t[1],
            face.style.capSize
        );
    } else {
        face.arrowAtNode1 = null;
    }

    // Apply cap-size offset to inset line endpoints when arrows are present
    if (hasNode1Src) {
        // Cap offset at node2 end (where the arrow tip is)
        if (v[lx] === v[nx]) {
            t[ny] -= Math.sign(t[ny] - t[ly]) * (face.style.capSize >> 1);
        } else {
            t[nx] -= Math.sign(t[nx] - t[lx]) * (face.style.capSize >> 1);
        }
    }

    if (hasNode2Src) {
        // Cap offset at node1 end — endpoint moves toward the inner vertex t[2],t[3], mirroring
        // the node2-end formula. `-= sign(endpoint - inner) * half` steps the endpoint one half
        // cap-size toward the adjacent vertex (for t[0] < t[2], sign is -1 and -= negates to +=).
        if (t[0] === t[2]) {
            t[1] -= Math.sign(t[1] - t[3]) * (face.style.capSize >> 1);
        } else {
            t[0] -= Math.sign(t[0] - t[2]) * (face.style.capSize >> 1);
        }
    }

    // Set vertices
    face.vertices = getAbsoluteMultiElbowPath(
        t, face.style.borderRadius
    );

}

/**
 * Returns the corrected position of the elbow adjacent to a moved endpoint so
 * that the endpoint→elbow segment is axis-aligned, choosing the snap axis that
 * preserves the elbow→neighbor segment's existing axis (H/V alternation).
 *
 * Policy A (snap-elbow, plan.md): the elbow slides onto the endpoint's row or
 * column. No handle insertion. Pure — caller writes the result to model state.
 *
 * Axis-selection rules:
 * - If `elbow → neighbor` is currently horizontal (`|elbow.y − neighbor.y| <
 *   AXIS_EPSILON`), the next segment is H, so the end segment must be V →
 *   snap `elbow.x = endpoint.x` (keep `elbow.y`).
 * - If `elbow → neighbor` is currently vertical (`|elbow.x − neighbor.x| <
 *   AXIS_EPSILON`), the next segment is V, so the end segment must be H →
 *   snap `elbow.y = endpoint.y` (keep `elbow.x`).
 * - **Fallback** (neighbor is null, or elbow→neighbor is diagonal/degenerate):
 *   snap on the axis of the larger endpoint→elbow displacement — if
 *   `|endpoint.x − elbow.x| >= |endpoint.y − elbow.y|` make the end segment
 *   horizontal: `elbow.y = endpoint.y`; else vertical: `elbow.x = endpoint.x`.
 * - If the end segment is already axis-aligned (within `AXIS_EPSILON`), the
 *   elbow is returned unchanged — this is the TALA-route no-op case.
 * - **Degenerate neighbor-snap:** when the endpoint is already aligned with the
 *   neighbor on the chosen axis (e.g. H neighbor at the same y as the endpoint),
 *   the resulting elbow position is coincident with the neighbor and the
 *   `elbow→neighbor` segment degenerates to zero length. This is correct per the
 *   axis-preservation rule; de-duplication of coincident vertices is the caller's
 *   responsibility (Step 2 / #18).
 *
 * @param endpoint  The moved endpoint (latch) position.
 * @param elbow     The current adjacent interior handle position.
 * @param neighbor  The vertex beyond the elbow (the next handle, or the far
 *                   endpoint if the elbow is the only interior vertex), or null
 *                   if there is no meaningful neighbor.
 * @returns         The corrected elbow position `{ x, y }`, or `null` if the
 *                   end segment is already axis-aligned (the TALA no-op case).
 *                   When a non-null value is returned it is always a fresh
 *                   object — the `elbow` argument is never mutated.
 */
export function orthogonalizeEndElbow(
    endpoint: { x: number, y: number },
    elbow: { x: number, y: number },
    neighbor: { x: number, y: number } | null
): { x: number, y: number } | null {
    const dx = endpoint.x - elbow.x;
    const dy = endpoint.y - elbow.y;

    // Already axis-aligned on either axis — no correction needed (TALA no-op
    // case).  The OR is intentional: if the end segment is within AXIS_EPSILON
    // of H or V on either axis, the span classifier will still accept it, so
    // we leave the elbow unchanged rather than applying a sub-pixel nudge.
    if (Math.abs(dx) < AXIS_EPSILON || Math.abs(dy) < AXIS_EPSILON) {
        return null;
    }

    // Determine target axis from the elbow→neighbor segment's existing axis,
    // if the neighbor is available and the segment is clearly H or V.
    if (neighbor !== null) {
        const ndx = neighbor.x - elbow.x;
        const ndy = neighbor.y - elbow.y;
        const neighborIsH = Math.abs(ndy) < AXIS_EPSILON && Math.abs(ndx) >= AXIS_EPSILON;
        const neighborIsV = Math.abs(ndx) < AXIS_EPSILON && Math.abs(ndy) >= AXIS_EPSILON;

        if (neighborIsH) {
            // Next segment is H → end segment must be V: snap elbow.x = endpoint.x.
            return { x: endpoint.x, y: elbow.y };
        }
        if (neighborIsV) {
            // Next segment is V → end segment must be H: snap elbow.y = endpoint.y.
            return { x: elbow.x, y: endpoint.y };
        }
    }

    // Fallback: neighbor is null or elbow→neighbor is diagonal/degenerate.
    // Snap on the axis of the larger endpoint→elbow displacement so the
    // visibly longer end segment becomes the straight one.
    if (Math.abs(dx) >= Math.abs(dy)) {
        // Larger displacement on X → make end segment horizontal.
        return { x: elbow.x, y: endpoint.y };
    } else {
        // Larger displacement on Y → make end segment vertical.
        return { x: endpoint.x, y: elbow.y };
    }
}

/**
 * Applies cap space to a source and target coordinate on the same axis.
 * @param s
 *  The source coordinate.
 * @param t
 *  The target coordinate.
 * @param c
 *  The cap space.
 * @returns
 *  The adjusted source and target coordinates.
 */
function oneAxisCapSpace(s: number, t: number, c: number) {
    const d = t - s;
    if (c << 1 < Math.abs(d)) {
        const cs = Math.sign(d) * c;
        return [s + cs, t - cs];
    } else {
        return [s, t];
    }
}

/**
 * Applies cap space to a single endpoint, offset toward an adjacent vertex.
 * @remarks
 *  The two-elbow layouts use this to position the cap offset in the direction
 *  the first / last segment actually travels — which is `endpoint → handle`,
 *  not `source → target`.  The distinction matters when both anchors sit on
 *  the same face of their respective blocks: `oneAxisCapSpace` would push the
 *  source's cap back into its own block instead of out past its face.
 * @param p
 *  The endpoint coordinate to offset.
 * @param q
 *  The adjacent vertex coordinate (the direction to offset toward).
 * @param c
 *  The cap space.
 * @returns
 *  The offset endpoint coordinate, or `p` unchanged if `q` is within `c`.
 */
function axisCapTowards(p: number, q: number, c: number) {
    const d = q - p;
    if (c < Math.abs(d)) {
        return p + Math.sign(d) * c;
    }
    return p;
}

/**
 * Applies cap space to a source and target coordinate on two axises.
 * @param s1
 *  The source coordinate on axis 1.
 * @param t1
 *  The target coordinate on axis 1.
 * @param s2
 *  The source coordinate on axis 2.
 * @param t2
 *  The target coordinate on axis 2.
 * @param c
 *  The cap space.
 * @returns
 *  The adjusted source (axis 1) and target (axis 2) coordinates.
 */
function twoAxisCapSpace(s1: number, t1: number, s2: number, t2: number, c: number) {
    const d1 = t1 - s1;
    const d2 = t2 - s2;
    let s = s1, e = t2;
    if (c < Math.abs(d1)) {
        s += Math.sign(d1) * c;
    }
    if (c < Math.abs(d2)) {
        e -= Math.sign(d2) * c;
    }
    return [s, e];
}
