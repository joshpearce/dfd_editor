// pattern: Imperative Shell
// (Manages a stateful WebSocket connection with reconnect logic — inherently I/O-oriented)

/**
 * The set of broadcast envelope types the server can emit.
 */
export type SocketEnvelopeType =
    | "display"
    | "diagram-updated"
    | "diagram-deleted"
    | "remote-control";

/**
 * A broadcast envelope received from the server.
 */
export interface SocketEnvelope {
    type: SocketEnvelopeType;
    payload?: unknown;
}

type Handler = (payload: unknown) => void;

/**
 * The exponential-backoff delays (ms) used between reconnect attempts.
 * Once the last value is reached it is reused for all subsequent attempts.
 */
const BACKOFF_STEPS = [500, 1000, 2000, 5000] as const;

/**
 * A thin WebSocket client that connects to the DFD Flask server's `/ws`
 * endpoint and dispatches typed broadcast envelopes to registered handlers.
 *
 * Auto-reconnects with exponential backoff (500 ms → 1 s → 2 s → 5 s, then
 * stays at 5 s) until {@link close} is called, which permanently stops the
 * reconnect loop.
 *
 * @example
 * ```ts
 * const client = new DfdSocketClient("ws://localhost:5050/ws");
 * const unsub = client.on("display", (payload) => { ... });
 * // later:
 * unsub();
 * client.close();
 * ```
 */
export class DfdSocketClient {

    /**
     * The WebSocket server URL.
     */
    private readonly _url: string;

    /**
     * Per-type handler sets.
     */
    private readonly _handlers: Map<SocketEnvelopeType, Set<Handler>>;

    /**
     * Current WebSocket connection (null when not connected).
     */
    private _ws: WebSocket | null;

    /**
     * Number of consecutive failed open attempts. Reset to 0 on a successful
     * open; incremented before each backoff delay.
     */
    private _attemptCount: number;

    /**
     * Pending reconnect timer handle. Cleared on {@link close}.
     */
    private _reconnectTimer: ReturnType<typeof setTimeout> | null;

    /**
     * When true, the reconnect loop is permanently disabled.
     * Set by {@link close}.
     */
    private _permanentlyClosed: boolean;


    /**
     * Creates a new {@link DfdSocketClient} and immediately begins connecting.
     * @param url
     *  The WebSocket endpoint URL (e.g. `"ws://localhost:5050/ws"`).
     */
    constructor(url: string) {
        this._url = url;
        this._handlers = new Map();
        this._ws = null;
        this._attemptCount = 0;
        this._reconnectTimer = null;
        this._permanentlyClosed = false;
        this._connect();
    }


    // -------------------------------------------------------------------------
    //  Public API
    // -------------------------------------------------------------------------


    /**
     * Registers a handler for the given envelope type.
     * @param type
     *  The envelope type to listen for.
     * @param handler
     *  The callback invoked with the envelope's `payload` (may be `undefined`).
     * @returns
     *  An unsubscribe function. Calling it removes this specific handler.
     */
    on(type: SocketEnvelopeType, handler: Handler): () => void {
        let set = this._handlers.get(type);
        if (!set) {
            set = new Set();
            this._handlers.set(type, set);
        }
        set.add(handler);
        return () => {
            this._handlers.get(type)?.delete(handler);
        };
    }

    /**
     * Permanently closes the connection and stops the reconnect loop. Safe to
     * call multiple times.
     */
    close(): void {
        if (this._permanentlyClosed) {
            return;
        }
        this._permanentlyClosed = true;
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws !== null) {
            // Remove event listeners so the `close` event doesn't trigger a
            // reconnect attempt after we deliberately close the socket.
            this._ws.onopen = null;
            this._ws.onmessage = null;
            this._ws.onerror = null;
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }
        console.info("DfdSocketClient: permanently closed.");
    }


    // -------------------------------------------------------------------------
    //  Private helpers
    // -------------------------------------------------------------------------


    /**
     * Opens a new WebSocket connection and attaches lifecycle handlers.
     */
    private _connect(): void {
        if (this._permanentlyClosed) {
            return;
        }
        this._ws = new WebSocket(this._url);

        this._ws.onopen = () => {
            console.info("DfdSocketClient: connected to", this._url);
            this._attemptCount = 0;
        };

        this._ws.onmessage = (event: MessageEvent) => {
            this._handleMessage(event.data);
        };

        // The `error` event is always followed by `close`, so we only
        // reconnect in `onclose`. Log the error for visibility but don't
        // schedule a reconnect here.
        this._ws.onerror = () => {
            console.warn("DfdSocketClient: connection error — will reconnect on close.");
        };

        this._ws.onclose = () => {
            if (this._permanentlyClosed) {
                return;
            }
            this._scheduleReconnect();
        };
    }

    /**
     * Parses an incoming raw message and fans it out to registered handlers.
     * Silently drops non-JSON messages or envelopes that lack a `type` field.
     * @param raw
     *  The raw message data from the WebSocket `message` event.
     */
    private _handleMessage(raw: unknown): void {
        if (typeof raw !== "string") {
            return;
        }
        let envelope: SocketEnvelope;
        try {
            envelope = JSON.parse(raw) as SocketEnvelope;
        } catch {
            return; // non-JSON — silently drop
        }
        const type = envelope?.type;
        if (
            type !== "display"
            && type !== "diagram-updated"
            && type !== "diagram-deleted"
            && type !== "remote-control"
        ) {
            return; // missing or unrecognised type — silently drop
        }
        const handlers = this._handlers.get(type);
        if (!handlers) {
            return;
        }
        for (const handler of handlers) {
            handler(envelope.payload);
        }
    }

    /**
     * Schedules the next reconnect attempt using the backoff table.
     */
    private _scheduleReconnect(): void {
        const stepIndex = Math.min(this._attemptCount, BACKOFF_STEPS.length - 1);
        const delayMs = BACKOFF_STEPS[stepIndex];
        this._attemptCount++;
        console.warn(
            `DfdSocketClient: disconnected — reconnecting in ${delayMs} ms `
            + `(attempt ${this._attemptCount}).`
        );
        this._reconnectTimer = window.setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._permanentlyClosed) {
                this._connect();
            }
        }, delayMs);
    }

}
