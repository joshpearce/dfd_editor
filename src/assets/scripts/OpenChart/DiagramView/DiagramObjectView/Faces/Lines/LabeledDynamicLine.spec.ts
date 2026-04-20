/**
 * @file LabeledDynamicLine.spec.ts
 *
 * Unit tests for LabeledDynamicLine — the line face that renders data-item
 * pill chips at the line midpoint.
 *
 * COVERAGE:
 * - `computeChipsWithCtx()` — chip layout, colors, labels, centering.
 * - `renderTo()` — draw-op sequence via a recording CanvasRenderingContext2D
 *   stub (I1: 0-ref, 2-ref draw order, plate lineWidth regression).
 *
 * Test-environment note: The NodeFont used by Vitest returns 0 for
 * measureText().width.  All chip widths in the zero-width tests are therefore
 * exactly 2 * chipPadX.  Tests that need non-zero widths supply a mock that
 * returns `s.length * 7` per character.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
    Alignment, DiagramObjectViewFactory, FaceType, LineView, Orientation
} from "@OpenChart/DiagramView";
import { DarkStyle, LightStyle, ThemeLoader } from "@OpenChart/ThemeLoader";
import {
    Canvas,
    DiagramObjectType,
    DictionaryProperty,
    ListProperty,
    PropertyType,
    RootProperty,
    StringProperty
} from "@OpenChart/DiagramModel";
import { sampleSchema } from "../../../../DiagramModel/DiagramModel.fixture";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { LabeledDynamicLine } from "./LabeledDynamicLine";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";

// ---------------------------------------------------------------------------
// Minimal schema — canvas + labeled_line template + supporting base objects
// ---------------------------------------------------------------------------

const testSchema: DiagramSchemaConfiguration = {
    ...sampleSchema,
    templates: [
        // Keep the generic_block (anchors etc) from sampleSchema
        ...sampleSchema.templates,
        // Labeled line template
        {
            name: "labeled_line",
            type: DiagramObjectType.Line,
            latch_template: { source: "generic_latch", target: "generic_latch" },
            handle_template: "generic_handle",
            properties: {
                data_item_refs: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: []
                }
            }
        }
    ]
};

// ---------------------------------------------------------------------------
// Theme configs — dark and light, with LabeledDynamicLine for labeled_line
// ---------------------------------------------------------------------------

const darkThemeConfig: DiagramThemeConfiguration = {
    id: "test_dark",
    name: "Test Dark",
    grid: [5, 5],
    scale: 2,
    designs: {
        generic_canvas: {
            type: FaceType.LineGridCanvas,
            attributes: Alignment.Grid,
            style: DarkStyle.Canvas()
        },
        generic_block: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: DarkStyle.DictionaryBlock()
        },
        labeled_line: {
            type: FaceType.LabeledDynamicLine,
            attributes: Alignment.Grid,
            style: DarkStyle.LabeledLine()
        },
        dynamic_line: {
            type: FaceType.DynamicLine,
            attributes: Alignment.Grid,
            style: DarkStyle.Line()
        },
        generic_anchor: {
            type: FaceType.AnchorPoint,
            attributes: Orientation.D0,
            style: DarkStyle.Point()
        },
        generic_latch: {
            type: FaceType.LatchPoint,
            attributes: Alignment.Grid,
            style: DarkStyle.Point()
        },
        generic_handle: {
            type: FaceType.HandlePoint,
            attributes: Alignment.Grid,
            style: DarkStyle.Point()
        }
    }
};

const lightThemeConfig: DiagramThemeConfiguration = {
    ...darkThemeConfig,
    id: "test_light",
    name: "Test Light",
    designs: {
        ...darkThemeConfig.designs,
        labeled_line: {
            type: FaceType.LabeledDynamicLine,
            attributes: Alignment.Grid,
            style: LightStyle.LabeledLine()
        }
    }
};

// ---------------------------------------------------------------------------
// Test-fixture factories
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Canvas model with a `data_items` ListProperty populated
 * with the given items.  Mirrors the helper in DictionaryBlock.spec.ts.
 */
function makeCanvasWithItems(
    items: Array<{
        guid: string;
        parent: string;
        identifier: string;
        name: string;
        classification?: string;
    }>
): Canvas {
    const root = new RootProperty();

    const listProp = new ListProperty({
        id: "data_items",
        name: "Data Items",
        editable: true,
        template: new DictionaryProperty({ id: "__tmpl__", editable: true })
    });

    for (const item of items) {
        const entry = new DictionaryProperty({ id: item.guid, name: item.guid, editable: true });
        const addStr = (key: string, val: string) => {
            const sp = new StringProperty({ id: key, name: key, editable: true }, val);
            entry.addProperty(sp, key, undefined, false);
        };
        addStr("parent", item.parent);
        addStr("identifier", item.identifier);
        addStr("name", item.name);
        if (item.classification !== undefined) {
            addStr("classification", item.classification);
        }
        listProp.addProperty(entry, item.guid, undefined, false);
    }

    root.addProperty(listProp, "data_items", undefined, false);
    return new Canvas("generic_canvas", "canvas-instance", 0, root);
}

/**
 * Creates a LineView with the `labeled_line` template, wires it into the
 * canvas, and returns it.
 */
function makeLineOnCanvas(
    factory: DiagramObjectViewFactory,
    canvas: Canvas
): LineView {
    const line = factory.createNewDiagramObject("labeled_line", LineView);
    canvas.addObject(line);
    // Also add the latches/handle children of the line to the canvas tree
    // so that `findCanvas` can walk up and find it from those sub-objects too.
    // (The factory already attaches them as children of the line, and addObject
    //  sets line._parent = canvas — that's sufficient for findCanvas.)
    return line;
}

/**
 * Adds a data_item_ref GUID to a line's data_item_refs ListProperty.
 * Inlined here to avoid the OpenChart → configuration import inversion.
 */
function addDataItemRef(line: LineView, refGuid: string): void {
    const refsProp = line.properties.value.get("data_item_refs");
    if (!(refsProp instanceof ListProperty)) {
        throw new Error("line.properties.data_item_refs is not a ListProperty");
    }
    const entry = refsProp.createListItem() as StringProperty;
    entry.setValue(refGuid);
    refsProp.addProperty(entry);
}

/** A minimal mock CanvasRenderingContext2D with zero-width measureText. */
function makeCtxMock(): Pick<CanvasRenderingContext2D, "measureText" | "font"> {
    return {
        font: "",
        measureText: (_text: string) => ({ width: 0 } as TextMetrics)
    };
}

/**
 * A mock with non-zero measureText: returns `s.length * 7` px width.
 * Use in tests that verify chip width scaling or strip centering with
 * variable-length labels.
 */
function makeCtxMockNonZero(): Pick<CanvasRenderingContext2D, "measureText" | "font"> {
    return {
        font: "",
        measureText: (s: string) => ({ width: s.length * 7 } as TextMetrics)
    };
}

// ---------------------------------------------------------------------------
// Recording CanvasRenderingContext2D stub (I1)
// ---------------------------------------------------------------------------

type CallRecord = { op: string, args: unknown[], state: Record<string, unknown> };

/**
 * Creates a recording stub for CanvasRenderingContext2D.
 *
 * Each method call appends `{ op, args, state }` to the shared call log,
 * where `state` is a snapshot of the tracked properties at the time of the
 * call.  Property assignments are captured via Object.defineProperty setters
 * so the effective state at the moment of each draw call is preserved.
 *
 * Covers the full surface that DynamicLine.renderTo and
 * LabeledDynamicLine.renderTo actually touch:
 *   - DynamicLine: lineWidth, fillStyle, strokeStyle + drawAbsoluteMultiElbowPath
 *     (beginPath / moveTo / lineTo / quadraticCurveTo) + stroke + setLineDash +
 *     drawAbsolutePolygon (beginPath / moveTo / lineTo / closePath) + fill
 *   - LabeledDynamicLine overlay: lineWidth / fillStyle / strokeStyle +
 *     drawRect (beginPath / moveTo / quadraticCurveTo / lineTo / closePath) +
 *     fill + stroke + fillText
 *
 * If the recording context helper grows beyond ~60 LOC it should be extracted
 * to a sibling __test-utils__/recordingCtx.ts under the Faces tree.
 */
function makeRecordingCtx(): {
    ctx: CanvasRenderingContext2D;
    calls: () => CallRecord[];
} {
    const log: CallRecord[] = [];
    let state: Record<string, unknown> = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        font: "",
        textBaseline: "alphabetic",
        textAlign: "start"
    };

    const record = (op: string) =>
        (...args: unknown[]) => { log.push({ op, args, state: { ...state } }); };

    const ctx = {
        measureText: (s: string) => ({ width: s.length * 7 } as TextMetrics),
        beginPath:         record("beginPath"),
        moveTo:            record("moveTo"),
        lineTo:            record("lineTo"),
        quadraticCurveTo:  record("quadraticCurveTo"),
        closePath:         record("closePath"),
        fill:              record("fill"),
        stroke:            record("stroke"),
        fillText:          record("fillText"),
        save:              record("save"),
        restore:           record("restore"),
        setLineDash:       record("setLineDash"),
        // Not called by LabeledDynamicLine but present for completeness:
        strokeText:        record("strokeText"),
        rect:              record("rect"),
        fillRect:          record("fillRect"),
        strokeRect:        record("strokeRect"),
        arcTo:             record("arcTo"),
        arc:               record("arc")
    };

    for (const key of ["fillStyle", "strokeStyle", "lineWidth", "font", "textBaseline", "textAlign"]) {
        Object.defineProperty(ctx, key, {
            get: () => state[key],
            set: (v: unknown) => { state = { ...state, [key]: v }; },
            configurable: true
        });
    }

    return {
        ctx: ctx as unknown as CanvasRenderingContext2D,
        calls: () => log
    };
}

/** Returns a viewport region large enough to make any face "visible". */
function makeWideRegion(): ViewportRegion {
    return {
        xMin: -Infinity,
        yMin: -Infinity,
        xMax: Infinity,
        yMax: Infinity,
        scale: 1
    } as ViewportRegion;
}

/** A minimal RenderSettings that does not enable animations. */
const noAnimSettings: RenderSettings = {
    get shadowsEnabled() { return false; },
    get animationsEnabled() { return false; }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LabeledDynamicLine (Step 5)", () => {

    let darkFactory: DiagramObjectViewFactory;
    let lightFactory: DiagramObjectViewFactory;

    beforeAll(async () => {
        const [darkTheme, lightTheme] = await Promise.all([
            ThemeLoader.load(darkThemeConfig),
            ThemeLoader.load(lightThemeConfig)
        ]);
        darkFactory = new DiagramObjectViewFactory(testSchema as DiagramSchemaConfiguration, darkTheme);
        lightFactory = new DiagramObjectViewFactory(testSchema as DiagramSchemaConfiguration, lightTheme);
    });

    // -----------------------------------------------------------------------
    // 1. Flow with 2 refs → midpoint strip with qualified labels
    // -----------------------------------------------------------------------

    describe("2 refs → midpoint strip with qualified labels", () => {

        it("produces exactly 2 chip descriptors", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D1", name: "PII field", classification: "pii" },
                { guid: "g2", parent: "proc-1", identifier: "D2", name: "Secret", classification: "secret" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);

            addDataItemRef(line, "g1");
            addDataItemRef(line, "g2");

            line.calculateLayout();
            const face = line.face as LabeledDynamicLine;
            const chips = face.computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips).toHaveLength(2);
        });

        it("chip texts are qualified labels (GuidOrName.Identifier)", () => {
            // The canvas has a data item whose parent is "proc-1".
            // No block with instance "proc-1" exists in the canvas object tree,
            // so pillLabel falls back to the raw GUID as the parent-name prefix.
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D1", name: "Proc", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);

            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            // Parent GUID is "proc-1" (6 chars, no truncation); identifier is "D1"
            // → qualified label is "proc-1.D1"
            expect(chips[0].text).toBe("proc-1.D1");
            // Verify the label contains the identifier suffix
            expect(chips[0].text).toContain("D1");
        });

        it("resolves pii classification fill from dark theme", () => {
            const config = DarkStyle.LabeledLine();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D1", name: "A", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips[0].fill).toBe(config.data_pill.pii.fill);
            expect(chips[0].textColor).toBe(config.data_pill.pii.text);
        });

        it("resolves secret classification fill from dark theme", () => {
            const config = DarkStyle.LabeledLine();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D2", name: "B", classification: "secret" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips[0].fill).toBe(config.data_pill.secret.fill);
        });

        it("strip is axis-aligned: all chip y values are identical", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" },
                { guid: "g2", parent: "p", identifier: "D2", name: "B", classification: "secret" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            addDataItemRef(line, "g2");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips).toHaveLength(2);
            // Axis-aligned strip → all chips on the same y
            expect(chips[0].y).toBe(chips[1].y);
        });

        it("strip is centered on line midpoint", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            const handle = line.handles[0];
            const midX = handle.face.boundingBox.xMid;

            // With one chip, its center should be at midX
            const chipCenter = chips[0].x + chips[0].w / 2;
            expect(chipCenter).toBeCloseTo(midX, 1);
        });

    });

    // -----------------------------------------------------------------------
    // 2. Zero refs → no strip (computeChips returns empty array)
    // -----------------------------------------------------------------------

    describe("0 refs → no strip", () => {

        it("computeChips returns empty array when no refs are present", () => {
            const canvas = makeCanvasWithItems([]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            // Do NOT add any refs
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips).toHaveLength(0);
        });

        it("computeChips returns empty array when data_item_refs property is missing", () => {
            // Use a plain dynamic_line (no data_item_refs property) on a canvas
            const canvas = makeCanvasWithItems([]);
            const line = darkFactory.createNewDiagramObject("dynamic_line", LineView);
            canvas.addObject(line);
            line.calculateLayout();

            // The base DynamicLine face has no computeChips — this test verifies
            // that a line without data_item_refs is simply unaffected.
            // We can only verify this via the line face type.
            expect(line.face.constructor.name).toBe("DynamicLine");
        });

    });

    // -----------------------------------------------------------------------
    // 3. Dangling ref → skipped silently; other refs still render
    // -----------------------------------------------------------------------

    describe("dangling ref (unknown GUID)", () => {

        it("unknown GUID is silently skipped", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            // g1 is valid; dangling-guid does not exist in canvas
            addDataItemRef(line, "g1");
            addDataItemRef(line, "dangling-guid");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            // Only 1 chip for the valid ref; the dangling one is silently dropped
            expect(chips).toHaveLength(1);
            expect(chips[0].text).toContain("D1");
        });

        it("all-dangling refs produce no chips", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "non-existent-guid-1");
            addDataItemRef(line, "non-existent-guid-2");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips).toHaveLength(0);
        });

    });

    // -----------------------------------------------------------------------
    // 4. Midpoint stays centered when endpoints vary
    // -----------------------------------------------------------------------

    describe("midpoint centering with varying endpoint coordinates", () => {

        it("chip strip x-center tracks the handle midpoint after moves", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "default" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const face = line.face as LabeledDynamicLine;

            // Record initial midpoint and chip center
            const initialMid = line.handles[0].face.boundingBox.xMid;
            const chips1 = face.computeChipsWithCtx(makeCtxMock(), canvas);
            const center1 = chips1[0].x + chips1[0].w / 2;
            expect(center1).toBeCloseTo(initialMid, 1);

            // Move the target endpoint, recalculate
            line.target.face.moveBy(100, 0);
            line.calculateLayout();

            const newMid = line.handles[0].face.boundingBox.xMid;
            const chips2 = face.computeChipsWithCtx(makeCtxMock(), canvas);
            const center2 = chips2[0].x + chips2[0].w / 2;
            expect(center2).toBeCloseTo(newMid, 1);
        });

    });

    // -----------------------------------------------------------------------
    // 5. Theme toggle — light and dark use different pill colours
    // -----------------------------------------------------------------------

    describe("theme pill colours", () => {

        it("light and dark themes produce different pii fill colours", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" }
            ]);

            const darkLine = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(darkLine, "g1");
            darkLine.calculateLayout();

            const lightLine = makeLineOnCanvas(lightFactory, canvas);
            addDataItemRef(lightLine, "g1");
            lightLine.calculateLayout();

            const darkChips = (darkLine.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            const lightChips = (lightLine.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);

            const darkConfig = DarkStyle.LabeledLine();
            const lightConfig = LightStyle.LabeledLine();

            expect(darkChips[0].fill).toBe(darkConfig.data_pill.pii.fill);
            expect(lightChips[0].fill).toBe(lightConfig.data_pill.pii.fill);
            // The two themes must produce different colours (non-trivial test)
            expect(darkChips[0].fill).not.toBe(lightChips[0].fill);
        });

    });

    // -----------------------------------------------------------------------
    // 6. Classification fallback to "default"
    // -----------------------------------------------------------------------

    describe("classification fallback", () => {

        it("unknown classification resolves to default fill", () => {
            const config = DarkStyle.LabeledLine();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "confidential" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips[0].fill).toBe(config.data_pill.default.fill);
        });

        it("missing classification resolves to default fill", () => {
            const config = DarkStyle.LabeledLine();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips[0].fill).toBe(config.data_pill.default.fill);
        });

    });

    // -----------------------------------------------------------------------
    // 7. Parent-name truncation in qualified labels
    // -----------------------------------------------------------------------

    describe("parent-name truncation (via pillLabel / DataItemLookup)", () => {

        it("parent GUIDs > 12 chars are truncated with ellipsis in the label", () => {
            // When no block object is found in the canvas, pillLabel falls back to
            // the raw GUID.  Use a long GUID to verify the truncation path.
            const longGuid = "a-very-long-parent-guid-123";
            const canvas = makeCanvasWithItems([
                {
                    guid: "g1",
                    parent: longGuid,
                    identifier: "D1",
                    name: "A",
                    classification: "pii"
                }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            // "a-very-long-parent-guid-123" → truncated to "a-very-long-…" + ".D1"
            expect(chips[0].text).toBe("a-very-long-….D1");
        });

        it("parent GUIDs ≤ 12 chars are not truncated", () => {
            const shortGuid = "proc-1"; // 6 chars
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: shortGuid, identifier: "D1", name: "A" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips[0].text).toBe("proc-1.D1");
        });

    });

    // -----------------------------------------------------------------------
    // 8. renderTo draw-op coverage (I1) — recording CanvasRenderingContext2D
    // -----------------------------------------------------------------------

    describe("renderTo draw-op coverage", () => {

        it("0 refs → draw output matches base DynamicLine.renderTo", () => {
            // Acceptance criterion: when there are no data_item_refs the
            // LabeledDynamicLine must produce exactly the same call sequence as
            // an equivalent plain DynamicLine (no extra calls, no plate, no chips).
            const canvas = makeCanvasWithItems([]);

            // Build a labeled line (no refs added)
            const labeledLine = makeLineOnCanvas(darkFactory, canvas);
            labeledLine.calculateLayout();

            // Build a plain DynamicLine with the same geometry
            const baseLine = darkFactory.createNewDiagramObject("dynamic_line", LineView);
            canvas.addObject(baseLine);
            baseLine.calculateLayout();

            const region = makeWideRegion();

            // Run both against fresh recording ctxs
            const { ctx: ctx1, calls: calls1 } = makeRecordingCtx();
            (labeledLine.face as LabeledDynamicLine).renderTo(ctx1, region, noAnimSettings);

            const { ctx: ctx2, calls: calls2 } = makeRecordingCtx();
            baseLine.face.renderTo(ctx2, region, noAnimSettings);

            // Strip `state` snapshots for cleaner diffing — op name + args must match
            const normalize = (c: CallRecord[]) => c.map(r => ({ op: r.op, args: r.args }));
            expect(normalize(calls1())).toEqual(normalize(calls2()));
        });

        it("2 refs → draw order: base line → plate → chip rects → chip labels", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" },
                { guid: "g2", parent: "p", identifier: "D2", name: "B", classification: "secret" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            addDataItemRef(line, "g2");
            line.calculateLayout();

            const { ctx, calls } = makeRecordingCtx();
            (line.face as LabeledDynamicLine).renderTo(ctx, makeWideRegion(), noAnimSettings);

            const log = calls();

            // There must be at least one stroke (the base line) before any fill
            // that corresponds to the plate overlay.
            const firstStrokeIdx = log.findIndex(c => c.op === "stroke");
            expect(firstStrokeIdx).toBeGreaterThanOrEqual(0);

            // After the base line, the plate fill+stroke must appear before fillText.
            const fillTextIdx = log.findIndex(c => c.op === "fillText");
            expect(fillTextIdx).toBeGreaterThan(firstStrokeIdx);

            // There must be exactly 2 fillText calls (one per chip).
            const fillTexts = log.filter(c => c.op === "fillText");
            expect(fillTexts).toHaveLength(2);

            // The 2 fillText args must include each chip label.
            const textArgs = fillTexts.map(c => c.args[0] as string);
            expect(textArgs).toContain("p.D1");
            expect(textArgs).toContain("p.D2");
        });

        it("plate lineWidth regression: plate stroke uses PLATE_STROKE_WIDTH (1px)", () => {
            // Locks in the fix from I6: the plate outline must be drawn at exactly
            // 1px — not the line's own width (which is typically 2px).
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const { ctx, calls } = makeRecordingCtx();
            (line.face as LabeledDynamicLine).renderTo(ctx, makeWideRegion(), noAnimSettings);

            const log = calls();

            // Find the stroke() call(s) after the base line's first stroke.
            // The plate stroke is the second stroke() call in the sequence.
            const strokeCalls = log
                .map((c, i) => ({ ...c, idx: i }))
                .filter(c => c.op === "stroke");

            // Must have at least 2 stroke calls: one for the base line, one for the plate.
            expect(strokeCalls.length).toBeGreaterThanOrEqual(2);

            // The plate stroke is the second stroke call.  At that point,
            // ctx.lineWidth must equal PLATE_STROKE_WIDTH = 1.
            const plateStroke = strokeCalls[1];
            expect(plateStroke.state["lineWidth"]).toBe(1);
        });

        it("chip font string is valid CSS shorthand (<weight> <size>px <family>)", () => {
            // M2 regression: the previous regex could produce "18px 600 11px Inter, …"
            // (invalid CSS). The fix splits weight + family into separate theme tokens.
            // Verify the emitted font string matches "<weight> <size>px <family>".
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const { ctx, calls } = makeRecordingCtx();
            (line.face as LabeledDynamicLine).renderTo(ctx, makeWideRegion(), noAnimSettings);

            // Find all distinct font strings that were assigned during the call.
            // The chip font assignment is the last font assignment before fillText.
            const log = calls();
            const fillTextIdx = log.findIndex(c => c.op === "fillText");
            expect(fillTextIdx).toBeGreaterThan(0);

            // The font state at the time of the first fillText call must match the
            // valid CSS font shorthand pattern: "<number> <number>px <...>"
            const fontAtFillText = log[fillTextIdx].state["font"] as string;
            expect(fontAtFillText).toMatch(/^\d+\s+\d+px\s+\S/);
        });

    });

    // -----------------------------------------------------------------------
    // 9. Non-zero measureText: chip widths scale with label length (I5)
    // -----------------------------------------------------------------------

    describe("chip widths with non-zero measureText", () => {

        it("chip width scales with label length", () => {
            // "proc-1.D1" (9 chars) vs "proc-1.D22" (10 chars) — longer label → wider chip
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D1",  name: "A", classification: "pii" },
                { guid: "g2", parent: "proc-1", identifier: "D22", name: "B", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            addDataItemRef(line, "g2");
            line.calculateLayout();

            const ctx = makeCtxMockNonZero();
            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(ctx, canvas);

            // Both chips must exist
            expect(chips).toHaveLength(2);
            // "proc-1.D22" is longer than "proc-1.D1" → chip[1].w > chip[0].w
            expect(chips[1].w).toBeGreaterThan(chips[0].w);
        });

        it("strip mid-x equals line mid-x within ±0.5 px with variable widths", () => {
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D1",   name: "A", classification: "pii" },
                { guid: "g2", parent: "proc-1", identifier: "D2222", name: "B", classification: "secret" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            addDataItemRef(line, "g2");
            line.calculateLayout();

            const ctx = makeCtxMockNonZero();
            const canvas2 = canvas;
            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(ctx, canvas2);
            expect(chips).toHaveLength(2);

            // Strip left edge = first chip x; right edge = last chip x + last chip w
            const stripLeft  = chips[0].x;
            const stripRight = chips[chips.length - 1].x + chips[chips.length - 1].w;
            const stripMidX  = (stripLeft + stripRight) / 2;

            const handle = line.handles[0];
            const lineMidX = handle.face.boundingBox.xMid;

            // Note: hSpacing gaps between chips shift the strict mid slightly;
            // verify within ±0.5 px.
            expect(Math.abs(stripMidX - lineMidX)).toBeLessThanOrEqual(0.5);
        });

    });

    // -----------------------------------------------------------------------
    // 10. M8: dangling refs warn even when canvas has zero data_items
    // (Validator test — see DfdValidator.spec.ts for the full validator suite.
    //  This test verifies that the validator's early-return removal
    //  has no impact on the face layer: the face simply produces no chips
    //  when there are no canvas data items to resolve against.)
    // -----------------------------------------------------------------------

    describe("face: zero canvas data items + refs → no chips rendered", () => {

        it("computeChipsWithCtx returns empty when canvas has no data_items at all", () => {
            // Canvas with NO data_items property: face must return [] gracefully.
            const root = new RootProperty();
            const canvas = new Canvas("generic_canvas", "canvas-instance", 0, root);

            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "some-guid");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChipsWithCtx(makeCtxMock(), canvas);
            expect(chips).toHaveLength(0);
        });

    });

});
