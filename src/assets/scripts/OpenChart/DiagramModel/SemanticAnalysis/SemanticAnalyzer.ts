import { traverse } from "../DiagramNavigators";
import { SemanticGraphNode } from "./SemanticGraphNode";
import { SemanticGraphEdge } from "./SemanticGraphEdge";
import { Block, Group, Line } from "../DiagramObject";
import type { GraphExport } from "./GraphExport";
import type { Canvas, DiagramObject } from "../DiagramObject";

export class SemanticAnalyzer {

    /**
     * Derives the graph depicted by a {@link Canvas}.
     * @param canvas
     *  The {@link Canvas}.
     * @returns
     *  The graph's edges and nodes.
     */
    public static toGraph(canvas: Canvas): GraphExport {
        const nodes: Map<string, SemanticGraphNode> = new Map();
        const edges: Map<string, SemanticGraphEdge> = new Map();
        const objMap: Map<string, Group | Block> = new Map();
        // Build graph
        for (const obj of traverse(canvas as DiagramObject)) {
            if (obj instanceof Group || obj instanceof Block) {
                nodes.set(obj.instance, new SemanticGraphNode(obj));
                objMap.set(obj.instance, obj);
            } else if (obj instanceof Line) {
                edges.set(obj.instance, new SemanticGraphEdge(obj));
            }
        }
        // Connect graph
        for (const block of traverse(canvas)) {
            if (!(block instanceof Block)) {
                continue;
            }
            const node = nodes.get(block.instance)!;
            for (const [position, anchor] of block.anchors) {
                for (const latch of anchor.latches) {
                    // Select line
                    const line = latch.parent;
                    if (!(line instanceof Line)) {
                        continue;
                    }
                    const edge = edges.get(line.instance)!;
                    // Resolve direction
                    const source = line.node1.anchor?.instance;
                    const target = line.node2.anchor?.instance;
                    if (source === anchor.instance) {
                        node.addNextEdge(position, edge);
                    }
                    if (target === anchor.instance) {
                        node.addPrevEdge(position, edge);
                    }
                }
            }
        }
        // Pass 3 — parent links
        for (const [instance, obj] of objMap) {
            const parentObj = obj.parent;
            if (!parentObj || parentObj === canvas) { continue; }
            if (!(parentObj instanceof Group)) { continue; }
            const parentNode = nodes.get(parentObj.instance);
            if (!parentNode) { continue; }
            const childNode = nodes.get(instance)!;
            childNode.parent = parentNode;
            parentNode.children.push(childNode);
        }
        // Pass 4 — crossings
        for (const [, edge] of edges) {
            if (!edge.node1 || !edge.node2) { continue; }
            const n1a = edge.node1.trustBoundaryAncestors;
            const n2a = edge.node2.trustBoundaryAncestors;
            const n2aSet = new Set(n2a);
            const n1aSet = new Set(n1a);
            edge.crossings = [
                ...n1a.filter(n => !n2aSet.has(n)),
                ...n2a.filter(n => !n1aSet.has(n))
            ];
        }
        return { edges, nodes };
    }

    /**
     * Returns a {@link DiagramObject}'s child {@link Block}s.
     * @param object
     *  The starting object.
     * @returns
     *  All child blocks.
     */
    public static getChildBlocks<T extends DiagramObject, B extends Block>(object: T): B[] {
        return SemanticAnalyzer.getAdjacentBlocks(object, "outgoing");
    }

    /**
     * Returns a {@link DiagramObject}'s parent {@link Block}s.
     * @param object
     *  The starting object.
     * @returns
     *  All child blocks.
     */
    public static getParentBlocks<T extends DiagramObject, B extends Block>(object: T): B[] {
        return SemanticAnalyzer.getAdjacentBlocks(object, "ingoing");
    }

    /**
     * Returns all adjacent {@link Block}s connected to a {@link DiagramObject}
     * in the specified direction.
     * @param object
     *  The starting object.
     * @param direction
     *  The direction of traversal.
     * @returns
     *  All adjacent blocks.
     */
    private static getAdjacentBlocks<T extends DiagramObject, B extends Block>(
        object: T,
        direction: "ingoing" | "outgoing"
    ): B[] {
        const blocks = new Map<string, B>();

        // Resolve direction
        let dirSource: "node1" | "node2";
        let dirTarget: "node1" | "node2";
        if (direction === "outgoing") {
            dirSource = "node1";
            dirTarget = "node2";
        } else {
            dirSource = "node2";
            dirTarget = "node1";
        }

        // Collect lines
        let lines: Line[] = [];
        if (object instanceof Block) {
            const latches = [...object.anchors.values()]
                .flatMap(a => a.latches);
            for (const latch of latches) {
                const line = latch.parent;
                if (!(line instanceof Line)) {
                    continue;
                }
                if (line[dirSource] === latch) {
                    lines.push(line);
                }
            }
        } else if (object instanceof Line) {
            lines = [object];
        } else {
            return [];
        }

        // Collect blocks
        for (const line of lines) {
            const target = line[dirTarget].anchor?.parent;
            if (target instanceof Block) {
                blocks.set(target.instance, target as B);
            }
        }

        // Return blocks
        return [...blocks.values()];
    }

}
