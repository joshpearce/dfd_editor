import { DiagramFace } from "../DiagramFace";
import { PositionSetByUser } from "../../ViewAttributes";
import { findUnlinkedObjectAt } from "../../ViewLocators";
import type { GroupStyle } from "../Styles/GroupStyle";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";
import type { GroupView, HitTarget } from "../../Views";

/**
 * Default group styling (the trust-boundary look: dashed indigo).
 */
export const DEFAULT_GROUP_STYLE: GroupStyle = {
    strokeColor: "rgba(99, 102, 241, 0.35)",
    focusedStrokeColor: "rgba(99, 102, 241, 0.9)",
    focusedFillColor: "rgba(99, 102, 241, 0.08)",
    labelColor: "rgba(99, 102, 241, 0.55)",
    focusedLabelColor: "rgba(99, 102, 241, 0.9)",
    handleColor: "rgba(99, 102, 241, 0.95)",
    lineDash: [8, 4]
};

/**
 * Default half-width of a fresh group (in diagram units).
 */
export const DEFAULT_HW = 150;

/**
 * Default half-height of a fresh group (in diagram units).
 */
export const DEFAULT_HH = 100;

/**
 * Padding added around children when growing the group to contain them.
 */
export const CHILD_PADDING = 20;

/**
 * Absolute minimum width/height the group is allowed to shrink to, in
 * diagram units.
 */
const MIN_SIZE = 60;

/**
 * Width of the outer hit halo for resize detection (in diagram units).
 */
export const RESIZE_HALO = 12;

/**
 * Identifies which edge (or corner) of a group face is being resized.
 * Horizontal and vertical components are independent bitmask bits so corners
 * are simply `N | E`, `S | W`, and so on.
 */
export const ResizeEdge = {
    None : 0,
    N    : 1,
    S    : 2,
    W    : 4,
    E    : 8,
    NW   : 1 | 4,
    NE   : 1 | 8,
    SW   : 2 | 4,
    SE   : 2 | 8
} as const;
export type ResizeEdge = typeof ResizeEdge[keyof typeof ResizeEdge];


export class GroupFace extends DiagramFace {

    /**
     * The face's view.
     */
    declare protected view: GroupView;

    /**
     * The user-chosen minimum x of the group.
     */
    private _userXMin: number = -DEFAULT_HW;

    /**
     * The user-chosen minimum y of the group.
     */
    private _userYMin: number = -DEFAULT_HH;

    /**
     * The user-chosen maximum x of the group.
     */
    private _userXMax: number = DEFAULT_HW;

    /**
     * The user-chosen maximum y of the group.
     */
    private _userYMax: number = DEFAULT_HH;

    /**
     * Which resize edge the cursor is currently hovering, if any. Populated
     * by the edit plugin during hit testing so the cursor map can read it
     * back without re-running edge detection.
     */
    public hoveredEdge: ResizeEdge = ResizeEdge.None;

    /**
     * The face's style.
     */
    public readonly style: GroupStyle;


    /**
     * Whether view's position has been set by the user.
     * @remarks
     *  The group's position lives inside its explicit bounds, not a single
     *  center point, so the usual `PositionSetByUser` flag does not apply.
     */
    public get userSetPosition(): number  {
        return PositionSetByUser.False;
    }

    /**
     * Whether view's position has been set by the user.
     */
    public set userSetPosition(value: number) {}


    /**
     * Returns the four user-chosen bound fields as a tuple.
     * @returns
     *  `[xMin, yMin, xMax, yMax]`
     * @see {@link GroupBoundsMap}
     */
    public get userBounds(): [number, number, number, number] {
        return [this._userXMin, this._userYMin, this._userXMax, this._userYMax];
    }

    /**
     * Directly assigns the four user-chosen bound fields and syncs the
     * displayed bounding box.
     * @param xMin
     *  The minimum x coordinate.
     * @param yMin
     *  The minimum y coordinate.
     * @param xMax
     *  The maximum x coordinate.
     * @param yMax
     *  The maximum y coordinate.
     * @remarks
     *  Low-level setter for the persistence engine. Writes the user-chosen
     *  bounds **and** syncs the displayed bounding box so reads see the
     *  persisted values immediately. Does not run layout, clamp to children,
     *  or move children — the persisted four-tuple is the final word.
     */
    public setBounds(xMin: number, yMin: number, xMax: number, yMax: number): void {
        this._userXMin = xMin;
        this._userYMin = yMin;
        this._userXMax = xMax;
        this._userYMax = yMax;
        // Sync the displayed bounding box directly: persistence is authoritative
        // and must not be reshaped by calculateLayout's child-expansion logic.
        this.boundingBox.xMin = xMin;
        this.boundingBox.yMin = yMin;
        this.boundingBox.xMax = xMax;
        this.boundingBox.yMax = yMax;
        this.boundingBox.x = (xMin + xMax) / 2;
        this.boundingBox.y = (yMin + yMax) / 2;
    }


    /**
     * Creates a new {@link GroupFace}.
     * @param style
     *  Optional style; defaults to the trust-boundary look.
     */
    constructor(style: GroupStyle = DEFAULT_GROUP_STYLE) {
        super();
        this.style = style;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  1. Selection  /////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns the topmost view at the specified coordinate.
     * @param x
     *  The x coordinate.
     * @param y
     *  The y coordinate.
     * @returns
     *  The topmost view, undefined if there isn't one.
     */
    public getObjectAt(x: number, y: number): HitTarget | undefined {
        if (this.boundingBox.contains(x, y)) {
            // Try objects (view.objects yields groups, lines, and blocks;
            // findUnlinkedObjectAt now passes PolyLineSpanView hits through)
            const object = findUnlinkedObjectAt(
                [...this.view.objects], x, y
            );
            if (object) {
                return object;
            }
            // Return group
            return this.view;
        } else {
            return undefined;
        }
    }

    /**
     * Returns the resize edge at the given coordinate, if the coordinate is
     * inside the outer resize halo.
     * @param x
     *  The x coordinate.
     * @param y
     *  The y coordinate.
     * @returns
     *  The resize edge, or {@link ResizeEdge.None} if the coordinate is not
     *  on a resize halo.
     * @remarks
     *  The hit zone lives just outside the current bounding box so that
     *  clicks inside the group still fall through to move / child selection.
     *  Corners are implied by the bitmask: e.g. being in both the west outer
     *  band and the north outer band yields {@link ResizeEdge.NW}.
     */
    public getResizeEdgeAt(x: number, y: number): ResizeEdge {
        const { xMin, yMin, xMax, yMax } = this.boundingBox;
        // Reject points that aren't inside the outer halo rectangle.
        if (x < xMin - RESIZE_HALO || x > xMax + RESIZE_HALO) {
            return ResizeEdge.None;
        }
        if (y < yMin - RESIZE_HALO || y > yMax + RESIZE_HALO) {
            return ResizeEdge.None;
        }
        // Classify each axis independently. A point strictly inside the
        // bounding box on both axes is not a resize hit.
        let edge: number = ResizeEdge.None;
        if (y < yMin) {
            edge |= ResizeEdge.N;
        } else if (y > yMax) {
            edge |= ResizeEdge.S;
        }
        if (x < xMin) {
            edge |= ResizeEdge.W;
        } else if (x > xMax) {
            edge |= ResizeEdge.E;
        }
        return edge as ResizeEdge;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  2. Movement  //////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Sets the face's position relative to its current position.
     * @param dx
     *  The change in x.
     * @param dy
     *  The change in y.
     */
    public moveBy(dx: number, dy: number): void {
        // Shift user bounds
        this._userXMin += dx;
        this._userYMin += dy;
        this._userXMax += dx;
        this._userYMax += dy;
        // Move children
        for (const object of this.view.objects) {
            object.face.moveBy(dx, dy);
        }
        // Recalculate layout
        this.calculateLayout();
    }

    /**
     * Resizes the face by shifting the specified edges/corners by the given
     * delta. Children are not moved.
     * @param edge
     *  The edge bitmask to shift.
     * @param dx
     *  The desired change in x for west/east edges.
     * @param dy
     *  The desired change in y for north/south edges.
     * @returns
     *  The actual clamped `[dx, dy]` delta applied. Clamping kicks in when
     *  the resize would clip an existing child (minus padding) or shrink the
     *  box below the absolute minimum size.
     */
    public resizeBy(edge: ResizeEdge, dx: number, dy: number): [number, number] {
        // Derive the constraints imposed by existing children. Infinity
        // sentinels mean "no constraint from this side."
        let childXMin = Infinity;
        let childYMin = Infinity;
        let childXMax = -Infinity;
        let childYMax = -Infinity;
        for (const object of this.view.objects) {
            const bb = object.face.boundingBox;
            if (bb.xMin < childXMin) {
                childXMin = bb.xMin;
            }
            if (bb.yMin < childYMin) {
                childYMin = bb.yMin;
            }
            if (bb.xMax > childXMax) {
                childXMax = bb.xMax;
            }
            if (bb.yMax > childYMax) {
                childYMax = bb.yMax;
            }
        }
        const xMinCeiling = Number.isFinite(childXMin)
            ? childXMin - CHILD_PADDING
            : Infinity;
        const yMinCeiling = Number.isFinite(childYMin)
            ? childYMin - CHILD_PADDING
            : Infinity;
        const xMaxFloor = Number.isFinite(childXMax)
            ? childXMax + CHILD_PADDING
            : -Infinity;
        const yMaxFloor = Number.isFinite(childYMax)
            ? childYMax + CHILD_PADDING
            : -Infinity;

        let appliedDx = 0;
        let appliedDy = 0;

        // Horizontal component
        if (edge & ResizeEdge.W) {
            const target = this._userXMin + dx;
            const ceiling = Math.min(this._userXMax - MIN_SIZE, xMinCeiling);
            const clamped = Math.min(target, ceiling);
            appliedDx = clamped - this._userXMin;
            this._userXMin = clamped;
        } else if (edge & ResizeEdge.E) {
            const target = this._userXMax + dx;
            const floor = Math.max(this._userXMin + MIN_SIZE, xMaxFloor);
            const clamped = Math.max(target, floor);
            appliedDx = clamped - this._userXMax;
            this._userXMax = clamped;
        }

        // Vertical component
        if (edge & ResizeEdge.N) {
            const target = this._userYMin + dy;
            const ceiling = Math.min(this._userYMax - MIN_SIZE, yMinCeiling);
            const clamped = Math.min(target, ceiling);
            appliedDy = clamped - this._userYMin;
            this._userYMin = clamped;
        } else if (edge & ResizeEdge.S) {
            const target = this._userYMax + dy;
            const floor = Math.max(this._userYMin + MIN_SIZE, yMaxFloor);
            const clamped = Math.max(target, floor);
            appliedDy = clamped - this._userYMax;
            this._userYMax = clamped;
        }

        this.calculateLayout();
        return [appliedDx, appliedDy];
    }


    ///////////////////////////////////////////////////////////////////////////
    //  3. Layout / Rendering  ////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Calculates the face's layout.
     * @returns
     *  True if the layout changed, false otherwise.
     * @remarks
     *  The displayed bounding box is the user-chosen box expanded as needed
     *  to keep all children inside (with padding). This means child moves
     *  grow the box automatically, but user resizes never clip children.
     *  Any growth is written back into the user bounds so subsequent resize
     *  operations start from the true displayed box.
     */
    public calculateLayout(): boolean {
        let xMin = this._userXMin;
        let yMin = this._userYMin;
        let xMax = this._userXMax;
        let yMax = this._userYMax;

        let hasChildren = false;
        let cXMin = Infinity;
        let cYMin = Infinity;
        let cXMax = -Infinity;
        let cYMax = -Infinity;
        for (const object of this.view.objects) {
            hasChildren = true;
            const bb = object.face.boundingBox;
            if (bb.xMin < cXMin) {
                cXMin = bb.xMin;
            }
            if (bb.yMin < cYMin) {
                cYMin = bb.yMin;
            }
            if (bb.xMax > cXMax) {
                cXMax = bb.xMax;
            }
            if (bb.yMax > cYMax) {
                cYMax = bb.yMax;
            }
        }
        if (hasChildren) {
            const pXMin = cXMin - CHILD_PADDING;
            const pYMin = cYMin - CHILD_PADDING;
            const pXMax = cXMax + CHILD_PADDING;
            const pYMax = cYMax + CHILD_PADDING;
            if (pXMin < xMin) {
                xMin = pXMin;
            }
            if (pYMin < yMin) {
                yMin = pYMin;
            }
            if (pXMax > xMax) {
                xMax = pXMax;
            }
            if (pYMax > yMax) {
                yMax = pYMax;
            }
            this._userXMin = xMin;
            this._userYMin = yMin;
            this._userXMax = xMax;
            this._userYMax = yMax;
        }

        this.boundingBox.xMin = xMin;
        this.boundingBox.yMin = yMin;
        this.boundingBox.xMax = xMax;
        this.boundingBox.yMax = yMax;
        this.boundingBox.x = (xMin + xMax) / 2;
        this.boundingBox.y = (yMin + yMax) / 2;
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
        const { xMin, yMin, xMax, yMax } = this.boundingBox;
        const w = xMax - xMin;
        const h = yMax - yMin;

        // Draw body
        ctx.save();
        ctx.lineWidth = 2;
        ctx.setLineDash(this.style.lineDash);
        if (this.view.focused) {
            // Selected: filled + bright animated border (marching-ants via SelectionAnimation)
            ctx.fillStyle = this.style.focusedFillColor;
            ctx.strokeStyle = this.style.focusedStrokeColor;
            ctx.fillRect(xMin, yMin, w, h);
        } else {
            // Idle: no fill, faint static border so it doesn't look like a selection
            ctx.strokeStyle = this.style.strokeColor;
            ctx.lineDashOffset = 0; // Prevent global animation offset from animating idle boundaries
        }
        ctx.strokeRect(xMin, yMin, w, h);
        ctx.restore();

        // Draw label in the top-left corner if the group has a name
        const label = this.view.properties.isDefined()
            ? this.view.properties.toString()
            : "";
        if (label) {
            ctx.save();
            ctx.font = "bold 13px sans-serif";
            ctx.fillStyle = this.view.focused
                ? this.style.focusedLabelColor
                : this.style.labelColor;
            ctx.fillText(label, xMin + 8, yMin + 18);
            ctx.restore();
        }

        // Draw resize affordances when focused (8 handles: corners + edge midpoints)
        if (this.view.focused) {
            ctx.save();
            const handleSize = 8;
            const half = handleSize / 2;
            const xs = [xMin, (xMin + xMax) / 2, xMax];
            const ys = [yMin, (yMin + yMax) / 2, yMax];
            ctx.fillStyle = this.style.handleColor;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
            ctx.lineWidth = 1;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    if (i === 1 && j === 1) {
                        continue; // skip center
                    }
                    const hx = xs[i];
                    const hy = ys[j];
                    ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
                    ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
                }
            }
            ctx.restore();
        }

        // Render child objects
        for (const obj of this.view.objects) {
            obj.renderTo(ctx, region, settings);
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
        const isRendered = super.renderDebugTo(ctx, region);
        if (isRendered) {
            for (const object of this.view.objects) {
                object.renderDebugTo(ctx, region);
            }
        }
        return isRendered;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  4. Cloning  ///////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns a clone of the face.
     * @returns
     *  A clone of the face.
     */
    public clone(): GroupFace {
        const clone = new GroupFace(this.style);
        clone._userXMin = this._userXMin;
        clone._userYMin = this._userYMin;
        clone._userXMax = this._userXMax;
        clone._userYMax = this._userYMax;
        return clone;
    }

}
