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
        const file = this.editor.file;
        const payload = {
            ...file.toExport(),
            // Duplicate the canvas's representative name at the top level so
            // the server's list endpoint can surface a human-readable label
            // without having to understand the schema.
            name: file.canvas.properties.toString() || "Untitled Diagram"
        };
        await saveDiagram(this.diagramId, JSON.stringify(payload, null, 4));
    }

}
