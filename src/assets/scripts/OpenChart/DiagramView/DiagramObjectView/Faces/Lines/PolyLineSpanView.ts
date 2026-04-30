import type { HandleView, LineView } from "../../Views";

/**
 * Represents one axis-aligned segment between two flanking interior handles on
 * a {@link PolyLine}.  This is a pure data carrier — the renderer and arrow
 * pipeline never touch it.  It exists so {@link PolyLine.getObjectAt} (Step 3)
 * can return a typed hit target for interior segments, and so
 * `PolyLineSpanMover` (Step 2) can read the flanking handles and axis without
 * reaching into PolyLine's private state.
 *
 * Not a {@link HandleView} subclass.  `PowerEditPlugin.CursorMap` is keyed by
 * `obj.constructor.name`, so the class must be a named class rather than a
 * plain object literal or interface.
 */
export class PolyLineSpanView {

    /**
     * The {@link LineView} that owns this span.
     */
    public readonly parent: LineView;

    /**
     * The first flanking interior handle (handles[i]).
     */
    public readonly handleA: HandleView;

    /**
     * The second flanking interior handle (handles[i+1]).
     */
    public readonly handleB: HandleView;

    /**
     * The axis along which this segment runs.
     * `"H"` — horizontal (handleA.y === handleB.y).
     * `"V"` — vertical (handleA.x === handleB.x).
     */
    public readonly axis: "H" | "V";

    /**
     * A copy of the hitbox polygon for this segment, taken from
     * {@link PolyLine}'s `hitboxes` cache at layout time.
     */
    public hitbox: number[];

    /**
     * Creates a new {@link PolyLineSpanView}.
     * @param parent - The owning {@link LineView}.
     * @param handleA - The first flanking interior handle.
     * @param handleB - The second flanking interior handle.
     * @param axis - The axis along which this segment runs.
     * @param hitbox - Cached hitbox polygon for this segment.
     */
    constructor(
        parent: LineView,
        handleA: HandleView,
        handleB: HandleView,
        axis: "H" | "V",
        hitbox: number[]
    ) {
        this.parent = parent;
        this.handleA = handleA;
        this.handleB = handleB;
        this.axis = axis;
        this.hitbox = hitbox;
    }

}
