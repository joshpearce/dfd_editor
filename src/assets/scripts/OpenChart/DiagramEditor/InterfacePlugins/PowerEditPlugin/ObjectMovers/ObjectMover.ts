import * as EditorCommands from "../../../Commands";
import { GroupView } from "@OpenChart/DiagramView";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { GroupBoundsSnapshot } from "../../../Commands";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CommandExecutor } from "../CommandExecutor";

export abstract class ObjectMover {

    /**
     * The mover's plugin.
     */
    protected plugin: PowerEditPlugin;

    /**
     * The mover's command executor.
     */
    protected execute: CommandExecutor;


    /**
     * Creates a new {@link ObjectMover}.
     * @param plugin
     *  The mover's plugin.
     * @param execute
     *  The mover's command executor.
     */
    constructor(plugin: PowerEditPlugin, execute: CommandExecutor) {
        this.plugin = plugin;
        this.execute = execute;
    }


    /**
     * Captures the subject.
     */
    public abstract captureSubject(): void;

    /**
     * Moves the subject.
     * @param track
     *  The subject's track.
     */
    public abstract moveSubject(track: SubjectTrack): void;

    /**
     * Releases the subjects.
     */
    public abstract releaseSubject(): void;


    /**
     * Walks the ancestor chain of {@link startFrom}, snapshots each
     * {@link GroupView} ancestor's current `userBounds`, and emits a
     * `RestoreGroupBounds` command into the active command stream. Does
     * nothing if the chain contains no `GroupView` ancestors.
     *
     * @remarks
     *  Must be called from the mover's `captureSubject()` BEFORE any
     *  other command is emitted. The command has to land first in the
     *  drag stream so its undo runs last on reverse playback — at that
     *  point every `moveBy` / `handleUpdate` cascade has already
     *  completed, so `GroupFace.setBounds` (which writes `_user*` and
     *  `boundingBox` without running `calculateLayout`) has the final
     *  word. Emitting later in the drag would mean a subsequent
     *  `moveBy` undo could re-grow the group via `calculateLayout`'s
     *  grow-only write-back and clobber the restored bounds.
     *
     *  The empty-snapshot case skips the emission entirely so drags
     *  that don't touch a group don't pollute the stream with a no-op
     *  command.
     *
     * @param startFrom
     *  The view whose ancestor chain should be walked. Typically the
     *  subject's `parent`. `null` is allowed and produces an empty
     *  snapshot (useful when a subject may or may not have a parent).
     */
    protected pinAncestorGroupBounds(startFrom: DiagramObjectView | null): void {
        const snapshots: GroupBoundsSnapshot[] = [];
        let node: DiagramObjectView | null = startFrom;
        while (node) {
            if (node instanceof GroupView) {
                snapshots.push({ group: node, bounds: node.face.userBounds });
            }
            node = node.parent;
        }
        if (snapshots.length > 0) {
            this.execute(EditorCommands.restoreGroupBounds(snapshots));
        }
    }

}
