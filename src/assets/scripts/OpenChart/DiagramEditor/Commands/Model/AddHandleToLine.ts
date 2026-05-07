import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { HandleView } from "@OpenChart/DiagramView/DiagramObjectView/Views/HandleView";
import type { LineView } from "@OpenChart/DiagramView/DiagramObjectView/Views/LineView";

export class AddHandleToLine extends SynchronousEditorCommand {

    /**
     * The line to add the handle to.
     * @remarks
     *  Precondition: `line.handles.length >= 1`. Every line is guaranteed to
     *  satisfy this because {@link DiagramObjectViewFactory} attaches a
     *  reference handle at index 0 during line creation.
     */
    public readonly line: LineView;

    /**
     * The x coordinate of the new handle.
     */
    public readonly x: number;

    /**
     * The y coordinate of the new handle.
     */
    public readonly y: number;

    /**
     * The index at which to insert the handle.
     */
    public readonly atIndex: number;

    /**
     * The handle inserted by this command, captured on first execute for
     * undo/redo symmetry.
     */
    private _handle: HandleView | null;


    /**
     * Adds a handle to a line at a specific index.
     * @param line
     *  The line. Must have at least one existing handle (index 0) to clone.
     * @param x
     *  The x coordinate of the new handle.
     * @param y
     *  The y coordinate of the new handle.
     * @param atIndex
     *  The index at which to insert the handle.
     */
    constructor(line: LineView, x: number, y: number, atIndex: number) {
        super();
        this.line = line;
        this.x = x;
        this.y = y;
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
            // First execute: clone the reference handle and position it while
            // it is still parentless. The cascade we care about
            // (DynamicLine.calculateLayout → dropHandles(1)) only fires once
            // the handle is inserted into the line below. We rely on
            // diffAutoLayout to emit SetLineFace(PolyLine) before this command
            // whenever the line is currently a DynamicLine.
            //
            // HandleView.clone() calls clone.moveTo(template.x, template.y)
            // internally; the face.moveTo call below supersedes that with the
            // command-supplied coordinates (template coords ≠ command coords).
            const template = this.line.handles[0];
            const clone = template.clone();
            clone.face.moveTo(this.x, this.y);
            this._handle = clone;
        }
        this.line.insertHandle(this._handle, this.atIndex, true);
        issueDirective(EditorDirective.Autosave | EditorDirective.Record);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        // _handle is always non-null after execute has been called.
        this.line.deleteHandle(this._handle!, true);
        issueDirective(EditorDirective.Autosave | EditorDirective.Record);
    }

}
