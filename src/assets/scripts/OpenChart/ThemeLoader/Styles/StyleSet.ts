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
     * Font string used for pill chip labels (e.g. `"600 11px Inter, sans-serif"`).
     * Sourced from the theme so the face does not hardcode a font family.
     */
    chipFont: string;
};
