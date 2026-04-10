import { DiagramObjectType } from "@OpenChart/DiagramModel";
import type { DiagramObjectTemplate } from "@OpenChart/DiagramModel";

export const BaseTemplates: DiagramObjectTemplate[] = [
    {
        name: "horizontal_anchor",
        type: DiagramObjectType.Anchor
    },
    {
        name: "vertical_anchor",
        type: DiagramObjectType.Anchor
    },
    {
        name: "generic_latch",
        type: DiagramObjectType.Latch
    },
    {
        name: "generic_handle",
        type: DiagramObjectType.Handle
    }
];
