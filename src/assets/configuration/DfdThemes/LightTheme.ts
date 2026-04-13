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
        attributes: Alignment.Grid
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
