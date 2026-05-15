// pattern: Imperative Shell
/* eslint-disable vitest/expect-expect -- this file uses vitest as a TS runtime, not an assertion suite */
//
// Temporary parity-development tool.  Standalone module — the app never
// imports this directory.  Exercises the real engine pipeline headless via
// vitest (preprocessor → factory → DiagramViewFile → runLayout → toExport).
// Deletable in one commit alongside the `tala` key + NewAutoLayoutEngine files.
//
// Requires Flask reachable (layout-engine HTTP callbacks) — run under
// `npm run dev:all`.
//
// --- I/O channel deviations from the plan ---
//
// The plan describes stdin/stdout as the I/O channels.  Two constraints forced
// a different approach:
//
//  1. INPUT via env var (LAYOUT_HARNESS_JOB) instead of stdin:
//     Vitest runs test bodies in worker forks.  `process.stdin` inside a
//     vitest worker is closed / unreliable.  An env var set on
//     `subprocess.run(env=…)` carries the job JSON with the same security
//     guarantees as stdin (Flask never builds a shell string; no interpolation
//     of user data into argv).
//
//  2. OUTPUT via temp file (path in LAYOUT_HARNESS_OUT) instead of stdout:
//     Vitest pollutes stdout with reporter banners, progress lines, and timing
//     output.  Parsing `{engine,ms,document}` off stdout is fragile.  A temp
//     file created by Python's `tempfile` module outside `storage.DATA_DIR`
//     (OS temp dir ≠ DATA_DIR) is robust and satisfies the "never writes
//     server/data/" invariant.

import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { ThemeLoader } from "@OpenChart/ThemeLoader";
import { DiagramObjectViewFactory } from "@OpenChart/DiagramView";
import { DiagramViewFile } from "@OpenChart/DiagramView";
import { resolveLayoutEngine } from "@/assets/scripts/LayoutEngineRegistry";
import Configuration from "@/assets/configuration/app.configuration";
import type { PositionMap } from "@OpenChart/DiagramView/DiagramLayoutEngine";
import type { DiagramViewExport } from "@OpenChart/DiagramView/DiagramViewExport";

// Polyfill DOMParser for the Node environment.
// NewAutoLayoutEngine's SVG-parsing path (D2Bridge.parseTalaSvg) calls
// `new DOMParser()`, which is only available natively in browsers / jsdom.
// The vitest config uses environment:node (so GlobalFontStore picks
// NodeFontStore and font loading works headlessly); we supply DOMParser via
// jsdom without switching the entire environment.
if (typeof globalThis.DOMParser === "undefined") {
    const { window } = new JSDOM("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).DOMParser = window.DOMParser;
}

// ---------------------------------------------------------------------------
// Absolute-URL callbacks for the engine constructors.
// DfdApiClient uses relative URLs ("/api/…") which Vite proxies in-browser.
// In the Node runtime there is no Vite proxy, so the harness defines its own
// callbacks that fetch the running Flask directly.
// ---------------------------------------------------------------------------

const API_BASE = process.env.LAYOUT_HARNESS_API_BASE ?? "http://127.0.0.1:5050";

async function layoutDiagram(source: string): Promise<string> {
    const response = await fetch(`${API_BASE}/api/layout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source })
    });
    if (!response.ok) {
        let message = `layout request failed: ${response.status}`;
        try {
            const body = await response.json() as { error?: string };
            if (body.error) {
                message = `layout request failed: ${body.error}`;
            }
        } catch {
            // response body unreadable — use the status-based message
        }
        throw new Error(message);
    }
    const data = await response.json() as { svg: string };
    return data.svg;
}

async function nativeLayout(doc: unknown): Promise<PositionMap> {
    const response = await fetch(`${API_BASE}/api/native-layout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc)
    });
    if (!response.ok) {
        let message = `native layout request failed: ${response.status}`;
        try {
            const body = await response.json() as { error?: string };
            if (body.error) {
                message = `native layout request failed: ${body.error}`;
            }
        } catch {
            // response body unreadable — use the status-based message
        }
        throw new Error(message);
    }
    const data = await response.json() as { layout: PositionMap };
    return data.layout;
}

// ---------------------------------------------------------------------------
// Harness entry — vitest is the TS/alias-resolving runtime here, not an
// assertion suite.  The test body IS the harness work.
//
// Self-skip guard: the test is skipped (not failed) unless both
// LAYOUT_HARNESS_JOB and LAYOUT_HARNESS_OUT are set, so it is inert in
// the normal `npm run test:unit` run.  Flask sets those env vars before
// shelling `npx vitest run <path>`, which is the only active execution path.
// ---------------------------------------------------------------------------

const HARNESS_ACTIVE =
    Boolean(process.env.LAYOUT_HARNESS_JOB) && Boolean(process.env.LAYOUT_HARNESS_OUT);

describe("layout-harness", () => {
    it.skipIf(!HARNESS_ACTIVE)(
        "runs the engine pipeline and writes {engine, ms, document} to LAYOUT_HARNESS_OUT",
        async () => {
            const outPath = process.env.LAYOUT_HARNESS_OUT;
            if (!outPath) {
                throw new Error("LAYOUT_HARNESS_OUT env var is required");
            }

            const jobJson = process.env.LAYOUT_HARNESS_JOB;
            if (!jobJson) {
                writeFileSync(outPath, JSON.stringify({ error: "LAYOUT_HARNESS_JOB env var is required" }));
                throw new Error("LAYOUT_HARNESS_JOB env var is required");
            }

            let job: { diagram: unknown, engine: string };
            try {
                job = JSON.parse(jobJson) as { diagram: unknown, engine: string };
            } catch (e) {
                const msg = `failed to parse LAYOUT_HARNESS_JOB: ${String(e)}`;
                writeFileSync(outPath, JSON.stringify({ error: msg }));
                throw new Error(msg);
            }

            const { diagram, engine = "tala" } = job;

            try {
            // Parse the diagram if it was serialized as a string
                const rawDoc: unknown = typeof diagram === "string"
                    ? JSON.parse(diagram)
                    : structuredClone(diagram as object);

                // Run the same pipeline as loadExistingFile — but directly via
                // the pure leaf primitives, importing nothing from
                // Application/Commands or Pinia or Vue.
                //
                // filePreprocessor is optional in AppConfiguration; when absent,
                // treat the raw doc as already in the expected shape.
                const processed: DiagramViewExport = Configuration.filePreprocessor
                    ? Configuration.filePreprocessor.create().process(rawDoc as DiagramViewExport)
                    : rawDoc as DiagramViewExport;

                const theme = await ThemeLoader.load(Configuration.themes[0]); // LightTheme — the app default
                const factory = new DiagramObjectViewFactory(Configuration.schema, theme);
                const viewFile = new DiagramViewFile(factory, processed);

                const t0 = performance.now();
                await viewFile.runLayout(resolveLayoutEngine(engine, { layoutDiagram, nativeLayout }));
                const ms = performance.now() - t0;

                const document = viewFile.toExport();

                writeFileSync(outPath, JSON.stringify({ engine, ms, document }));
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                writeFileSync(outPath, JSON.stringify({ error: msg }));
                throw err; // rethrow so vitest exits non-zero → Flask maps to 502
            }
        });
});
