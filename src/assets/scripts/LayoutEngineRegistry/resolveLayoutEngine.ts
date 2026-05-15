// pattern: Functional Core
import { NewAutoLayoutEngine, NativeLayoutEngine } from "@OpenChart/DiagramView/DiagramLayoutEngine";
import type { LayoutSource, NativeLayoutSource, AsyncDiagramLayoutEngine } from "@OpenChart/DiagramView/DiagramLayoutEngine";

/**
 * The set of recognized engine keys.  Use {@link resolveLayoutEngine} to
 * obtain an engine instance from a key.
 *
 * - `"tala"` — {@link NewAutoLayoutEngine} (D2 + TALA, the current default).
 * - `"native"` — {@link NativeLayoutEngine} (scaffold, no D2/TALA dependency).
 */
export type LayoutEngineKey = "tala" | "native";

/**
 * The engine used when no key is supplied or when an unrecognized key is
 * passed to {@link resolveLayoutEngine}.  Set to `"tala"` during the parity
 * phase so layout-less imports keep working; flip to `"native"` once parity
 * is reached.
 */
export const DEFAULT_LAYOUT_ENGINE: LayoutEngineKey = "tala";

/**
 * The HTTP-level callbacks injected into engine constructors.  Declared here
 * rather than in the engine files so the engines themselves remain HTTP-free
 * (OpenChart boundary).
 *
 * - `layoutDiagram` — passed to {@link NewAutoLayoutEngine}; accepts a D2
 *   source string and resolves to a TALA-rendered SVG string.
 * - `nativeLayout`  — passed to {@link NativeLayoutEngine}; accepts a
 *   serialized diagram document and resolves to a {@link PositionMap}.
 */
export interface LayoutEngineCallbacks {
    layoutDiagram: LayoutSource;
    nativeLayout:  NativeLayoutSource;
}

/**
 * Returns the {@link AsyncDiagramLayoutEngine} corresponding to `key`,
 * wiring the appropriate callback from `callbacks` into its constructor.
 *
 * This is the single source of truth mapping a key to an engine:
 *  - `"tala"`    → {@link NewAutoLayoutEngine} (receives `layoutDiagram`)
 *  - `"native"`  → {@link NativeLayoutEngine} (receives `nativeLayout`)
 *  - any other string → {@link DEFAULT_LAYOUT_ENGINE} (recursive, terminates
 *    because the default is always a recognized case)
 *
 * The `key` parameter is typed `string` (not `LayoutEngineKey`) so callers
 * can pass arbitrary query-string values without a cast; the function falls
 * back to {@link DEFAULT_LAYOUT_ENGINE} for unknown input.
 *
 * Note: the browser-only query-string reader `selectedLayoutEngineKey()` is
 * deliberately absent from this module.  It lives with the app wiring (Step 4)
 * so this module has no `location`/DOM/query-string dependency and cannot
 * structurally reach a query string.
 *
 * @param key       - An engine key string, e.g. `"tala"` or `"native"`.
 * @param callbacks - HTTP-level callbacks bound into engine constructors.
 * @returns         An {@link AsyncDiagramLayoutEngine} ready to run.
 */
export function resolveLayoutEngine(
    key: string,
    callbacks: LayoutEngineCallbacks
): AsyncDiagramLayoutEngine {
    switch (key) {
        case "native":
            return new NativeLayoutEngine(callbacks.nativeLayout);
        case "tala":
            return new NewAutoLayoutEngine(callbacks.layoutDiagram);
        default:
            return resolveLayoutEngine(DEFAULT_LAYOUT_ENGINE, callbacks);
    }
}
