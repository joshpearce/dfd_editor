import { toRaw } from "vue";
import { AppCommand } from "..";
import type { ApplicationStore } from "@/stores/ApplicationStore";
import type { DiagramModelEditor } from "@OpenChart/DiagramEditor/index.model";

export class SaveDiagramFileToRecoveryBank extends AppCommand {

    /**
     * The application context.
     */
    public readonly context: ApplicationStore;

    /**
     * The file's editor.
     */
    public readonly editor: DiagramModelEditor;


    /**
     * Saves a diagram file to the application's file recovery bank.
     * @param context
     *  The application context.
     * @param editor
     *  The file's editor.
     */
    constructor(context: ApplicationStore, editor: DiagramModelEditor) {
        super();
        this.context = context;
        this.editor = editor;
    }


    /**
     * Executes the command.
     */
    public async execute(): Promise<void> {
        // Create raw references
        const editor = toRaw(this.editor);
        // Serialize file
        const contents = JSON.stringify(editor.file.toExport());
        // Key by server id when bound, so a later "open from server" can
        // detect a newer local copy. Otherwise fall back to the editor's
        // instance id (per-session recovery only).
        const serverId = this.context.serverFileId;
        const key = serverId
            ? `server:${serverId}`
            : `local:${this.editor.id}`;
        this.context.fileRecoveryBank.saveFile(
            key,
            this.editor.name,
            contents
        );
    }

}
