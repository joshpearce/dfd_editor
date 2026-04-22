import {
    DarkThemeMarquee, DiagramViewEditor, LightThemeMarquee,
    PowerEditPlugin, RectangleSelectPlugin
} from "@OpenChart/DiagramEditor";
import type { AppSettings } from "@/assets/scripts/Application/Configuration/AppSettings";

// TODO: Move into application configuration (mirrors the comment in LoadFile.ts)
const marqueeThemes = {
    dark_theme  : DarkThemeMarquee,
    blog_theme  : LightThemeMarquee,
    light_theme : LightThemeMarquee
};

/**
 * Installs the interactive-editing plugins on a live editor's interface.
 * @remarks
 *  Called both at file-load time ({@link LoadFile}) and when toggling out
 *  of read-only mode ({@link SetReadonlyMode}) so the two sites stay in
 *  lockstep.
 * @param editor
 *  The editor whose interface will receive the plugins.
 * @param settings
 *  The current application settings (provides hotkeys and edit templates).
 */
export function installEditPlugins(editor: DiagramViewEditor, settings: AppSettings): void {
    const hotkeys = settings.hotkeys.edit;
    const pluginSettings = {
        factory           : editor.file.factory,
        lineTemplate      : settings.edit.anchor_line_template,
        multiselectHotkey : hotkeys.select_many
    };
    editor.interface.installPlugin(
        new RectangleSelectPlugin(editor, marqueeThemes, hotkeys.select_marquee),
        new PowerEditPlugin(editor, pluginSettings)
    );
}

export { RectangleSelectPlugin, PowerEditPlugin };
