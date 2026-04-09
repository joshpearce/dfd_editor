import { AnchorConfiguration } from "./AnchorFormat";
import { DiagramObjectType, PropertyType } from "@OpenChart/DiagramModel";
import type { DiagramObjectTemplate } from "@OpenChart/DiagramModel";

export const DfdObjects: DiagramObjectTemplate[] = [
    {
        name: "process",
        namespace: ["dfd", "process"],
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
            number: {
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
        namespace: ["dfd", "external_entity"],
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
        namespace: ["dfd", "data_store"],
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
        namespace: ["dfd", "data_flow"],
        type: DiagramObjectType.Line,
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
            }
        }
    },
    {
        name: "trust_boundary",
        namespace: ["dfd", "trust_boundary"],
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
    }
];
