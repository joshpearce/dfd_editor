import * as EditorCommands from "../../../Commands";
import { Alignment, BlockView, findDeepestContainingGroup, GroupView } from "@OpenChart/DiagramView";
import type { CanvasView } from "@OpenChart/DiagramView";
import { ObjectMover } from "./ObjectMover";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { CommandExecutor } from "../CommandExecutor";

export class GenericMover extends ObjectMover {

    /**
     * The mover's objects.
     */
    private objects: DiagramObjectView[];

    /**
     * The objects actually moved on each drag tick — identical to
     * {@link objects} except that structural descendants of other selected
     * objects are excluded. When a group G and a child block b are both
     * selected, `GroupFace.moveBy` already repositions b as G's structural
     * child; issuing a second `moveBy` on b directly would double-displace it.
     * Filtering b out of `moveTargets` prevents that double-move.
     */
    private moveTargets: DiagramObjectView[];

    /**
     * Pre-drag `userBounds` snapshots for every {@link GroupView} ancestor of
     * any object in the selection. Captured once in `captureSubject` and
     * consumed in `releaseSubject` to temporarily restore group bounds before
     * the drop-target containment check. Groups auto-expand during the drag
     * via `calculateLayout`'s grow-only write-back; without this restoration,
     * a group that chased its dragged children would still claim to contain
     * them and `findDeepestContainingGroup` would return that group — causing
     * no reparenting to occur even when the objects were dragged outside it.
     */
    private groupSnapshots: Map<GroupView, readonly [number, number, number, number]>;

    /**
     * The mover's alignment.
     */
    private alignment: number;


    /**
     * Creates a new {@link ObjectMover}.
     * @param plugin
     *  The mover's plugin.
     * @param execute
     *  The mover's command executor.
     * @param objects
     *  The mover's objects.
     */
    constructor(
        plugin: PowerEditPlugin,
        executor: CommandExecutor,
        objects: DiagramObjectView[]
    ) {
        super(plugin, executor);
        this.objects = objects;
        // Pre-compute the move-safe subset: exclude any object that is a
        // structural descendant of another object in the selection.
        // GroupFace.moveBy propagates movement to all children, so a
        // selected descendant must not also receive a direct move command.
        const selectionSet = new Set<DiagramObjectView>(objects);
        const isDescendantOfSelection = (o: DiagramObjectView): boolean => {
            let p = o.parent;
            while (p) {
                if (selectionSet.has(p)) { return true; }
                p = p.parent;
            }
            return false;
        };
        this.moveTargets = objects.filter(o => !isDescendantOfSelection(o));
        this.groupSnapshots = new Map();
        this.alignment = this.objects.some(
            o => o.alignment === Alignment.Grid
        ) ? Alignment.Grid : Alignment.Free;
    }


    /**
     * Captures the subject.
     *
     * Snapshots the ancestor group bounds for every object in the selection
     * so that any auto-expansion of a containing trust boundary during the
     * drag is reversible in one undo step. The `RestoreGroupBounds` command
     * must land first in the drag stream so its undo runs last on reverse
     * playback, after all movement commands have been undone.
     *
     * The same bounds are also stored in {@link groupSnapshots} so that
     * `releaseSubject` can temporarily restore them before running the
     * drop-target containment check (see {@link releaseSubject}).
     */
    public captureSubject(): void {
        for (const obj of this.objects) {
            // Walk the ancestor chain and snapshot each GroupView's userBounds
            // before any movement. Used in releaseSubject to counteract the
            // auto-expansion that occurs during the drag.
            let node: DiagramObjectView | null = obj.parent;
            while (node) {
                if (node instanceof GroupView && !this.groupSnapshots.has(node)) {
                    this.groupSnapshots.set(node, node.face.userBounds);
                }
                node = node.parent;
            }
            this.pinAncestorGroupBounds(obj.parent);
        }
    }

    /**
     * Moves the subject.
     * @param track
     *  The subject's track.
     */
    public moveSubject(track: SubjectTrack): void {
        const editor = this.plugin.editor;
        const canvas = editor.file.canvas;
        const { moveObjectsBy, userSetObjectPosition } = EditorCommands;
        // Get distance
        let delta;
        if (this.alignment === Alignment.Grid) {
            delta = track.getDistanceOnGrid(canvas.grid);
        } else {
            delta = track.getDistance();
        }
        // Move (use moveTargets to avoid double-moving structural descendants)
        if (delta[0] | delta[1]) {
            for (const object of this.moveTargets) {
                if (!object.userSetPosition) {
                    this.execute(userSetObjectPosition(object));
                }
            }
            this.execute(moveObjectsBy(this.moveTargets, ...delta));
        }
        // Apply delta
        track.applyDelta(delta);
    }

    /**
     * Releases the subject from movement.
     *
     * Reparents each {@link BlockView} and {@link GroupView} in the selection
     * to the deepest trust boundary whose bounding box contains its drop
     * position (TB-5). The TB-7 guard skips any object whose ancestor is also
     * in the selection — that object rides along with its selected ancestor and
     * must not be independently reparented, which would invert the structural
     * hierarchy.
     */
    public releaseSubject(): void {
        const { addObjectToGroup, removeObjectFromGroup } = EditorCommands;
        const canvas = this.plugin.editor.file.canvas;
        // Restore every ancestor group's pre-drag bounds before the
        // containment check. During the drag, GroupFace.calculateLayout
        // auto-expands groups (grow-only) to contain their moved children.
        // Without this restoration, a group that chased its children would
        // still report that it contains them and findDeepestContainingGroup
        // would return the wrong target — trapping the objects inside their
        // original container even after a fast drag outside it.
        // The subsequent reparenting commands trigger handleUpdate →
        // calculateLayout, which will correctly resize each group based on
        // its actual remaining children.
        for (const [group, bounds] of this.groupSnapshots) {
            group.face.setBounds(bounds[0], bounds[1], bounds[2], bounds[3]);
        }
        // TB-7 guard: collect the selection set, then skip any object whose
        // ancestor is also in the selection. That object rides along with its
        // selected ancestor and must not be independently reparented.
        const selectionSet = new Set<DiagramObjectView>(this.objects);
        const isDescendantOfSelection = (o: DiagramObjectView): boolean => {
            let p = o.parent;
            while (p) {
                if (selectionSet.has(p)) { return true; }
                p = p.parent;
            }
            return false;
        };
        // Pre-compute all drop targets BEFORE executing any reparenting.
        // Each removeObjectFromGroup triggers calculateLayout on the vacated
        // group, which re-expands the group around its remaining children.
        // If those remaining children also need to be ejected, their
        // containment check would incorrectly see the re-expanded bounds and
        // conclude they are still inside the group. By separating the lookup
        // pass from the mutation pass we ensure all targets are determined
        // against consistent (restored pre-drag) bounds.
        type Reparent = { obj: DiagramObjectView; target: CanvasView | GroupView };
        const reparents: Reparent[] = [];
        for (const obj of this.objects) {
            if (isDescendantOfSelection(obj)) { continue; }
            // Only blocks and groups are structural reparent candidates.
            // Lines follow their LCA via TB-4; latches/handles/anchors are
            // children of lines or blocks and their parent is set by their owner.
            if (!(obj instanceof BlockView) && !(obj instanceof GroupView)) { continue; }
            // Self-exclusion: pass the group itself as `exclude` so it cannot
            // become its own ancestor. Same pattern as GroupMover.releaseSubject.
            const target = findDeepestContainingGroup(
                canvas, obj.x, obj.y,
                obj instanceof GroupView ? obj : undefined
            ) ?? canvas;
            if (obj.parent !== target) {
                reparents.push({ obj, target });
            }
        }
        for (const { obj, target } of reparents) {
            this.execute(removeObjectFromGroup([obj]));
            this.execute(addObjectToGroup(obj, target));
        }
        // Re-apply pre-drag bounds to all snapshot groups after reparenting.
        // Each removeObjectFromGroup triggers calculateLayout which re-expands
        // the group around its remaining children. Groups that lost all their
        // selected children end up with _user* stuck at those mid-loop expanded
        // values. Restoring and recalculating gives each group its correct
        // final size: the pre-drag minimum expanded only as needed for any
        // children that were not selected (and therefore remain inside).
        for (const [group, bounds] of this.groupSnapshots) {
            group.face.setBounds(bounds[0], bounds[1], bounds[2], bounds[3]);
            group.face.calculateLayout();
        }
    }

}
