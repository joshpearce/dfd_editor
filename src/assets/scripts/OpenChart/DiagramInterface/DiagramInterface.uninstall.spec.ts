/**
 * Unit tests for DiagramInterface.uninstallPlugin.
 *
 * Uses a minimal stub plugin subclass to stay focused on the API contract
 * rather than the concrete RectangleSelectPlugin / PowerEditPlugin
 * implementations.
 *
 * The global vitest setup (PowerEditPlugin.testing.setup.ts) stubs the
 * DiagramInterface module for all spec files. This file unmocks the module
 * so it can test the real implementation. We then bypass the DOM-dependent
 * constructor by using Object.create + manually seeding only the fields that
 * installPlugin / uninstallPlugin actually touch (the `plugins` Map).
 */

// Must be hoisted before any imports that pull in DiagramInterface.

vi.unmock("@OpenChart/DiagramInterface");

import { describe, it, expect, vi } from "vitest";
import { DiagramInterface } from "./DiagramInterface";
import { DiagramInterfacePlugin } from "./DiagramInterfacePlugin";
import type { SubjectTrack } from "./ObjectTrack";

// ---------------------------------------------------------------------------
// Minimal concrete plugin stubs — just enough to satisfy the abstract class.
// ---------------------------------------------------------------------------

class StubPluginA extends DiagramInterfacePlugin {
    public canHandleHover(): boolean { return false; }
    public canHandleSelection(): boolean { return false; }
    protected handleHoverStart(): void { return; }
    protected handleSelectStart(): boolean { return true; }
    protected handleSelectDrag(_track: SubjectTrack): void { return; }
    protected handleSelectEnd(): void { return; }
}

class StubPluginB extends DiagramInterfacePlugin {
    public canHandleHover(): boolean { return false; }
    public canHandleSelection(): boolean { return false; }
    protected handleHoverStart(): void { return; }
    protected handleSelectStart(): boolean { return true; }
    protected handleSelectDrag(_track: SubjectTrack): void { return; }
    protected handleSelectEnd(): void { return; }
}

class StubPluginC extends DiagramInterfacePlugin {
    public canHandleHover(): boolean { return false; }
    public canHandleSelection(): boolean { return false; }
    protected handleHoverStart(): void { return; }
    protected handleSelectStart(): boolean { return true; }
    protected handleSelectDrag(_track: SubjectTrack): void { return; }
    protected handleSelectEnd(): void { return; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the private plugins Map for assertion purposes only.
 * Production code never accesses it directly.
 */
function getPluginMap(iface: DiagramInterface): Map<string, DiagramInterfacePlugin> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (iface as any).plugins as Map<string, DiagramInterfacePlugin>;
}

/**
 * Read the private activePlugin field for assertion purposes only.
 */
function getActivePlugin(iface: DiagramInterface): DiagramInterfacePlugin | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (iface as any).activePlugin as DiagramInterfacePlugin | null;
}

/**
 * Build a minimal DiagramInterface without triggering the DOM-dependent
 * constructor (which calls d3.select(document.createElement("canvas"))).
 *
 * We use Object.create to get an instance with the correct prototype, then
 * manually seed the only private fields that installPlugin / uninstallPlugin
 * actually access: the `plugins` Map and `activePlugin`.
 */
function makeInterface(): DiagramInterface {
    const iface = Object.create(DiagramInterface.prototype) as DiagramInterface;
    // Seed the private `plugins` Map that installPlugin / uninstallPlugin use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (iface as any).plugins = new Map<string, DiagramInterfacePlugin>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (iface as any).activePlugin = null;
    return iface;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiagramInterface.uninstallPlugin", () => {

    it("removes a previously installed plugin by constructor name", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        iface.installPlugin(pluginA);

        expect(getPluginMap(iface).has("StubPluginA")).toBe(true);

        iface.uninstallPlugin(StubPluginA);

        expect(getPluginMap(iface).has("StubPluginA")).toBe(false);
    });

    it("is a no-op when the constructor was never installed", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        iface.installPlugin(pluginA);

        // Removing a plugin that was never installed must not throw
        expect(() => iface.uninstallPlugin(StubPluginB)).not.toThrow();

        // The installed plugin is unaffected
        expect(getPluginMap(iface).has("StubPluginA")).toBe(true);
    });

    it("removes multiple constructors in one call and leaves unmentioned plugins intact", () => {
        const iface = makeInterface();
        iface.installPlugin(new StubPluginA(), new StubPluginB(), new StubPluginC());

        // Sanity: all three installed
        expect(getPluginMap(iface).size).toBe(3);

        // Remove A and B only
        iface.uninstallPlugin(StubPluginA, StubPluginB);

        const map = getPluginMap(iface);
        expect(map.has("StubPluginA")).toBe(false);
        expect(map.has("StubPluginB")).toBe(false);
        // C must still be present
        expect(map.has("StubPluginC")).toBe(true);
        expect(map.size).toBe(1);
    });

    it("clears activePlugin when the uninstalled constructor matches the active plugin", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        iface.installPlugin(pluginA);
        // Simulate the interface having selected this plugin during a drag interaction.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (iface as any).activePlugin = pluginA;
        expect(getActivePlugin(iface)).toBe(pluginA);

        iface.uninstallPlugin(StubPluginA);

        expect(getActivePlugin(iface)).toBeNull();
    });

    it("leaves activePlugin intact when a different constructor is uninstalled", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        const pluginB = new StubPluginB();
        iface.installPlugin(pluginA, pluginB);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (iface as any).activePlugin = pluginA;

        iface.uninstallPlugin(StubPluginB);

        // activePlugin was not the uninstalled one — must remain unchanged.
        expect(getActivePlugin(iface)).toBe(pluginA);
    });

    it("invokes dispose() on removed plugins", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        const disposeSpy = vi.spyOn(pluginA, "dispose");
        iface.installPlugin(pluginA);

        iface.uninstallPlugin(StubPluginA);

        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it("does not invoke dispose when the constructor was never installed", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        const disposeSpy = vi.spyOn(pluginA, "dispose");
        iface.installPlugin(pluginA);

        iface.uninstallPlugin(StubPluginB);

        expect(disposeSpy).not.toHaveBeenCalled();
    });

    it("continues uninstalling remaining plugins after one plugin's dispose throws", () => {
        const iface = makeInterface();
        const pluginA = new StubPluginA();
        const pluginB = new StubPluginB();
        vi.spyOn(pluginA, "dispose").mockImplementation(() => {
            throw new Error("boom");
        });
        const disposeBSpy = vi.spyOn(pluginB, "dispose");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { return; });
        iface.installPlugin(pluginA, pluginB);

        expect(() => iface.uninstallPlugin(StubPluginA, StubPluginB)).not.toThrow();
        expect(disposeBSpy).toHaveBeenCalledTimes(1);
        expect(getPluginMap(iface).size).toBe(0);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

});
