import { LineFace } from "../Bases";
import { findUnlinkedObjectAt } from "../../ViewLocators";
import {
    doRegionsOverlap,
    drawAbsoluteMultiElbowPath,
    drawAbsolutePolygon,
    drawBoundingRegion,
    isInsideRegion
} from "@OpenChart/Utilities";
import { runMultiElbowLayout } from "./LineLayoutStrategies";
import { PolyLineSpanView } from "./PolyLineSpanView";
import type { LineStyle } from "../Styles";
import type { BoundingBox } from "../BoundingBox";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";
import type { DiagramObjectView, HitTarget } from "../../Views";
import type { GenericLineInternalState } from "./GenericLineInternalState";

// Handle positions originate from TALA's `parseFloat`'d SVG vertices; snap
// equality to an epsilon so fractional-pixel outputs classify as axis-aligned.
const AXIS_EPSILON = 1e-6;

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
        const obj = findUnlinkedObjectAt([this.view.node1, this.view.node2], x, y);
        if (obj) {
            return obj;
        }
        if (this.isAnchored()) {
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
