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
        // Only description is optional; classification is always emitted by the
        // backend (default "unclassified") and the engine tolerates absent
        // sub-keys in legacy diagrams.
        // Round-trip behaviour is verified by
        // DfdFilePreprocessor.spec.ts: "absent description sub-key … round-trips".
        data_items: {
            type: PropertyType.List,
            default: [],
            form: {
                type: PropertyType.Dictionary,
                form: {
                    parent: {
                        type: PropertyType.String
                    },
                    identifier: {
                        type: PropertyType.String,
                        // The display token (e.g. "D1") is what a user reads;
                        // using `identifier` as the representative field produces
                        // a human-readable label rather than exposing the raw GUID
                        // that lives in `parent`.
                        is_representative: true
                    },
                    name: {
                        type: PropertyType.String
                    },
                    description: {
                        type: PropertyType.String
                    },
                    classification: {
                        type: PropertyType.Enum,
                        options: {
                            type: PropertyType.List,
                            form: { type: PropertyType.String },
                            default: [
                                ["unclassified", "Unclassified"],
                                ["pii",          "PII"],
                                ["secret",       "Secret"],
                                ["public",       "Public"],
                                ["internal",     "Internal"]
                            ]
                        },
                        default: "unclassified"
                    }
                }
            }
        }
    }
};
