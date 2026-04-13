/**
 * @file PowerEditPlugin.testing.setup.ts
 *
 * Shared environment shims for PowerEditPlugin spec files.
 * NOT production code — do not import from any production barrel.
 *
 * Imported automatically by PowerEditPlugin.testing.ts so every spec that
 * uses the scaffold gets the shims without boilerplate.
 *
 * Note on vi.mock():
 *   vitest hoists vi.mock() calls per spec file at compile time — they cannot
 *   be moved to a shared module and remain hoisted. Each spec file that needs
 *   to stub DiagramInterface must include its own vi.mock() call. This module
 *   only handles the globalThis.window shim, which can safely live here.
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
