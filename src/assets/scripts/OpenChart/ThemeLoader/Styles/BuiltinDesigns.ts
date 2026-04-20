import { StyleGenerator } from "./StyleGenerator";

// ─── Dark theme pill tokens ───────────────────────────────────────────────────
export const darkDataPill = {
    pii:      { fill: "#92400e", text: "#fcd34d" },
    secret:   { fill: "#7f1d1d", text: "#fca5a5" },
    public:   { fill: "#1e3a5f", text: "#93c5fd" },
    internal: { fill: "#1a3d2b", text: "#86efac" },
    default:  { fill: "#2f2f2f", text: "#a0a0a0" }
} as const;
export const darkPillRowVerticalPaddingUnits = 1;
export const darkPillSpacingUnits = 1;
/** Plate colours for the dark theme: near-canvas-background fill, low-contrast border. */
export const darkPlateFill   = "#1a1a1aee";
export const darkPlateStroke = "#ffffff14";

// ─── Light / Blog theme pill tokens ──────────────────────────────────────────
// Fills chosen so each clears WCAG AA normal-text 4.5:1 against #ffffff:
//   pii #b45309 5.02:1 | secret #b91c1c 6.47:1 | public #1d4ed8 6.70:1
//   internal #166534 7.13:1 | default #525252 7.81:1
export const lightDataPill = {
    pii:      { fill: "#b45309", text: "#ffffff" },
    secret:   { fill: "#b91c1c", text: "#ffffff" },
    public:   { fill: "#1d4ed8", text: "#ffffff" },
    internal: { fill: "#166534", text: "#ffffff" },
    default:  { fill: "#525252", text: "#ffffff" }
} as const;
export const lightPillRowVerticalPaddingUnits = 1;
export const lightPillSpacingUnits = 1;
/** Plate colours for the light theme: near-white fill, hairline border. */
export const lightPlateFill   = "#ffffffee";
export const lightPlateStroke = "#00000014";

/**
 * Dark Style
 */
export const DarkStyle = new StyleGenerator({

    blockBranch: {
        max_unit_width: 30,
        head: {
            fill_color: "#000",
            stroke_color: "#000",
            one_title: {
                title: {
                    font: { family: "Inter", size: "10.5pt", weight: 700 },
                    color: "#d8d8d8",
                    units: 1,
                    align_top: false
                }
            },
            two_title: {
                title: {
                    font: { family: "JetBrains Mono", size: "8.5pt", weight: 600 },
                    color: "#d8d8d8",
                    units: 1,
                    align_top: true
                },
                subtitle:  {
                    font: { family: "Inter", size: "13pt", weight: 800 },
                    color: "#d8d8d8",
                    units: 2
                }
            },
            vertical_padding_units: 2
        },
        body: {
            fill_color: "#1f1f1f",
            stroke_color: "#383838",
            field_name_text: {
                font: { family: "Inter", size: "8.1pt", weight: 600 },
                color: "#a0a0a0",
                units: 1,
                align_top: false
            },
            field_value_text: {
                font: { family: "Inter", size: "10.5pt" },
                color: "#cacaca",
                units: 2
            },
            body_vertical_padding_units: 1.5,
            field_vertical_padding_units: 2
        },
        branch: {
            font: { family: "Inter", size: "10.5pt" },
            color: "#bfbfbf",
            height: 3,
            min_width: 10
        },
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 9
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        border_radius: 5,
        horizontal_padding_units: 2,
        data_pill: darkDataPill,
        pill_row_vertical_padding_units: darkPillRowVerticalPaddingUnits,
        pill_spacing_units: darkPillSpacingUnits
    },

    blockDictionary: {
        max_unit_width: 30,
        head: {
            fill_color: "#000",
            stroke_color: "#000",
            one_title: {
                title: {
                    font: { family: "Inter", size: "10.5pt", weight: 700 },
                    color: "#d8d8d8",
                    units: 1,
                    align_top: false
                }
            },
            two_title: {
                title: {
                    font: { family: "JetBrains Mono", size: "8.5pt", weight: 600 },
                    color: "#d8d8d8",
                    units: 1,
                    align_top: true
                },
                subtitle:  {
                    font: { family: "Inter", size: "13pt", weight: 800 },
                    color: "#d8d8d8",
                    units: 2
                }
            },
            vertical_padding_units: 2
        },
        body: {
            fill_color: "#1f1f1f",
            stroke_color: "#383838",
            field_name_text: {
                font: { family: "Inter", size: "8.1pt", weight: 600 },
                color: "#a0a0a0",
                units: 1,
                align_top: false
            },
            field_value_text: {
                font: { family: "Inter", size: "10.5pt" },
                color: "#cacaca",
                units: 2
            },
            body_vertical_padding_units: 1.5,
            field_vertical_padding_units: 2
        },
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 9
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        border_radius: 5,
        horizontal_padding_units: 2,
        data_pill: darkDataPill,
        pill_row_vertical_padding_units: darkPillRowVerticalPaddingUnits,
        pill_spacing_units: darkPillSpacingUnits
    },

    blockText: {
        max_unit_width: 30,
        fill_color: "#000",
        stroke_color: "#000",
        text: {
            font: { family: "Inter", size: "16.5pt", weight: 800 },
            color: "#d8d8d8",
            units: 1.5,
            align_top: false
        },
        border_radius: 13,
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 19
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        vertical_padding: 2.25,
        horizontal_padding: 3
    },

    point: {
        radius: 6,
        fill_color: "#fedb22",
        stroke_color: "#141414",
        stroke_width: 3
    },

    line: {
        width: 2,
        hitbox_width: 20,
        border_radius: 12,
        cap_size: 12,
        cap_space: 0,
        color: "#465bf8",
        select_color: "#e6d845"
    },

    canvas: {
        grid_color: "#1d1d1d",
        background_color: "#141414",
        drop_shadow: {
            color: "rgba(0,0,0,.4)",
            offset: [3, 3]
        }
    },

    plate: { fill: darkPlateFill, stroke: darkPlateStroke },
    chipFontWeight: "600",
    chipFontFamily: "'Inter', sans-serif"

});

/**
 * Light Style
 */
export const LightStyle = new StyleGenerator({

    blockBranch: {
        max_unit_width: 30,
        head: {
            fill_color: "#000",
            stroke_color: "#000",
            one_title: {
                title: {
                    font: { family: "Inter", size: "10.5pt", weight: 700 },
                    color: "#fafafa",
                    units: 1,
                    align_top: false
                }
            },
            two_title: {
                title: {
                    font: { family: "JetBrains Mono", size: "8.5pt", weight: 600 },
                    color: "#fafafa",
                    units: 1,
                    align_top: true
                },
                subtitle:  {
                    font: { family: "Inter", size: "13pt", weight: 800 },
                    color: "#fafafa",
                    units: 2
                }
            },
            vertical_padding_units: 2
        },
        body: {
            fill_color: "#ededed",
            stroke_color: "#b8b8b8",
            field_name_text: {
                font: { family: "Inter", size: "8.1pt", weight: 600 },
                color: "#808080",
                units: 1,
                align_top: false
            },
            field_value_text: {
                font: { family: "Inter", size: "10.5pt" },
                color: "#525252",
                units: 2
            },
            body_vertical_padding_units: 1.5,
            field_vertical_padding_units: 2
        },
        branch: {
            font: { family: "Inter", size: "10.5pt" },
            color: "#bfbfbf",
            height: 3,
            min_width: 10
        },
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 9
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        border_radius: 5,
        horizontal_padding_units: 2,
        data_pill: lightDataPill,
        pill_row_vertical_padding_units: lightPillRowVerticalPaddingUnits,
        pill_spacing_units: lightPillSpacingUnits
    },

    blockDictionary: {
        max_unit_width: 30,
        head: {
            fill_color: "#000",
            stroke_color: "#000",
            one_title: {
                title: {
                    font: { family: "Inter", size: "10.5pt", weight: 700 },
                    color: "#fafafa",
                    units: 1,
                    align_top: false
                }
            },
            two_title: {
                title: {
                    font: { family: "JetBrains Mono", size: "8.5pt", weight: 600 },
                    color: "#fafafa",
                    units: 1,
                    align_top: true
                },
                subtitle:  {
                    font: { family: "Inter", size: "13pt", weight: 800 },
                    color: "#fafafa",
                    units: 2
                }
            },
            vertical_padding_units: 2
        },
        body: {
            fill_color: "#ededed",
            stroke_color: "#b8b8b8",
            field_name_text: {
                font: { family: "Inter", size: "8.1pt", weight: 600 },
                color: "#808080",
                units: 1,
                align_top: false
            },
            field_value_text: {
                font: { family: "Inter", size: "10.5pt" },
                color: "#525252",
                units: 2
            },
            body_vertical_padding_units: 1.5,
            field_vertical_padding_units: 2
        },
        select_outline: {
            color: "#FF4D00",
            padding: 4,
            border_radius: 9
        },
        anchor_markers: {
            color: "#999999",
            size: 3
        },
        border_radius: 5,
        horizontal_padding_units: 2,
        data_pill: lightDataPill,
        pill_row_vertical_padding_units: lightPillRowVerticalPaddingUnits,
        pill_spacing_units: lightPillSpacingUnits
    },

    blockText: {
        max_unit_width: 30,
        fill_color: "#000",
        stroke_color: "#000",
        text: {
            font: { family: "Inter", size: "16.5pt", weight: 800 },
            color: "#d8d8d8",
            units: 1.5,
            align_top: false
        },
        border_radius: 13,
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 19
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        vertical_padding: 2.25,
        horizontal_padding: 3
    },

    point: {
        radius: 6,
        fill_color: "#FF4D00",
        stroke_color: "#f2f2f2",
        stroke_width: 3
    },

    line: {
        width: 2,
        hitbox_width: 20,
        border_radius: 12,
        cap_size: 12,
        cap_space: 0,
        color: "#5286e7",
        select_color: "#FF4D00"
    },

    canvas: {
        grid_color: "#e0e0e0",
        background_color: "#f2f2f2",
        drop_shadow: {
            color: "rgba(0,0,0,0.25)",
            offset: [3, 3]
        }
    },

    plate: { fill: lightPlateFill, stroke: lightPlateStroke },
    chipFontWeight: "600",
    chipFontFamily: "'Inter', sans-serif"

});

/**
 * Blog Style — carry-over from the attack_flow_builder scaffold; not wired
 * into any DFD theme and not used in production.
 */
export const BlogStyle = new StyleGenerator({

    blockBranch: {
        max_unit_width: 30,
        head: {
            fill_color: "#000",
            stroke_color: "#000",
            one_title: {
                title: {
                    font: { family: "Inter", size: "10.5pt", weight: 700 },
                    color: "#ffffff",
                    units: 1,
                    align_top: false
                }
            },
            two_title: {
                title: {
                    font: { family: "JetBrains Mono", size: "8.5pt", weight: 600 },
                    color: "#ffffff",
                    units: 1,
                    align_top: true
                },
                subtitle:  {
                    font: { family: "Inter", size: "13pt", weight: 700 },
                    color: "#ffffff",
                    units: 2
                }
            },
            vertical_padding_units: 2
        },
        body: {
            fill_color: "#e5e5e5",
            stroke_color: "#e5e5e5",
            field_name_text: {
                font: { family: "Inter", size: "8.1pt", weight: 600 },
                color: "#999999",
                units: 1,
                align_top: false
            },
            field_value_text: {
                font: { family: "Inter", size: "10.5pt" },
                color: "#737373",
                units: 2
            },
            body_vertical_padding_units: 2,
            field_vertical_padding_units: 2
        },
        branch: {
            font: { family: "Inter", size: "10.5pt", weight: 600 },
            color: "#737373",
            height: 3,
            min_width: 10
        },
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 9
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        border_radius: 5,
        horizontal_padding_units: 2,
        data_pill: lightDataPill,
        pill_row_vertical_padding_units: lightPillRowVerticalPaddingUnits,
        pill_spacing_units: lightPillSpacingUnits
    },

    blockDictionary: {
        max_unit_width: 30,
        head: {
            fill_color: "#000",
            stroke_color: "#000",
            one_title: {
                title: {
                    font: { family: "Inter", size: "10.5pt", weight: 700 },
                    color: "#ffffff",
                    units: 1,
                    align_top: false
                }
            },
            two_title: {
                title: {
                    font: { family: "JetBrains Mono", size: "8.5pt", weight: 600 },
                    color: "#ffffff",
                    units: 1,
                    align_top: true
                },
                subtitle:  {
                    font: { family: "Inter", size: "13pt", weight: 700 },
                    color: "#ffffff",
                    units: 2
                }
            },
            vertical_padding_units: 2
        },
        body: {
            fill_color: "#e5e5e5",
            stroke_color: "#e5e5e5",
            field_name_text: {
                font: { family: "Inter", size: "8.1pt", weight: 600 },
                color: "#999999",
                units: 1,
                align_top: false
            },
            field_value_text: {
                font: { family: "Inter", size: "10.5pt" },
                color: "#737373",
                units: 2
            },
            body_vertical_padding_units: 2,
            field_vertical_padding_units: 2
        },
        select_outline: {
            color: "#000",
            padding: 4,
            border_radius: 9
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        border_radius: 5,
        horizontal_padding_units: 2,
        data_pill: lightDataPill,
        pill_row_vertical_padding_units: lightPillRowVerticalPaddingUnits,
        pill_spacing_units: lightPillSpacingUnits
    },

    blockText: {
        max_unit_width: 30,
        fill_color: "#000",
        stroke_color: "#000",
        text: {
            font: { family: "Inter", size: "16.5pt", weight: 800 },
            color: "#d8d8d8",
            units: 1.5,
            align_top: false
        },
        border_radius: 13,
        select_outline: {
            color: "#e6d845",
            padding: 4,
            border_radius: 19
        },
        anchor_markers: {
            color: "#ffffff",
            size: 3
        },
        vertical_padding: 2.25,
        horizontal_padding: 3
    },

    point: {
        radius: 6,
        fill_color: "#000",
        stroke_color: "#e5e5e5",
        stroke_width: 3
    },

    line: {
        width: 4,
        hitbox_width: 20,
        border_radius: 12,
        cap_size: 14,
        cap_space: 12,
        color: "#a6a6a6",
        select_color: "#000"
    },

    canvas: {
        grid_color: "#e5e5e5",
        background_color: "#e5e5e5",
        drop_shadow: {
            color: "rgba(0,0,0,0.25)",
            offset: [3, 3]
        }
    },

    plate: { fill: lightPlateFill, stroke: lightPlateStroke },
    chipFontWeight: "600",
    chipFontFamily: "'Inter', sans-serif"

});
