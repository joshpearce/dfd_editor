/**
 * @file useEditorEditEvent.ts
 *
 * Composable that registers a handler for every editor "edit" event.
 * Automatically re-attaches when the active editor changes and removes the
 * listener on component unmount.
 *
 * Extracted from DataItemParentRefField.vue and OwnedDataItemsSection.vue to
 * avoid duplicating the attachedEditor safeguard and watcher setup across both
 * components.
 */

// pattern: Imperative Shell

import { watch, onUnmounted } from "vue";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";

/**
 * Shape of an active-editor-bearing store.  Narrowed to the subset the
 * composable actually needs, avoiding a direct Pinia store import which
 * would create a circular dependency risk and make the composable harder
 * to test.
 */
interface EditorStore {
    activeEditor: unknown;
}

/**
 * Register a handler that fires after every editor "edit" event.
 * Automatically re-attaches when the active editor changes and removes the
 * listener on component unmount.
 *
 * @param store    The application store (only `activeEditor` is accessed).
 * @param handler  The callback to invoke after each edit.
 */
export function useEditorEditEvent(store: EditorStore, handler: () => void): void {
    let attachedEditor: DiagramViewEditor | null = null;
    let editListener: ((...args: unknown[]) => void) | null = null;

    function detach(): void {
        const editor = attachedEditor;
        if (!editor || !editListener || typeof editor.removeEventListener !== "function") { return; }
        editor.removeEventListener("edit", editListener as Parameters<typeof editor.removeEventListener>[1]);
        editListener = null;
        attachedEditor = null;
    }

    function attach(): void {
        detach();
        const editor = store.activeEditor as DiagramViewEditor | undefined;
        if (!editor || typeof editor.on !== "function") { return; }
        const listener = () => { handler(); };
        editor.on("edit", listener as Parameters<typeof editor.on>[1]);
        editListener = listener;
        attachedEditor = editor;
    }

    watch(
        () => store.activeEditor,
        () => { attach(); },
        { immediate: true }
    );

    onUnmounted(() => { detach(); });
}
