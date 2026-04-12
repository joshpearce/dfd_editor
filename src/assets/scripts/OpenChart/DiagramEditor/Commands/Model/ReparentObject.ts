import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import { Group } from "@OpenChart/DiagramModel";
import type { DiagramObject } from "@OpenChart/DiagramModel";
import type { DirectiveIssuer } from "../../EditorDirectives";

export class ReparentObject extends SynchronousEditorCommand {

    /**
     * The diagram object to reparent.
     */
    public readonly object: DiagramObject;

    /**
     * The object's original parent group.
     */
    public readonly fromGroup: Group;

    /**
     * The object's original index within its parent group.
     */
    public readonly fromIndex: number;

    /**
     * The target group.
     */
    public readonly toGroup: Group;


    /**
     * Moves a diagram object from its current parent to a new group without
     * severing external anchor/latch connections.
     * @remarks
     *  Use this instead of `RemoveObjectFromGroup` + `AddObjectToGroup` when
     *  the object is being relocated (not deleted). `RemoveObjectFromGroup`
     *  severs all external links, which is correct for deletion but wrong for
     *  reparenting (e.g. a line being moved to its LCA group should keep its
     *  latch-to-anchor connections intact).
     * @param object
     *  The object to reparent.
     * @param toGroup
     *  The group to move the object into.
     */
    constructor(object: DiagramObject, toGroup: Group) {
        super();
        if (!(object.parent instanceof Group)) {
            throw new Error("Object must belong to a group.");
        }
        this.object = object;
        this.fromGroup = object.parent;
        this.fromIndex = this.fromGroup.getObjectIndex(object);
        this.toGroup = toGroup;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        const directives
            = EditorDirective.Autosave
            | EditorDirective.Record
            | EditorDirective.ReindexContent
            | EditorDirective.ReindexSelection;
        this.fromGroup.removeObject(this.object, true);
        this.toGroup.addObject(this.object, undefined, true);
        issueDirective(directives, this.object.instance);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        const directives
            = EditorDirective.Autosave
            | EditorDirective.Record
            | EditorDirective.ReindexContent
            | EditorDirective.ReindexSelection;
        this.toGroup.removeObject(this.object, true);
        this.fromGroup.addObject(this.object, this.fromIndex, true);
        issueDirective(directives, this.object.instance);
    }

}
