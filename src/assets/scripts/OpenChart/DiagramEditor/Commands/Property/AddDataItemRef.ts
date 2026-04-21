import { EditorDirective } from "../../EditorDirectives";
import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import type { DirectiveIssuer } from "../../EditorDirectives";
import type { ListProperty, StringProperty } from "@OpenChart/DiagramModel";

export class AddDataItemRef extends SynchronousEditorCommand {

    /**
     * The property.
     */
    public readonly property: ListProperty;

    /**
     * The subproperty (the new data-item ref entry).
     */
    private readonly subproperty: StringProperty;


    /**
     * Creates a new data-item reference and adds it to a {@link ListProperty}.
     * @param property
     *  The {@link ListProperty}.
     * @param guid
     *  The GUID of the data item to reference.
     */
    constructor(property: ListProperty, guid: string) {
        super();
        this.property = property;
        const entry = property.createListItem() as StringProperty;
        entry.setValue(guid);
        this.subproperty = entry;
    }


    /**
     * Executes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public execute(issueDirective: DirectiveIssuer = () => {}): void {
        this.property.addProperty(this.subproperty, this.subproperty.id);
        issueDirective(EditorDirective.Record | EditorDirective.Autosave);
    }

    /**
     * Undoes the editor command.
     * @param issueDirective
     *  A function that can issue one or more editor directives.
     */
    public undo(issueDirective: DirectiveIssuer = () => {}): void {
        this.property.removeProperty(this.subproperty.id);
        issueDirective(EditorDirective.Autosave);
    }

}
