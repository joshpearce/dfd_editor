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
        },
        // Canvas-level data items.  Each entry is keyed by the item's guid;
        // the DictionaryProperty sub-fields mirror the DataItem schema shape.
        // description and classification are optional — absent keys are treated
        // identically to explicit null on load (StringProperty.setValue accepts
        // null and the DiagramObjectFactory skips absent optional keys).
        data_items: {
            type: PropertyType.List,
            form: {
                type: PropertyType.Dictionary,
                form: {
                    parent: {
                        type: PropertyType.String,
                        is_representative: true
                    },
                    identifier: {
                        type: PropertyType.String
                    },
                    name: {
                        type: PropertyType.String
                    },
                    description: {
                        type: PropertyType.String
                    },
                    classification: {
                        type: PropertyType.String
                    }
                }
            }
        }
    }
};
