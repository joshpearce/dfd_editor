import { merge } from "@OpenChart/Utilities";
import type { StyleSet } from "./StyleSet";
import type { DeepPartial } from "../TypeHelpers";
import type {
    BranchBlockStyleConfiguration,
    CanvasStyleConfiguration,
    DictionaryBlockStyleConfiguration,
    LineStyleConfiguration,
    PointStyleConfiguration,
    TextBlockStyleConfiguration
} from "../ThemeConfigurations";
import type { LabeledLineStyleConfiguration } from "../ThemeConfigurations";

export class StyleGenerator {

    /**
     * The generator's style set.
     */
    private readonly styles: StyleSet;


    /**
     * Creates a new {@link StyleGenerator}.
     * @param style
     *  The generator's style set.
     */
    public constructor(style: StyleSet) {
        this.styles = style;
    }


    /**
     * Returns the branch block style.
     * @param style
     *  The style parameters.
     *  (Default: {})
     * @returns
     *  The branch block style.
     */
    public BranchBlock(
        style: DeepPartial<BranchBlockStyleConfiguration> = {}
    ): BranchBlockStyleConfiguration {
        return merge(style, structuredClone(this.styles.blockBranch));
    }

    /**
     * Returns the dictionary block style.
     * @param style
     *  The style parameters.
     *  (Default: {})
     * @returns
     *  The dictionary block style.
     */
    public DictionaryBlock(
        style: DeepPartial<DictionaryBlockStyleConfiguration> = {}
    ): DictionaryBlockStyleConfiguration {
        return merge(style, structuredClone(this.styles.blockDictionary));
    }


    /**
     * Returns the text block style.
     * @param style
     *  The style parameters.
     *  (Default: {})
     * @returns
     *  The text block style.
     */
    public TextBlock(
        style: DeepPartial<TextBlockStyleConfiguration> = {}
    ): TextBlockStyleConfiguration {
        return merge(style, structuredClone(this.styles.blockText));
    }

    /**
     * Returns the point style.
     * @param style
     *  The style parameters.
     *  (Default: {})
     * @returns
     *  The point style.
     */
    public Point(
        style: DeepPartial<PointStyleConfiguration> = {}
    ): PointStyleConfiguration {
        return merge(style, structuredClone(this.styles.point));
    }

    /**
     * Returns the line style.
     * @param style
     *  The style parameters.
     *  (Default: {})
     * @returns
     *  The line style.
     */
    public Line(
        style: DeepPartial<LineStyleConfiguration> = {}
    ): LineStyleConfiguration {
        return merge(style, structuredClone(this.styles.line));
    }

    /**
     * Returns the canvas style.
     * @param style
     *  The style parameters.
     *  (Default: {})
     * @returns
     *  The canvas style.
     */
    public Canvas(
        style: DeepPartial<CanvasStyleConfiguration> = {}
    ): CanvasStyleConfiguration {
        return merge(style, structuredClone(this.styles.canvas));
    }

    /**
     * Returns a {@link LabeledLineStyleConfiguration} (snake_case) that merges
     * the base line style with the shared pill-palette tokens stored on this
     * StyleGenerator.
     *
     * Prefer this over reaching into `DictionaryBlock().data_pill` from the
     * theme file — that pattern couples the line style to the block style type.
     * The ThemeLoader converts the returned snake_case object to the camelCase
     * {@link LabeledLineStyle} at runtime.
     *
     * @param style  Optional overrides applied on top of the generated base.
     */
    public LabeledLine(
        style: DeepPartial<LabeledLineStyleConfiguration> = {}
    ): LabeledLineStyleConfiguration {
        const s = this.styles;
        const base: LabeledLineStyleConfiguration = {
            ...structuredClone(s.line),
            data_pill: structuredClone(s.blockDictionary.data_pill),
            pill_row_vertical_padding_units: s.blockDictionary.pill_row_vertical_padding_units,
            pill_spacing_units: s.blockDictionary.pill_spacing_units,
            plate: structuredClone(s.plate),
            chip_font: s.chipFont
        };
        return merge(style as Partial<LabeledLineStyleConfiguration>, base) as LabeledLineStyleConfiguration;
    }

}
