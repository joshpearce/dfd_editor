import { Colors, LightStyle } from "@OpenChart/ThemeLoader";
import { Alignment, FaceType, Orientation } from "@OpenChart/DiagramView";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";

type DesignMap = DiagramThemeConfiguration["designs"];

const BaseObjects: DesignMap = {
    dynamic_line: {
        type: FaceType.DynamicLine,
        attributes: Alignment.Grid,
        style: LightStyle.Line()
    },
    vertical_anchor: {
        type: FaceType.AnchorPoint,
        attributes: Orientation.D90,
        style: {
            radius: 10,
            fill_color: "rgba(255, 255, 255, 0.25)",
            stroke_color: "rgba(255, 255, 255, 0.25)",
            stroke_width: 0
        }
    },
    horizontal_anchor: {
        type: FaceType.AnchorPoint,
        attributes: Orientation.D0,
        style: {
            radius: 10,
            fill_color: "rgba(255, 255, 255, 0.25)",
            stroke_color: "rgba(255, 255, 255, 0.25)",
            stroke_width: 0
        }
    },
    generic_latch: {
        type: FaceType.LatchPoint,
        attributes: Alignment.Grid,
        style: {
            radius: 8,
            fill_color: "rgba(255, 77, 0, 0.25)",
            stroke_color: "#141414",
            stroke_width: 0
        }
    },
    generic_handle: {
        type: FaceType.HandlePoint,
        attributes: Alignment.Grid,
        style: LightStyle.Point()
    }
};

const DfdObjects: DesignMap = {
    dfd: {
        type: FaceType.DotGridCanvas,
        attributes: Alignment.Grid,
        style: LightStyle.Canvas()
    },
    process: {
        type: FaceType.DictionaryBlock,
        attributes: Alignment.Grid,
        style: LightStyle.DictionaryBlock({ head: Colors.LightThemeBlue })
    },
    external_entity: {
        type: FaceType.DictionaryBlock,
        attributes: Alignment.Grid,
        style: LightStyle.DictionaryBlock({ head: Colors.LightThemeOrange })
    },
    data_store: {
        type: FaceType.DictionaryBlock,
        attributes: Alignment.Grid,
        style: LightStyle.DictionaryBlock({ head: Colors.LightThemeGray })
    },
    data_flow: {
        type: FaceType.DynamicLine,
        attributes: Alignment.Grid,
        style: LightStyle.Line()
    },
    trust_boundary: {
        type: FaceType.Group,
        attributes: Alignment.Grid,
        style: {
            strokeColor: "rgba(99, 102, 241, 0.5)",
            focusedStrokeColor: "rgba(79, 70, 229, 0.95)",
            focusedFillColor: "rgba(99, 102, 241, 0.1)",
            labelColor: "rgba(79, 70, 229, 0.7)",
            focusedLabelColor: "rgba(67, 56, 202, 0.95)",
            handleColor: "rgba(79, 70, 229, 0.95)",
            lineDash: [8, 4]
        }
    },
    container: {
        type: FaceType.Group,
        attributes: Alignment.Grid,
        style: {
            strokeColor: "rgba(107, 114, 128, 0.5)",
            focusedStrokeColor: "rgba(55, 65, 81, 0.95)",
            focusedFillColor: "rgba(107, 114, 128, 0.08)",
            labelColor: "rgba(75, 85, 99, 0.75)",
            focusedLabelColor: "rgba(31, 41, 55, 0.95)",
            handleColor: "rgba(55, 65, 81, 0.95)",
            lineDash: []
        }
    }
};

export const LightTheme: DiagramThemeConfiguration = {
    id: "light_theme",
    name: "Light Theme",
    grid: [5, 5],
    snap_grid: [20, 20],
    scale: 2,
    designs: {
        ...BaseObjects,
        ...DfdObjects
    }
};
