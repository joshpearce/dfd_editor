import { getDiagram, saveDiagram } from "@/assets/scripts/api/DfdApiClient";
import { AppCommand } from "../AppCommand";
import { SaveDiagramFileToServer } from "./SaveDiagramFileToServer";
import { prepareEditorFromServerFile } from "./index";
import type { ApplicationStore } from "@/stores/ApplicationStore";
import type { DiagramViewExport } from "@OpenChart/DiagramView";

/**
 * Re-runs TALA on the active file by flushing the file to the server,
 * stripping its stored layout, and reloading via the normal "open from
 * server" path. The reload swaps the active editor wholesale, so undo /
 * redo history, selection state, and bound listeners are all cleared as
 * a side effect — no in-place mutation of the live editor.
 *
 * Confirms with the user first because it's destructive to the undo stack.
 * No-op if the active editor has no server binding.
 */
export class AutoLayoutActiveFile extends AppCommand {

    constructor(
        private readonly context: ApplicationStore,
        private readonly diagramId: string
    ) {
        super();
    }

    public async execute(): Promise<void> {
        const accept = window.confirm(
            "Auto Layout will re-run automatic layout on this diagram and "
            + "CLEAR your undo/redo history.\n\n"
            + "Continue?"
        );
        if (!accept) {
            return;
        }
        // Flush local edits so they're not lost when we reload from server.
        await new SaveDiagramFileToServer(this.context.activeEditor, this.diagramId).execute();
        // Strip the stored layout so loadFileFromServer's runLayout pass fires.
        const stored = JSON.parse(await getDiagram(this.diagramId)) as DiagramViewExport;
        delete stored.layout;
        await saveDiagram(this.diagramId, JSON.stringify(stored, null, 4));
        // Reload via the standard server-open path — replaces the active editor
        // and clears its undo/redo stacks naturally.
        const reload = await prepareEditorFromServerFile(this.context, this.diagramId);
        await reload.execute();
    }

}
