import * as EditorCommands from "../../../Commands";
import { ObjectMover } from "./ObjectMover";
import { Alignment, findDeepestContainingGroup, GroupView } from "@OpenChart/DiagramView";
import type { CanvasView } from "@OpenChart/DiagramView";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CommandExecutor } from "../CommandExecutor";

export class GroupMover extends ObjectMover {

    /**
     * The group being moved.
     */
    private group: GroupView;

    /**
     * The group's current parent container, if it's nested inside another
     * group. Updated as the dragged group is chain-ejected up the hierarchy.
     */
    private currentParent: GroupView | null;

    /**
     * Snapshot of {@link currentParent}'s bounding box taken when the
     * dragged group entered it. The parent's live bbox grows to follow its
     * children, so leave-detection has to compare against a frozen snapshot
     * — otherwise the parent visually chases the child during the drag.
     */
    private currentParentBox: { xMin: number, yMin: number, xMax: number, yMax: number } | null;


    /**
     * Creates a new {@link GroupMover}.
     * @param plugin
     *  The mover's plugin.
     * @param executor
     *  The mover's command executor.
     * @param group
     *  The group being moved.
     */
    constructor(
        plugin: PowerEditPlugin,
        executor: CommandExecutor,
        group: GroupView
    ) {
        super(plugin, executor);
        this.group = group;
        this.currentParent = null;
        this.currentParentBox = null;
    }


    /**
     * Captures the subject.
     */
    public captureSubject(): void {
        if (this.group.parent instanceof GroupView) {
            this.currentParent = this.group.parent;
            this.snapshotCurrentParentBox();
        }
    }

    /**
     * Freezes the current parent group's bounding box so leave-detection
     * compares against the territory at the time of entry.
     */
    private snapshotCurrentParentBox(): void {
        if (!this.currentParent) {
            this.currentParentBox = null;
            return;
        }
        const bb = this.currentParent.face.boundingBox;
        this.currentParentBox = {
            xMin: bb.xMin, yMin: bb.yMin,
            xMax: bb.xMax, yMax: bb.yMax
        };
    }

    /**
     * Moves the subject.
     * @param track
     *  The subject's track.
     */
    public moveSubject(track: SubjectTrack): void {
        const editor = this.plugin.editor;
        const canvas = editor.file.canvas;
        const { addObjectToGroup, moveObjectsBy, removeObjectFromGroup } = EditorCommands;
        const delta = this.group.alignment === Alignment.Grid
            ? track.getDistanceOnGrid(canvas.grid)
            : track.getDistance();
        if (delta[0] | delta[1]) {
            this.execute(moveObjectsBy([this.group], delta[0], delta[1]));
        }
        // Eject up the hierarchy as the dragged group leaves each parent's
        // original territory. Without this the parent's auto-grow layout
        // would visually chase the child during the drag. The loop handles
        // leaping multiple levels in a single tick.
        while (this.currentParent && this.currentParentBox) {
            const bb = this.group.face.boundingBox;
            const cx = (bb.xMin + bb.xMax) / 2;
            const cy = (bb.yMin + bb.yMax) / 2;
            const { xMin, yMin, xMax, yMax } = this.currentParentBox;
            const insideCurrent
                = xMin <= cx && cx <= xMax
                && yMin <= cy && cy <= yMax;
            if (insideCurrent) {
                break;
            }
            const grandparent = this.currentParent.parent;
            const newParent: CanvasView | GroupView
                = grandparent instanceof GroupView ? grandparent : canvas;
            this.execute(removeObjectFromGroup([this.group]));
            this.execute(addObjectToGroup(this.group, newParent));
            if (newParent instanceof GroupView) {
                this.currentParent = newParent;
                this.snapshotCurrentParentBox();
            } else {
                this.currentParent = null;
                this.currentParentBox = null;
            }
        }
        track.applyDelta(delta);
    }

    /**
     * Releases the subject from movement.
     *
     * Reparents the group into the deepest group whose bounding box contains
     * its new center, excluding itself and any of its descendants so a group
     * can't become its own ancestor. Falls through to the canvas when nothing
     * else contains the group.
     */
    public releaseSubject(): void {
        const editor = this.plugin.editor;
        const canvas: CanvasView = editor.file.canvas;
        const bb = this.group.face.boundingBox;
        const cx = (bb.xMin + bb.xMax) / 2;
        const cy = (bb.yMin + bb.yMax) / 2;
        const target: CanvasView | GroupView
            = findDeepestContainingGroup(canvas, cx, cy, this.group) ?? canvas;
        if (this.group.parent !== target) {
            const { addObjectToGroup, removeObjectFromGroup } = EditorCommands;
            this.execute(removeObjectFromGroup([this.group]));
            this.execute(addObjectToGroup(this.group, target));
        }
    }

}
