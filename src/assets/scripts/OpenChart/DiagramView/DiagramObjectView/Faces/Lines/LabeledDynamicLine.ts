import { DynamicLine } from "./DynamicLine";
import { ListProperty } from "@OpenChart/DiagramModel";
import { drawRect } from "@OpenChart/Utilities";
import { findCanvas } from "../faceCanvasLookup";
import { pillLabel, resolveRefs } from "@OpenChart/DiagramModel/DataItemLookup";
import type { DataItem } from "@OpenChart/DiagramModel/DataItemLookup";
import type { Canvas } from "@OpenChart/DiagramModel";
import type { LabeledLineStyle } from "../Styles";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";

/**
 * Sentinel `viewedFromGuid` value used when calling `pillLabel` from a flow
 * context.  A data flow never owns a data item — ownership lives on nodes —
 * so any non-matching string guarantees the qualified `"Parent.Identifier"`
 * branch is always taken.  The empty string is chosen because it can never
 * equal a valid UUID-format parent guid.
 */
const FLOW_VIEWER_GUID = "";

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

        // Draw plate (use a solid neutral background for readability over the
        // line, regardless of canvas color — consistent with block-style chips)
        const strokeW = 1;
        drawRect(ctx, plateXMin, plateYMin, plateW, plateH, plateRadius, strokeW);
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.strokeStyle = "rgba(0,0,0,0.08)";
        ctx.fill();
        ctx.stroke();

        // ── Pill chips ────────────────────────────────────────────────────
        for (const chip of chips) {
            // Background
            drawRect(ctx, chip.x, chip.y, chip.w, chip.h, chipRadius, strokeW);
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
     */
    public override clone(): LabeledDynamicLine {
        return new LabeledDynamicLine(this.labeledStyle, this.labeledGrid);
    }


    ///////////////////////////////////////////////////////////////////////////
    //  3. Internal helpers  ///////////////////////////////////////////////////
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
    public computeChips(
        ctx: Pick<CanvasRenderingContext2D, "measureText" | "font">,
        canvas: Canvas | null
    ): PillChipDescriptor[] {
        if (canvas === null) {
            return [];
        }

        // Read ref GUIDs from the line's data_item_refs property.
        const refsProp = this.view.properties.value.get("data_item_refs");
        if (!(refsProp instanceof ListProperty)) {
            return [];
        }
        const guids: string[] = [];
        for (const [, entry] of refsProp.value) {
            const val = entry.toJson();
            if (typeof val === "string" && val.length > 0) {
                guids.push(val);
            }
        }
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

        // Chip height: one text line (~14px at 2× scale with 5-unit grid).
        const chipH = gridY * 2.8;
        const chipPadX = chipH * 0.5;
        const hSpacing = gridX * style.pillSpacingUnits;

        // Set font for measuring chip label widths.
        const fontSize = Math.round(chipH * 0.65);
        ctx.font = `600 ${fontSize}px Inter, sans-serif`;

        // Pre-compute labels and widths.
        const labels: string[] = items.map(item =>
            pillLabel(item, FLOW_VIEWER_GUID, canvas)
        );
        const chipWidths: number[] = labels.map(label =>
            ctx.measureText(label).width + 2 * chipPadX
        );
        const totalWidth = chipWidths.reduce((sum, w) => sum + w, 0)
            + hSpacing * Math.max(0, items.length - 1);

        // Lay out chips left-to-right, strip centred on midX.
        let chipX = midX - totalWidth / 2;
        const chipTopY = midY - chipH / 2;
        const textBaselineOffsetY = chipH * 0.75;

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
 * Narrows `classification` to the known key union with a fallback to `"default"`.
 */
function resolvePillChipStyle(
    item: DataItem,
    style: LabeledLineStyle
): { fill: string, textColor: string } {
    const cls = item.classification;
    const pillKey = (
        cls === "pii" || cls === "secret" ||
        cls === "public" || cls === "internal"
    ) ? cls : "default";
    const pill = style.dataPill[pillKey];
    return { fill: pill.fill, textColor: pill.text };
}
