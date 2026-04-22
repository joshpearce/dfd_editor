/**
 * Unit tests for SetReadonlyMode.
 *
 * Tests use a plain-object stub for the editor's interface so this file has
 * no dependency on the concrete DiagramInterface DOM setup (canvas, d3, etc.)
 * or on Vue / Pinia.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SetReadonlyMode } from "./SetReadonlyMode";
import { PhantomEditor } from "@/stores/PhantomEditor";
import { PowerEditPlugin, RectangleSelectPlugin } from "@OpenChart/DiagramEditor";
import { BaseAppSettings } from "@/assets/scripts/Application/Configuration/AppSettings";
import type { ApplicationStore } from "@/stores/ApplicationStore";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub interface whose installPlugin / uninstallPlugin are
 * vitest spies. The caller can provide either method to override the default
 * vi.fn().
 */
function makeStubInterface() {
    return {
        installPlugin: vi.fn(),
        uninstallPlugin: vi.fn(),
        // Extra no-ops so LoadFile-style construction doesn't explode if
        // a test path ever reaches them (not expected here).
        enableShadows: vi.fn(),
        enableDebugInfo: vi.fn(),
        enableAnimations: vi.fn()
    };
}

/**
 * Build a live-editor stub with a unique id (never equal to PhantomEditor.id).
 */
function makeStubEditor(iface = makeStubInterface()) {
    return {
        id: "real-editor-001",
        interface: iface,
        file: { factory: {} }
    } as unknown as DiagramViewEditor;
}

/**
 * Build a minimal ApplicationStore stub.  Only the fields read by
 * SetReadonlyMode are populated.
 */
function makeContext(overrides: { readOnlyMode?: boolean, activeEditor?: DiagramViewEditor } = {}) {
    return {
        readOnlyMode: overrides.readOnlyMode ?? false,
        activeEditor: overrides.activeEditor ?? (PhantomEditor as unknown as DiagramViewEditor),
        settings: BaseAppSettings
    } as unknown as ApplicationStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SetReadonlyMode", () => {

    describe("PhantomEditor — pure flag flip", () => {
        /**
         * When the active editor is the PhantomEditor placeholder, executing
         * the command must update the flag but must NOT touch the interface
         * because the phantom editor has no real canvas.
         *
         * The DiagramInterfaceStub (from PowerEditPlugin.testing.setup.ts) has
         * no installPlugin / uninstallPlugin methods. We attach no-op versions
         * in beforeEach so vi.spyOn can instrument them, then assert they are
         * never called — directly expressing the guard invariant.
         */
        let installSpy: ReturnType<typeof vi.spyOn>;
        let uninstallSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            // The stub DiagramInterface lacks installPlugin / uninstallPlugin.
            // Attach no-ops so vi.spyOn has something to wrap.
            Object.assign(PhantomEditor.interface, {
                installPlugin: () => { /* no-op */ },
                uninstallPlugin: () => { /* no-op */ }
            });
            installSpy = vi.spyOn(PhantomEditor.interface, "installPlugin" as never);
            uninstallSpy = vi.spyOn(PhantomEditor.interface, "uninstallPlugin" as never);
        });

        afterEach(() => {
            installSpy.mockRestore();
            uninstallSpy.mockRestore();
        });

        it("updates the flag and never calls installPlugin when toggled to read-only", async () => {
            const context = makeContext({ readOnlyMode: false });
            expect(context.activeEditor).toBe(PhantomEditor as unknown as DiagramViewEditor);

            await new SetReadonlyMode(context, true).execute();

            expect(context.readOnlyMode).toBe(true);
            expect(installSpy).not.toHaveBeenCalled();
            expect(uninstallSpy).not.toHaveBeenCalled();
        });

        it("updates the flag and never calls uninstallPlugin when toggled to interactive", async () => {
            const context = makeContext({ readOnlyMode: true });
            expect(context.activeEditor).toBe(PhantomEditor as unknown as DiagramViewEditor);

            await new SetReadonlyMode(context, false).execute();

            expect(context.readOnlyMode).toBe(false);
            expect(installSpy).not.toHaveBeenCalled();
            expect(uninstallSpy).not.toHaveBeenCalled();
        });
    });

    describe("live editor — readonly=true uninstalls both plugins", () => {
        let context: ApplicationStore;
        let iface: ReturnType<typeof makeStubInterface>;

        beforeEach(() => {
            iface = makeStubInterface();
            const editor = makeStubEditor(iface);
            context = makeContext({ readOnlyMode: false, activeEditor: editor });
        });

        it("calls uninstallPlugin with RectangleSelectPlugin and PowerEditPlugin", async () => {
            await new SetReadonlyMode(context, true).execute();

            expect(iface.uninstallPlugin).toHaveBeenCalledExactlyOnceWith(RectangleSelectPlugin, PowerEditPlugin);
            // The command passes both ctors in a single variadic call
        });

        it("does not call installPlugin when going read-only", async () => {
            await new SetReadonlyMode(context, true).execute();

            expect(iface.installPlugin).not.toHaveBeenCalled();
        });
    });

    describe("live editor — readonly=false installs both plugins", () => {
        let context: ApplicationStore;
        let iface: ReturnType<typeof makeStubInterface>;

        beforeEach(() => {
            iface = makeStubInterface();
            const editor = makeStubEditor(iface);
            context = makeContext({ readOnlyMode: true, activeEditor: editor });
        });

        it("calls installPlugin with instances of RectangleSelectPlugin and PowerEditPlugin", async () => {
            await new SetReadonlyMode(context, false).execute();

            expect(iface.installPlugin).toHaveBeenCalledOnce();
            const args = iface.installPlugin.mock.calls[0];
            // installPlugin is called as installPlugin(rectSelectInstance, powerEditInstance)
            expect(args[0]).toBeInstanceOf(RectangleSelectPlugin);
            expect(args[1]).toBeInstanceOf(PowerEditPlugin);
        });

        it("does not call uninstallPlugin when going interactive", async () => {
            await new SetReadonlyMode(context, false).execute();

            expect(iface.uninstallPlugin).not.toHaveBeenCalled();
        });
    });

    describe("no-op when value equals current readOnlyMode", () => {

        it("does not call installPlugin or uninstallPlugin when true→true", async () => {
            const iface = makeStubInterface();
            const editor = makeStubEditor(iface);
            const context = makeContext({ readOnlyMode: true, activeEditor: editor });

            await new SetReadonlyMode(context, true).execute();

            expect(iface.installPlugin).not.toHaveBeenCalled();
            expect(iface.uninstallPlugin).not.toHaveBeenCalled();
        });

        it("does not call installPlugin or uninstallPlugin when false→false", async () => {
            const iface = makeStubInterface();
            const editor = makeStubEditor(iface);
            const context = makeContext({ readOnlyMode: false, activeEditor: editor });

            await new SetReadonlyMode(context, false).execute();

            expect(iface.installPlugin).not.toHaveBeenCalled();
            expect(iface.uninstallPlugin).not.toHaveBeenCalled();
        });
    });

    describe("readOnlyMode flag is always updated", () => {
        const cases = [
            { from: false, to: true,  label: "false → true (live editor)"     },
            { from: true,  to: false, label: "true → false (live editor)"     },
            { from: false, to: false, label: "false → false no-op (live editor)" },
            { from: true,  to: true,  label: "true → true no-op (live editor)"   }
        ] as const;

        for (const { from, to, label } of cases) {
            it(`updates readOnlyMode: ${label}`, async () => {
                const editor = makeStubEditor();
                const context = makeContext({ readOnlyMode: from, activeEditor: editor });

                await new SetReadonlyMode(context, to).execute();

                expect(context.readOnlyMode).toBe(to);
            });
        }

        it("updates readOnlyMode even when activeEditor is PhantomEditor", async () => {
            const context = makeContext({ readOnlyMode: false });
            await new SetReadonlyMode(context, true).execute();
            expect(context.readOnlyMode).toBe(true);
        });
    });

});
