/// <reference types="node" />
//
// Static confinement guard for src/assets/scripts/LayoutHarness/runHarness.spec.ts.
//
// The harness is a standalone parity-development tool that must remain
// structurally isolated from the app command graph, Pinia, Vue, and the
// query-string reader.  A query string cannot reach the harness via any import
// path — the import graph enforces this, not convention.  Deleting the
// LayoutHarness directory (plus the `tala` key) must leave the app building.
//
// This file reads source as text; it does NOT import the harness module.
// Importing runHarness.spec.ts would execute its top-level `new JSDOM("")`
// polyfill at collection time and pull the JSDOM env into the test runner.
//

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";

const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
const HARNESS_ENTRY = fileURLToPath(new URL("./runHarness.spec.ts", import.meta.url));
// Repo root: LayoutHarness dir is src/assets/scripts/LayoutHarness,
// so 4 parent steps up from the dir reach the repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHarness(): string {
    return readFileSync(HARNESS_ENTRY, "utf8");
}

/** Strip single-line comments and block comments from TS source. */
function stripComments(src: string): string {
    // Remove block comments /* ... */ first, then single-line // comments.
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

function extractImportSpecifiers(source: string): string[] {
    return source
        .split("\n")
        .filter((l) => /^\s*import\s/.test(l))
        .map((l) => {
            const m = l.match(/from\s+["']([^"']+)["']/);
            return m ? m[1] : null;
        })
        .filter((s): s is string => s !== null);
}


describe("LayoutHarness confinement guard", () => {

    describe("import graph — harness imports only from allowed modules", () => {

        it("has no forbidden imports (Application/Commands, Pinia, Vue, stores, DfdApiClient, selectedLayoutEngineKey)", () => {
            const src = readHarness();
            const importLines = src
                .split("\n")
                .filter((l) => /^\s*import\s/.test(l));

            // Architectural invariant: the harness must NOT import the app
            // command graph (Application/Commands), Pinia, Vue, app stores,
            // the DfdApiClient relative-URL HTTP client, or the query-string
            // reader (selectedLayoutEngineKey).  Any of these would create an
            // import path from a query string into the harness — the confinement
            // guarantee is structural, not merely by convention.
            const forbidden = [
                /Application\/Commands/,
                /selectedLayoutEngineKey/,
                /@\/stores/,
                /\bpinia\b/,
                /^['"]vue['"]$/,
                /@\/components/,
                /assets\/scripts\/api\/DfdApiClient/
            ];

            for (const line of importLines) {
                const specifierMatch = line.match(/from\s+["']([^"']+)["']/);
                if (!specifierMatch) {
                    continue;
                }
                const specifier = specifierMatch[1];
                for (const pattern of forbidden) {
                    // Failure message surfaced via the specifier in the loop variable.
                    // When this assertion fails, the specifier and pattern appear in the
                    // vitest diff (specifier is inspected in the surrounding scope).
                    expect(pattern.test(specifier)).toBe(false);
                }
            }
        });

        it("every import specifier is from the allowed set", () => {
            const specifiers = extractImportSpecifiers(readHarness());

            // Allowed origins:
            //   vitest        — test runner used as TS runtime
            //   node:*        — Node stdlib
            //   jsdom         — headless DOM polyfill
            //   @OpenChart/*  — engine + view primitives
            //   @/assets/scripts/LayoutEngineRegistry — neutral resolver
            //   @/assets/configuration/app.configuration — schema/theme config
            //
            // The harness may NOT import Application/Commands, Pinia, Vue,
            // app stores, or the browser HTTP client.
            const isAllowed = (s: string): boolean =>
                s === "vitest" ||
                s.startsWith("node:") ||
                s === "jsdom" ||
                s.startsWith("@OpenChart/") ||
                s === "@/assets/scripts/LayoutEngineRegistry" ||
                s === "@/assets/configuration/app.configuration";

            for (const specifier of specifiers) {
                // Architectural invariant: harness must only import from the allowed set.
                // Failure here means a new import was added that couples the harness to
                // the app graph (Pinia / Vue / commands) or the browser HTTP client.
                // Allowed: vitest, node:*, jsdom, @OpenChart/*, LayoutEngineRegistry,
                // app.configuration.
                expect(isAllowed(specifier)).toBe(true);
            }
        });

    });


    describe("confinement grep gate — no D2/SVG/TALA vocabulary in implementation paths", () => {

        it("does not reference D2Bridge, AnchorRebind, or parseTalaSvg identifiers in executable code", () => {
            // Strip comments before checking — the harness legitimately names
            // these in doc-comments to explain what the polyfill is for, but
            // must not *call* them in live code.  Comments are not executable;
            // they do not create an import-time or runtime dependency.
            const src = stripComments(readHarness());

            // These identifiers belong to the TALA-specific implementation
            // (NewAutoLayoutEngine internals).  The harness must not import or
            // call them; it uses the engine through the resolver abstraction.
            const talaVocab = /\bD2Bridge\b|\bAnchorRebind\b|\bparseTalaSvg\b/;
            expect(talaVocab.test(src)).toBe(false);
        });

        it("does not contain raw SVG processing or d2 CLI references", () => {
            const src = readHarness();

            // Hard-coded d2/svg/SVG strings would indicate the harness is
            // bypassing the resolver abstraction and coupling directly to the
            // TALA pipeline — which must stay confined to NewAutoLayoutEngine.
            // Exception: the `tala` engine key is a legitimate passthrough
            // value (the harness reads it from the job, does not hard-code it
            // as SVG/D2 vocabulary).
            //
            // We check for D2/SVG *identifiers*, not the key string "tala".
            const svgD2Vocab = /\bparseTala\b|\bD2Layout\b|\bsvgToLayout\b|\btala\.svg\b|\bd2\.run\b/;
            expect(svgD2Vocab.test(src)).toBe(false);
        });

    });


    describe("app never imports the harness", () => {

        it("no .ts file outside LayoutHarness/ imports from LayoutHarness", () => {
            // Structural guarantee: deleting the LayoutHarness directory must
            // leave the app building.  If any non-harness .ts file imports from
            // LayoutHarness, that invariant is broken.
            const srcDir = nodePath.join(REPO_ROOT, "src");

            const externalImporters: string[] = [];

            function walk(dir: string): void {
                for (const entry of readdirSync(dir)) {
                    const full = nodePath.join(dir, entry);
                    if (statSync(full).isDirectory()) {
                        walk(full);
                    } else if (full.endsWith(".ts") && !full.includes("LayoutHarness")) {
                        const content = readFileSync(full, "utf8");
                        if (/from\s+["'][^"']*LayoutHarness/.test(content)) {
                            externalImporters.push(full);
                        }
                    }
                }
            }

            walk(srcDir);

            expect(externalImporters).toEqual([]);
        });

    });


    describe("LayoutHarness directory itself is self-contained", () => {

        it("the harness directory contains only known files (runHarness.spec.ts + this guard)", () => {
            const files = readdirSync(HARNESS_DIR)
                .filter((f) => !f.startsWith("."))
                .sort();

            // If someone adds a new file to this directory they must update
            // this list — which forces a deliberate review of what is being
            // added and whether it violates the "standalone, deletable in one
            // commit" constraint.
            const expected = [
                "harnessConfinement.spec.ts",
                "runHarness.spec.ts"
            ];
            expect(files).toEqual(expected);
        });

    });

});
