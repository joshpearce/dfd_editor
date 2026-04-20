// pattern: Mixed (unavoidable)
// Reason: renderTo() is a rendering callback that receives a CanvasRenderingContext2D
// (side-effectful I/O surface); the pure chip-layout logic is isolated in computeChips()
// which is fully testable without a real canvas context.

import { DynamicLine } from "./DynamicLine";
import { drawRect } from "@OpenChart/Utilities";
import { findCanvas } from "../faceCanvasLookup";
import {
    pillLabel,
    resolveRefs,
    readDataItemRefs,
    narrowClassification,
    CHIP_PAD_X_OF_HEIGHT,
    CHIP_FONT_SIZE_OF_HEIGHT,
    CHIP_BASELINE_OF_HEIGHT
} from "@OpenChart/DiagramModel/DataItemLookup";
import type { DataItem } from "@OpenChart/DiagramModel/DataItemLookup";
import type { Canvas } from "@OpenChart/DiagramModel";
import type { LabeledLineStyle } from "../Styles";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";

// ---------------------------------------------------------------------------
// Chip layout constants
// ---------------------------------------------------------------------------

/** Chip height as a multiple of the vertical grid unit. */
const CHIP_HEIGHT_GRID_UNITS = 2.8;

/** Stroke width for the background plate border (px). */
const PLATE_STROKE_WIDTH = 1;

/**
 * A single pill chip descriptor, computed per render from the resolved
 * data items.  All coordinates are in canvas-space (absolute).
 */
type PillChipDescriptor = {
    /** Absolute x of chip left edge. */
    x: number;
    /** Absolute y of chip top edge. */
    y: number;
    /** Chip width (px). */
    w: number;
    /** Chip height (px). */
    h: number;
    /** Background fill colour. */
    fill: string;
    /** Text colour. */
    textColor: string;
    /** Chip label — qualified "Parent.Identifier". */
    text: string;
    /** Absolute x of text baseline start. */
    textX: number;
    /** Absolute y of text baseline. */
    textY: number;
};

/**
 * A {@link DynamicLine} variant that draws an axis-aligned data-item pill strip
 * centered on the line's midpoint.
 *
 * When the flow's `data_item_refs` property is empty (or unset), this face
 * renders identically to the base {@link DynamicLine} — no overhead, no strip.
 *
 * Chips show qualified labels (`Parent.Identifier`) because the flow viewer is
 * by definition a non-owner of the data items.
 */
export class LabeledDynamicLine extends DynamicLine {

    /**
     * The labeled line's extended style (includes pill tokens).
     */
    private readonly labeledStyle: LabeledLineStyle;

    /**
     * The base grid, used to scale pill spacing/padding.
     */
    private readonly labeledGrid: [number, number];


    /**
     * Creates a new {@link LabeledDynamicLine}.
     * @param style
     *  The line's style (must include pill tokens).
     * @param grid
     *  The line's grid.
     */
    constructor(style: LabeledLineStyle, grid: [number, number]) {
        super(style, grid);
        this.labeledStyle = style;
        this.labeledGrid = grid;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  1. Rendering  //////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Renders the face to a context.
     *
     * Delegates to the base {@link DynamicLine.renderTo} first, then overlays
     * the pill strip when there are resolved data items.
     *
     * @param ctx      The context to render to.
     * @param region   The context's viewport.
     * @param settings The current render settings.
     */
    public renderTo(
        ctx: CanvasRenderingContext2D,
        region: ViewportRegion,
        settings: RenderSettings
    ): void {
        // Always render the base line first.
        super.renderTo(ctx, region, settings);

        // Resolve data items — bail early if nothing to draw.
        const canvas = findCanvas(this.view);
        const chips = this.computeChips(ctx, canvas);
        if (chips.length === 0) {
            return;
        }

        // ── Background plate ──────────────────────────────────────────────
        const chipH = chips[0].h;
        const chipRadius = chipH / 2;
        const vPad = this.labeledGrid[1] * this.labeledStyle.pillRowVerticalPaddingUnits;
        const hPad = this.labeledGrid[0] * this.labeledStyle.pillSpacingUnits;

        // Determine strip bounding rect from all chips
        let plateXMin = Infinity;
        let plateXMax = -Infinity;
        const plateYMin = chips[0].y - vPad;
        const plateYMax = chips[0].y + chipH + vPad;

        for (const chip of chips) {
            plateXMin = Math.min(plateXMin, chip.x - hPad);
            plateXMax = Math.max(plateXMax, chip.x + chip.w + hPad);
        }

        const plateW = plateXMax - plateXMin;
        const plateH = plateYMax - plateYMin;
        const plateRadius = Math.min(chipRadius + 2, plateH / 2);

        // Draw plate: theme-sourced colours ensure readability on both light and
        // dark canvases (avoids hardcoded near-white that breaks dark mode).
        const plate = this.labeledStyle.plate;
        ctx.lineWidth = PLATE_STROKE_WIDTH;
        drawRect(ctx, plateXMin, plateYMin, plateW, plateH, plateRadius, PLATE_STROKE_WIDTH);
        ctx.fillStyle = plate.fill;
        ctx.strokeStyle = plate.stroke;
        ctx.fill();
        ctx.stroke();

        // ── Pill chips ────────────────────────────────────────────────────
        for (const chip of chips) {
            // Background
            drawRect(ctx, chip.x, chip.y, chip.w, chip.h, chipRadius, PLATE_STROKE_WIDTH);
            ctx.fillStyle = chip.fill;
            ctx.strokeStyle = chip.fill;
            ctx.fill();
            // Label
            ctx.fillStyle = chip.textColor;
            ctx.fillText(chip.text, chip.textX, chip.textY);
        }
    }


    ///////////////////////////////////////////////////////////////////////////
    //  2. Cloning  ////////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns a clone of the face.
     * Style is treated as immutable; shared reference matches DynamicLine.clone() precedent.
     */
    public override clone(): LabeledDynamicLine {
        return new LabeledDynamicLine(this.labeledStyle, this.labeledGrid);
    }


    ///////////////////////////////////////////////////////////////////////////
    //  3. Test seam  //////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Computes the pill chip descriptors for the current frame with an explicit
     * context.  Useful in tests that need non-zero `measureText` widths or
     * that want to inspect chip geometry without going through `renderTo`.
     *
     * In tests, pass a recording stub CanvasRenderingContext2D (or the minimal
     * `{ font: "", measureText: (s) => ({ width: s.length * 7 }) }` mock).
     * Production code calls `computeChips` directly through `renderTo`.
     *
     * @internal This method exists as a test seam.  It is not part of the
     * public face API and may be removed or renamed without notice.
     *
     * @param ctx     The rendering context (used for `measureText`).
     * @param canvas  The nearest Canvas ancestor (null → returns []).
     */
    public computeChipsWithCtx(
        ctx: Pick<CanvasRenderingContext2D, "measureText" | "font">,
        canvas: Canvas | null
    ): ReadonlyArray<PillChipDescriptor> {
        return this.computeChips(ctx, canvas);
    }


    ///////////////////////////////////////////////////////////////////////////
    //  4. Internal helpers  ///////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Computes the pill chip descriptors for the current frame.
     *
     * Returns an empty array when:
     * - The view has no `data_item_refs` property.
     * - The property is empty.
     * - No refs resolve to canvas data items.
     * - The canvas is not reachable from this view.
     *
     * @param ctx     The rendering context (used for `measureText`).
     * @param canvas  The nearest Canvas ancestor (null → returns []).
     */
    private computeChips(
        ctx: Pick<CanvasRenderingContext2D, "measureText" | "font">,
        canvas: Canvas | null
    ): PillChipDescriptor[] {
        if (canvas === null) {
            return [];
        }

        // Read ref GUIDs from the line's data_item_refs property
        // via the shared readDataItemRefs helper (avoids duplicating the
        // ListProperty-iteration pattern across callers).
        const guids = readDataItemRefs(this.view.properties);
        if (guids.length === 0) {
            return [];
        }

        // Resolve GUIDs → DataItems (unknown GUIDs silently skipped).
        const items = resolveRefs(canvas, guids);
        if (items.length === 0) {
            return [];
        }

        // ── Compute midpoint ──────────────────────────────────────────────
        // The handle (index 0) is positioned at the logical midpoint of the
        // line; use its bounding-box centre as the strip anchor.
        const handle = this.view.handles[0];
        const midX = handle.face.boundingBox.xMid;
        const midY = handle.face.boundingBox.yMid;

        // ── Chip geometry ─────────────────────────────────────────────────
        const style = this.labeledStyle;
        const gridX = this.labeledGrid[0];
        const gridY = this.labeledGrid[1];

        /** Chip height (px) — CHIP_HEIGHT_GRID_UNITS vertical grid units. */
        const chipH = gridY * CHIP_HEIGHT_GRID_UNITS;
        /** Horizontal padding inside each chip (px). */
        const chipPadX = chipH * CHIP_PAD_X_OF_HEIGHT;
        /** Gap between adjacent chips (px). */
        const hSpacing = gridX * style.pillSpacingUnits;

        // Set font for measuring chip label widths.
        // Font size is derived from chip height; weight + family sourced from theme tokens.
        // Produces valid CSS font shorthand: "<weight> <size>px <family>".
        const fontSize = Math.round(chipH * CHIP_FONT_SIZE_OF_HEIGHT);
        ctx.font = `${style.chipFontWeight} ${fontSize}px ${style.chipFontFamily}`;

        // Pre-compute labels and widths.
        // Passing null as viewedFromGuid means "no owner view — always qualify".
        const labels: string[] = items.map(item =>
            pillLabel(item, null, canvas)
        );
        const chipWidths: number[] = labels.map(label =>
            ctx.measureText(label).width + 2 * chipPadX
        );
        const totalWidth = chipWidths.reduce((sum, w) => sum + w, 0)
            + hSpacing * Math.max(0, items.length - 1);

        // Lay out chips left-to-right, strip centred on midX.
        let chipX = midX - totalWidth / 2;
        const chipTopY = midY - chipH / 2;
        /** Baseline offset: CHIP_BASELINE_OF_HEIGHT of chip height from top edge. */
        const textBaselineOffsetY = chipH * CHIP_BASELINE_OF_HEIGHT;

        const chips: PillChipDescriptor[] = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const chipW = chipWidths[i];
            chips.push({
                ...resolvePillChipStyle(item, style),
                x:     chipX,
                y:     chipTopY,
                w:     chipW,
                h:     chipH,
                text:  labels[i],
                textX: chipX + chipPadX,
                textY: chipTopY + textBaselineOffsetY
            });
            chipX += chipW + hSpacing;
        }

        return chips;
    }

}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the `{ fill, textColor }` pair for a data item from the given style.
 * Delegates narrowing to {@link narrowClassification} (shared with DictionaryBlock).
 */
function resolvePillChipStyle(
    item: DataItem,
    style: LabeledLineStyle
): { fill: string, textColor: string } {
    const pill = style.dataPill[narrowClassification(item.classification)];
    return { fill: pill.fill, textColor: pill.text };
}
