import { afterEach, describe, it, expect, vi } from "vitest";
import { selectedLayoutEngineKey } from "./index";
import { DEFAULT_LAYOUT_ENGINE, resolveLayoutEngine } from "@/assets/scripts/LayoutEngineRegistry";
import type { LayoutEngineCallbacks } from "@/assets/scripts/LayoutEngineRegistry";
import { NewAutoLayoutEngine, NativeLayoutEngine } from "@OpenChart/DiagramView/DiagramLayoutEngine";

const fakeCallbacks: LayoutEngineCallbacks = {
    layoutDiagram: async () => "",
    nativeLayout: async () => ({})
};

function stubSearch(search: string): void {
    vi.stubGlobal("location", { search } as unknown as Location);
}

afterEach(() => {
    vi.unstubAllGlobals();
});


describe("selectedLayoutEngineKey — query-string → key", () => {

    it("DEFAULT_LAYOUT_ENGINE is 'tala' (documents current default; test will flag the future flip)", () => {
        expect(DEFAULT_LAYOUT_ENGINE).toBe("tala");
    });

    it("?layoutEngine=native  returns 'native'", () => {
        stubSearch("?layoutEngine=native");
        expect(selectedLayoutEngineKey()).toBe("native");
    });

    it("?layoutEngine=tala  returns 'tala'", () => {
        stubSearch("?layoutEngine=tala");
        expect(selectedLayoutEngineKey()).toBe("tala");
    });

    it("?layoutEngine=new (alias)  returns 'tala'", () => {
        stubSearch("?layoutEngine=new");
        expect(selectedLayoutEngineKey()).toBe("tala");
    });

    it("?layoutEngine=garbage (unrecognized)  returns DEFAULT_LAYOUT_ENGINE", () => {
        stubSearch("?layoutEngine=garbage");
        expect(selectedLayoutEngineKey()).toBe(DEFAULT_LAYOUT_ENGINE);
    });

    it("no layoutEngine param (empty search)  returns DEFAULT_LAYOUT_ENGINE", () => {
        stubSearch("");
        expect(selectedLayoutEngineKey()).toBe(DEFAULT_LAYOUT_ENGINE);
    });

    it("?layoutEngine=NATIVE (uppercase, case-sensitive)  returns DEFAULT_LAYOUT_ENGINE", () => {
        stubSearch("?layoutEngine=NATIVE");
        expect(selectedLayoutEngineKey()).toBe(DEFAULT_LAYOUT_ENGINE);
    });

});


describe("selectedLayoutEngineKey — end-to-end engine class selection", () => {

    it("?layoutEngine=native  resolves to NativeLayoutEngine", () => {
        stubSearch("?layoutEngine=native");
        const engine = resolveLayoutEngine(selectedLayoutEngineKey(), fakeCallbacks);
        expect(engine).toBeInstanceOf(NativeLayoutEngine);
    });

    it("?layoutEngine=tala  resolves to NewAutoLayoutEngine", () => {
        stubSearch("?layoutEngine=tala");
        const engine = resolveLayoutEngine(selectedLayoutEngineKey(), fakeCallbacks);
        expect(engine).toBeInstanceOf(NewAutoLayoutEngine);
    });

});
