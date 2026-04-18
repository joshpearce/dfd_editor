import { Device } from "@/assets/scripts/Browser";
import { exportMinimalDiagram } from "@/assets/scripts/api/DfdApiClient";
import { AppCommand } from "../AppCommand";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";

export class ExportDiagramAsDataFlow extends AppCommand {

    /**
     * The server-side diagram id to export.
     */
    public readonly serverFileId: string;

    /**
     * The editor whose canvas-name is used as the download filename.
     */
    public readonly editor: DiagramViewEditor;


    /**
     * Exports a server-bound diagram in the minimal Data Flow format and
     * downloads it to the user's file system. Requires the editor to be
     * bound to a server id (use `serverFileId` from `ApplicationStore`).
     * @param serverFileId
     *  The diagram's server id.
     * @param editor
     *  The active editor (for naming the downloaded file).
     */
    constructor(serverFileId: string, editor: DiagramViewEditor) {
        super();
        this.serverFileId = serverFileId;
        this.editor = editor;
    }


    /**
     * Executes the command.
     */
    public async execute(): Promise<void> {
        const contents = await exportMinimalDiagram(this.serverFileId);
        const nameProperty = this.editor.file?.canvas.properties.value.get("name");
        const fileName = nameProperty ? nameProperty.toString() : "Untitled Document";
        Device.downloadTextFile(fileName, contents, "json");
    }

}
