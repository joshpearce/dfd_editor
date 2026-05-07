import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { HandleView } from "@OpenChart/DiagramView/DiagramObjectView/Views/HandleView";
import type { LineView } from "@OpenChart/DiagramView/DiagramObjectView/Views/LineView";

export class RemoveHandleFromLine extends SynchronousEditorCommand {

    /**
     * The line to remove the handle from.
     */
    public readonly line: LineView;

    /**
     * The index of the handle to remove.
     */
    public readonly atIndex: number;

    /**
     * The handle removed by this command, captured on first execute for
     * undo/redo symmetry (null until first execute).
     */
    private _handle: HandleView | null;


    /**
     * Removes a handle from a line at a specific index.
     * @param line
     *  The line.
     * @param atIndex
     *  The index of the handle to remove.
     */
    constructor(line: LineView, atIndex: number) {
        super();
        this.line = line;
        this.atIndex = atIndex;
        this._handle = null;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        if (this._handle === null) {
            // First execute: capture the handle reference before removal so
            // undo can re-insert the exact same JS object (no fresh clone).
            const h = this.line.handles[this.atIndex];
            if (h === undefined) {
                throw new Error(
                    `RemoveHandleFromLine: atIndex ${this.atIndex} out of range` +
                    ` (line has ${this.line.handles.length} handles)`
                );
            }
            this._handle = h;
        }
        this.line.deleteHandle(this._handle, true);
        issueDirective(EditorDirective.Autosave | EditorDirective.Record);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        // _handle is always non-null after execute has been called.
        this.line.insertHandle(this._handle!, this.atIndex, true);
        issueDirective(EditorDirective.Autosave | EditorDirective.Record);
    }

}
