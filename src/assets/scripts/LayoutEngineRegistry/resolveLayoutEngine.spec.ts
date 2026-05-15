/// <reference types="node" />

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveLayoutEngine, DEFAULT_LAYOUT_ENGINE } from "./resolveLayoutEngine";
import type { LayoutEngineCallbacks } from "./resolveLayoutEngine";
import { NewAutoLayoutEngine, NativeLayoutEngine } from "@OpenChart/DiagramView/DiagramLayoutEngine";


const callbacks: LayoutEngineCallbacks = {
    layoutDiagram: async () => "",
    nativeLayout:  async () => ({})
};


describe("resolveLayoutEngine", () => {

    describe("key mapping", () => {

        it("maps 'tala' to NewAutoLayoutEngine", () => {
            expect(resolveLayoutEngine("tala", callbacks)).toBeInstanceOf(NewAutoLayoutEngine);
        });

        it("maps 'native' to NativeLayoutEngine", () => {
            expect(resolveLayoutEngine("native", callbacks)).toBeInstanceOf(NativeLayoutEngine);
        });

    });

    describe("fallback to default on unrecognized key", () => {

        it("DEFAULT_LAYOUT_ENGINE is 'tala' (documents current default; test will flag the future flip)", () => {
            expect(DEFAULT_LAYOUT_ENGINE).toBe("tala");
        });

        it("falls back to NewAutoLayoutEngine for an unknown string", () => {
            expect(resolveLayoutEngine("not-an-engine", callbacks)).toBeInstanceOf(NewAutoLayoutEngine);
        });

        it("falls back to NewAutoLayoutEngine for an empty string", () => {
            expect(resolveLayoutEngine("", callbacks)).toBeInstanceOf(NewAutoLayoutEngine);
        });

    });

});


describe("resolveLayoutEngine module — import-graph guard", () => {

    it("imports only from @OpenChart/DiagramView/DiagramLayoutEngine (no Vue/Pinia/store/app coupling)", () => {
        const src = readFileSync(
            fileURLToPath(new URL("./resolveLayoutEngine.ts", import.meta.url)),
            "utf8"
        );

        const importLines = src.split("\n").filter((l: string) => /^\s*import\s/.test(l));

        // Collect every module specifier present in the import statements.
        const specifiers = importLines
            .map((line: string) => {
                const m = line.match(/from\s+["']([^"']+)["']/);
                return m ? m[1] : null;
            })
            .filter((s): s is string => s !== null);

        // Every import must point at the single allowed barrel.
        // The resolver must be importable from a non-Vue / standalone-harness
        // context and may only import from @OpenChart/DiagramView/DiagramLayoutEngine.
        for (const specifier of specifiers) {
            expect(specifier).toBe("@OpenChart/DiagramView/DiagramLayoutEngine");
        }

        // Belt-and-suspenders: none of the import lines reference framework/app coupling.
        // The resolver must remain importable from a non-Vue / standalone-harness context.
        const forbidden = /vue|pinia|stores|components|Application|assets\/scripts\/api|DfdApiClient/i;
        for (const line of importLines) {
            expect(forbidden.test(line)).toBe(false);
        }
    });

});
