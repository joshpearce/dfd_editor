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
     */
    public readonly priorFaceCtor: LineFaceCtor;

    /**
     * The line style captured from the prior face.
     */
    public readonly style: LineStyle;

    /**
     * The grid captured from the prior face.
     */
    public readonly grid: [number, number];


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
        const priorFace = line.face as unknown as GenericLineInternalState;
        this.priorFaceCtor = line.face.constructor as LineFaceCtor;
        this.style = priorFace.style;
        this.grid = priorFace.grid;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        this.line.replaceFace(new this.faceCtor(this.style, this.grid));
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        this.line.replaceFace(new this.priorFaceCtor(this.style, this.grid));
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

}
