import { LineFace } from "../Bases";
import { DiagramFace } from "../DiagramFace";
import { findUnlinkedObjectAt } from "../../ViewLocators";
import {
    doRegionsOverlap,
    drawAbsoluteMultiElbowPath,
    drawAbsolutePolygon,
    drawBoundingRegion,
    isInsideRegion
} from "@OpenChart/Utilities";
import { AXIS_EPSILON, orthogonalizeEndElbow, runMultiElbowLayout } from "./LineLayoutStrategies";
import { PolyLineSpanView } from "./PolyLineSpanView";
import type { LineStyle } from "../Styles";
import type { BoundingBox } from "../BoundingBox";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";
import type { DiagramObjectView, HandleView, HitTarget, LatchView } from "../../Views";
import type { GenericLineInternalState } from "./GenericLineInternalState";

/**
 * A {@link LineFace} that renders an arbitrary-vertex polyline whose interior
 * vertices each correspond to a real, stored, user-draggable handle.
 *
 * Where {@link DynamicLine} parameterises an L- or Z-shape from a single
 * waypoint and computes the intermediate corners on every layout tick,
 * PolyLine draws `M src_anchor L handles[0] L handles[1] … L trg_anchor`
 * verbatim.  This is what lets TALA's multi-bend routes survive auto-layout
 * import: every TALA polyline vertex becomes a handle the renderer reads
 * straight back out (see `docs/implementation-plans/2026-04-23-polyline-face.md`).
 *
 * Face selection is inferred from handle count rather than declared in the
 * theme — see `DiagramObjectViewFactory` and the auto-layout engine.  A line
 * with `handles.length >= 2` is rendered by PolyLine; otherwise DynamicLine.
 *
 * The `private` field set mirrors {@link DynamicLine} exactly so tests reach
 * internal state via `face as unknown as GenericLineInternalState` (the same
 * pattern `DynamicLine.spec.ts` uses).
 */
export class PolyLine extends LineFace {

    private readonly style: LineStyle;
    private readonly grid: [number, number];

    private points: DiagramObjectView[];
    private vertices: number[];
    private arrowAtNode1: number[] | null;
    private arrowAtNode2: number[] | null;
    private hitboxes: number[][];
    private spans: PolyLineSpanView[];
    /**
     * Cached two-element array of the end latches, used by {@link getObjectAt}
     * to avoid a new allocation on every hit-test call.  Populated in
     * {@link calculateLayout}; mirrors how `this.points`, `this.hitboxes`, and
     * `this.spans` are already cached.
     */
    private latchEndpoints: DiagramObjectView[];

    constructor(style: LineStyle, grid: [number, number]) {
        super();
        this.style = style;
        this.grid = grid;
        this.points = [];
        this.vertices = [];
        this.arrowAtNode1 = null;
        this.arrowAtNode2 = null;
        this.hitboxes = [];
        this.spans = [];
        this.latchEndpoints = [];
    }

    /**
     * Returns the topmost view at the specified coordinate.
     *
     * Behavior changes from the original `DynamicLine`-mirroring logic:
     *
     * 1. Point hit-testing only considers the two end latches (`node1`,
     *    `node2`).  Interior handle dots still render when the line is focused
     *    (they're in `this.points` for `renderTo`), but they are excluded from
     *    hit-testing because point-drag is disabled for PolyLine.  Interior
     *    handles are positional anchors driven by span-drag, not independent
     *    drag targets — letting them be grabbed would allow free 2-D movement
     *    that breaks the H/V alternation invariant.
     *
     * 2. Interior hitboxes (`0 < i < hitboxes.length - 1`) return the matching
     *    {@link PolyLineSpanView} rather than the raw handle.  The span is
     *    looked up by searching `this.spans` for the entry whose flanking
     *    handles match `handles[i-1]` and `handles[i]` — a defensive O(k)
     *    scan that stays correct even if a diagonal segment was skipped during
     *    span classification (which TALA never produces, but the classifier
     *    guards against it).  If no matching span exists, the line view itself
     *    is returned as a safe fallback.
     *
     * 3. End hitboxes (`i === 0` or `i === hitboxes.length - 1`) still return
     *    `this.view` (the line) — matching `DynamicLine` and preserving the
     *    "dragging an end segment selects the whole line" UX.
     */
    public getObjectAt(x: number, y: number): HitTarget | undefined {
        // Only test the two end latches — interior handle dots are rendered but
        // are not drag targets (point-drag is disabled for PolyLine).
        // latchEndpoints contains only LatchView instances — never LineViews —
        // so the result is always DiagramObjectView | undefined.
        const obj = findUnlinkedObjectAt(this.latchEndpoints, x, y) as DiagramObjectView | undefined;
        if (obj) {
            return obj;
        }
        if (this.isAnchored()) {
            // Dead-zone fix: clicks within the visible handle-dot radius of an
            // interior handle resolve to an adjacent span, not to undefined.
            // Strict-inequality hitboxes leave a ~1px gap at each H/V corner
            // that sits inside the visible dot area; catch those here before the
            // main hitbox scan.
            for (let h = 0; h < this.view.handles.length; h++) {
                const handle = this.view.handles[h];
                if (DiagramFace.isInsideMarkerDot(handle.x, handle.y, x, y, handle.face.radius)) {
                    // Prefer the span whose handleB === handle (the segment
                    // ending at this handle), falling back to the span starting
                    // at it.  Deterministic: iteration order reads forward.
                    const span =
                        this.spans.find(s => s.handleB === handle) ??
                        this.spans.find(s => s.handleA === handle);
                    if (span) { return span; }
                }
            }

            for (let i = 0; i < this.hitboxes.length; i++) {
                if (!isInsideRegion(x, y, this.hitboxes[i])) {
                    continue;
                }
                if (0 < i && i < this.hitboxes.length - 1) {
                    // Interior hitbox: resolve to the span for this segment.
                    // Defensive lookup: find the span whose flanking handles
                    // match handles[i-1] and handles[i].  This stays correct
                    // even when a diagonal segment was skipped in span
                    // classification (no span for that gap), in which case we
                    // fall through to the line view as a safe fallback.
                    const handleA = this.view.handles[i - 1];
                    const handleB = this.view.handles[i];
                    const span = this.spans.find(
                        s => s.handleA === handleA && s.handleB === handleB
                    );
                    // If no span matches (diagonal segment skipped during
                    // classification — defensive only, TALA never produces
                    // diagonals), fall through to the line view.  Silent because
                    // getObjectAt runs on every hover tick.
                    return span ?? this.view;
                } else {
                    return this.view;
                }
            }
        } else {
            for (const hitbox of this.hitboxes) {
                if (isInsideRegion(x, y, hitbox)) {
                    return this.view;
                }
            }
        }
        return undefined;
    }

    public calculateLayout(): boolean {
        const src = this.view.node1;
        const trg = this.view.node2;
        const handles = this.view.handles;
        // Defensive bail — PolyLine is only instantiated for lines that
        // already carry two or more handles, but the face swap can run
        // mid-construction (e.g. an import that has restored the line but
        // not yet attached its handles).
        if (!src || !trg || handles.length === 0) {
            return false;
        }

        this.points = [src, ...handles, trg];
        // Cache the two end latches so getObjectAt can reuse the same array
        // instead of allocating [node1, node2] on every hit-test call.
        this.latchEndpoints = [src, trg];

        // --- Policy A: snap-elbow end-segment orthogonality (issue #19) -------
        this.orthogonalizeEndElbows(src, trg, handles);
        // --- end issue #19 correction -----------------------------------------

        const vertices = this.points.flatMap(p => [p.x, p.y]);

        runMultiElbowLayout(this.view, this as unknown as GenericLineInternalState, vertices);

        // Rebuild spans: one per axis-aligned interior segment (handles[i] → handles[i+1]).
        // points = [src, ...handles, trg], so hitboxes[i+1] is the segment
        // between points[i+1] (= handles[i]) and points[i+2] (= handles[i+1]).
        this.spans = [];
        for (let i = 0; i < handles.length - 1; i++) {
            const a = handles[i];
            const b = handles[i + 1];
            let axis: "H" | "V";
            if (Math.abs(a.y - b.y) < AXIS_EPSILON) {
                axis = "H";
            } else if (Math.abs(a.x - b.x) < AXIS_EPSILON) {
                axis = "V";
            } else {
                continue;
            }
            this.spans.push(new PolyLineSpanView(this.view, a, b, axis, [...this.hitboxes[i + 1]]));
        }

        this.calculateBoundingBoxFromViews(this.points);
        this.boundingBox.x = this.boundingBox.xMid;
        this.boundingBox.y = this.boundingBox.yMid;

        return true;
    }

    /**
     * Applies Policy A end-segment orthogonality correction (issue #19):
     * snaps each end elbow onto the adjacent endpoint's row or column so
     * that every end segment is H or V before the span-classification loop.
     *
     * Positions are written via `handle.face.moveTo` (face-layer path) to
     * bypass the `LineView.handleUpdate → dropHandles` cascade that the
     * high-level `handle.moveTo` would trigger (see OpenChart CLAUDE.md).
     *
     * `n === 1` (single handle): source and target ends share the same
     * handle.  The source correction is applied first; the target correction
     * then uses `src` as its neighbor.  On a true-diagonal single-handle
     * route the two corrections may conflict — this is the documented
     * best-effort; issue #18 owns any residual off-axis segments.
     *
     * @param src      The source latch.
     * @param trg      The target latch.
     * @param handles  The line's interior handles (at least one).
     */
    private orthogonalizeEndElbows(
        src: LatchView,
        trg: LatchView,
        handles: ReadonlyArray<HandleView>
    ): void {
        const n = handles.length;

        // Source end: endpoint = src, elbow = handles[0],
        // neighbor = handles[1] if it exists, else trg.
        const srcElbow = handles[0];
        const srcNeighbor = n > 1 ? handles[1] : trg;
        const corrSrc = orthogonalizeEndElbow(src, srcElbow, srcNeighbor);
        if (corrSrc !== null) {
            srcElbow.face.moveTo(corrSrc.x, corrSrc.y);
        }

        // Target end: endpoint = trg, elbow = handles[n-1],
        // neighbor = handles[n-2] if it exists, else src.
        const trgElbow = handles[n - 1];
        const trgNeighbor = n > 1 ? handles[n - 2] : src;
        const corrTrg = orthogonalizeEndElbow(trg, trgElbow, trgNeighbor);
        if (corrTrg !== null) {
            trgElbow.face.moveTo(corrTrg.x, corrTrg.y);
        }
    }

    public renderTo(
        ctx: CanvasRenderingContext2D,
        region: ViewportRegion, settings: RenderSettings
    ): void {
        if (!this.isVisible(region)) {
            return;
        }

        const { width, color, selectColor } = this.style;

        ctx.lineWidth = width;
        if (this.view.focused) {
            if (settings.animationsEnabled) {
                ctx.setLineDash([5, 2]);
            }
            ctx.fillStyle = selectColor;
            ctx.strokeStyle = selectColor;
        } else {
            ctx.fillStyle = color;
            ctx.strokeStyle = color;
        }

        drawAbsoluteMultiElbowPath(ctx, this.vertices);
        ctx.stroke();
        ctx.setLineDash([]);

        if (this.arrowAtNode1 !== null) {
            drawAbsolutePolygon(ctx, this.arrowAtNode1);
            ctx.fill();
        }
        if (this.arrowAtNode2 !== null) {
            drawAbsolutePolygon(ctx, this.arrowAtNode2);
            ctx.fill();
        }

        if (this.view.focused) {
            for (const point of this.points) {
                point.renderTo(ctx, region, settings);
            }
        }
    }

    public renderDebugTo(ctx: CanvasRenderingContext2D, region: ViewportRegion): boolean {
        if (!this.isVisible(region)) {
            return false;
        }
        drawBoundingRegion(ctx, this.boundingBox);
        ctx.stroke();
        for (const object of this.points) {
            object.renderDebugTo(ctx, region);
        }
        const radius = 2;
        const p = Math.PI * 2;
        ctx.beginPath();
        for (const hitbox of this.hitboxes) {
            for (let i = 0; i < hitbox.length; i += 2) {
                ctx.moveTo(hitbox[i] + radius, hitbox[i + 1]);
                ctx.arc(hitbox[i], hitbox[i + 1], radius, 0, p);
            }
        }
        ctx.fill();
        return true;
    }

    public clone(): PolyLine {
        return new PolyLine(this.style, this.grid);
    }

    public overlaps(region: BoundingBox): boolean {
        if (!this.boundingBox.overlaps(region)) {
            return false;
        }
        const vertices = region.vertices;
        for (const hitbox of this.hitboxes) {
            if (doRegionsOverlap(vertices, hitbox)) {
                return true;
            }
        }
        return false;
    }

}
