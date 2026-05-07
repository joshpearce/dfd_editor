import { layoutDiagram } from "@/assets/scripts/api/DfdApiClient";
import { NewAutoLayoutEngine } from "@OpenChart/DiagramView";
import { AppCommand } from "../AppCommand";
import { SaveDiagramFileToServer } from "./SaveDiagramFileToServer";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";

/**
 * Re-runs TALA on the active file and clears the undo/redo history.
 *
 * The mutation is performed in place on the live editor file. Auto Layout is
 * disruptive enough that preserving prior commands on the stack would produce
 * confusing replays — so the stack is wiped after the layout completes. The
 * user is asked to confirm before any of this happens.
 */
export class AutoLayoutActiveFile extends AppCommand {

    constructor(
        private readonly editor: DiagramViewEditor,
        private readonly diagramId: string | null
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
        await this.editor.file.runLayout(new NewAutoLayoutEngine(layoutDiagram));
        this.editor.clearHistory();
        if (this.diagramId !== null) {
            await new SaveDiagramFileToServer(this.editor, this.diagramId).execute();
        }
    }

}
