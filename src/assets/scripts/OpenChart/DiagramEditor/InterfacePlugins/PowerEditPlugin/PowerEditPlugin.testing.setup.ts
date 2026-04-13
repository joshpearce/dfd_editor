/**
 * @file PowerEditPlugin.testing.setup.ts
 *
 * Shared environment shims for PowerEditPlugin spec files.
 * NOT production code — do not import from any production barrel.
 *
 * Imported automatically by PowerEditPlugin.testing.ts so every spec that
 * uses the scaffold gets the shims without boilerplate.
 *
 * Note on vi.mock() (M2):
 *   vitest hoists vi.mock() above all ES imports at compile time. This means
 *   identifiers introduced via `import` statements cannot be referenced inside
 *   the vi.mock() factory — they are undefined at hoist time. Therefore the
 *   mock factory body CANNOT be moved here and re-imported; each spec file must
 *   inline its own vi.mock() call with the full factory body.
 *
 *   The `diagramInterfaceMockFactory` export below serves as the authoritative
 *   reference implementation of the stub. When updating the stub, update it
 *   here; then mirror any changes into the inline copies in each spec file.
 *   This centralises the intent even though the call-site must stay per-spec.
 */

import { vi } from "vitest";

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
 * Reference implementation of the DiagramInterface stub used by all PowerEditPlugin
 * spec files.
 *
 * This function cannot be passed directly to vi.mock() from an import because
 * vitest hoists vi.mock() above ES imports — see the file-level note above.
 * Each spec inlines an equivalent factory; keep them in sync with this reference.
 */
export async function diagramInterfaceMockFactory() {
    const original = await import("@OpenChart/DiagramInterface");
    class DiagramInterfaceStub {
        on() { return this; }
        off() { return this; }
        emit() { return this; }
        render() { /* no-op */ }
        registerPlugin() { /* no-op */ }
        deregisterPlugin() { /* no-op */ }
    }
    return { ...original, DiagramInterface: DiagramInterfaceStub };
}
