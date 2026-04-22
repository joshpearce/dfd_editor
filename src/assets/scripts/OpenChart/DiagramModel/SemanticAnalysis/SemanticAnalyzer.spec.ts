/**
 * @file SemanticAnalyzer.spec.ts
 *
 * Unit tests for the graph-enrichment passes added in Phase C:
 *  - Pass 3: parent / children links
 *  - Pass 4: edge crossings (symmetric difference of trustBoundaryAncestors)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SemanticAnalyzer } from "./SemanticAnalyzer";
import { DiagramObjectFactory, DiagramObjectType, PropertyType } from "../DiagramObjectFactory";
import { DiagramModelFile } from "../DiagramModelFile";
import { Block, Group, Line } from "../DiagramObject";
import type { Canvas } from "../DiagramObject";
import type { DiagramSchemaConfiguration } from "../DiagramObjectFactory";


///////////////////////////////////////////////////////////////////////////////
//  1. Test Schema  ////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


const testSchema: DiagramSchemaConfiguration = {
    id: "test_schema",
    canvas: {
        name: "dfd",
        type: DiagramObjectType.Canvas,
        properties: {}
    },
    templates: [
        {
            name: "trust_boundary",
            type: DiagramObjectType.Group,
            properties: {
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
            name: "process",
            type: DiagramObjectType.Block,
            anchors: {
                up: "test_anchor",
                down: "test_anchor"
            },
            properties: {}
        },
        {
            name: "external_entity",
            type: DiagramObjectType.Block,
            anchors: {
                up: "test_anchor",
                down: "test_anchor"
            },
            properties: {
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
            }
        },
        {
            name: "data_flow",
            type: DiagramObjectType.Line,
            latch_template: {
                node1: "generic_latch",
                node2: "generic_latch"
            },
            handle_template: "generic_handle",
            properties: {
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
            name: "test_anchor",
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
    ]
};


///////////////////////////////////////////////////////////////////////////////
//  2. Helpers  ////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


let factory: DiagramObjectFactory;
let canvas: Canvas;

/**
 * Connects `line` source → blockA, target → blockB using their first anchors.
 */
function connect(line: Line, blockA: Block, blockB: Block): void {
    const srcAnchor = [...blockA.anchors.values()][0];
    const tgtAnchor = [...blockB.anchors.values()][0];
    line.node1.link(srcAnchor);
    line.node2.link(tgtAnchor);
}


///////////////////////////////////////////////////////////////////////////////
//  3. Tests  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("SemanticAnalyzer — parent / children enrichment", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(testSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("canvas-level block has null parent", () => {
        const block = factory.createNewDiagramObject("process", Block);
        canvas.addObject(block);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const node = graph.nodes.get(block.instance)!;

        expect(node.parent).toBeNull();
    });

    it("block inside a trust boundary has that boundary as parent", () => {
        const boundary = factory.createNewDiagramObject("trust_boundary", Group);
        const block = factory.createNewDiagramObject("process", Block);
        boundary.addObject(block);
        canvas.addObject(boundary);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const blockNode = graph.nodes.get(block.instance)!;

        expect(blockNode.parent).not.toBeNull();
        expect(blockNode.parent!.instance).toBe(boundary.instance);
    });

    it("nested block has direct parent (not outer boundary)", () => {
        const b0 = factory.createNewDiagramObject("trust_boundary", Group);
        const b1 = factory.createNewDiagramObject("trust_boundary", Group);
        const block = factory.createNewDiagramObject("process", Block);
        b1.addObject(block);
        b0.addObject(b1);
        canvas.addObject(b0);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const blockNode = graph.nodes.get(block.instance)!;

        expect(blockNode.parent!.instance).toBe(b1.instance);
        expect(blockNode.parent!.instance).not.toBe(b0.instance);
    });

    it("children array is populated for a group node", () => {
        const boundary = factory.createNewDiagramObject("trust_boundary", Group);
        const block1 = factory.createNewDiagramObject("process", Block);
        const block2 = factory.createNewDiagramObject("process", Block);
        boundary.addObject(block1);
        boundary.addObject(block2);
        canvas.addObject(boundary);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const boundaryNode = graph.nodes.get(boundary.instance)!;

        expect(boundaryNode.children.length).toBe(2);
        const childInstances = boundaryNode.children.map(n => n.instance);
        expect(childInstances).toContain(block1.instance);
        expect(childInstances).toContain(block2.instance);
    });

    it("trustBoundaryAncestors is empty for canvas-level block", () => {
        const block = factory.createNewDiagramObject("process", Block);
        canvas.addObject(block);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const node = graph.nodes.get(block.instance)!;

        expect(node.trustBoundaryAncestors).toHaveLength(0);
    });

    it("trustBoundaryAncestors returns innermost boundary first for nested block", () => {
        const b0 = factory.createNewDiagramObject("trust_boundary", Group);
        const b1 = factory.createNewDiagramObject("trust_boundary", Group);
        const block = factory.createNewDiagramObject("process", Block);
        b1.addObject(block);
        b0.addObject(b1);
        canvas.addObject(b0);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const blockNode = graph.nodes.get(block.instance)!;
        const ancestors = blockNode.trustBoundaryAncestors;

        expect(ancestors).toHaveLength(2);
        expect(ancestors[0].instance).toBe(b1.instance);  // innermost first
        expect(ancestors[1].instance).toBe(b0.instance);
    });

});

describe("SemanticAnalyzer — edge crossings enrichment", () => {

    beforeEach(() => {
        factory = new DiagramObjectFactory(testSchema);
        canvas = new DiagramModelFile(factory).canvas;
    });

    it("no crossings — both endpoints in the same boundary", () => {
        const boundary = factory.createNewDiagramObject("trust_boundary", Group);
        const blockA = factory.createNewDiagramObject("process", Block);
        const blockB = factory.createNewDiagramObject("process", Block);
        const line = factory.createNewDiagramObject("data_flow", Line);

        boundary.addObject(blockA);
        boundary.addObject(blockB);
        boundary.addObject(line);
        canvas.addObject(boundary);
        connect(line, blockA, blockB);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const edge = graph.edges.get(line.instance)!;

        expect(edge.crossings).toHaveLength(0);
    });

    it("crossing — one endpoint in a boundary, one at canvas root", () => {
        const boundary = factory.createNewDiagramObject("trust_boundary", Group);
        const blockA = factory.createNewDiagramObject("process", Block);
        const blockB = factory.createNewDiagramObject("process", Block);
        const line = factory.createNewDiagramObject("data_flow", Line);

        boundary.addObject(blockA);
        canvas.addObject(boundary);
        canvas.addObject(blockB);
        canvas.addObject(line);
        connect(line, blockA, blockB);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const edge = graph.edges.get(line.instance)!;
        const boundaryNode = graph.nodes.get(boundary.instance)!;

        expect(edge.crossings).toHaveLength(1);
        expect(edge.crossings[0]).toBe(boundaryNode);
    });

    it("crossing — source in inner boundary B1, target directly in outer boundary B0", () => {
        const b0 = factory.createNewDiagramObject("trust_boundary", Group);
        const b1 = factory.createNewDiagramObject("trust_boundary", Group);
        const blockA = factory.createNewDiagramObject("process", Block);
        const blockB = factory.createNewDiagramObject("process", Block);
        const line = factory.createNewDiagramObject("data_flow", Line);

        b1.addObject(blockA);
        b0.addObject(b1);
        b0.addObject(blockB);
        b0.addObject(line);
        canvas.addObject(b0);
        connect(line, blockA, blockB);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const edge = graph.edges.get(line.instance)!;
        const b0Node = graph.nodes.get(b0.instance)!;
        const b1Node = graph.nodes.get(b1.instance)!;

        // B0 contains both endpoints — not a crossing.
        // B1 contains only blockA — crosses B1.
        expect(edge.crossings).toHaveLength(1);
        expect(edge.crossings[0]).toBe(b1Node);
        expect(edge.crossings).not.toContain(b0Node);
    });

    it("crossings — sibling boundaries B1 and B2 both inside B0", () => {
        const b0 = factory.createNewDiagramObject("trust_boundary", Group);
        const b1 = factory.createNewDiagramObject("trust_boundary", Group);
        const b2 = factory.createNewDiagramObject("trust_boundary", Group);
        const blockA = factory.createNewDiagramObject("process", Block);
        const blockB = factory.createNewDiagramObject("process", Block);
        const line = factory.createNewDiagramObject("data_flow", Line);

        b1.addObject(blockA);
        b2.addObject(blockB);
        b0.addObject(b1);
        b0.addObject(b2);
        b0.addObject(line);
        canvas.addObject(b0);
        connect(line, blockA, blockB);

        const graph = SemanticAnalyzer.toGraph(canvas);
        const edge = graph.edges.get(line.instance)!;
        const b1Node = graph.nodes.get(b1.instance)!;
        const b2Node = graph.nodes.get(b2.instance)!;

        expect(edge.crossings).toHaveLength(2);
        expect(edge.crossings).toContain(b1Node);
        expect(edge.crossings).toContain(b2Node);
    });

    it("unbound edge has empty crossings", () => {
        const line = factory.createNewDiagramObject("data_flow", Line);
        canvas.addObject(line);
        // No latch links — edge remains unbound (node1/node2 null)

        const graph = SemanticAnalyzer.toGraph(canvas);
        const edge = graph.edges.get(line.instance)!;

        expect(edge.node1).toBeNull();
        expect(edge.node2).toBeNull();
        expect(edge.crossings).toHaveLength(0);
    });

});
