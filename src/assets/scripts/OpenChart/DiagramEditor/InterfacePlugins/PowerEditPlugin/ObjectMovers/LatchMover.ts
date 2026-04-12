import * as EditorCommands from "../../../Commands";
import { ObjectMover } from "./ObjectMover";
import { Alignment, AnchorView, findLowestCommonContainer, LineView } from "@OpenChart/DiagramView";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CanvasView, DiagramObjectView, GroupView, LatchView } from "@OpenChart/DiagramView";
import type { CommandExecutor } from "../CommandExecutor";

export class LatchMover extends ObjectMover {

    /**
     * The mover's leader latch.
     */
    private leader: LatchView;

    /**
     * The mover's latches.
     */
    private latches: LatchView[];

    /**
     * The mover's alignment.
     */
    private alignment: number;


    /**
     * Creates a new {@link LatchMover}.
     * @param plugin
     *  The mover's plugin.
     * @param execute
     *  The mover's command executor.
     * @param latches
     *  The latches to move.
     */
    constructor(
        plugin: PowerEditPlugin,
        execute: CommandExecutor,
        latches: LatchView[]
    ) {
        super(plugin, execute);
        this.leader = latches[0];
        this.latches = latches;
        this.alignment = this.latches.some(
            o => o.alignment === Alignment.Grid
        ) ? Alignment.Grid : Alignment.Free;
    }


    /**
     * Captures the subject.
     */
    public captureSubject(): void {
        // Walk the leader latch's ancestor chain (latch → line → group
        // → …). A latch move propagates through `LineView.moveBy →
        // parent.handleUpdate`, which can grow any containing group via
        // `calculateLayout`'s write-back — the same undo-invisibility
        // bug that affects `BlockMover`. Snapshotting here lets
        // `RestoreGroupBounds.undo` revert the auto-grow as the final
        // step of the drag's reverse playback.
        this.pinAncestorGroupBounds(this.leader.parent);
    }

    /**
     * Moves the subject.
     * @param track
     *  The subject's track.
     */
    public moveSubject(track: SubjectTrack): void {
        const editor = this.plugin.editor;
        const canvas = editor.file.canvas;
        // Get target
        let delta = track.getDistance();
        const target = this.getBlocksAndAnchorsAt(
            this.leader.x + delta[0],
            this.leader.y + delta[1],
            canvas
        );
        // Update hover
        this.execute(EditorCommands.clearHover(canvas));
        if (target) {
            this.execute(EditorCommands.hoverObject(target, true));
        }
        // Update distance, if necessary
        if (this.alignment === Alignment.Grid) {
            delta = track.getDistanceOnGrid(canvas.grid);
        }
        // Attach latch
        if (target instanceof AnchorView) {
            delta = track.getDistanceOntoObject(target, this.leader);
            this.linkLatches(target);
        } else {
            this.unlinkLatches();
        }
        // Move object
        const { moveObjectsBy } = EditorCommands;
        this.execute(moveObjectsBy(this.latches, delta[0], delta[1]));
        // Apply delta
        track.applyDelta(delta);
    }

    /**
     * Minimum drag distance (in diagram units) for a new connector to be
     * committed. A drag shorter than this that leaves the target latch
     * unlinked is treated as an accidental click and the whole stream is
     * discarded without adding anything to the undo history.
     */
    private static readonly MIN_CONNECTOR_LENGTH = 40;

    /**
     * Releases the subject from movement.
     */
    public releaseSubject(): void {
        const l = this.latches;
        const line = this.leader.parent as LineView | null;
        if (!line) { return; }
        // Discard the stream (and roll back the line creation) when the target
        // latch is unlinked and the drag was too short to form a meaningful
        // connector. This prevents an invisible zero-length line from being
        // committed when the user accidentally clicks a contact point.
        if (l.length === 1 && !l[0].isLinked()) {
            const dx = l[0].x - line.source.x;
            const dy = l[0].y - line.source.y;
            if (Math.hypot(dx, dy) < LatchMover.MIN_CONNECTOR_LENGTH) {
                this._discardStream = true;
                return;
            }
            // this.plugin.requestSuggestions(l[0]);
        }
        // TB-4: reparent the line to the LCA of its source and target blocks.
        // Reparenting happens once at release (not mid-drag) so the stream stays
        // clean; the final bound state is used, not intermediate hover binds.
        const canvas = this.plugin.editor.file.canvas;
        const src = line.sourceObject;
        const tgt = line.targetObject;
        const target =
            src && tgt
                ? (findLowestCommonContainer(src, tgt) ?? canvas)
                : canvas;
        if (line.parent !== target) {
            this.execute(EditorCommands.reparentObject(line, target));
        }
    }

    /**
     * Links the mover's latches.
     * @param anchor
     *  The anchor to link the latches to.
     */
    private linkLatches(anchor: AnchorView) {
        const { attachLatchToAnchor } = EditorCommands;
        for (const latch of this.latches) {
            if (!latch.isLinked(anchor)) {
                this.execute(attachLatchToAnchor(latch, anchor));
            }
        }
    }

    /**
     * Unlinks the mover's latches.
     */
    private unlinkLatches() {
        const { detachLatchFromAnchor } = EditorCommands;
        for (const latch of this.latches) {
            if (latch.isLinked()) {
                this.execute(detachLatchFromAnchor(latch));
            }
        }
    }

    /**
     * Returns the topmost block or anchor at the specified coordinate.
     * @param x
     *  The x coordinate.
     * @param y
     *  The y coordinate.
     * @param group
     *  The group to evaluate.
     *  (Default: The interface's canvas.)
     * @returns
     *  The topmost block or anchor, undefined if there isn't one.
     * @remarks
     *  Walks this group's direct blocks first, then recurses into nested
     *  groups. Without the recursion, blocks that live inside a trust
     *  boundary are invisible to a latch drag originating outside it and
     *  the usual anchor-hover affordance never triggers.
     */
    private getBlocksAndAnchorsAt(
        x: number, y: number,
        group: CanvasView | GroupView
    ): DiagramObjectView | undefined {
        // Direct blocks
        const blocks = group.blocks;
        for (let i = blocks.length - 1; 0 <= i; i--) {
            const hit = blocks[i].getObjectAt(x, y);
            if (hit) {
                return hit;
            }
        }
        // Nested groups (recurse)
        const groups = group.groups;
        for (let i = groups.length - 1; 0 <= i; i--) {
            const hit = this.getBlocksAndAnchorsAt(x, y, groups[i]);
            if (hit) {
                return hit;
            }
        }
        return undefined;
    }

}
