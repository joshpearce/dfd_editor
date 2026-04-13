import * as EditorCommands from "../../../Commands";
import { ObjectMover } from "./ObjectMover";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { GroupView, ResizeEdge } from "@OpenChart/DiagramView";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CommandExecutor } from "../CommandExecutor";

export class GroupResizeMover extends ObjectMover {

    /**
     * The group being resized.
     */
    private group: GroupView;

    /**
     * The edge(s) being dragged.
     */
    private edge: ResizeEdge;


    /**
     * Creates a new {@link GroupResizeMover}.
     * @param plugin
     *  The mover's plugin.
     * @param executor
     *  The mover's command executor.
     * @param group
     *  The group being resized.
     * @param edge
     *  The edge bitmask identifying which side(s) are being dragged.
     */
    constructor(
        plugin: PowerEditPlugin,
        executor: CommandExecutor,
        group: GroupView,
        edge: ResizeEdge
    ) {
        super(plugin, executor);
        this.group = group;
        this.edge = edge;
    }


    /**
     * Captures the subject.
     */
    public captureSubject(): void {}

    /**
     * Moves the subject.
     * @param track
     *  The subject's track.
     */
    public moveSubject(track: SubjectTrack): void {
        const editor = this.plugin.editor;
        const canvas = editor.file.canvas;
        const delta = track.getDistanceOnGrid(canvas.snapGrid);
        if (delta[0] | delta[1]) {
            const cmd = EditorCommands.resizeGroupBy(
                this.group, this.edge, delta[0], delta[1]
            );
            this.execute(cmd);
            // Track the delta actually applied (may differ from requested
            // when the resize was clamped by children or the minimum size).
            track.applyDelta([cmd.appliedDx, cmd.appliedDy]);
        }
    }

    /**
     * Releases the subject from movement.
     */
    public releaseSubject(): void {}

}
