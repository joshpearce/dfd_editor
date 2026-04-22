// pattern: Functional Core
// (Tests pure reconnect/dispatch logic via an injected mock WebSocket)

import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from "vitest";
import { DfdSocketClient } from "./DfdSocketClient";

// ---------------------------------------------------------------------------
//  Mock WebSocket
// ---------------------------------------------------------------------------

type MockWsInstance = {
    url: string;
    _readyState: number;
    onopen: ((e: Event) => void) | null;
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: ((e: Event) => void) | null;
    onclose: ((e: CloseEvent) => void) | null;
    close: () => void;
    /** Test helper: fire the open event */
    simulateOpen: () => void;
    /** Test helper: fire a message event with a raw string payload */
    simulateMessage: (data: string) => void;
    /** Test helper: fire error then close (matches real WS behaviour) */
    simulateErrorThenClose: () => void;
    /** Test helper: fire a clean close */
    simulateClose: () => void;
};

let mockInstances: MockWsInstance[] = [];

class MockWebSocket {
    url: string;
    _readyState: number = 0; // CONNECTING
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;

    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    constructor(url: string) {
        this.url = url;
        mockInstances.push(this as unknown as MockWsInstance);
    }

    close() {
        // Real browser WebSocket.close() is a request — the CLOSED state and
        // the onclose event fire asynchronously. We do NOT flip _readyState here
        // so that tests can call simulateClose() independently to model the
        // async close event arriving after client.close() was called.
        this._readyState = MockWebSocket.CLOSING;
    }

    simulateOpen() {
        this._readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event("open"));
    }

    simulateMessage(data: string) {
        this.onmessage?.(new MessageEvent("message", { data }));
    }

    simulateErrorThenClose() {
        this.onerror?.(new Event("error"));
        this._readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
    }

    simulateClose() {
        this._readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
    }
}

// ---------------------------------------------------------------------------
//  Test setup
// ---------------------------------------------------------------------------

let consoleInfo: MockInstance;
let consoleWarn: MockInstance;
let consoleError: MockInstance;

beforeEach(() => {
    mockInstances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
    // Suppress console noise AND allow assertions on log lines (M3).
    consoleInfo  = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarn  = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
//  Helper
// ---------------------------------------------------------------------------

function latestWs(): MockWsInstance {
    return mockInstances[mockInstances.length - 1];
}

// ---------------------------------------------------------------------------
//  Tests: handler registration
// ---------------------------------------------------------------------------

describe("DfdSocketClient.on", () => {
    it("calls registered handler when matching envelope is received", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("display", (p) => { received.push(p); });

        latestWs().simulateMessage(JSON.stringify({ type: "display", payload: { id: "abc" } }));
        expect(received).toEqual([{ id: "abc" }]);

        client.close();
    });

    it("fans out to multiple handlers for the same type", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const a: unknown[] = [];
        const b: unknown[] = [];
        client.on("diagram-updated", (p) => { a.push(p); });
        client.on("diagram-updated", (p) => { b.push(p); });

        latestWs().simulateMessage(JSON.stringify({ type: "diagram-updated", payload: { id: "x" } }));
        expect(a).toEqual([{ id: "x" }]);
        expect(b).toEqual([{ id: "x" }]);

        client.close();
    });

    it("does NOT call handler for a different envelope type", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("display", (p) => { received.push(p); });

        latestWs().simulateMessage(JSON.stringify({ type: "diagram-deleted", payload: { id: "y" } }));
        expect(received).toHaveLength(0);

        client.close();
    });

    it("returns an unsubscribe function that removes the handler", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        const unsub = client.on("remote-control", (p) => { received.push(p); });

        latestWs().simulateMessage(JSON.stringify({ type: "remote-control", payload: { state: "on" } }));
        expect(received).toHaveLength(1);

        unsub();

        latestWs().simulateMessage(JSON.stringify({ type: "remote-control", payload: { state: "off" } }));
        expect(received).toHaveLength(1); // not called after unsub

        client.close();
    });

    it("silently drops non-JSON messages", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("display", (p) => { received.push(p); });

        latestWs().simulateMessage("not-json{{{{");
        expect(received).toHaveLength(0);

        client.close();
    });

    it("silently drops envelopes with unrecognised type", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("display", (p) => { received.push(p); });

        latestWs().simulateMessage(JSON.stringify({ type: "unknown-type", payload: {} }));
        expect(received).toHaveLength(0);

        client.close();
    });

    it("handles envelope with undefined payload", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("diagram-deleted", (p) => { received.push(p); });

        latestWs().simulateMessage(JSON.stringify({ type: "diagram-deleted" }));
        expect(received).toEqual([undefined]);

        client.close();
    });

    it("logs a console.error when a handler returns a rejecting promise", async () => {
        const err = new Error("boom");
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        client.on("display", () => Promise.reject(err));
        latestWs().simulateMessage(JSON.stringify({ type: "display", payload: {} }));
        // Flush microtasks so the .catch runs
        await Promise.resolve();
        await Promise.resolve();
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining("handler rejected"),
            err
        );
        client.close();
    });

    it("continues to fan out to sibling handlers when one handler throws synchronously", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        const thrower = vi.fn(() => { throw new Error("sync-throw"); });
        const survivor = vi.fn();
        client.on("display", thrower);
        client.on("display", survivor);

        latestWs().simulateMessage(JSON.stringify({ type: "display", payload: { id: "x" } }));

        expect(thrower).toHaveBeenCalledTimes(1);
        expect(survivor).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining("handler threw"),
            expect.any(Error)
        );
        client.close();
    });
});

// ---------------------------------------------------------------------------
//  Tests: reconnect / backoff
// ---------------------------------------------------------------------------

describe("DfdSocketClient reconnect backoff", () => {
    it("reconnects after first disconnect with 500 ms delay", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        expect(mockInstances).toHaveLength(1);

        latestWs().simulateClose();
        expect(mockInstances).toHaveLength(1); // not yet reconnected

        vi.advanceTimersByTime(499);
        expect(mockInstances).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(mockInstances).toHaveLength(2); // reconnected

        client.close();
    });

    it("uses escalating backoff delays on successive failures", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");

        // 1st disconnect → 500 ms
        latestWs().simulateClose();
        vi.advanceTimersByTime(500);
        expect(mockInstances).toHaveLength(2);

        // 2nd disconnect → 1000 ms
        latestWs().simulateClose();
        vi.advanceTimersByTime(999);
        expect(mockInstances).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(mockInstances).toHaveLength(3);

        // 3rd disconnect → 2000 ms
        latestWs().simulateClose();
        vi.advanceTimersByTime(1999);
        expect(mockInstances).toHaveLength(3);
        vi.advanceTimersByTime(1);
        expect(mockInstances).toHaveLength(4);

        // 4th disconnect → 5000 ms (cap reached)
        latestWs().simulateClose();
        vi.advanceTimersByTime(4999);
        expect(mockInstances).toHaveLength(4);
        vi.advanceTimersByTime(1);
        expect(mockInstances).toHaveLength(5);

        // 5th disconnect → still 5000 ms
        latestWs().simulateClose();
        vi.advanceTimersByTime(4999);
        expect(mockInstances).toHaveLength(5);
        vi.advanceTimersByTime(1);
        expect(mockInstances).toHaveLength(6);

        client.close();
    });

    it("resets the backoff counter after a successful open", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");

        // Cause two failures to push the backoff up to 1000 ms
        latestWs().simulateClose();
        vi.advanceTimersByTime(500);
        latestWs().simulateClose();
        vi.advanceTimersByTime(1000);
        expect(mockInstances).toHaveLength(3);

        // Now simulate a successful open — this resets the attempt counter
        latestWs().simulateOpen();

        // Next disconnect should use 500 ms again
        latestWs().simulateClose();
        vi.advanceTimersByTime(499);
        expect(mockInstances).toHaveLength(3);
        vi.advanceTimersByTime(1);
        expect(mockInstances).toHaveLength(4);

        client.close();
    });

    it("does NOT reconnect after close()", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();
        client.close();

        // If the underlying socket fires a close event after close() was called,
        // no reconnect should occur even after waiting a long time.
        vi.advanceTimersByTime(10_000);
        expect(mockInstances).toHaveLength(1);
    });

    it("cancels a pending reconnect when close() is called", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateClose(); // schedules reconnect at 500 ms

        // Close the client before the timer fires
        client.close();

        vi.advanceTimersByTime(1000);
        expect(mockInstances).toHaveLength(1); // no new connection created
    });

    it("logs a reconnect warning when the connection closes unexpectedly (M3)", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();
        latestWs().simulateClose();
        expect(consoleWarn).toHaveBeenCalledWith(
            expect.stringContaining("DfdSocketClient: disconnected — reconnecting in")
        );
        client.close();
    });

    it("does not reconnect twice when error then close fire together", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        latestWs().simulateErrorThenClose(); // error + close in sequence

        // Only one reconnect timer should have been scheduled
        vi.advanceTimersByTime(500);
        expect(mockInstances).toHaveLength(2); // exactly one reconnect

        client.close();
    });
});

// ---------------------------------------------------------------------------
//  Tests: close() idempotency
// ---------------------------------------------------------------------------

describe("DfdSocketClient.close", () => {
    it("is safe to call multiple times", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();
        expect(() => {
            client.close();
            client.close();
            client.close();
        }).not.toThrow();
    });

    it("does not schedule reconnect when onclose fires asynchronously after client.close()", () => {
        // M1: verify that the combination of _permanentlyClosed = true AND
        // nulling onclose prevents any reconnect after close().
        //
        // To test _permanentlyClosed independently, we capture the onclose
        // callback BEFORE close() nulls it, then invoke it afterward — this
        // simulates the true async "event already in the queue" scenario.
        //
        // This test FAILS if either guard is removed:
        //   - Remove `_permanentlyClosed = true` → the captured closure calls
        //     _scheduleReconnect() (because _permanentlyClosed is still false).
        //   - Remove `this._ws.onclose = null` → invoking capturedOnclose would
        //     call _scheduleReconnect() via the stale onclose reference that
        //     was set on the real _ws before it was nulled.  That path is the
        //     same: the captured closure still holds a reference to the old
        //     onclose fn, so removing _permanentlyClosed = true makes it
        //     re-enter _scheduleReconnect.
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();
        const ws = latestWs();

        // Capture the onclose callback BEFORE close() nulls it.
        // This is the "event already in the queue" race.
        const capturedOnclose = ws.onclose!;

        // Permanently close the client. This sets _permanentlyClosed = true
        // and sets ws.onclose = null.
        client.close();

        // Invoke the captured callback — simulates the browser firing the close
        // event that was already queued before we nulled the handler.
        // The closure checks `if (this._permanentlyClosed) return`, so with
        // the guard in place no reconnect is scheduled.
        capturedOnclose(new CloseEvent("close"));

        vi.advanceTimersByTime(10_000);
        expect(mockInstances).toHaveLength(1); // no reconnect
    });

    it("logs 'permanently closed' when close() is called (M3)", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();
        client.close();
        expect(consoleInfo).toHaveBeenCalledWith("DfdSocketClient: permanently closed.");
    });
});
