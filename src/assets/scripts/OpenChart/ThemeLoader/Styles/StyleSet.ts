import type {
    BranchBlockStyleConfiguration,
    CanvasStyleConfiguration,
    DictionaryBlockStyleConfiguration,
    LineStyleConfiguration,
    PointStyleConfiguration,
    TextBlockStyleConfiguration
} from "../ThemeConfigurations";

export type StyleSet = {
    blockBranch: BranchBlockStyleConfiguration;
    blockDictionary: DictionaryBlockStyleConfiguration;
    blockText: TextBlockStyleConfiguration;
    point: PointStyleConfiguration;
    line: LineStyleConfiguration;
    canvas: CanvasStyleConfiguration;
    /**
     * Background plate tokens for the labeled-line pill strip.
     * Sourced from the theme so the plate reads well against the canvas color.
     */
    plate: { fill: string, stroke: string };
    /**
     * Font weight token for pill chip labels (e.g. `"600"`).
     * Combined with chipFontFamily and the computed size to produce a valid
     * CSS font shorthand.
     */
    chipFontWeight: string;

    /**
     * Font family (with optional stack) for pill chip labels
     * (e.g. `"'Inter', sans-serif"`).  Must NOT include a size or weight.
     */
    chipFontFamily: string;
};
