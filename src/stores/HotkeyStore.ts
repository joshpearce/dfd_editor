import * as AppCommands from "@/assets/scripts/Application/Commands";
import * as EditorCommands from "@OpenChart/DiagramEditor/Commands";
import { defineStore } from "pinia";
import { useApplicationStore } from "./ApplicationStore";
import type { Hotkey } from "@/assets/scripts/Browser";
import type { CommandEmitter } from "@/assets/scripts/Application/Commands";

export const useHotkeyStore = defineStore("hotkeyStore", {
    getters: {

        /**
         * Returns the native hotkeys.
         * @returns
         *  The supported native hotkeys.
         */
        nativeHotkeys(): Hotkey<CommandEmitter>[] {
            return [
                {
                    shortcut: "Control+R",
                    repeatable: true,
                    allowBrowserBehavior: true
                },
                {
                    shortcut: "Control+Shift+R",
                    repeatable: true,
                    allowBrowserBehavior: true
                },
                {
                    shortcut: "Meta+R",
                    repeatable: true,
                    allowBrowserBehavior: true
                },
                {
                    shortcut: "Meta+Shift+R",
                    repeatable: true,
                    allowBrowserBehavior: true
                }
            ];
        },

        /**
         * Returns the file hotkeys.
         * @returns
         *  The file hotkeys.
         */
        fileHotkeys(): Hotkey<CommandEmitter>[] {
            const app = useApplicationStore();
            const editor = app.activeEditor;
            const file = app.settings.hotkeys.file;
            return [
                {
                    data: () => AppCommands.prepareEditorFromNewFile(app),
                    shortcut: file.new_file,
                    repeatable: false
                },
                {
                    data: () => AppCommands.prepareEditorFromFileSystem(app),
                    shortcut: file.open_file,
                    repeatable: false
                },
                {
                    data: () => AppCommands.prepareEditorFromStixFileSystem(app),
                    shortcut: file.open_stix_file,
                    repeatable: false
                },
                {
                    data: () => AppCommands.importFileFromFilesystem(app, editor),
                    shortcut: file.import_file,
                    repeatable: false
                },
                {
                    data: () => AppCommands.importStixFileFromFilesystem(app, editor),
                    shortcut: file.import_stix_file,
                    repeatable: false
                },
                {
                    data: () => AppCommands.saveActiveFileToDevice(app),
                    shortcut: file.save_file,
                    repeatable: false
                },
                {
                    data: () => AppCommands.saveActiveFileToServer(app),
                    shortcut: file.save_to_server,
                    repeatable: false
                },
                {
                    data: () => AppCommands.saveDiagramImageToDevice(app),
                    shortcut: file.save_image,
                    repeatable: false
                },
                {
                    data: () => AppCommands.saveSelectionImageToDevice(app),
                    shortcut: file.save_select_image,
                    repeatable: false
                },
                {
                    data: () => AppCommands.publishActiveFileToDevice(app),
                    shortcut: file.publish_file,
                    repeatable: false,
                    disabled: !app.activePublisher || !app.isValid
                }
            ];
        },

        /**
         * Returns the edit hotkeys.
         * @returns
         *  The edit hotkeys.
         */
        editHotKeys(): Hotkey<CommandEmitter>[] {
            const app = useApplicationStore();
            const edit = app.settings.hotkeys.edit;
            const editor = app.activeEditor;
            const finder = app.activeFinder;
            return [
                {
                    data: () => AppCommands.undoEditorCommand(editor),
                    shortcut: edit.undo,
                    repeatable: true
                },
                {
                    data: () => AppCommands.redoEditorCommand(editor),
                    shortcut: edit.redo,
                    repeatable: true
                },
                {
                    data: () => AppCommands.cutActiveSelectionToClipboard(app),
                    shortcut: edit.cut,
                    repeatable: false
                },
                {
                    data: () => AppCommands.copyActiveSelectionToClipboard(app),
                    shortcut: edit.copy,
                    repeatable: false,
                    allowBrowserBehavior: true
                },
                {
                    data: () => AppCommands.pasteFileFromClipboard(app),
                    shortcut: edit.paste,
                    repeatable: true
                },
                {
                    data: () => EditorCommands.removeSelectedChildren(editor),
                    shortcut: edit.delete,
                    repeatable: false
                },
                // {
                //     data: () => new Page.DuplicateSelectedChildren(ctx, page),
                //     shortcut: edit.duplicate,
                //     repeatable: false
                // },
                {
                    data: () => AppCommands.showSearchMenu(app),
                    shortcut: edit.find,
                    repeatable: false
                },
                {
                    data: () => AppCommands.toNextSearchResult(finder),
                    shortcut: edit.find_next,
                    disabled: !finder.hasResults,
                    repeatable: true
                },
                {
                    data: () => AppCommands.toPreviousSearchResult(finder),
                    shortcut: edit.find_previous,
                    disabled: !finder.hasResults,
                    repeatable: true
                },
                {
                    data: () => EditorCommands.selectAllObjects(editor),
                    shortcut: edit.select_all,
                    repeatable: false
                },
                {
                    data: () => EditorCommands.unselectAllObjects(editor),
                    shortcut: edit.unselect_all,
                    repeatable: false
                }
            ];
        },

        /**
         * Returns the view hotkeys.
         * @returns
         *  The view hotkeys.
         */
        viewHotkeys(): Hotkey<CommandEmitter>[] {
            const app = useApplicationStore();
            const editor = app.activeEditor;
            const view = app.settings.hotkeys.view;
            const {
                display_animations,
                display_shadows,
                display_debug_info
            } = app.settings.view.diagram;
            return  [
                {
                    data: () => AppCommands.enableAnimations(app, !display_animations),
                    shortcut: view.toggle_animations,
                    repeatable: false
                },
                {
                    data: () => AppCommands.enableShadows(app, !display_shadows),
                    shortcut: view.toggle_shadows,
                    repeatable: false
                },
                {
                    data: () => AppCommands.resetCamera(editor),
                    shortcut: view.reset_view,
                    repeatable: false
                },
                {
                    data: () => AppCommands.zoomCamera(editor, 0.25),
                    shortcut: view.zoom_in,
                    repeatable: true
                },
                {
                    data: () => AppCommands.zoomCamera(editor, -0.25),
                    shortcut: view.zoom_out,
                    repeatable: true
                },
                {
                    data: () => EditorCommands.moveCameraToSelection(editor),
                    shortcut: view.jump_to_selection,
                    repeatable: false
                },
                {
                    data: () => EditorCommands.moveCameraToParents(editor),
                    shortcut: view.jump_to_parents,
                    repeatable: true
                },
                {
                    data: () => EditorCommands.moveCameraToChildren(editor),
                    shortcut: view.jump_to_children,
                    repeatable: true
                },
                {
                    data: () => AppCommands.switchToFullscreen(),
                    shortcut: view.fullscreen,
                    repeatable: false
                },
                {
                    data: () => AppCommands.enableDebugInfo(app, display_debug_info),
                    shortcut: view.toggle_debug_info,
                    repeatable: false
                }
            ];
        },

        /**
         * Returns the create-template hotkeys, derived from each template's
         * own `shortcut` field. Templates without a shortcut are skipped.
         * @returns
         *  The create hotkeys.
         */
        /**
         * Returns arrow-key movement hotkeys. Plain arrows nudge the
         * selection 1px; Shift+arrow moves by the canvas snap-grid step
         * so alignment to existing grid-phased objects is preserved.
         * @returns
         *  The movement hotkeys.
         */
        movementHotkeys(): Hotkey<CommandEmitter>[] {
            const app = useApplicationStore();
            const editor = app.activeEditor;
            const selection = app.getSelection;
            const snap = editor.file.canvas.snapGrid;
            const disabled = selection.length === 0;
            const move = (dx: number, dy: number) =>
                EditorCommands.moveObjectsBy(selection, dx, dy);
            return [
                { shortcut: "ArrowLeft",        data: () => move(-1, 0), repeatable: true, disabled },
                { shortcut: "ArrowRight",       data: () => move(1, 0),  repeatable: true, disabled },
                { shortcut: "ArrowUp",          data: () => move(0, -1), repeatable: true, disabled },
                { shortcut: "ArrowDown",        data: () => move(0, 1),  repeatable: true, disabled },
                { shortcut: "Shift+ArrowLeft",  data: () => move(-snap[0], 0), repeatable: true, disabled },
                { shortcut: "Shift+ArrowRight", data: () => move(snap[0], 0),  repeatable: true, disabled },
                { shortcut: "Shift+ArrowUp",    data: () => move(0, -snap[1]), repeatable: true, disabled },
                { shortcut: "Shift+ArrowDown",  data: () => move(0, snap[1]),  repeatable: true, disabled }
            ];
        },

        createHotkeys(): Hotkey<CommandEmitter>[] {
            const app = useApplicationStore();
            const editor = app.activeEditor;
            // Suppress create shortcuts whenever the editor has a selection, so
            // a stray keypress can't spawn an object while the user is acting
            // on existing ones.
            const hasSelection = 0 < app.hasSelection;
            const hotkeys: Hotkey<CommandEmitter>[] = [];
            for (const template of editor.file.factory.templates.values()) {
                if (!template.shortcut) {
                    continue;
                }
                const id = template.name;
                hotkeys.push({
                    data: () => {
                        app.requestNameFocus();
                        return EditorCommands.spawnObjectAtPointer(editor, id);
                    },
                    shortcut: template.shortcut,
                    repeatable: false,
                    disabled: hasSelection
                });
            }
            return hotkeys;
        }

    }
});

