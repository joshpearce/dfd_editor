import * as EditorCommands from "../../../Commands";
import { ObjectMover } from "./ObjectMover";
import { PolyLineSpanView } from "@OpenChart/DiagramView";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CommandExecutor } from "../CommandExecutor";

/**
 * Moves one interior segment of a {@link PolyLine} perpendicular to its axis.
 *
 * A span-drag translates both flanking handles of a segment by an equal,
 * axis-locked delta: horizontal spans (`axis === "H"`) accept only a vertical
 * delta; vertical spans (`axis === "V"`) accept only a horizontal delta.
 * Locking preserves the H/V alternation invariant that
 * `getAbsoluteMultiElbowPath`'s corner-radius math depends on — letting dx
 * move freely on an H span would produce a diagonal corner and invert the
 * rendered curve.
 *
 * Each drag tick emits at most one `moveObjectsBy` over `[handleA, handleB]`
 * (parallel-only cursor motion is dropped); the surrounding command stream
 * collapses every tick into one undo step.
 */
export class PolyLineSpanMover extends ObjectMover {

    /**
     * The span being dragged.
     */
    private readonly span: PolyLineSpanView;


    /**
     * Creates a new {@link PolyLineSpanMover}.
     * @param plugin
     *  The mover's plugin.
     * @param execute
     *  The mover's command executor.
     * @param span
     *  The span to drag.
     */
    constructor(plugin: PowerEditPlugin, execute: CommandExecutor, span: PolyLineSpanView) {
        super(plugin, execute);
        this.span = span;
    }


    /**
     * Captures the subject.
     *
     * Snapshots ancestor group bounds for the owning line so that any
     * auto-expansion of a containing trust boundary during the drag is
     * reversible.  The `RestoreGroupBounds` command must land first in the
     * drag stream so its undo runs last on reverse playback — the same
     * ordering requirement that `LatchMover` and `GenericMover` follow.
     */
    public captureSubject(): void {
        // LineView itself is never a GroupView — the helper skips it and walks
        // upward from the line's container, matching LatchMover.
        this.pinAncestorGroupBounds(this.span.parent);
    }

    /**
     * Moves the subject.
     * @param track
     *  The subject's track.
     */
    public moveSubject(track: SubjectTrack): void {
        let [dx, dy] = track.getDistance();
        // Lock delta to the axis perpendicular to the span's own direction:
        // an H (horizontal) span can only move vertically; a V (vertical)
        // span can only move horizontally.
        if (this.span.axis === "H") {
            dx = 0;
        } else {
            dy = 0;
        }
        // Skip when cursor motion was purely parallel to the span's own axis:
        // after axis-locking, both components are zero and there's nothing to emit.
        if (dx !== 0 || dy !== 0) {
            this.execute(EditorCommands.moveObjectsBy([this.span.handleA, this.span.handleB], dx, dy));
            track.applyDelta([dx, dy]);
        }
    }

    /**
     * Releases the subject from movement.
     *
     * No reparenting is needed: a span-drag translates two interior handles
     * of an existing line by equal perpendicular deltas. The line's
     * lowest-common-ancestor container does not change as a result, so
     * there is nothing to reparent here (contrast with LatchMover, which
     * reparents the line when its endpoints move to a new container).
     */
    public releaseSubject(): void {
        // Intentional no-op — see JSDoc above.
    }

}
