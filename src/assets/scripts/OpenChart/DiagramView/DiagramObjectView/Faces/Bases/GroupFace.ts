import { DiagramFace } from "../DiagramFace";
import { PositionSetByUser } from "../../ViewAttributes";
import { findUnlinkedObjectAt } from "../../ViewLocators";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";
import type { DiagramObjectView, GroupView } from "../../Views";

/**
 * Default half-width of an empty group (in diagram units).
 */
const DEFAULT_HW = 150;

/**
 * Default half-height of an empty group (in diagram units).
 */
const DEFAULT_HH = 100;

/**
 * Padding added around children when the group has members.
 */
const CHILD_PADDING = 20;

export class GroupFace extends DiagramFace {

    /**
     * The face's view.
     */
    declare protected view: GroupView;

    /**
     * Stored center x — used when the group is empty.
     */
    private _x: number = 0;

    /**
     * Stored center y — used when the group is empty.
     */
    private _y: number = 0;


    /**
     * Whether view's position has been set by the user.
     * @remarks
     *  The position of a group is always defined by its children (or by the
     *  explicit stored position when empty). It cannot be "set" by the user.
     */
    public get userSetPosition(): number  {
        return PositionSetByUser.False;
    }

    /**
     * Whether view's position has been set by the user.
     */
    public set userSetPosition(value: number) {}


    /**
     * Creates a new {@link GroupFace}.
     */
    constructor() {
        super();
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
    public getObjectAt(x: number, y: number): DiagramObjectView | undefined {
        if (this.boundingBox.contains(x, y)) {
            // Try objects
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
        // Update stored center
        this._x += dx;
        this._y += dy;
        // Move children
        for (const object of this.view.objects) {
            object.face.moveBy(dx, dy);
        }
        // Recalculate layout
        this.calculateLayout();
    }


    ///////////////////////////////////////////////////////////////////////////
    //  3. Layout / Rendering  ////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Calculates the face's layout.
     * @returns
     *  True if the layout changed, false otherwise.
     */
    public calculateLayout(): boolean {
        const objects = [...this.view.objects];
        if (objects.length === 0) {
            // Empty group: use stored position with default dimensions
            this.boundingBox.xMin = this._x - DEFAULT_HW;
            this.boundingBox.yMin = this._y - DEFAULT_HH;
            this.boundingBox.xMax = this._x + DEFAULT_HW;
            this.boundingBox.yMax = this._y + DEFAULT_HH;
        } else {
            // Has children: derive bounds from them, with padding
            this.calculateBoundingBoxFromViews(objects);
            this.boundingBox.xMin -= CHILD_PADDING;
            this.boundingBox.yMin -= CHILD_PADDING;
            this.boundingBox.xMax += CHILD_PADDING;
            this.boundingBox.yMax += CHILD_PADDING;
            // Keep stored position in sync with children's center
            this._x = this.boundingBox.xMid;
            this._y = this.boundingBox.yMid;
        }
        this.boundingBox.x = this._x;
        this.boundingBox.y = this._y;
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
        ctx.setLineDash([8, 4]);
        if (this.view.focused) {
            // Selected: filled + bright animated border (marching-ants via SelectionAnimation)
            ctx.fillStyle = "rgba(99, 102, 241, 0.08)";
            ctx.strokeStyle = "rgba(99, 102, 241, 0.9)";
            ctx.fillRect(xMin, yMin, w, h);
        } else {
            // Idle: no fill, faint static border so it doesn't look like a selection
            ctx.strokeStyle = "rgba(99, 102, 241, 0.35)";
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
                ? "rgba(99, 102, 241, 0.9)"
                : "rgba(99, 102, 241, 0.55)";
            ctx.fillText(label, xMin + 8, yMin + 18);
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
        const clone = new GroupFace();
        clone._x = this._x;
        clone._y = this._y;
        return clone;
    }

}
