import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { GroupView } from "@OpenChart/DiagramView";

/**
 * A captured snapshot of a single {@link GroupView}'s bounds.
 */
export type GroupBoundsSnapshot = {
    /**
     * The group whose bounds were captured.
     */
    readonly group: GroupView;

    /**
     * The group's `userBounds` at capture time,
     * as `[xMin, yMin, xMax, yMax]`.
     */
    readonly bounds: readonly [number, number, number, number];
};

/**
 * Records a set of group-bounds snapshots so that a subsequent undo can
 * restore them authoritatively.
 *
 * @remarks
 *  `execute()` is deliberately a no-op — this command exists solely to
 *  carry the snapshots into the undo stack. It is meant to be emitted as
 *  the **first** command in a drag stream so that {@link undo} runs
 *  **last** on reverse playback. By then every other undo step has
 *  already completed (the dragged subject has returned to its origin),
 *  so {@link GroupFace.setBounds} — which writes both `_user*` and
 *  `boundingBox` directly without invoking `calculateLayout` — has the
 *  final word on each group's bounds.
 *
 *  This is the load-bearing half of the fix for drag-time group
 *  auto-expansion being invisible to the undo stack: the expansion is a
 *  side-effect of `calculateLayout`'s grow-only write-back during
 *  `MoveObjectsBy.execute`, not a separately recorded mutation, and
 *  nothing in the existing command stream can walk it back.
 */
export class RestoreGroupBounds extends SynchronousEditorCommand {

    /**
     * The captured snapshots, in the order they were provided.
     */
    public readonly snapshots: ReadonlyArray<GroupBoundsSnapshot>;


    /**
     * Creates a new {@link RestoreGroupBounds} command.
     * @param snapshots
     *  The groups and bounds to restore on undo. May be empty.
     */
    constructor(snapshots: ReadonlyArray<GroupBoundsSnapshot>) {
        super();
        this.snapshots = snapshots;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        // No-op: the drag that follows will grow these groups via the
        // side-effects of `MoveObjectsBy`. This command's sole purpose
        // is to anchor the originals for undo.
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        for (const { group, bounds } of this.snapshots) {
            group.face.setBounds(bounds[0], bounds[1], bounds[2], bounds[3]);
        }
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

}
