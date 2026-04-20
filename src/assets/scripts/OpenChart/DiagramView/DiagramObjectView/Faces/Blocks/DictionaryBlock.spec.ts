/**
 * @file DictionaryBlock.spec.ts
 *
 * Unit tests for the DictionaryBlock face, specifically the pill-row section
 * introduced in Step 4 of the data-items-on-canvas plan.
 *
 * COVERAGE NOTE: renderTo is a canvas-rendering method that requires a live
 * CanvasRenderingContext2D. It is excluded here (same convention as
 * GroupFace.spec.ts). The layoutDebug accessor on the face provides the
 * observable surface for pill-row state, tested via calculateLayout().
 * Visual rendering is validated manually.
 *
 * Test-environment note: The NodeFont used in Vitest returns 0 for
 * measureWidth(), so every chip's text width is 0.  Chip width is therefore
 * always exactly `2 * chipPadX` (which equals one body-line height derived
 * from the blockGrid).  All expected-height calculations below use the same
 * formula so they stay in sync with the implementation automatically.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
    Alignment, BlockView, DiagramObjectViewFactory, FaceType,
    Orientation
} from "@OpenChart/DiagramView";
import { DarkStyle, LightStyle, ThemeLoader } from "@OpenChart/ThemeLoader";
import { sampleSchema } from "../../../../DiagramModel/DiagramModel.fixture";
import {
    Canvas,
    DictionaryProperty,
    ListProperty,
    RootProperty,
    StringProperty
} from "@OpenChart/DiagramModel";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { DictionaryBlock } from "./DictionaryBlock";

// ---------------------------------------------------------------------------
// Minimal schema — canvas canvas with data_items, one block template
// ---------------------------------------------------------------------------

// Use the plain sampleSchema — we inject canvas.data_items manually below
// (via makeCanvasWithItems) rather than through the schema.
const testSchema: DiagramSchemaConfiguration = sampleSchema;

// ---------------------------------------------------------------------------
// Theme configs — dark and light for colour-resolution tests
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
        generic_block: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: LightStyle.DictionaryBlock()
        }
    }
};

// ---------------------------------------------------------------------------
// Test-fixture factories
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Canvas model (not CanvasView) with a `data_items`
 * ListProperty pre-populated with the given items.
 *
 * The canvas is just a property-bag root — we use the real Canvas model
 * class so that DataItemLookup.dataItemsForParent() can read from it.
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

    // Build the list property manually (mirrors DfdCanvas.ts structure)
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

    // Canvas constructor: id, instance, attributes, properties
    return new Canvas("generic_canvas", "canvas-instance", 0, root);
}

/**
 * Creates a BlockView using the given factory with the specified instance id
 * so data-item parent references match, then attaches it to the canvas via
 * the public `canvas.addObject()` path (which sets the block's parent).
 *
 * Uses `createBaseDiagramObject` to set the instance id at construction time.
 * The block has no anchors (that's what `createNewDiagramObject` adds), but
 * the pill-row layout does not require anchors.
 */
function makeBlockOnCanvas(
    factory: DiagramObjectViewFactory,
    canvas: Canvas,
    blockInstance = "block-instance-1"
): BlockView {
    // createBaseDiagramObject accepts an instance id as its second argument,
    // giving us a properly constructed object without any `as any` casts.
    const block = factory.createBaseDiagramObject("generic_block", blockInstance, undefined, BlockView);

    // Wire block → canvas using the public Group.addObject() API, which
    // calls makeChild() internally to set block._parent = canvas.
    canvas.addObject(block);

    return block;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DictionaryBlock — pill row (Step 4)", () => {

    let darkFactory: DiagramObjectViewFactory;
    let lightFactory: DiagramObjectViewFactory;

    beforeAll(async () => {
        const [darkTheme, lightTheme] = await Promise.all([
            ThemeLoader.load(darkThemeConfig),
            ThemeLoader.load(lightThemeConfig)
        ]);
        darkFactory = new DiagramObjectViewFactory(testSchema, darkTheme);
        lightFactory = new DiagramObjectViewFactory(testSchema, lightTheme);
    });

    // -----------------------------------------------------------------------
    // 1. Zero items — layout unchanged; no pill draw ops
    // -----------------------------------------------------------------------

    describe("0 items", () => {

        it("pill chips array is empty and pill row height is 0", () => {
            const canvas = makeCanvasWithItems([]);
            const block = makeBlockOnCanvas(darkFactory, canvas);
            block.face.calculateLayout();

            const { pillChips, pillRowHeight } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips).toHaveLength(0);
            expect(pillRowHeight).toBe(0);
        });

        it("block height equals the pre-pill baseline with no data items", () => {
            const emptyCanvas = makeCanvasWithItems([]);
            const blockA = makeBlockOnCanvas(darkFactory, emptyCanvas, "block-a");
            blockA.face.calculateLayout();
            const baseHeight = blockA.face.height;

            // A block with items on a DIFFERENT parent — height must not change
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: "other-block", identifier: "D1", name: "Item 1" }
            ]);
            const blockB = makeBlockOnCanvas(darkFactory, canvas, "block-b");
            blockB.face.calculateLayout();

            expect(blockB.face.height).toBe(baseHeight);
            expect((blockB.face as DictionaryBlock).layoutDebug.pillChips).toHaveLength(0);
        });

    });

    // -----------------------------------------------------------------------
    // 2. Three items, mixed classifications — single row, correct fills
    // -----------------------------------------------------------------------

    describe("3 items, mixed classifications", () => {

        it("produces exactly 3 chips all on one row", () => {
            const blockInstance = "proc-1";
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "PII field", classification: "pii" },
                { guid: "g2", parent: blockInstance, identifier: "D2", name: "Secret", classification: "secret" },
                { guid: "g3", parent: blockInstance, identifier: "D3", name: "Default item", classification: undefined }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips).toHaveLength(3);
        });

        it("resolves pii, secret, and default fills from the dark theme", () => {
            const blockInstance = "proc-2";
            // DarkStyle.DictionaryBlock() returns the snake_case configuration;
            // data_pill is the raw config key (ThemeLoader converts it to
            // dataPill on the runtime style object).
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "PII", classification: "pii" },
                { guid: "g2", parent: blockInstance, identifier: "D2", name: "Secret", classification: "secret" },
                { guid: "g3", parent: blockInstance, identifier: "D3", name: "None", classification: undefined }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips[0].fill).toBe(config.data_pill.pii.fill);
            expect(pillChips[1].fill).toBe(config.data_pill.secret.fill);
            expect(pillChips[2].fill).toBe(config.data_pill.default.fill);
        });

        it("renders bare identifiers as chip text (owner view)", () => {
            const blockInstance = "proc-3";
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "PII", classification: "pii" },
                { guid: "g2", parent: blockInstance, identifier: "D2", name: "Secret", classification: "secret" },
                { guid: "g3", parent: blockInstance, identifier: "CARD-NUM", name: "None", classification: undefined }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips.map(c => c.text)).toEqual(["D1", "D2", "CARD-NUM"]);
        });

        it("all 3 chips share the same y (single sub-row)", () => {
            const blockInstance = "proc-4";
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "A", classification: "pii" },
                { guid: "g2", parent: blockInstance, identifier: "D2", name: "B", classification: "secret" },
                { guid: "g3", parent: blockInstance, identifier: "D3", name: "C", classification: undefined }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips.length).toBe(3);
            // All chips on the same row → same y
            const firstY = pillChips[0].y;
            for (const chip of pillChips) {
                expect(chip.y).toBe(firstY);
            }
        });

    });

    // -----------------------------------------------------------------------
    // 3. Wrapping — chips overflow block content width → ≥ 2 sub-rows
    //    In the test environment measureWidth() always returns 0, so chip
    //    widths equal 2 * chipPadX.  We control the number of chips and the
    //    block max-unit-width to force a wrap.
    // -----------------------------------------------------------------------

    describe("wrapping", () => {

        it("chips overflow → at least 2 distinct y values (sub-rows)", () => {
            const blockInstance = "proc-wrap";
            // Create many items — enough that they cannot all fit even with
            // zero-text-width chips when chipPadX > 0.
            const items = Array.from({ length: 20 }, (_, i) => ({
                guid: `g${i}`,
                parent: blockInstance,
                identifier: `D${i}`,
                name: `Item ${i}`,
                classification: undefined as string | undefined
            }));
            const canvas = makeCanvasWithItems(items);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips.length).toBe(20);

            const uniqueYValues = new Set(pillChips.map(c => c.y));

            // We expect wrapping when chip count is high enough.
            // If chipPadX > 0, the chips will wrap; if not, they'll all be on one row.
            // The test is authoritative when chipPadX > 0 (which it is per implementation).
            expect(uniqueYValues.size).toBeGreaterThanOrEqual(2);
        });

        it("block height grows by exactly (rows × chipH + (rows-1) × spacing + 2 × vPad)", () => {
            const blockInstance = "proc-wrap-height";
            // DarkStyle.DictionaryBlock() returns the snake_case configuration.
            // The theme uses grid=[5,5], scale=2 so blockGrid=[10,10].
            const config = DarkStyle.DictionaryBlock();
            const blockGridY = 10; // grid[1] * scale = 5 * 2
            // chipH = body.field_value_text.units * blockGridY
            const chipH = config.body.field_value_text.units * blockGridY;

            // First measure baseline height with no items
            const emptyCanvas = makeCanvasWithItems([]);
            const baseBlock = makeBlockOnCanvas(darkFactory, emptyCanvas, "base-block-h");
            baseBlock.face.calculateLayout();
            const baseHeight = baseBlock.face.height;

            // Now create a block with 20 items to force wrapping
            const items = Array.from({ length: 20 }, (_, i) => ({
                guid: `g${i}`,
                parent: blockInstance,
                identifier: `D${i}`,
                name: `Item ${i}`,
                classification: undefined as string | undefined
            }));
            const canvas = makeCanvasWithItems(items);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips, pillRowHeight } = (block.face as DictionaryBlock).layoutDebug;

            // Count actual sub-rows from the computed chip y positions
            const uniqueYValues = new Set(pillChips.map(c => c.y));
            const numRows = uniqueYValues.size;

            // Re-derive expected pill-row height from style tokens
            // (all blockGrid-based so it stays in sync with the face impl)
            const vPad = blockGridY * config.pill_row_vertical_padding_units;
            const spacing = blockGridY * config.pill_spacing_units;
            const expectedPillRowH = numRows * chipH + Math.max(0, numRows - 1) * spacing + 2 * vPad;

            expect(pillRowHeight).toBeCloseTo(expectedPillRowH, 3);
            expect(block.face.height).toBeCloseTo(baseHeight + expectedPillRowH, 3);
        });

    });

    // -----------------------------------------------------------------------
    // 4. Unknown classification falls back to "default"
    // -----------------------------------------------------------------------

    describe("classification fallback", () => {

        it("unknown classification string ('confidential') resolves to default fill", () => {
            const blockInstance = "proc-fallback";
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "Classified", classification: "confidential" }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips).toHaveLength(1);
            expect(pillChips[0].fill).toBe(config.data_pill.default.fill);
            expect(pillChips[0].textColor).toBe(config.data_pill.default.text);
        });

        it("null classification resolves to default fill", () => {
            const blockInstance = "proc-null-class";
            const config = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "NoClass", classification: undefined }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            const { pillChips } = (block.face as DictionaryBlock).layoutDebug;
            expect(pillChips).toHaveLength(1);
            expect(pillChips[0].fill).toBe(config.data_pill.default.fill);
        });

    });

    // -----------------------------------------------------------------------
    // 5. Theme toggle — light theme uses different colours
    // -----------------------------------------------------------------------

    describe("theme colours", () => {

        it("light theme resolves pii fill from LightStyle.DictionaryBlock()", () => {
            const blockInstance = "proc-light";
            const lightConfig = LightStyle.DictionaryBlock();
            const darkConfig = DarkStyle.DictionaryBlock();
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "PII", classification: "pii" }
            ]);

            const lightBlock = makeBlockOnCanvas(lightFactory, canvas, blockInstance);
            lightBlock.face.calculateLayout();

            const darkBlock = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            darkBlock.face.calculateLayout();

            const lightChips = (lightBlock.face as DictionaryBlock).layoutDebug.pillChips;
            const darkChips = (darkBlock.face as DictionaryBlock).layoutDebug.pillChips;

            expect(lightChips[0].fill).toBe(lightConfig.data_pill.pii.fill);
            expect(darkChips[0].fill).toBe(darkConfig.data_pill.pii.fill);
            // Light and dark fills must differ (non-trivial test)
            expect(lightChips[0].fill).not.toBe(darkChips[0].fill);
        });

    });

    // -----------------------------------------------------------------------
    // 6. Round-trip: 2 items, property-row x-offsets not regressed
    // -----------------------------------------------------------------------

    describe("round-trip: 2 items, no regression in property-row x-offset", () => {

        it("x-offset of block face is 0 (same as baseline)", () => {
            // xOffset is computed from the bounding-box snap; it should be 0
            // for a block that has not been moved from origin.
            const baseCanvas = makeCanvasWithItems([]);
            const baseBlock = makeBlockOnCanvas(darkFactory, baseCanvas, "base-rt");
            baseBlock.face.calculateLayout();
            const baseXOffset = baseBlock.face.xOffset;

            const blockInstance = "proc-rt";
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "PII", classification: "pii" },
                { guid: "g2", parent: blockInstance, identifier: "D2", name: "Secret", classification: "secret" }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            expect(block.face.xOffset).toBe(baseXOffset);
        });

        it("pill row adds height but does not change block width", () => {
            const baseCanvas = makeCanvasWithItems([]);
            const baseBlock = makeBlockOnCanvas(darkFactory, baseCanvas, "base-w");
            baseBlock.face.calculateLayout();
            const baseWidth = baseBlock.face.width;

            const blockInstance = "proc-w";
            const canvas = makeCanvasWithItems([
                { guid: "g1", parent: blockInstance, identifier: "D1", name: "PII", classification: "pii" },
                { guid: "g2", parent: blockInstance, identifier: "D2", name: "Secret", classification: "secret" }
            ]);
            const block = makeBlockOnCanvas(darkFactory, canvas, blockInstance);
            block.face.calculateLayout();

            // Pill row should not widen the block
            expect(block.face.width).toBe(baseWidth);
            // Block with items should be taller than the base
            expect(block.face.height).toBeGreaterThan(baseBlock.face.height);
        });

    });

});
