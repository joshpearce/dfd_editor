import { AppCommand } from "../AppCommand";
import { PhantomEditor } from "@/stores/PhantomEditor";
import { PowerEditPlugin, RectangleSelectPlugin } from "@OpenChart/DiagramEditor";
import { installEditPlugins } from "../EditorPlugins";
import type { ApplicationStore } from "@/stores/ApplicationStore";

export class SetReadonlyMode extends AppCommand {

    /**
     * The application context.
     */
    public readonly context: ApplicationStore;

    /**
     * The readonly value.
     */
    public readonly value: boolean;


    /**
     * Sets the application to read-only mode.
     * @remarks
     *  When a diagram is already loaded, toggling the flag also installs or
     *  uninstalls the interactive-editing plugins ({@link RectangleSelectPlugin}
     *  and {@link PowerEditPlugin}) on the live editor's interface, so the
     *  change takes effect immediately without requiring a page reload.
     * @param context
     *  The application context.
     * @param value
     *  The read-only state to apply.
     */
    constructor(context: ApplicationStore, value: boolean) {
        super();
        this.context = context;
        this.value = value;
    }


    /**
     * Executes the command.
     */
    public async execute(): Promise<void> {
        const prev = this.context.readOnlyMode;
        this.context.readOnlyMode = this.value;
        if (prev === this.value) { return; }
        const editor = this.context.activeEditor;
        // Skip plugin management for the PhantomEditor placeholder.
        if (editor.id === PhantomEditor.id) { return; }
        if (this.value) {
            // Going read-only: remove interactive-editing plugins.
            editor.interface.uninstallPlugin(RectangleSelectPlugin, PowerEditPlugin);
        } else {
            // Going interactive: (re)install editing plugins.
            installEditPlugins(editor, this.context.settings);
        }
    }

}
