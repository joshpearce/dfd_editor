import { AppCommand } from "../AppCommand";
import type { ApplicationStore } from "@/stores/ApplicationStore";

export class BindEditorToServer extends AppCommand {

    private readonly context: ApplicationStore;
    private readonly diagramId: string | null;
    private readonly markDirty: boolean;

    /**
     * Binds the active editor to a server-side diagram id, or clears the
     * binding when passed null.
     * @param context
     *  The application context.
     * @param diagramId
     *  The diagram's server-side ID, or null to clear.
     * @param markDirty
     *  When true, mark the editor as having unsaved changes vs. the server
     *  (used when restoring from a newer local copy).
     */
    constructor(
        context: ApplicationStore,
        diagramId: string | null,
        markDirty: boolean = false
    ) {
        super();
        this.context = context;
        this.diagramId = diagramId;
        this.markDirty = markDirty;
    }

    public async execute(): Promise<void> {
        this.context.setServerFileId(this.diagramId);
        if (this.diagramId === null) {
            this.context.activeEditor.lastServerSaveUndoDepth = null;
        } else if (this.markDirty) {
            this.context.activeEditor.lastServerSaveUndoDepth = null;
        } else {
            this.context.activeEditor.lastServerSaveUndoDepth =
                this.context.activeEditor.undoDepth;
        }
    }

}
