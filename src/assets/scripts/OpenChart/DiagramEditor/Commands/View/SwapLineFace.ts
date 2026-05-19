// pattern: Functional Core
import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { HandleView } from "@OpenChart/DiagramView";
import type { LineView } from "@OpenChart/DiagramView";
import type { LineFace } from "@OpenChart/DiagramView";

/**
 * A captured snapshot of a single {@link HandleView}'s position.
 */
type HandleSnapshot = {
    readonly handle: HandleView;
    readonly x: number;
    readonly y: number;
};

/**
 * Atomically swaps a {@link LineView}'s face between two {@link LineFace}
 * instances and — critically — preserves any interior handles that a
 * post-swap `calculateLayout` would have dropped via `dropHandles(1)`,
 * along with every handle's position at the time the command was constructed.
 *
 * @remarks
 * `DynamicLine.calculateLayout` calls `view.dropHandles(1)` as part of its
 * two-elbow layout strategies (`LineLayoutStrategies.ts`).  When a
 * `PolyLine` is swapped down to `DynamicLine`, the *next* `calculateLayout`
 * (a) repositions `handles[0]` to its computed waypoint and (b) silently
 * destroys every interior handle past index 0.  This command captures both
 * the handle list and each handle's position at construction time so that
 * `undo()` can fully restore the geometry before restoring the original face.
 *
 * ### Lifecycle
 *
 * - **execute**: swaps `fromFace` → `toFace` via `line.replaceFace`.
 * - **undo**: re-adds any handles that a post-`execute` `calculateLayout`
 *   dropped (by `instance` identity, so no duplicates), restores each handle
 *   to its captured `(x, y)` via `handle.face.moveTo` (face-level — no
 *   `LineView.handleUpdate` cascade), then swaps `toFace` → `fromFace`.
 * - **redo**: delegates to `execute` (default base-class behaviour).
 * - **merge**: always returns `null` — face swaps do not coalesce.
 *
 * No serialized file-format change — this is a pure in-memory command.
 * The command is intentionally a plain Functional-Core class: it captures
 * all state at construction time and performs no I/O.
 */
export class SwapLineFace extends SynchronousEditorCommand {

    /**
     * The line whose face is being swapped.
     */
    public readonly line: LineView;

    /**
     * The face the line holds before the swap (restored on undo).
     */
    public readonly fromFace: LineFace;

    /**
     * The face the line holds after the swap (applied by execute).
     */
    public readonly toFace: LineFace;

    /**
     * The full handle list captured at construction time (before execute),
     * each paired with its `(x, y)` position.  Used by undo() to re-attach
     * dropped handles and restore their pre-swap coordinates.
     */
    public readonly keptHandles: ReadonlyArray<HandleView>;

    /**
     * Per-handle position snapshots captured at construction time.
     * Indexed in the same order as `keptHandles`.
     */
    private readonly _handleSnapshots: ReadonlyArray<HandleSnapshot>;


    /**
     * Creates a new {@link SwapLineFace} command.
     *
     * @param line     - The line whose face will be swapped.
     * @param fromFace - The face the line currently holds.
     * @param toFace   - The face to swap to on execute.
     *
     * The handle list and every handle's position are captured immediately
     * from the live view so that undo() can fully restore pre-swap geometry.
     */
    constructor(line: LineView, fromFace: LineFace, toFace: LineFace) {
        super();
        this.line = line;
        this.fromFace = fromFace;
        this.toFace = toFace;
        // Capture before any mutation.  Spread into a new array so the
        // snapshot is independent of the live handles array.
        this.keptHandles = [...line.handles];
        this._handleSnapshots = line.handles.map(h => ({
            handle: h,
            x: h.x,
            y: h.y
        }));
    }


    /**
     * Executes the editor command.
     *
     * Swaps the line's face from {@link fromFace} to {@link toFace}.
     *
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        this.line.replaceFace(this.toFace);
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Undoes the editor command.
     *
     * Re-attaches any handles that a post-execute `calculateLayout` dropped,
     * in their original order, then restores each handle's pre-swap position
     * via `handle.face.moveTo` (face-level — avoids triggering
     * `LineView.handleUpdate` → `DynamicLine.calculateLayout` →
     * `dropHandles(1)` mid-restore), then swaps the face back to
     * {@link fromFace}.
     *
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        // Re-add any handles that a post-swap calculateLayout dropped.
        // DynamicLine layouts call view.dropHandles(1), so all handles
        // beyond index 0 may be missing.  We re-add only those that are
        // genuinely absent from the live handles array (identified by
        // instance id) so a double-undo can't duplicate handles.
        const liveInstances = new Set(this.line.handles.map(h => h.instance));
        for (const handle of this.keptHandles) {
            if (!liveInstances.has(handle.instance)) {
                this.line.addHandle(handle);
                liveInstances.add(handle.instance);
            }
        }
        // Restore every handle's pre-swap position via the face-level path.
        // Using handle.face.moveTo instead of handle.moveTo avoids triggering
        // LineView.handleUpdate → DynamicLine.calculateLayout → dropHandles(1)
        // mid-restore — the same technique used by the TALA handle-steering
        // pass (see OpenChart/CLAUDE.md Gotchas).
        for (const { handle, x, y } of this._handleSnapshots) {
            handle.face.moveTo(x, y);
        }
        this.line.replaceFace(this.fromFace);
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Merge's `command` with this command.
     *
     * Face swaps never coalesce — always returns `null`.
     */
    public override merge(_command: SynchronousEditorCommand): null {
        return null;
    }

}
