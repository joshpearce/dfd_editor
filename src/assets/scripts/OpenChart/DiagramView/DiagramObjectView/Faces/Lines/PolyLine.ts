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
import type { LineStyle } from "../Styles";
import type { BoundingBox } from "../BoundingBox";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";
import type { DiagramObjectView } from "../../Views";
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
 */
export class PolyLine extends LineFace {

    /**
     * The line's style.
     */
    public readonly style: LineStyle;

    /**
     * The line's grid.
     */
    public readonly grid: [number, number];

    /**
     * The line's visible points (src latch, handles in order, trg latch).
     */
    public points: DiagramObjectView[];

    /**
     * The line's vertices (rounded-corner output of {@link runMultiElbowLayout}).
     */
    public vertices: number[];

    /**
     * The line's arrow head shape at node1 end (when data flows node2 → node1).
     */
    public arrowAtNode1: number[] | null;

    /**
     * The line's arrow head shape at node2 end (when data flows node1 → node2).
     */
    public arrowAtNode2: number[] | null;

    /**
     * The line's per-segment hitboxes.  `hitboxes[i]` corresponds to the
     * segment between `points[i]` and `points[i+1]` — the same indexing
     * convention DynamicLine uses, generalised to N+1 hitboxes for N handles.
     */
    public hitboxes: number[][];


    /**
     * Creates a new {@link PolyLine}.
     * @param style
     *  The line's style.
     * @param grid
     *  The line's grid.
     */
    constructor(style: LineStyle, grid: [number, number]) {
        super();
        this.style = style;
        this.grid = grid;
        this.points = [];
        this.vertices = [];
        this.arrowAtNode1 = null;
        this.arrowAtNode2 = null;
        this.hitboxes = [];
    }


    ///////////////////////////////////////////////////////////////////////////
    //  1. Selection  /////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns the topmost view at the specified coordinate.
     * @remarks
     *  Mirrors {@link DynamicLine.getObjectAt} verbatim: interior segments
     *  resolve to the handle that anchors them (`hitboxes[i]` →
     *  `view.handles[i - 1]`), end segments resolve to the line itself.
     *  The mapping holds because `points` is laid out as
     *  `[src, handles[0]…handles[N], trg]` and `hitboxes` carries one entry
     *  per segment between consecutive points.
     */
    public getObjectAt(x: number, y: number): DiagramObjectView | undefined {
        // Try points
        const obj = findUnlinkedObjectAt(this.points, x, y);
        if (obj) {
            return obj;
        }
        if (this.isAnchored()) {
            // Try segments
            for (let i = 0; i < this.hitboxes.length; i++) {
                if (!isInsideRegion(x, y, this.hitboxes[i])) {
                    continue;
                }
                if (0 < i && i < this.hitboxes.length - 1) {
                    return this.view.handles[i - 1];
                } else {
                    return this.view;
                }
            }
        } else {
            // Try segments
            for (const hitbox of this.hitboxes) {
                if (isInsideRegion(x, y, hitbox)) {
                    return this.view;
                }
            }
        }
        return undefined;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  2. Layout / Rendering  ////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Calculates the face's layout.
     * @returns
     *  True if the layout changed, false otherwise.
     */
    public calculateLayout(): boolean {
        const src = this.view.node1;
        const trg = this.view.node2;
        const handles = this.view.handles;
        if (!src || !trg || handles.length === 0) {
            // Bail if object incomplete — PolyLine expects at least one handle.
            return false;
        }

        // Update points: src, every handle in order, trg.
        this.points = [src, ...handles, trg];

        // Build raw vertex array: [sx, sy, h0x, h0y, ..., tx, ty]
        const vertices: number[] = new Array(this.points.length * 2);
        for (let i = 0; i < this.points.length; i++) {
            vertices[i * 2]     = this.points[i].x;
            vertices[i * 2 + 1] = this.points[i].y;
        }

        // Run the shared multi-elbow layout — it builds per-segment hitboxes,
        // applies cap offsets, and writes rounded-corner output into the face.
        runMultiElbowLayout(this.view, this as unknown as GenericLineInternalState, vertices);

        // Calculate bounding box from points
        this.calculateBoundingBoxFromViews(this.points);

        // Update relative location
        this.boundingBox.x = this.boundingBox.xMid;
        this.boundingBox.y = this.boundingBox.yMid;

        return true;
    }

    /**
     * Renders the face to a context.
     * @param ctx
     *  The context to render to.
     * @param region
     *  The context's viewport.
     * @param settings
     *  The current render settings.
     */
    public renderTo(
        ctx: CanvasRenderingContext2D,
        region: ViewportRegion, settings: RenderSettings
    ): void {
        if (!this.isVisible(region)) {
            return;
        }

        // Init
        const { width, color, selectColor } = this.style;

        // Configure context
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

        // Draw line
        drawAbsoluteMultiElbowPath(ctx, this.vertices);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw arrow heads
        if (this.arrowAtNode1 !== null) {
            drawAbsolutePolygon(ctx, this.arrowAtNode1);
            ctx.fill();
        }
        if (this.arrowAtNode2 !== null) {
            drawAbsolutePolygon(ctx, this.arrowAtNode2);
            ctx.fill();
        }

        // Draw handles and ends
        if (this.view.focused) {
            for (const point of this.points) {
                point.renderTo(ctx, region, settings);
            }
        }
    }

    /**
     * Renders the face's debug information to a context.
     * @param ctx
     *  The context to render to.
     * @param region
     *  The context's viewport.
     * @returns
     *  True if the view is visible, false otherwise.
     */
    public renderDebugTo(ctx: CanvasRenderingContext2D, region: ViewportRegion): boolean {
        if (!this.isVisible(region)) {
            return false;
        }
        // Draw line
        drawBoundingRegion(ctx, this.boundingBox);
        ctx.stroke();
        // Draw points
        for (const object of this.points) {
            object.renderDebugTo(ctx, region);
        }
        const radius = 2;
        const p = Math.PI * 2;
        // Draw hitboxes
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


    ///////////////////////////////////////////////////////////////////////////
    //  3. Cloning  ///////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns a clone of the face.
     * @returns
     *  A clone of the face.
     */
    public clone(): PolyLine {
        return new PolyLine(this.style, this.grid);
    }


    ///////////////////////////////////////////////////////////////////////////
    //  4. Shape  /////////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Tests if a bounding region overlaps the face.
     * @param region
     *  The bounding region.
     * @returns
     *  True if the bounding region overlaps the face, false otherwise.
     */
    public overlaps(region: BoundingBox): boolean {
        // If bounding boxes don't overlap...
        if (!this.boundingBox.overlaps(region)) {
            // ...skip additional checks
            return false;
        }
        // Otherwise...
        const vertices = region.vertices;
        for (const hitbox of this.hitboxes) {
            if (doRegionsOverlap(vertices, hitbox)) {
                return true;
            }
        }
        return false;
    }

}
