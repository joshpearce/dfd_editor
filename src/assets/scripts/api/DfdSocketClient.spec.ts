// pattern: Functional Core
// (Tests pure reconnect/dispatch logic via an injected mock WebSocket)

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
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
        this._readyState = MockWebSocket.CLOSED;
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

beforeEach(() => {
    mockInstances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
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
        client.on("display", (p) => received.push(p));

        latestWs().simulateMessage(JSON.stringify({ type: "display", payload: { id: "abc" } }));
        expect(received).toEqual([{ id: "abc" }]);

        client.close();
    });

    it("fans out to multiple handlers for the same type", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const a: unknown[] = [];
        const b: unknown[] = [];
        client.on("diagram-updated", (p) => a.push(p));
        client.on("diagram-updated", (p) => b.push(p));

        latestWs().simulateMessage(JSON.stringify({ type: "diagram-updated", payload: { id: "x" } }));
        expect(a).toEqual([{ id: "x" }]);
        expect(b).toEqual([{ id: "x" }]);

        client.close();
    });

    it("does NOT call handler for a different envelope type", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("display", (p) => received.push(p));

        latestWs().simulateMessage(JSON.stringify({ type: "diagram-deleted", payload: { id: "y" } }));
        expect(received).toHaveLength(0);

        client.close();
    });

    it("returns an unsubscribe function that removes the handler", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        const unsub = client.on("remote-control", (p) => received.push(p));

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
        client.on("display", (p) => received.push(p));

        latestWs().simulateMessage("not-json{{{{");
        expect(received).toHaveLength(0);

        client.close();
    });

    it("silently drops envelopes with unrecognised type", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("display", (p) => received.push(p));

        latestWs().simulateMessage(JSON.stringify({ type: "unknown-type", payload: {} }));
        expect(received).toHaveLength(0);

        client.close();
    });

    it("handles envelope with undefined payload", () => {
        const client = new DfdSocketClient("ws://localhost:5050/ws");
        latestWs().simulateOpen();

        const received: unknown[] = [];
        client.on("diagram-deleted", (p) => received.push(p));

        latestWs().simulateMessage(JSON.stringify({ type: "diagram-deleted" }));
        expect(received).toEqual([undefined]);

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
});
