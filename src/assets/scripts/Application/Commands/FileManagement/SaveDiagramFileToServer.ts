import { saveDiagram } from "@/assets/scripts/api/DfdApiClient";
import { AppCommand } from "../AppCommand";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";

export class SaveDiagramFileToServer extends AppCommand {

    private readonly editor: DiagramViewEditor;
    private readonly diagramId: string;

    /**
     * Saves the active diagram file to the server.
     * @param editor
     *  The file's editor.
     * @param diagramId
     *  The diagram's server-side ID.
     */
    constructor(editor: DiagramViewEditor, diagramId: string) {
        super();
        this.editor = editor;
        this.diagramId = diagramId;
    }

    public async execute(): Promise<void> {
        const json = JSON.stringify(this.editor.file.toExport(), null, 4);
        await saveDiagram(this.diagramId, json);
    }

}
