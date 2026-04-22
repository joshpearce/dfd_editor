// pattern: Functional Core
// (Pure composition of client + dispatcher — no I/O, no framework coupling)

import { DfdSocketClient } from "./DfdSocketClient";
import { wireSocketClient } from "./DfdSocketDispatcher";
import type { ApplicationStore } from "@/stores/ApplicationStore";

/**
 * Composes a {@link DfdSocketClient} with the dispatcher and returns a dispose
 * function that unsubscribes all handlers and permanently closes the socket.
 *
 * Extracted from `App.vue` so the wiring logic can be tested as pure
 * TypeScript without mounting a Vue component.
 *
 * @param client
 *  A constructed (connecting) socket client.
 * @param ctx
 *  The application store instance used to resolve and execute commands.
 * @returns
 *  A disposer that tears down the socket when called (suitable for
 *  `unmounted()` or `onUnmounted()`).
 *
 * @example
 * ```ts
 * // In App.vue created():
 * const socket = new DfdSocketClient("ws://localhost:5050/ws");
 * this.disposeSocket = setupSocketLifecycle(socket, this.application);
 * ```
 */
export function setupSocketLifecycle(
    client: DfdSocketClient,
    ctx: ApplicationStore
): () => void {
    return wireSocketClient(client, ctx);
}
