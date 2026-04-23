import { DiagramFace } from "../DiagramFace";
import type { HandleView } from "../../Views";

export abstract class HandleFace extends DiagramFace {

    /**
     * The face's view.
     */
    declare protected view: HandleView;


    /**
     * Creates a new {@link HandleFace}.
     */
    constructor() {
        super();
    }


    ///////////////////////////////////////////////////////////////////////////
    //  0. Static Helpers  ////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns `true` if the point `(x, y)` is inside the visible handle dot
     * centred at the handle's stored position `(hx, hy)`.
     *
     * The marker is rendered at `(hx + markerOffset, hy + markerOffset)` —
     * the same convention used by {@link HandlePoint.renderTo} and
     * {@link HandlePoint.getObjectAt}.  The test uses strict inequality
     * (`<`) so the boundary edge is NOT considered a hit, matching
     * `HandlePoint.getObjectAt`.
     *
     * @param hx - The handle's `x` coordinate (bounding-box x, NOT the
     *   rendered centre).
     * @param hy - The handle's `y` coordinate (bounding-box y, NOT the
     *   rendered centre).
     * @param x - The point to test.
     * @param y - The point to test.
     * @param radius - The handle dot radius (from the theme's PointStyle).
     */
    public static isInsideHandleDot(
        hx: number, hy: number,
        x: number, y: number,
        radius: number
    ): boolean {
        const cx = hx + HandleFace.markerOffset;
        const cy = hy + HandleFace.markerOffset;
        const dx = x - cx;
        const dy = y - cy;
        return dx * dx + dy * dy < radius * radius;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  1. Movement  //////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Sets the face's position relative to its current position.
     * @param dx
     *  The change in x.
     * @param dy
     *  The change in y.
     */
    public moveBy(dx: number, dy: number): void {
        this.boundingBox.x += dx;
        this.boundingBox.y += dy;
        this.boundingBox.xMin += dx;
        this.boundingBox.xMax += dx;
        this.boundingBox.yMin += dy;
        this.boundingBox.yMax += dy;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  2. Cloning  ///////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns a clone of the face.
     * @returns
     *  A clone of the face.
     */
    public abstract clone(): HandleFace;

}
