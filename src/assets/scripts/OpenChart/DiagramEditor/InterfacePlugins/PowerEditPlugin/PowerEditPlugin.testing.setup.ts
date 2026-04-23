/**
 * @file PowerEditPlugin.testing.setup.ts
 *
 * Shared environment shims for PowerEditPlugin spec files.
 * NOT production code — do not import from any production barrel.
 *
 * Registered as a vitest setupFiles entry in vitest.config.ts, so this file
 * runs before every spec file. The vi.mock() call here stubs DiagramInterface
 * globally for all PowerEditPlugin specs without any per-file duplication.
 *
 * Note on vi.mock() hoisting:
 *   vitest hoists vi.mock() above all ES imports at compile time. This means
 *   identifiers introduced via `import` statements cannot be referenced inside
 *   the vi.mock() factory — they are undefined at hoist time.
 *
 *   The factory below only uses `importOriginal` (a callback provided by
 *   vitest itself) rather than any imported identifier, so the hoist is safe.
 *   This is also why `diagramInterfaceMockFactory` (below) cannot be directly
 *   used as the vi.mock() second argument — it is an import and thus undefined
 *   at hoist time. The inline factory duplicates its body intentionally.
 */

import { vi } from "vitest";

// Stub DiagramInterface for all PowerEditPlugin specs. DiagramInterface
// accesses document and window at construction time; this no-op stub lets
// DiagramViewEditor be instantiated in the node test environment.
vi.mock("@OpenChart/DiagramInterface", async (importOriginal) => {
    const original = await importOriginal<typeof import("@OpenChart/DiagramInterface")>();
    class DiagramInterfaceStub {
        // Truthful animation state: runAnimation/stopAnimation flip the flag so
        // isAnimationRunning() reflects actual calls rather than always returning
        // false.  No callers currently depend on this in tests, but the stub is
        // a more accurate model of the real DiagramInterface.
        private _running = false;
        on() { return this; }
        off() { return this; }
        emit() { return this; }
        render() { /* no-op */ }
        registerPlugin() { /* no-op */ }
        deregisterPlugin() { /* no-op */ }
        isAnimationRunning() { return this._running; }
        runAnimation() { this._running = true; }
        stopAnimation() { this._running = false; }
    }
    return { ...original, DiagramInterface: DiagramInterfaceStub };
});

// Node env lacks `window`; AutosaveController and ScreenEventMonitor reference
// it at runtime. Provide a minimal shim so tests remain DOM-free.
// vi.stubGlobal registers an afterEach restore automatically.
vi.stubGlobal("window", {
    setTimeout:  (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    devicePixelRatio: 1,
    matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    })
});

/**
 * Reference implementation of the DiagramInterface stub shape — exported for
 * documentation purposes only. The live stub is applied via the vi.mock() call
 * above (registered as a vitest setupFiles entry). Individual spec files no
 * longer need their own vi.mock("@OpenChart/DiagramInterface") blocks.
 *
 * @deprecated Not used directly; the setupFiles vi.mock() call above handles
 * stubbing for all specs. Kept here in case a future test needs to inspect the
 * stub shape.
 */
export async function diagramInterfaceMockFactory() {
    const original = await import("@OpenChart/DiagramInterface");
    class DiagramInterfaceStub {
        private _running = false;
        on() { return this; }
        off() { return this; }
        emit() { return this; }
        render() { /* no-op */ }
        registerPlugin() { /* no-op */ }
        deregisterPlugin() { /* no-op */ }
        isAnimationRunning() { return this._running; }
        runAnimation() { this._running = true; }
        stopAnimation() { this._running = false; }
    }
    return { ...original, DiagramInterface: DiagramInterfaceStub };
}
