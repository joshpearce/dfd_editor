// pattern: Imperative Shell
// (Wires a DfdSocketClient to ApplicationStore commands — pure I/O orchestration)

import { prepareEditorFromServerFile, setReadonlyMode, showSplashMenu } from "@/assets/scripts/Application/Commands";
import type { ApplicationStore } from "@/stores/ApplicationStore";
import type { DfdSocketClient } from "./DfdSocketClient";

/**
 * Registers handlers on the given {@link DfdSocketClient} that translate
 * broadcast envelopes into application commands dispatched through the
 * provided store context.
 *
 * @param client
 *  The connected (or reconnecting) socket client.
 * @param ctx
 *  The application store instance used to resolve and execute commands.
 * @returns
 *  A dispose callback that unsubscribes all handlers and permanently closes
 *  the socket. Call this from `unmounted()`.
 */
export function wireSocketClient(
    client: DfdSocketClient,
    ctx: ApplicationStore
): () => void {
    const unsubDisplay = client.on("display", (payload) => {
        void handleDisplay(payload, ctx);
    });

    const unsubUpdated = client.on("diagram-updated", (payload) => {
        void handleDiagramUpdated(payload, ctx);
    });

    const unsubDeleted = client.on("diagram-deleted", (payload) => {
        void handleDiagramDeleted(payload, ctx);
    });

    const unsubRemoteControl = client.on("remote-control", (payload) => {
        void handleRemoteControl(payload, ctx);
    });

    return () => {
        unsubDisplay();
        unsubUpdated();
        unsubDeleted();
        unsubRemoteControl();
        client.close();
    };
}


// -----------------------------------------------------------------------------
//  Private per-type handlers
// -----------------------------------------------------------------------------


/**
 * Handles a `display` envelope by loading the indicated diagram into the
 * editor.
 * @param payload
 *  The raw envelope payload — expected to be `{ id: string }`.
 * @param ctx
 *  The application store context.
 */
async function handleDisplay(
    payload: unknown,
    ctx: ApplicationStore
): Promise<void> {
    const id = extractId(payload);
    if (!id) {
        console.warn("DfdSocketDispatcher: display envelope missing id — ignored.");
        return;
    }
    try {
        await ctx.execute(await prepareEditorFromServerFile(ctx, id));
    } catch (err) {
        console.error("DfdSocketDispatcher: failed to display diagram:", err);
    }
}

/**
 * Handles a `diagram-updated` envelope by reloading the active diagram if its
 * id matches the currently-open server file.
 * @param payload
 *  The raw envelope payload — expected to be `{ id: string }`.
 * @param ctx
 *  The application store context.
 */
async function handleDiagramUpdated(
    payload: unknown,
    ctx: ApplicationStore
): Promise<void> {
    const id = extractId(payload);
    if (!id) {
        console.warn("DfdSocketDispatcher: diagram-updated envelope missing id — ignored.");
        return;
    }
    if (ctx.serverFileId !== id) {
        return; // not the active diagram — ignore
    }
    try {
        await ctx.execute(await prepareEditorFromServerFile(ctx, id));
    } catch (err) {
        console.error("DfdSocketDispatcher: failed to reload updated diagram:", err);
    }
}

/**
 * Handles a `diagram-deleted` envelope by returning to the splash screen if
 * the deleted diagram is currently open.
 * @param payload
 *  The raw envelope payload — expected to be `{ id: string }`.
 * @param ctx
 *  The application store context.
 */
async function handleDiagramDeleted(
    payload: unknown,
    ctx: ApplicationStore
): Promise<void> {
    const id = extractId(payload);
    if (!id) {
        console.warn("DfdSocketDispatcher: diagram-deleted envelope missing id — ignored.");
        return;
    }
    if (ctx.serverFileId !== id) {
        return; // not the active diagram — ignore
    }
    try {
        // Clear the server binding first so saves don't target a deleted file.
        ctx.setServerFileId(null);
        await ctx.execute(showSplashMenu(ctx));
    } catch (err) {
        console.error("DfdSocketDispatcher: failed to show splash after diagram deleted:", err);
    }
}

/**
 * Handles a `remote-control` envelope by toggling the application's
 * read-only mode.
 * @param payload
 *  The raw envelope payload — expected to be `{ state: "on" | "off" }`.
 * @param ctx
 *  The application store context.
 */
async function handleRemoteControl(
    payload: unknown,
    ctx: ApplicationStore
): Promise<void> {
    if (
        typeof payload !== "object"
        || payload === null
        || !("state" in payload)
    ) {
        console.warn("DfdSocketDispatcher: remote-control envelope missing state — ignored.");
        return;
    }
    const { state } = payload as { state: unknown };
    if (state !== "on" && state !== "off") {
        console.warn("DfdSocketDispatcher: remote-control state must be 'on' or 'off' — ignored.");
        return;
    }
    try {
        await ctx.execute(setReadonlyMode(ctx, state === "on"));
    } catch (err) {
        console.error("DfdSocketDispatcher: failed to set readonly mode:", err);
    }
}


// -----------------------------------------------------------------------------
//  Shared helpers
// -----------------------------------------------------------------------------


/**
 * Extracts the `id` string from an envelope payload, returning `null` if the
 * payload is not an object with a string `id` field.
 * @param payload
 *  The raw envelope payload.
 * @returns
 *  The id string, or null.
 */
function extractId(payload: unknown): string | null {
    if (
        typeof payload === "object"
        && payload !== null
        && "id" in payload
        && typeof (payload as { id: unknown }).id === "string"
    ) {
        return (payload as { id: string }).id;
    }
    return null;
}
