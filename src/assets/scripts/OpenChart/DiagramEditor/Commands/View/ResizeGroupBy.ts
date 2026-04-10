import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { GroupView, ResizeEdge } from "@OpenChart/DiagramView";

export class ResizeGroupBy extends SynchronousEditorCommand {

    /**
     * The group to resize.
     */
    public readonly group: GroupView;

    /**
     * The edge(s) being shifted.
     */
    public readonly edge: ResizeEdge;

    /**
     * The requested change in x for the affected horizontal edges.
     */
    public readonly dx: number;

    /**
     * The requested change in y for the affected vertical edges.
     */
    public readonly dy: number;

    /**
     * The clamped x delta actually applied by {@link execute}.
     */
    public appliedDx: number;

    /**
     * The clamped y delta actually applied by {@link execute}.
     */
    public appliedDy: number;


    /**
     * Resizes a group by shifting one or more of its edges.
     * @param group
     *  The group to resize.
     * @param edge
     *  The edge bitmask identifying which sides (or corners) to move.
     * @param dx
     *  The desired change in x for the affected horizontal edges.
     * @param dy
     *  The desired change in y for the affected vertical edges.
     */
    constructor(group: GroupView, edge: ResizeEdge, dx: number, dy: number) {
        super();
        this.group = group;
        this.edge = edge;
        this.dx = dx;
        this.dy = dy;
        this.appliedDx = 0;
        this.appliedDy = 0;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        const [adx, ady] = this.group.resizeBy(this.edge, this.dx, this.dy);
        this.appliedDx = adx;
        this.appliedDy = ady;
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        this.group.resizeBy(this.edge, -this.appliedDx, -this.appliedDy);
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

}
