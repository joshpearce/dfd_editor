import { AnchorConfiguration } from "./AnchorFormat";
import { DiagramObjectType, PropertyType } from "@OpenChart/DiagramModel";
import type { DiagramObjectTemplate } from "@OpenChart/DiagramModel";

export const DfdObjects: DiagramObjectTemplate[] = [
    {
        name: "process",
        namespace: ["process"],
        shortcut: "P",
        type: DiagramObjectType.Block,
        properties: {
            name: {
                type: PropertyType.String,
                is_representative: true,
                metadata: {
                    validator: {
                        is_required: true
                    }
                }
            },
            description: {
                type: PropertyType.String
            },
            trust_level: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["public", "Public"],
                        ["authenticated", "Authenticated"],
                        ["admin", "Admin"],
                        ["system", "System"]
                    ]
                }
            },
            assumptions: {
                type: PropertyType.List,
                form: { type: PropertyType.String }
            }
        },
        anchors: AnchorConfiguration
    },
    {
        name: "external_entity",
        namespace: ["external_entity"],
        shortcut: "E",
        type: DiagramObjectType.Block,
        properties: {
            name: {
                type: PropertyType.String,
                is_representative: true,
                metadata: {
                    validator: {
                        is_required: true
                    }
                }
            },
            description: {
                type: PropertyType.String
            },
            entity_type: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["user", "User"],
                        ["service", "Service"],
                        ["system", "System"],
                        ["device", "Device"]
                    ]
                }
            },
            out_of_scope: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["false", "No"],
                        ["true", "Yes"]
                    ]
                },
                default: "false"
            }
        },
        anchors: AnchorConfiguration
    },
    {
        name: "data_store",
        namespace: ["data_store"],
        shortcut: "S",
        type: DiagramObjectType.Block,
        properties: {
            name: {
                type: PropertyType.String,
                is_representative: true,
                metadata: {
                    validator: {
                        is_required: true
                    }
                }
            },
            description: {
                type: PropertyType.String
            },
            storage_type: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["database", "Database"],
                        ["cache", "Cache"],
                        ["file", "File"],
                        ["queue", "Queue"],
                        ["bucket", "Bucket"]
                    ]
                }
            },
            contains_pii: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["false", "No"],
                        ["true", "Yes"]
                    ]
                },
                default: "false"
            },
            encryption_at_rest: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["false", "No"],
                        ["true", "Yes"]
                    ]
                },
                default: "false"
            }
        },
        anchors: AnchorConfiguration
    },
    {
        name: "data_flow",
        namespace: ["data_flow"],
        shortcut: "F",
        type: DiagramObjectType.Line,
        handle_template: "generic_handle",
        latch_template: {
            source: "generic_latch",
            target: "generic_latch"
        },
        properties: {
            name: {
                type: PropertyType.String,
                is_representative: true,
                metadata: {
                    validator: {
                        is_required: true
                    }
                }
            },
            data_classification: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["public", "Public"],
                        ["internal", "Internal"],
                        ["confidential", "Confidential"],
                        ["secret", "Secret"]
                    ]
                }
            },
            protocol: {
                type: PropertyType.String
            },
            authenticated: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["false", "No"],
                        ["true", "Yes"]
                    ]
                },
                default: "false"
            },
            encrypted_in_transit: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["false", "No"],
                        ["true", "Yes"]
                    ]
                },
                default: "false"
            },
            // GUIDs of canvas-level data items that flow through this edge.
            // Each entry's key is opaque (auto-generated); the value is the
            // data-item guid as a plain string.
            data_item_refs: {
                type: PropertyType.List,
                form: { type: PropertyType.String },
                default: []
            }
        }
    },
    {
        name: "trust_boundary",
        namespace: ["trust_boundary"],
        shortcut: "B",
        type: DiagramObjectType.Group,
        properties: {
            name: {
                type: PropertyType.String,
                is_representative: true,
                metadata: {
                    validator: {
                        is_required: true
                    }
                }
            },
            description: {
                type: PropertyType.String
            },
            privilege_level: {
                type: PropertyType.Enum,
                options: {
                    type: PropertyType.List,
                    form: { type: PropertyType.String },
                    default: [
                        ["internet", "Internet"],
                        ["dmz", "DMZ"],
                        ["corporate", "Corporate"],
                        ["restricted", "Restricted"]
                    ]
                }
            }
        }
    },
    {
        name: "container",
        namespace: ["container"],
        shortcut: "C",
        type: DiagramObjectType.Group,
        properties: {
            name: {
                type: PropertyType.String,
                is_representative: true
            },
            description: {
                type: PropertyType.String
            }
        }
    }
];
