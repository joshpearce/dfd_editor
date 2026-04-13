import { AppCommand } from "../AppCommand";
import type { ApplicationStore } from "@/stores/ApplicationStore";

export class BindEditorToServer extends AppCommand {

    private readonly context: ApplicationStore;
    private readonly diagramId: string | null;

    /**
     * Binds the active editor to a server-side diagram id, or clears the
     * binding when passed null.
     * @param context
     *  The application context.
     * @param diagramId
     *  The diagram's server-side ID, or null to clear.
     */
    constructor(context: ApplicationStore, diagramId: string | null) {
        super();
        this.context = context;
        this.diagramId = diagramId;
    }

    public async execute(): Promise<void> {
        this.context.setServerFileId(this.diagramId);
    }

}
