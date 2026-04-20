import type { LineStyle } from "./LineStyle";

/**
 * Style definition for {@link LabeledDynamicLine}.
 *
 * Extends the base {@link LineStyle} with the data-pill visual vocabulary
 * introduced in Step 3 of the data-items plan.  The pill tokens are the same
 * vocabulary used by {@link DictionaryBlockStyle}; placing them here avoids
 * coupling the line face to the block style type.
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

};
