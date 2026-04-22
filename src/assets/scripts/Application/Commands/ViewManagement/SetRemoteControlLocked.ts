import { AppCommand } from "../AppCommand";
import { PhantomEditor } from "@/stores/PhantomEditor";
import { PowerEditPlugin, RectangleSelectPlugin } from "@OpenChart/DiagramEditor";
import { installEditPlugins } from "../EditorPlugins";
import type { ApplicationStore } from "@/stores/ApplicationStore";

export class SetRemoteControlLocked extends AppCommand {

    public readonly context: ApplicationStore;
    public readonly value: boolean;

    /**
     * Locks or unlocks the editor for remote-control sessions.
     * @remarks
     *  Sets `remoteControlLocked` and installs/uninstalls the interactive-
     *  editing plugins accordingly, but does NOT touch `readOnlyMode` — so
     *  the application chrome (title bar, sidebar, footer) stays visible.
     *  Plugins are only reinstalled when both this flag and `readOnlyMode`
     *  are false.
     * @param context
     *  The application context.
     * @param value
     *  True to lock (uninstall edit plugins), false to unlock.
     */
    constructor(context: ApplicationStore, value: boolean) {
        super();
        this.context = context;
        this.value = value;
    }

    public async execute(): Promise<void> {
        const prev = this.context.remoteControlLocked;
        this.context.remoteControlLocked = this.value;
        if (prev === this.value) { return; }
        const editor = this.context.activeEditor;
        if (editor.id === PhantomEditor.id) { return; }
        if (this.value) {
            editor.interface.uninstallPlugin(RectangleSelectPlugin, PowerEditPlugin);
        } else if (!this.context.readOnlyMode) {
            installEditPlugins(editor, this.context.settings);
        }
    }

}
