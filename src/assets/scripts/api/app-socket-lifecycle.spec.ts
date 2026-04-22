// pattern: Functional Core
// (Tests the socket lifecycle wiring extracted from App.vue)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupSocketLifecycle } from "./app-socket-lifecycle";
import type { DfdSocketClient, SocketEnvelopeType } from "./DfdSocketClient";
import type { ApplicationStore } from "@/stores/ApplicationStore";

// ---------------------------------------------------------------------------
//  Mocks
// ---------------------------------------------------------------------------

// Mock the dispatcher so we only test the lifecycle composition, not dispatch
// internals (those are covered in DfdSocketDispatcher.spec.ts).
vi.mock("./DfdSocketDispatcher", () => ({
    wireSocketClient: vi.fn((_client: unknown, _ctx: unknown) => {
        // Return a stub disposer that records whether it was called.
        return vi.fn();
    })
}));

import { wireSocketClient } from "./DfdSocketDispatcher";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeStubClient(): DfdSocketClient {
    return {
        on(_type: SocketEnvelopeType, _handler: unknown) {
            return () => {};
        },
        close: vi.fn()
    } as unknown as DfdSocketClient;
}

function makeStubCtx(): ApplicationStore {
    return {
        execute: vi.fn().mockResolvedValue(undefined),
        serverFileId: null,
        setServerFileId: vi.fn()
    } as unknown as ApplicationStore;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("setupSocketLifecycle", () => {
    it("wires the client to the dispatcher (wireSocketClient is called)", () => {
        const client = makeStubClient();
        const ctx = makeStubCtx();

        setupSocketLifecycle(client, ctx);

        expect(wireSocketClient).toHaveBeenCalledExactlyOnceWith(client, ctx);
    });

    it("returns a disposer; calling it invokes the disposer returned by wireSocketClient", () => {
        const client = makeStubClient();
        const ctx = makeStubCtx();

        const dispose = setupSocketLifecycle(client, ctx);

        // The mock wireSocketClient returns a vi.fn() disposer.
        const [disposer] = (wireSocketClient as ReturnType<typeof vi.fn>).mock.results;
        expect(disposer.value).toBeInstanceOf(Function);

        dispose();

        expect(disposer.value).toHaveBeenCalledOnce();
    });

    it("does not call the disposer automatically (only on explicit unmount)", () => {
        const client = makeStubClient();
        const ctx = makeStubCtx();

        setupSocketLifecycle(client, ctx);

        const [disposer] = (wireSocketClient as ReturnType<typeof vi.fn>).mock.results;
        // disposer must NOT have been called during setup
        expect(disposer.value).not.toHaveBeenCalled();
    });
});
