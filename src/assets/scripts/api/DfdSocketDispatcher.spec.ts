// pattern: Functional Core
// (Tests the pure dispatch wiring logic using stub client and store objects)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireSocketClient } from "./DfdSocketDispatcher";
import { type SocketEnvelopeType, type DfdSocketClient } from "./DfdSocketClient";
import type { ApplicationStore } from "@/stores/ApplicationStore";

// ---------------------------------------------------------------------------
//  Mocks
// ---------------------------------------------------------------------------

// Mock the Application Commands module so we can capture what gets executed
// without importing the full application graph.
vi.mock("@/assets/scripts/Application/Commands", () => ({
    prepareEditorFromServerFile: vi.fn((_ctx: unknown, id: string) =>
        Promise.resolve({ _type: "PrepareEditorWithFile", id })
    ),
    setReadonlyMode: vi.fn((_ctx: unknown, value: boolean) =>
        ({ _type: "SetReadonlyMode", value })
    ),
    showSplashMenu: vi.fn((_ctx: unknown) =>
        ({ _type: "ShowSplashMenu" })
    )
}));

import * as AppCommand from "@/assets/scripts/Application/Commands";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type HandlerMap = Map<SocketEnvelopeType, (payload: unknown) => void>;

/**
 * Creates a minimal stub DfdSocketClient that captures handlers registered
 * via `on()` and lets tests drive them manually.
 */
function makeStubClient(): { client: DfdSocketClient, handlers: HandlerMap, closed: boolean } {
    const handlers: HandlerMap = new Map();
    let closed = false;
    const client = {
        on(type: SocketEnvelopeType, handler: (payload: unknown) => void) {
            handlers.set(type, handler);
            return () => { handlers.delete(type); };
        },
        close() { closed = true; }
    } as unknown as DfdSocketClient;

    // Expose closed state via reference wrapper
    const wrapper = { client, handlers, get closed() { return closed; } };
    return wrapper;
}

/**
 * Creates a minimal stub ApplicationStore cast to the full store type.
 * Only the subset of properties used by the dispatcher is implemented.
 */
function makeStubCtx(serverFileId: string | null = null, isDirtyVsServer = false) {
    const executed: unknown[] = [];
    const stub = {
        serverFileId,
        isDirtyVsServer,
        executedCommands: executed,
        setServerFileId: vi.fn((id: string | null) => { stub.serverFileId = id; }),
        resetActiveEditor: vi.fn(),
        execute: vi.fn((cmd: unknown) => { executed.push(cmd); return Promise.resolve(); })
    };
    return stub as unknown as ApplicationStore & {
        executedCommands: unknown[];
        setServerFileId: ReturnType<typeof vi.fn>;
        resetActiveEditor: ReturnType<typeof vi.fn>;
        execute: ReturnType<typeof vi.fn>;
    };
}

let ctx: ReturnType<typeof makeStubCtx>;

beforeEach(() => {
    ctx = makeStubCtx("active-id");
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
//  Tests: wireSocketClient wiring
// ---------------------------------------------------------------------------

describe("wireSocketClient", () => {
    it("registers handlers for all four envelope types", () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        expect(handlers.has("display")).toBe(true);
        expect(handlers.has("diagram-updated")).toBe(true);
        expect(handlers.has("diagram-deleted")).toBe(true);
        expect(handlers.has("remote-control")).toBe(true);
    });

    it("returns a dispose callback that closes the client", () => {
        const wrapper = makeStubClient();
        const dispose = wireSocketClient(wrapper.client, ctx);
        dispose();

        expect(wrapper.closed).toBe(true);
    });
});

// ---------------------------------------------------------------------------
//  Tests: display handler
// ---------------------------------------------------------------------------

describe("display handler", () => {
    it("calls prepareEditorFromServerFile and executes the command", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("display")!({ id: "diagram-1" });

        expect(AppCommand.prepareEditorFromServerFile).toHaveBeenCalledWith(ctx, "diagram-1");
        expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it("ignores payload without id", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("display")!({});

        expect(ctx.execute).not.toHaveBeenCalled();
    });

    it("ignores null payload", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("display")!(null);

        expect(ctx.execute).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
//  Tests: diagram-updated handler
// ---------------------------------------------------------------------------

describe("diagram-updated handler", () => {
    it("reloads the file when id matches the active server file", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx); // ctx.serverFileId === "active-id"

        await handlers.get("diagram-updated")!({ id: "active-id" });

        expect(AppCommand.prepareEditorFromServerFile).toHaveBeenCalledWith(ctx, "active-id");
        expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it("ignores the update when id does not match the active server file", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("diagram-updated")!({ id: "other-diagram" });

        expect(ctx.execute).not.toHaveBeenCalled();
    });

    it("ignores payload without id", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("diagram-updated")!({});

        expect(ctx.execute).not.toHaveBeenCalled();
    });

    it("prompts the user and skips reload when local edits are unsaved and user declines", async () => {
        const dirtyCtx = makeStubCtx("active-id", true);
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, dirtyCtx);
        // jsdom's window.confirm is absent by default — install a stub.
        const confirmStub = vi.fn(() => false);
        window.confirm = confirmStub;

        await handlers.get("diagram-updated")!({ id: "active-id" });

        expect(confirmStub).toHaveBeenCalledTimes(1);
        expect(dirtyCtx.execute).not.toHaveBeenCalled();
    });

    it("prompts the user and reloads when local edits are unsaved and user accepts", async () => {
        const dirtyCtx = makeStubCtx("active-id", true);
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, dirtyCtx);
        const confirmStub = vi.fn(() => true);
        window.confirm = confirmStub;

        await handlers.get("diagram-updated")!({ id: "active-id" });

        expect(confirmStub).toHaveBeenCalledTimes(1);
        expect(AppCommand.prepareEditorFromServerFile).toHaveBeenCalledWith(dirtyCtx, "active-id");
        expect(dirtyCtx.execute).toHaveBeenCalledTimes(1);
    });

    it("does not prompt when editor is clean", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx); // ctx.isDirtyVsServer === false
        const confirmStub = vi.fn(() => true);
        window.confirm = confirmStub;

        await handlers.get("diagram-updated")!({ id: "active-id" });

        expect(confirmStub).not.toHaveBeenCalled();
        expect(ctx.execute).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
//  Tests: diagram-deleted handler
// ---------------------------------------------------------------------------

describe("diagram-deleted handler", () => {
    it("clears serverFileId, resets active editor, and shows splash when id matches", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("diagram-deleted")!({ id: "active-id" });

        expect(ctx.setServerFileId).toHaveBeenCalledWith(null);
        expect(ctx.resetActiveEditor).toHaveBeenCalledTimes(1);
        expect(AppCommand.showSplashMenu).toHaveBeenCalledWith(ctx);
        expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it("ignores the delete when id does not match the active server file", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("diagram-deleted")!({ id: "different-id" });

        expect(ctx.setServerFileId).not.toHaveBeenCalled();
        expect(ctx.execute).not.toHaveBeenCalled();
    });

    it("ignores payload without id", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("diagram-deleted")!({});

        expect(ctx.setServerFileId).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
//  Tests: remote-control handler
// ---------------------------------------------------------------------------

describe("remote-control handler", () => {
    it("sets readonly mode to true when state is 'on'", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("remote-control")!({ state: "on" });

        expect(AppCommand.setReadonlyMode).toHaveBeenCalledWith(ctx, true);
        expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it("sets readonly mode to false when state is 'off'", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("remote-control")!({ state: "off" });

        expect(AppCommand.setReadonlyMode).toHaveBeenCalledWith(ctx, false);
        expect(ctx.execute).toHaveBeenCalledTimes(1);
    });

    it("ignores payload with unrecognised state", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("remote-control")!({ state: "maybe" });

        expect(ctx.execute).not.toHaveBeenCalled();
    });

    it("ignores null payload", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("remote-control")!(null);

        expect(ctx.execute).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
//  Tests: error resilience (M2) — each handler absorbs ctx.execute rejections
// ---------------------------------------------------------------------------

describe("display handler — error resilience", () => {
    it("does not throw when ctx.execute rejects, logs error, and still handles the next valid envelope", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);
        const handler = handlers.get("display")!;

        ctx.execute.mockRejectedValueOnce(new Error("display-failure"));

        handler({ id: "diagram-1" });
        await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("DfdSocketDispatcher:"),
            expect.any(Error)
        ));

        // Handler registration must still be intact — second call succeeds.
        ctx.execute.mockResolvedValueOnce(undefined);
        await handler({ id: "diagram-2" });
        expect(ctx.execute).toHaveBeenCalledTimes(2);
    });
});

describe("diagram-updated handler — error resilience", () => {
    it("does not throw when ctx.execute rejects, logs error, and still handles the next valid envelope", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx); // ctx.serverFileId === "active-id"
        const handler = handlers.get("diagram-updated")!;

        ctx.execute.mockRejectedValueOnce(new Error("updated-failure"));

        handler({ id: "active-id" });
        await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("DfdSocketDispatcher:"),
            expect.any(Error)
        ));

        ctx.execute.mockResolvedValueOnce(undefined);
        await handler({ id: "active-id" });
        expect(ctx.execute).toHaveBeenCalledTimes(2);
    });
});

describe("diagram-deleted handler — error resilience", () => {
    it("does not throw when ctx.execute rejects, logs error, and still handles the next valid envelope", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx); // ctx.serverFileId === "active-id"
        const handler = handlers.get("diagram-deleted")!;

        ctx.execute.mockRejectedValueOnce(new Error("deleted-failure"));

        handler({ id: "active-id" });
        await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("DfdSocketDispatcher:"),
            expect.any(Error)
        ));

        // Reset serverFileId so the second call also matches.
        ctx.serverFileId = "active-id";
        ctx.execute.mockResolvedValueOnce(undefined);
        await handler({ id: "active-id" });
        expect(ctx.execute).toHaveBeenCalledTimes(2);
    });
});

describe("remote-control handler — error resilience", () => {
    it("does not throw when ctx.execute rejects, logs error, and still handles the next valid envelope", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);
        const handler = handlers.get("remote-control")!;

        ctx.execute.mockRejectedValueOnce(new Error("remote-control-failure"));

        handler({ state: "on" });
        await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("DfdSocketDispatcher:"),
            expect.any(Error)
        ));

        ctx.execute.mockResolvedValueOnce(undefined);
        await handler({ state: "off" });
        expect(ctx.execute).toHaveBeenCalledTimes(2);
    });
});
