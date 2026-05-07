import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { LineFace, LineStyle, LineView } from "@OpenChart/DiagramView";
import type { GenericLineInternalState } from "../../../DiagramView/DiagramObjectView/Faces/Lines/GenericLineInternalState";

/**
 * A constructor for a {@link LineFace} subclass.
 * Mirrors the shared `(style, grid)` signature of {@link DynamicLine}
 * and {@link PolyLine}.
 */
export type LineFaceCtor = new (style: LineStyle, grid: [number, number]) => LineFace;

/**
 * Swaps the face of a {@link LineView} from one {@link LineFace} subclass
 * to another and records the prior face class so the swap is undoable.
 *
 * @remarks
 *  The `style` and `grid` values are extracted from the line's current face
 *  on first execute (via the {@link GenericLineInternalState} escape hatch)
 *  and reused for every subsequent execute/undo so that undo/redo cycles
 *  are symmetric in both face class and rendering style.
 *
 *  Intended to be emitted by `diffAutoLayout` whenever the live line's
 *  face class differs from the planned line's face class
 *  (`DynamicLine` ↔ `PolyLine`).  Must be ordered before any
 *  `AddHandleToLine` commands for the same line in the `GroupCommand`
 *  emitted by `AutoLayoutActiveFile` so that the PolyLine face is in
 *  place before handle insertion triggers `calculateLayout`.
 */
export class SetLineFace extends SynchronousEditorCommand {

    /**
     * The line whose face will be replaced.
     */
    public readonly line: LineView;

    /**
     * The constructor for the new face class.
     */
    public readonly faceCtor: LineFaceCtor;

    /**
     * The constructor for the prior (pre-execute) face class.
     * Null until first execute; set exactly once so undo/redo cycles remain
     * symmetric.
     */
    private _priorFaceCtor: LineFaceCtor | null;

    /**
     * The line style captured from the initial face on first execute.
     * Reused for all subsequent execute/undo calls.
     */
    private _style: LineStyle | null;

    /**
     * The grid captured from the initial face on first execute.
     * Reused for all subsequent execute/undo calls.
     */
    private _grid: [number, number] | null;


    /**
     * Replaces the face of a line with a new face of the given class.
     * @param line
     *  The line whose face will be replaced.
     * @param faceCtor
     *  The constructor for the new face class (e.g. {@link PolyLine} or
     *  {@link DynamicLine}).
     */
    constructor(line: LineView, faceCtor: LineFaceCtor) {
        super();
        this.line = line;
        this.faceCtor = faceCtor;
        this._priorFaceCtor = null;
        this._style = null;
        this._grid = null;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        if (this._priorFaceCtor === null) {
            // First execute: capture the prior face class and the style/grid
            // from the current face so that undo can reconstruct it.
            const priorFace = this.line.face as unknown as GenericLineInternalState;
            this._priorFaceCtor = this.line.face.constructor as LineFaceCtor;
            this._style = priorFace.style;
            this._grid = priorFace.grid;
        }
        const newFace = new this.faceCtor(this._style!, this._grid!);
        this.line.replaceFace(newFace);
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        // _priorFaceCtor, _style, and _grid are always non-null after
        // execute has been called at least once.
        const oldFace = new this._priorFaceCtor!(this._style!, this._grid!);
        this.line.replaceFace(oldFace);
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

}
