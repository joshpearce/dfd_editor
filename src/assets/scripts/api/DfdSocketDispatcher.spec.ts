// pattern: Functional Core
// (Tests the pure dispatch wiring logic using stub client and store objects)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { wireSocketClient } from "./DfdSocketDispatcher";
import type { SocketEnvelopeType } from "./DfdSocketClient";
import type { DfdSocketClient } from "./DfdSocketClient";
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
function makeStubCtx(serverFileId: string | null = null) {
    const executed: unknown[] = [];
    const stub = {
        serverFileId,
        executedCommands: executed,
        setServerFileId: vi.fn((id: string | null) => { stub.serverFileId = id; }),
        execute: vi.fn((cmd: unknown) => { executed.push(cmd); return Promise.resolve(); })
    };
    return stub as unknown as ApplicationStore & {
        executedCommands: unknown[];
        setServerFileId: ReturnType<typeof vi.fn>;
        execute: ReturnType<typeof vi.fn>;
    };
}

let ctx: ReturnType<typeof makeStubCtx>;

beforeEach(() => {
    ctx = makeStubCtx("active-id");
    vi.clearAllMocks();
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
});

// ---------------------------------------------------------------------------
//  Tests: diagram-deleted handler
// ---------------------------------------------------------------------------

describe("diagram-deleted handler", () => {
    it("clears serverFileId and shows splash when id matches", async () => {
        const { client, handlers } = makeStubClient();
        wireSocketClient(client, ctx);

        await handlers.get("diagram-deleted")!({ id: "active-id" });

        expect(ctx.setServerFileId).toHaveBeenCalledWith(null);
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
