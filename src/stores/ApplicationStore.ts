import Configuration from "@/assets/configuration/app.configuration";
import { DateTime } from "luxon";
import { FileStore } from "@/assets/scripts/Browser";
import { defineStore } from "pinia";
import { PhantomEditor } from "./PhantomEditor";
import { BaseAppSettings } from "@/assets/scripts/Application";
import { OpenChartFinder } from "@/assets/scripts/OpenChartFinder";
import { ThemeRegistry, ThemeSourceFile } from "@OpenChart/ThemeRegistry";
import { AsynchronousEditorCommand, BasicRecommender, DiagramViewEditor, SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
import { readDataItems } from "@OpenChart/DiagramModel/DataItemLookup";
import type { EditorCommand } from "@OpenChart/DiagramEditor";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { DataItem } from "@OpenChart/DiagramModel/DataItemLookup";
import type { AppCommand, ValidationErrorResult, ValidationWarningResult } from "@/assets/scripts/Application";


///////////////////////////////////////////////////////////////////////////////
//  1. Registry Configuration  ////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Configure publishers, validators, file preprocessors, and command processors
const Publisher = Configuration.publisher?.create();
const Validator = Configuration.validator?.create();
const FilePreprocessor = Configuration.filePreprocessor?.create();

// Configure theme registry
const themeRegistry = new ThemeRegistry();
for (const theme of Configuration.themes) {
    themeRegistry.registerTheme(new ThemeSourceFile(theme));
}


///////////////////////////////////////////////////////////////////////////////
//  2. Application Store  /////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


let _remoteActivityTimer: ReturnType<typeof setTimeout> | null = null;

export const useApplicationStore = defineStore("applicationStore", {
    state: () => ({
        themeRegistry: themeRegistry,
        fileRecoveryBank: new FileStore("__recovery_bank_"),
        activeEditor: PhantomEditor,
        activeValidator: Validator,
        activePublisher: Publisher,
        activeFilePreprocessor: FilePreprocessor,
        activeRecommender: new BasicRecommender(),
        activeFinder: new OpenChartFinder<DiagramViewEditor, DiagramObjectView>(),
        settings: BaseAppSettings,
        readOnlyMode: false,
        remoteControlLocked: false,
        recentTimezone: DateTime.local().toFormat("ZZ"),
        serverFileId: null as string | null,
        pendingNameFocus: 0,
        lastRemoteActivityTs: null as number | null,
        remoteActivityUndoDepth: null as number | null,
    }),
    getters: {

        ///////////////////////////////////////////////////////////////////////
        //  1. Application Selection  /////////////////////////////////////////
        ///////////////////////////////////////////////////////////////////////


        /**
         * Tests if the active editor has a selection.
         * @returns
         *  The number of items selected.
         */
        hasSelection(): number {
            return this.getSelection.length;
        },

        /**
         * Returns the active editor's selection.
         * @returns
         *  The selected objects.
         */
        getSelection(): DiagramObjectView[] {
            return [...this.activeEditor.selection.values()];
        },


        ///////////////////////////////////////////////////////////////////////
        //  3. Application Command History  ///////////////////////////////////
        ///////////////////////////////////////////////////////////////////////


        /**
         * Tests if the last command on the active editor can be undone.
         * @returns
         *  True if the last command can be undone, false otherwise.
         */
        canUndo(): boolean {
            return this.activeEditor.canUndo();
        },

        /**
         * Tests if the last undone command on the active editor can be redone.
         * @returns
         *  True if the last undone command can be redone, false otherwise.
         */
        canRedo(): boolean {
            return this.activeEditor.canRedo();
        },

        /**
         * True if the active editor has unsaved changes relative to the last
         * successful server save. Always false when the editor is not bound
         * to a server diagram.
         */
        isDirtyVsServer(): boolean {
            if (this.serverFileId === null) {
                return false;
            }
            const depth = this.activeEditor.lastServerSaveUndoDepth;
            if (depth === null) {
                return true;
            }
            return this.activeEditor.undoDepth !== depth;
        },


        ///////////////////////////////////////////////////////////////////////
        //  4. Application Page Validation  ///////////////////////////////////
        ///////////////////////////////////////////////////////////////////////


        /**
         * Tests if the active page represents a valid diagram per the
         * configured validator. If the application is not configured with a
         * validator, true is returned by default.
         * @param state
         *  The Vuex state.
         * @returns
         *  True if the page is valid, false otherwise.
         */
        isValid(): boolean {
            return this.activeValidator?.inValidState() ?? true;
        },

        /**
         * Returns the active page's validation errors. If the application is
         * not configured with a validator, an empty array is returned.
         * @param state
         *  The Vuex state.
         * @returns
         *  The active page's validation errors.
         */
        validationErrors(): ValidationErrorResult[] {
            return this.activeValidator?.getErrors() ?? [];
        },

        /**
         * Returns the active page's validation warnings. If the application is
         * not configured with a validator, an empty array is returned.
         * @param state
         *  The Vuex state.
         * @returns
         *  The active page's validation warnings.
         */
        validationWarnings(): ValidationWarningResult[] {
            return this.activeValidator?.getWarnings() ?? [];
        },


        ///////////////////////////////////////////////////////////////////////
        //  5. Application Search Menu  ///////////////////////////////////////
        ///////////////////////////////////////////////////////////////////////


        /**
         * Indicates whether the find dialog is visible.
         * @param state
         *  The Vuex state.
         * @returns
         *  True if the find dialog is visible.
         */
        isShowingFindDialog(state): boolean {
            return state.settings.view.search.display;
        },


        ///////////////////////////////////////////////////////////////////////
        //  6. Application Splash Menu  ///////////////////////////////////////
        ///////////////////////////////////////////////////////////////////////

        /**
         * Indicates whether the splash menu is visible.
         * @param state
         *  The Vuex state.
         * @returns
         *  True if the splash menu is visible.
         */
        isShowingSplash(state): boolean {
            return state.settings.view.splash_menu.display_menu;
        },

        /**
         * Get recently used timezone to pre-populate DateTime fields
         * @param state
         * the Vuex state
         * @returns
         * the UTC offset last used
         */
        stickyTimezone(state): string {
            return state.recentTimezone;
        },

        /**
         * Returns all data items available in the active editor's canvas.
         * @returns
         *  The data items, or an empty array if no canvas is available.
         */
        activeDataItems(): DataItem[] {
            const canvas = this.activeEditor?.file?.canvas;
            if (!canvas) {
                return [];
            }
            return readDataItems(canvas);
        },

        isRemotelyActive(state): boolean {
            return state.lastRemoteActivityTs !== null;
        }

    },
    actions: {

        /**
         * Executes an application command.
         * @param state
         *  The Vuex state.
         * @param command
         *  The application command.
         */
        async execute(command: AppCommand | EditorCommand) {
            if (command instanceof SynchronousEditorCommand) {
                this.activeEditor.execute(command);
            } else if (command instanceof AsynchronousEditorCommand) {
                await this.activeEditor.executeAsync(command);
            } else {
                command.execute();
            }
        },

        /**
         * Updates sticky timezone with most recently used timezone offset
         * @param utc new value to save
         */
        setStickyTimezone(utc: string) {
            this.recentTimezone = utc;
        },

        /**
         * Binds the active editor to a server-side diagram id, or clears the
         * binding when passed null.
         * @param id
         *  The server diagram id, or null to unbind.
         */
        setServerFileId(id: string | null) {
            this.serverFileId = id;
        },

        /**
         * Resets the active editor back to the no-op {@link PhantomEditor}.
         *
         * Used when the underlying file is no longer addressable (e.g. the
         * server diagram was deleted from under us by an agent) — leaves the
         * app in a clean "no file loaded" state so subsequent commands that
         * read `activeEditor` are not operating on an orphan.
         */
        resetActiveEditor() {
            this.activeEditor = PhantomEditor;
        },

        /**
         * Signals that the next single-object selection should focus its
         * representative property field. Bumps a counter so consecutive
         * spawns each fire even when the value would otherwise be unchanged.
         */
        requestNameFocus() {
            this.pendingNameFocus++;
        },

        markRemoteActivity(): void {
            if (_remoteActivityTimer !== null) clearTimeout(_remoteActivityTimer);
            this.lastRemoteActivityTs = Date.now();
            this.remoteActivityUndoDepth = this.activeEditor.undoDepth;
            _remoteActivityTimer = setTimeout(() => this.clearRemoteActivity(), 60_000);
        },

        clearRemoteActivity(): void {
            if (_remoteActivityTimer !== null) { clearTimeout(_remoteActivityTimer); _remoteActivityTimer = null; }
            this.lastRemoteActivityTs = null;
            this.remoteActivityUndoDepth = null;
        }

    }

});

export type ApplicationStore = ReturnType<typeof useApplicationStore>;
