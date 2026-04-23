/**
 * @file Lines.testing.ts
 *
 * Test-only fixture helpers for line-face unit tests
 * (`DynamicLine.spec.ts`, `PolyLine.spec.ts`, …).  NOT production code —
 * do not add to any production barrel (index.ts).  Import via direct
 * relative path from spec files only.
 */

import { ThemeLoader, DarkStyle } from "@OpenChart/ThemeLoader";
import {
    Alignment, DiagramObjectViewFactory, FaceType, Orientation
} from "@OpenChart/DiagramView";
import { DfdCanvas, DfdObjects, BaseTemplates } from "@/assets/configuration/DfdTemplates";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { LineStyle } from "@OpenChart/DiagramView";

/**
 * The DFD schema, assembled from the production templates.
 */
export const linesTestSchema: DiagramSchemaConfiguration = {
    id: "dfd_v1",
    canvas: DfdCanvas,
    templates: [
        ...BaseTemplates,
        ...DfdObjects
    ]
};

/**
 * Minimal theme covering every template the line-face tests touch.  The
 * `data_flow` design points at `DynamicLine` to mirror the production
 * themes; PolyLine is a runtime swap, not a theme-declared face.
 */
export const linesTestTheme: DiagramThemeConfiguration = {
    id: "lines_test_theme",
    name: "Lines Test Theme",
    grid: [5, 5],
    scale: 2,
    designs: {
        dfd: {
            type: FaceType.LineGridCanvas,
            attributes: Alignment.Grid,
            style: DarkStyle.Canvas()
        },
        process: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: DarkStyle.DictionaryBlock()
        },
        external_entity: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: DarkStyle.DictionaryBlock()
        },
        data_store: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: DarkStyle.DictionaryBlock()
        },
        trust_boundary: {
            type: FaceType.Group,
            attributes: Alignment.Grid
        },
        container: {
            type: FaceType.Group,
            attributes: Alignment.Grid
        },
        data_flow: {
            type: FaceType.DynamicLine,
            attributes: Alignment.Grid,
            style: DarkStyle.Line()
        },
        horizontal_anchor: {
            type: FaceType.AnchorPoint,
            attributes: Orientation.D0,
            style: DarkStyle.Point()
        },
        vertical_anchor: {
            type: FaceType.AnchorPoint,
            attributes: Orientation.D90,
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

/**
 * Builds a {@link DiagramObjectViewFactory} wired with the shared schema
 * and theme.  Use directly from spec files for line-face tests.
 */
export async function createLinesTestingFactory(): Promise<DiagramObjectViewFactory> {
    const theme = await ThemeLoader.load(linesTestTheme);
    return new DiagramObjectViewFactory(linesTestSchema, theme);
}

/**
 * Returns the {@link LineStyle} that the shared test theme assigns to
 * the `data_flow` template.  Centralises the design-narrowing so spec
 * files can construct a `PolyLine`/`DynamicLine` without re-asserting
 * the theme structure each time.
 */
export function getDataFlowLineStyle(factory: DiagramObjectViewFactory): LineStyle {
    const design = factory.resolveDesign("data_flow");
    if (design.type !== FaceType.DynamicLine && design.type !== FaceType.PolyLine) {
        throw new Error(`Expected data_flow design to be a line face; got ${design.type}.`);
    }
    return design.style;
}
