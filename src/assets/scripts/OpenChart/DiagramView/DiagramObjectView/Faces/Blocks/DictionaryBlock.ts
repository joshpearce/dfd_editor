import { BlockFace } from "../Bases";
import { Canvas, TupleProperty } from "@OpenChart/DiagramModel";
import { drawRect, drawChip, ceilNearestMultiple } from "@OpenChart/Utilities";
import {
    addTextCell,
    addStackedTextCells,
    calculateAnchorPositions,
    DrawTextInstructionSet
} from "./Layout";
import { dataItemsForParent } from "@OpenChart/DiagramModel/DataItemLookup";
import type { Enumeration } from "../Enumeration";
import type { ViewportRegion } from "../../ViewportRegion";
import type { RenderSettings } from "../../RenderSettings";
import type { DictionaryBlockStyle } from "../Styles";

/**
 * A single data-item pill chip, as computed in calculateLayout() and
 * consumed in renderTo().  Coordinates are relative to the block's top-left
 * corner (i.e. the same origin used for {@link DrawTextInstructionSet}).
 */
type PillChipDescriptor = {
    /** Left edge of the chip, relative to the block's top-left corner. */
    x: number;
    /** Top edge of the chip, relative to the block's top-left corner. */
    y: number;
    /** Chip width (px). */
    w: number;
    /** Chip height (px). */
    h: number;
    /** Chip background fill colour (from dataPill theme token). */
    fill: string;
    /** Chip text colour (from dataPill theme token). */
    textColor: string;
    /** Chip label — bare identifier (owner view). */
    text: string;
    /** Horizontal position for the text baseline inside the chip. */
    textX: number;
    /** Vertical position for the text baseline inside the chip. */
    textY: number;
};


export class DictionaryBlock extends BlockFace {

    /**
     * The block's style.
     */
    private readonly style: DictionaryBlockStyle;

    /**
     * The block's enumerated properties.
     */
    private readonly properties: Enumeration | undefined;

    /**
     * The block's text render instructions.
     */
    private readonly text: DrawTextInstructionSet;

    /**
     * The block's fill color.
     */
    private fillColor: string;

    /**
     * The block's stroke color.
     */
    private strokeColor: string;

    /**
     * The block header's height.
     */
    private headHeight: number;

    /**
     * Pill chip descriptors computed during the most recent calculateLayout()
     * call.  Empty when the block has no parented data items.
     */
    private _pillChips: PillChipDescriptor[];

    /**
     * Total height consumed by the pill-row section (including top and bottom
     * padding).  Zero when the block has no parented data items.
     */
    private _pillRowHeight: number;


    /**
     * Creates a new {@link DictionaryBlock}.
     * @param style
     *  The block's style.
     * @param grid
     *  The block's base grid.
     * @param scale
     *  The block's scale.
     * @param properties
     *  The block's enumerated properties.
     */
    constructor(
        style: DictionaryBlockStyle,
        grid: [number, number],
        scale: number,
        properties?: Enumeration
    ) {
        super(grid, scale);
        this.style = style;
        this.properties = properties;
        this.text = new DrawTextInstructionSet();
        this.fillColor = this.style.body.fillColor;
        this.strokeColor = this.style.body.strokeColor;
        this.headHeight = 0;
        this._pillChips = [];
        this._pillRowHeight = 0;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  1. Layout / Rendering  ////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Calculates the face's layout.
     * @returns
     *  True if the layout changed, false otherwise.
     */
    public calculateLayout(): boolean {
        const markerOffset = BlockFace.markerOffset;
        const baseGrid = this.grid;
        const blockGrid = this.blockGrid;
        const head = this.style.head;
        const body = this.style.body;
        const props = this.view.properties;

        // Recalculate content hash.  We include both the block's own property
        // hash and a lightweight hash of the canvas's data-item list so that
        // adding/removing a data item triggers re-layout even when the block's
        // own properties haven't changed.
        const canvas = DictionaryBlock.findCanvas(this.view);
        const dataItems = canvas ? dataItemsForParent(canvas, this.view.instance) : [];
        const itemsHashSource = dataItems.map(
            i => `${i.guid}:${i.identifier}:${i.classification ?? ""}`
        ).join("|");
        // Simple djb2-style fold — good enough for a changed-detection hash.
        let itemsHash = 0;
        for (let ci = 0; ci < itemsHashSource.length; ci++) {
            itemsHash = (itemsHash * 31 + itemsHashSource.charCodeAt(ci)) >>> 0;
        }
        const lastContentHash = this.contentHash;
        const nextContentHash = (props.toHashValue() * 31 + itemsHash) >>> 0;
        this.contentHash = nextContentHash;

        // If content hasn't changed, bail.
        if (lastContentHash === nextContentHash) {
            return false;
        }

        // Reset state
        this.width = 0;
        this.height = 0;
        this._pillChips = [];
        this._pillRowHeight = 0;
        this.text.eraseAllInstructions();

        // Calculate padding
        const yHeadPadding = blockGrid[1] * head.verticalPaddingUnits;
        const yBodyPadding = blockGrid[1] * body.bodyVerticalPaddingUnits;
        const yFieldPadding = blockGrid[1] * body.fieldVerticalPaddingUnits;
        const xPadding = blockGrid[0] * this.style.horizontalPaddingUnits;

        // Collect visible fields
        const fields: [string, string][] = [];
        const properties = this.properties?.include ?? props.value.keys();
        for (const id of properties) {
            if (this.properties?.exclude?.has(id) || !props.value.has(id)) {
                continue;
            }
            const property = props.value.get(id)!;
            if (!property.isDefined() || id === props.representativeKey) {
                continue;
            }
            if (property instanceof TupleProperty) {
                // Unwrap tuples
                for (const prop of property.value.values()) {
                    if (!prop.isDefined()) {
                        continue;
                    }
                    fields.push([
                        prop.name.toLocaleUpperCase(),
                        prop.toString()
                    ]);
                }
            } else {
                fields.push([
                    property.name.toLocaleUpperCase(),
                    property.toString()
                ]);
            }
        }

        // Determine title font
        const titleText = this.view.id.toLocaleUpperCase();
        const subtitleText = props.isDefined() ? props.toString() : "";
        let title;
        if (subtitleText) {
            title = head.twoTitle.title;
        } else {
            title = head.oneTitle.title;
        }

        // Get field fonts
        const fieldName = body.fieldNameText;
        const fieldValue = body.fieldValueText;

        // Calculate max content width
        let maxWidth = blockGrid[0] * this.style.maxUnitWidth;
        this.width = title.font.measureWidth(titleText);
        maxWidth = Math.max(this.width, maxWidth);
        for (const [key] of fields) {
            this.width = Math.max(this.width, fieldName.font.measureWidth(key));
            maxWidth = Math.max(this.width, maxWidth);
        }

        // Calculate title and subtitle layout
        const x = xPadding + markerOffset;
        let y = yHeadPadding + markerOffset;

        // Calculate title
        y = addTextCell(
            this.text,
            x, y,
            titleText,
            title.font,
            title.color,
            title.units * blockGrid[1],
            title.alignTop
        );

        // Calculate subtitle
        if (subtitleText) {
            const subtitle = head.twoTitle.subtitle;
            // Update content width
            const lines = subtitle.font.wordWrap(subtitleText, maxWidth);
            for (let i = 0, width; i < lines.length; i++) {
                width = subtitle.font.measureWidth(lines[i]);
                this.width = Math.max(this.width, width);
            }
            // Calculate subtitle
            y = addStackedTextCells(
                this.text,
                x, y,
                lines,
                subtitle.font,
                subtitle.color,
                subtitle.units * blockGrid[1]
            );
        }

        // Add head's bottom padding
        y += yHeadPadding;

        // Calculate body layout
        if (fields.length) {
            // Set head height
            this.headHeight = y;
            // Set body color
            this.fillColor = body.fillColor;
            this.strokeColor = body.strokeColor;
            // Calculate body layout
            y += yBodyPadding - yFieldPadding;
            for (const [key, value] of fields) {
                y += yFieldPadding;
                // Update content width
                const lines = fieldValue.font.wordWrap(value, maxWidth);
                for (let i = 0, width; i < lines.length; i++) {
                    width = fieldValue.font.measureWidth(lines[i]);
                    this.width = Math.max(this.width, width);
                }
                // Calculate field's section layout
                y = addTextCell(
                    this.text,
                    x, y,
                    key,
                    fieldName.font,
                    fieldName.color,
                    fieldName.units * blockGrid[1],
                    fieldName.alignTop
                );
                y = addStackedTextCells(
                    this.text,
                    x, y,
                    lines,
                    fieldValue.font,
                    fieldValue.color,
                    fieldValue.units * blockGrid[1]
                );
            }
            y += yBodyPadding;
        } else {
            // Set head height
            this.headHeight = 0;
            // Set body color
            this.fillColor = head.fillColor;
            this.strokeColor = head.strokeColor;
        }

        // ── Pill-row section ────────────────────────────────────────────────
        // Emit one wrapping chip-row at the bottom of the block body for any
        // data items whose parent is this block.  Skip the section entirely
        // (zero height delta, no draw ops) when there are no items.
        if (dataItems.length > 0) {
            // Chip height = one body-line (fieldValueText.units * blockGrid[1])
            const chipH  = body.fieldValueText.units * blockGrid[1];
            // Horizontal padding inside each chip, derived from chip height so
            // it scales with the theme's body-line size.  This local constant
            // is private to this section; it does not need a theme token.
            const chipPadX = chipH * 0.5;
            const vPad    = blockGrid[1] * this.style.pillRowVerticalPaddingUnits;
            const hSpacing = blockGrid[0] * this.style.pillSpacingUnits;

            // The content width available for chip layout.  We use the same
            // rounding as the block-width finalisation below so the wrapping
            // math stays consistent.  We also apply the maxUnitWidth floor so
            // that the content width is never 0 (which would happen in the
            // Vitest environment where NodeFont.measureWidth() always returns
            // 0).
            const contentWidth = Math.max(
                ceilNearestMultiple(this.width, blockGrid[0]),
                blockGrid[0] * this.style.maxUnitWidth
            );

            // Text baseline offset within a chip (vertically centred)
            const textBaselineOffsetY = chipH * 0.75;

            // Y position of the top of the first sub-row of chips
            let chipY = y + vPad;
            let chipX = x;

            for (const item of dataItems) {
                const textWidth = body.fieldValueText.font.measureWidth(item.identifier);
                const chipW = textWidth + 2 * chipPadX;

                // Wrap to a new sub-row when the next chip would overflow
                if (chipX > x && chipX + chipW > x + contentWidth) {
                    chipY += chipH + hSpacing;
                    chipX = x;
                }

                // Resolve classification → dataPill key (narrow-or-default)
                const cls = item.classification;
                const pillKey = (
                    cls === "pii" || cls === "secret" ||
                    cls === "public" || cls === "internal"
                ) ? cls : "default";
                const pill = this.style.dataPill[pillKey];

                this._pillChips.push({
                    x:         chipX,
                    y:         chipY,
                    w:         chipW,
                    h:         chipH,
                    fill:      pill.fill,
                    textColor: pill.text,
                    text:      item.identifier,
                    textX:     chipX + chipPadX,
                    textY:     chipY + textBaselineOffsetY
                });

                chipX += chipW + hSpacing;
            }

            // Compute total pill-row height from the sub-rows used
            const numSubRows = this._pillChips.length > 0
                ? (this._pillChips[this._pillChips.length - 1].y - this._pillChips[0].y) / (chipH + hSpacing) + 1
                : 0;
            this._pillRowHeight = numSubRows * chipH + Math.max(0, numSubRows - 1) * hSpacing + 2 * vPad;
            y += this._pillRowHeight;
        }
        // ── End pill-row section ─────────────────────────────────────────────

        // Round content width up to nearest multiple of the grid size
        this.width = ceilNearestMultiple(this.width, blockGrid[0]);

        // Calculate block width and height
        this.width += 2 * (markerOffset + xPadding);
        this.height = y + markerOffset;

        // Calculate block's bounding box
        const bb = this.boundingBox;
        const xMin = bb.x - (this.width / 2);
        const yMin = bb.y - (this.height / 2);
        bb.xMin = ceilNearestMultiple(xMin, blockGrid[0] / this.scale);
        bb.yMin = ceilNearestMultiple(yMin, blockGrid[1] / this.scale);
        bb.xMax = bb.xMin + this.width;
        bb.yMax = bb.yMin + this.height;
        const renderX = bb.xMin;
        const renderY = bb.yMin;

        // Update anchor positions
        const anchors = calculateAnchorPositions(bb, baseGrid, markerOffset);
        for (const position in anchors) {
            const coords = anchors[position];
            this.view.anchors.get(position)?.face.moveTo(...coords);
        }

        // Recalculate bonding box
        super.calculateLayout();

        // Calculate render offsets
        this.xOffset = renderX - bb.xMin;
        this.yOffset = renderY - bb.yMin;

        // Update parent's bounding box
        return true;

    }

    /**
     * Renders the face to a context.
     * @param ctx
     *  The context to render to.
     * @param region
     *  The context's viewport.
     * @param settings
     *  The current render settings.
     */
    public renderTo(
        ctx: CanvasRenderingContext2D,
        region: ViewportRegion, settings: RenderSettings
    ): void {
        if (!this.isVisible(region)) {
            return;
        }

        // Init
        const x = this.boundingBox.xMin + this.xOffset;
        const y = this.boundingBox.yMin + this.yOffset;
        const strokeWidth = BlockFace.markerOffset;
        const { head, borderRadius } = this.style;

        // Draw body
        ctx.lineWidth = strokeWidth + 0.1;
        drawRect(ctx, x, y, this.width, this.height, borderRadius, strokeWidth);
        if (settings.shadowsEnabled) {
            ctx.shadowBlur = 8;
            ctx.fillStyle = this.fillColor;
            ctx.strokeStyle = this.strokeColor;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.stroke();
        } else {
            ctx.fillStyle = this.fillColor;
            ctx.strokeStyle = this.strokeColor;
            ctx.fill();
            ctx.stroke();
        }

        // Draw head
        if (this.headHeight) {
            drawChip(ctx, x, y, this.width, this.headHeight, borderRadius, strokeWidth);
            ctx.fillStyle = head.fillColor;
            ctx.strokeStyle = head.strokeColor;
            ctx.fill();
            ctx.stroke();
        }

        // Draw text
        for (const { font, color, instructions } of this.text) {
            ctx.font = font;
            ctx.fillStyle = color;
            for (const instruction of instructions) {
                ctx.fillText(
                    instruction.text,
                    instruction.x + x,
                    instruction.y + y
                );
            }
        }

        // Draw data-item pill chips
        if (this._pillChips.length > 0) {
            const chipRadius = this._pillChips[0].h / 2;
            for (const chip of this._pillChips) {
                // Draw chip background
                drawRect(ctx, x + chip.x, y + chip.y, chip.w, chip.h, chipRadius, strokeWidth);
                ctx.fillStyle = chip.fill;
                ctx.strokeStyle = chip.fill;
                ctx.fill();
                // Draw chip label
                ctx.fillStyle = chip.textColor;
                ctx.fillText(chip.text, x + chip.textX, y + chip.textY);
            }
        }

        // Draw focus and hover markers
        if (this.view.focused) {
            const outline = this.style.selectOutline;
            const padding = outline.padding + 1;
            // Draw focus border
            if (settings.animationsEnabled) {
                ctx.setLineDash([5, 2]);
            }
            drawRect(
                ctx,
                x - padding,
                y - padding,
                this.width + padding * 2,
                this.height + padding * 2,
                outline.borderRadius, strokeWidth
            );
            ctx.strokeStyle = outline.color;
            ctx.stroke();
            ctx.setLineDash([]);
        } else if (this.view.hovered) {
            const { color, size } = this.style.anchorMarkers;
            // Draw anchors
            for (const anchor of this.view.anchors.values()) {
                anchor.renderTo(ctx, region, settings);
            }
            // Draw anchor markers
            ctx.strokeStyle = color;
            ctx.beginPath();
            let x, y;
            for (const o of this.view.anchors.values()) {
                x = o.x + BlockFace.markerOffset;
                y = o.y + BlockFace.markerOffset;
                ctx.moveTo(x - size, y - size);
                ctx.lineTo(x + size, y + size);
                ctx.moveTo(x + size, y - size);
                ctx.lineTo(x - size, y + size);
            }
            ctx.stroke();
        }

    }


    ///////////////////////////////////////////////////////////////////////////
    //  2. Cloning  ///////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Returns a clone of the face.
     * @returns
     *  A clone of the face.
     */
    public clone(): DictionaryBlock {
        return new DictionaryBlock(this.style, this.grid, this.scale, this.properties);
    }


    ///////////////////////////////////////////////////////////////////////////
    //  3. Internal Helpers  ///////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Walks the view's parent chain and returns the first {@link Canvas}
     * ancestor.  Returns `null` when the block is not yet attached to a
     * canvas (e.g. during a clone that hasn't been grafted into the tree).
     *
     * The walk is O(depth) — typically 2–3 hops for a block inside at most
     * one trust-boundary group.
     */
    private static findCanvas(view: { parent: { parent: unknown } | null }): Canvas | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let node: any = view;
        while (node !== null && node !== undefined) {
            if (node instanceof Canvas) {
                return node;
            }
            node = node._parent ?? null;
        }
        return null;
    }

}
