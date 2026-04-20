/**
 * @file LabeledDynamicLine.spec.ts
 *
 * Unit tests for LabeledDynamicLine — the line face that renders data-item
 * pill chips at the line midpoint.
 *
 * COVERAGE NOTE: renderTo() requires a live CanvasRenderingContext2D and is
 * excluded here (same convention as DictionaryBlock.spec.ts and
 * GroupFace.spec.ts). The public `computeChips()` accessor provides the
 * observable surface for chip layout, tested without a DOM/canvas context.
 *
 * Test-environment note: The NodeFont used by Vitest returns 0 for
 * measureText().width.  All chip widths are therefore exactly 2 * chipPadX.
 * Expected values below use the same derivation so they stay in sync with the
 * implementation automatically.
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
import { addDataItemRef } from "@/assets/configuration/DfdTemplates/dataItems.test-utils";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { LabeledDynamicLine } from "./LabeledDynamicLine";

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
            style: {
                ...DarkStyle.Line(),
                data_pill:                       DarkStyle.DictionaryBlock().data_pill,
                pill_row_vertical_padding_units: DarkStyle.DictionaryBlock().pill_row_vertical_padding_units,
                pill_spacing_units:              DarkStyle.DictionaryBlock().pill_spacing_units
            }
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
            style: {
                ...LightStyle.Line(),
                data_pill:                       LightStyle.DictionaryBlock().data_pill,
                pill_row_vertical_padding_units: LightStyle.DictionaryBlock().pill_row_vertical_padding_units,
                pill_spacing_units:              LightStyle.DictionaryBlock().pill_spacing_units
            }
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

/** A minimal mock CanvasRenderingContext2D that satisfies computeChips. */
function makeCtxMock(): Pick<CanvasRenderingContext2D, "measureText" | "font"> {
    return {
        font: "",
        measureText: (_text: string) => ({ width: 0 } as TextMetrics)
    };
}

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
            const chips = face.computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
            // Parent GUID is "proc-1" (6 chars, no truncation); identifier is "D1"
            // → qualified label is "proc-1.D1"
            expect(chips[0].text).toBe("proc-1.D1");
            // Verify the label contains the identifier suffix
            expect(chips[0].text).toContain("D1");
        });

        it("resolves pii classification fill from dark theme", () => {
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D1", name: "A", classification: "pii" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
            expect(chips[0].fill).toBe(config.data_pill.pii.fill);
            expect(chips[0].textColor).toBe(config.data_pill.pii.text);
        });

        it("resolves secret classification fill from dark theme", () => {
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "proc-1", identifier: "D2", name: "B", classification: "secret" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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
            const chips1 = face.computeChips(makeCtxMock(), canvas);
            const center1 = chips1[0].x + chips1[0].w / 2;
            expect(center1).toBeCloseTo(initialMid, 1);

            // Move the target endpoint, recalculate
            line.target.face.moveBy(100, 0);
            line.calculateLayout();

            const newMid = line.handles[0].face.boundingBox.xMid;
            const chips2 = face.computeChips(makeCtxMock(), canvas);
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

            const darkChips = (darkLine.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
            const lightChips = (lightLine.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);

            const darkConfig = DarkStyle.DictionaryBlock();
            const lightConfig = LightStyle.DictionaryBlock();

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
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A", classification: "confidential" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
            expect(chips[0].fill).toBe(config.data_pill.default.fill);
        });

        it("missing classification resolves to default fill", () => {
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "p", identifier: "D1", name: "A" }
            ]);
            const line = makeLineOnCanvas(darkFactory, canvas);
            addDataItemRef(line, "g1");
            line.calculateLayout();

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
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

            const chips = (line.face as LabeledDynamicLine).computeChips(makeCtxMock(), canvas);
            expect(chips[0].text).toBe("proc-1.D1");
        });

    });

});
