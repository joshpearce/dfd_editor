import { DiagramObjectType, PropertyType } from "@OpenChart/DiagramModel";
import type { CanvasTemplate } from "@OpenChart/DiagramModel";

export const DfdCanvas: CanvasTemplate = {
    name: "dfd",
    type: DiagramObjectType.Canvas,
    properties: {
        name: {
            type: PropertyType.String,
            default: "Untitled Diagram",
            is_representative: true
        },
        description: {
            type: PropertyType.String
        },
        author: {
            type: PropertyType.String
        },
        created: {
            type: PropertyType.Date,
            default: new Date()
        }
    }
};
