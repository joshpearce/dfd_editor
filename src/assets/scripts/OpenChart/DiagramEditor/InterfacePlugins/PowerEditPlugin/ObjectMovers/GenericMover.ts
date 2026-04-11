import * as EditorCommands from "../../../Commands";
import { Alignment, BlockView, findDeepestContainingGroup, GroupView } from "@OpenChart/DiagramView";
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
     */
    public captureSubject(): void {
        for (const obj of this.objects) {
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
        // Move
        if (delta[0] | delta[1]) {
            for (const object of this.objects) {
                if (!object.userSetPosition) {
                    this.execute(userSetObjectPosition(object));
                }
            }
            this.execute(moveObjectsBy(this.objects, ...delta));
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
                this.execute(removeObjectFromGroup([obj]));
                this.execute(addObjectToGroup(obj, target));
            }
        }
    }

}
