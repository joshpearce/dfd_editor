import * as EditorCommands from "../../../Commands";
import { LineView } from "@OpenChart/DiagramView";
import { ObjectMover } from "./ObjectMover";
import { Alignment, BoundingBox, CanvasView, findDeepestContainingGroup, findLowestCommonContainer, GroupView } from "@OpenChart/DiagramView";
import type { BlockView, DiagramObjectView } from "@OpenChart/DiagramView";
import type { SubjectTrack } from "@OpenChart/DiagramInterface";
import type { PowerEditPlugin } from "../PowerEditPlugin";
import type { CommandExecutor } from "../CommandExecutor";

export class BlockMover extends ObjectMover {

    /**
     * The mover's block.
     */
    private block: BlockView;

    /**
     * The mover's alignment.
     */
    private alignment: number;

    /**
     * The mover's lines.
     */
    private lines: Map<string, LineView>;

    /**
     * The group the block is currently parented to, if any. Updated as the
     * block is chain-ejected up the group hierarchy during drag.
     */
    private currentGroup: GroupView | null;

    /**
     * Snapshot of {@link currentGroup}'s bounding box taken when the block
     * entered it. The group's live bbox grows with its children, so we must
     * compare against a frozen snapshot to reliably detect when the block
     * has moved outside the group's original territory.
     */
    private currentGroupBox: { xMin: number; yMin: number; xMax: number; yMax: number } | null;


    /**
     * Creates a new {@link ObjectMover}.
     * @param plugin
     *  The mover's plugin.
     * @param execute
     *  The mover's command executor.
     * @param block
     *  The mover's block.
     */
    constructor(
        plugin: PowerEditPlugin,
        execute: CommandExecutor,
        block: BlockView
    ) {
        super(plugin, execute);
        this.lines = new Map();
        this.block = block;
        this.alignment = block.alignment;
        this.currentGroup = null;
        this.currentGroupBox = null;
    }


    /**
     * Captures the subject.
     */
    public captureSubject(): void {
        // Snapshot ancestor group bounds FIRST so the RestoreGroupBounds
        // command lands at index 0 of the drag stream. Its undo runs
        // last on reverse playback and authoritatively restores any
        // auto-grow the drag caused via `calculateLayout` write-back.
        this.pinAncestorGroupBounds(this.block.parent);
        if (this.block.parent instanceof GroupView) {
            this.currentGroup = this.block.parent;
            this.snapshotCurrentGroupBox();
        }
    }

    /**
     * Freezes the current parent group's bounding box so leave-detection
     * compares against the territory at the time of entry.
     */
    private snapshotCurrentGroupBox(): void {
        if (!this.currentGroup) {
            this.currentGroupBox = null;
            return;
        }
        const bb = this.currentGroup.face.boundingBox;
        this.currentGroupBox = {
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
        const { moveObjectsBy, userSetObjectPosition,
                reparentObject } = EditorCommands;
        // Get distance
        let delta;
        if (this.alignment === Alignment.Grid) {
            delta = track.getDistanceOnGrid(canvas.snapGrid);
        } else {
            delta = track.getDistance();
        }
        // Move
        if (delta[0] | delta[1]) {
            if (!this.block.userSetPosition) {
                this.execute(userSetObjectPosition(this.block));
            }
            this.execute(moveObjectsBy(this.block, ...delta));
        }
        // If the block is inside a group, eject it up the hierarchy one level
        // at a time as it leaves each containing group's original territory.
        // The snapshot comparison prevents the group from visually following
        // the block (its live bbox would otherwise grow to keep the block
        // inside). The loop handles leaping multiple levels in one tick.
        while (this.currentGroup && this.currentGroupBox) {
            const bx = this.block.x;
            const by = this.block.y;
            const { xMin, yMin, xMax, yMax } = this.currentGroupBox;
            const insideCurrent
                = xMin <= bx && bx <= xMax
                && yMin <= by && by <= yMax;
            if (insideCurrent) {
                break;
            }
            // Move the block up one level toward the canvas root.
            const parent = this.currentGroup.parent;
            const newParent: CanvasView | GroupView
                = parent instanceof GroupView ? parent : canvas;
            // Use reparentObject (not remove+add) so external latch
            // connections survive the eject — otherwise data-flow lines
            // attached to this block would be unlinked the instant a fast
            // drag ejects it from a containing trust boundary.
            this.execute(reparentObject(this.block, newParent));
            // TB-4b: re-LCA any line connected to this block. Without this,
            // a line still parented to the just-vacated group stretches to
            // follow the block, which makes the group's calculateLayout
            // grow to wrap the line — visually trapping the block inside
            // the boundary it was supposedly ejected from.
            this.reparentConnectedLinesToLCA(canvas);
            if (newParent instanceof GroupView) {
                this.currentGroup = newParent;
                this.snapshotCurrentGroupBox();
            } else {
                this.currentGroup = null;
                this.currentGroupBox = null;
            }
        }
        // Update overlap
        this.updateOverlap(canvas);
        // Apply delta
        track.applyDelta(delta);
    }

    /**
     * Reparents every line connected to this block to the LCA of its source
     * and target blocks. Called from the mid-drag eject loop so that lines
     * don't remain in a vacated boundary group and drag its bbox around.
     */
    private reparentConnectedLinesToLCA(canvas: CanvasView): void {
        const { reparentObject } = EditorCommands;
        const seen = new Set<LineView>();
        for (const anchor of this.block.anchors.values()) {
            for (const latch of anchor.latches) {
                const line = latch.parent;
                if (!(line instanceof LineView) || seen.has(line)) { continue; }
                seen.add(line);
                const src = line.sourceObject;
                const tgt = line.targetObject;
                const target = src && tgt
                    ? (findLowestCommonContainer(src, tgt) ?? canvas)
                    : canvas;
                if (line.parent !== target) {
                    this.execute(reparentObject(line, target));
                }
            }
        }
    }

    /**
     * Updates the line overlap.
     * @param group
     *  The group to evaluate.
     */
    protected updateOverlap(group: CanvasView | GroupView) {
        const objects = group.objects;
        const bb: BoundingBox = this.block.face.boundingBox;
        for (const object of objects) {
            if (
                object instanceof LineView &&
                object.sourceObject !== this.block &&
                object.targetObject !== this.block &&
                (object.sourceObject || object.targetObject)
            ) {
                this.selectLine(object, object.overlaps(bb));
            }
            if (object instanceof GroupView) {
                this.updateOverlap(object);
            }
        }
    }

    /**
     * Selects a line.
     * @param line
     *  The line to select.
     * @param value
     *  The line's select state.
     */
    public selectLine(line: LineView, value: boolean) {
        const editor = this.plugin.editor;
        if (line.focused === value) {
            return;
        }
        const { selectObject, unselectObject } = EditorCommands;
        if (value) {
            this.lines.set(line.instance, line);
            this.execute(selectObject(editor, line));
        } else {
            this.lines.delete(line.instance);
            this.execute(unselectObject(editor, line));
        }
    }

    /**
     * Releases the subject from movement.
     */
    public releaseSubject(): void {
        const { routeLinesThroughBlock, selectObject, unselectAllObjects,
                reparentObject } = EditorCommands;
        const editor = this.plugin.editor;
        const canvas = editor.file.canvas;
        const block = this.block;
        const lines = [...this.lines.values()];
        if (lines.length) {
            this.execute(routeLinesThroughBlock(canvas, block, lines));
            this.execute(unselectAllObjects(editor));
            this.execute(selectObject(editor, this.block));
        }
        // Reparent to the deepest group that contains the drop point.
        // Falls through to the canvas when nothing contains it.
        // Use reparentObject (not remove+add) to preserve external latch
        // connections — otherwise data-flow lines attached to this block
        // would be unlinked when the block crosses a trust boundary.
        const target = findDeepestContainingGroup(canvas, block.x, block.y) ?? canvas;
        if (block.parent !== target) {
            this.execute(reparentObject(block, target));
        }
    }

}
