import type { LineStyle } from "./LineStyle";

/**
 * Style definition for {@link LabeledDynamicLine}.
 *
 * Extends the base {@link LineStyle} with the data-pill visual vocabulary
 * introduced in Step 3 of the data-items plan.  The pill tokens are the same
 * vocabulary used by {@link DictionaryBlockStyle}; shared palette consts in
 * {@link BuiltinDesigns} are the single source of truth — both block and line
 * styles reference those consts rather than coupling the line face to the block
 * style type.
 */
export type LabeledLineStyle = LineStyle & {

    /**
     * Per-classification fill and text colours for data pills.
     * Keys correspond to the `classification` field on a DataItem, plus
     * `"default"` which is used when classification is null or unknown.
     */
    dataPill: Record<"pii" | "secret" | "public" | "internal" | "default", {

        /**
         * The pill's background fill colour.
         */
        fill: string;

        /**
         * The pill's text colour (must meet WCAG contrast against fill).
         */
        text: string;

    }>;

    /**
     * Vertical padding above and below the pill strip (in grid units).
     */
    pillRowVerticalPaddingUnits: number;

    /**
     * Horizontal spacing between adjacent pills in the strip (in grid units).
     */
    pillSpacingUnits: number;

    /**
     * Background plate colours for the pill strip.
     * Sourced from the theme so that the plate reads well against both light
     * and dark canvases.
     */
    plate: {
        /** Plate fill colour (should be translucent near-canvas-background). */
        fill: string;
        /** Plate stroke colour (should be low-contrast border). */
        stroke: string;
    };

    /**
     * Font string for chip labels, e.g. `"600 11px Inter, sans-serif"`.
     * Sourced from the theme to avoid hardcoding a font family in the face.
     */
    chipFont: string;

};
