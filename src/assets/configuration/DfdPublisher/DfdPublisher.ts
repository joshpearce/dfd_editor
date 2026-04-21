import { DiagramModelFile, SemanticAnalyzer } from "@OpenChart/DiagramModel";
import type { Canvas } from "@OpenChart/DiagramModel";
import { readDataItems, readFlowRefs } from "@OpenChart/DiagramModel/DataItemLookup";
import type { DataItem } from "@OpenChart/DiagramModel/DataItemLookup";
import type { FilePublisher } from "@/assets/scripts/Application";

class DfdPublisher implements FilePublisher {

    /**
     * Returns the published diagram as a JSON string.
     * @param file
     *  The file to publish.
     * @returns
     *  The published diagram in text form.
     */
    public publish(file: DiagramModelFile): string {
        const graph = SemanticAnalyzer.toGraph(file.canvas);
        const nodes: Record<string, unknown>[] = [];
        const edges: Record<string, unknown>[] = [];

        for (const [instance, node] of graph.nodes) {
            nodes.push({
                id: instance,
                type: node.id,
                parent: node.parent?.instance ?? null,
                properties: node.props.toJson()
            });
        }

        for (const [id, edge] of graph.edges) {
            // Emit both ref arrays as separate fields, always (even when empty).
            // AC2.4 requires empty-both-sides flows to survive round-trip and be
            // emitted in the output.
            const flowRefs = readFlowRefs(edge.props);
            const edgeRecord: Record<string, unknown> = {
                id,
                node1: edge.node1?.instance ?? null,
                node2: edge.node2?.instance ?? null,
                crosses: edge.crossings.map(n => n.instance),
                node1_src_data_item_refs: flowRefs.node1ToNode2,
                node2_src_data_item_refs: flowRefs.node2ToNode1
            };
            edges.push(edgeRecord);
        }

        // Project canvas-level data_items.
        const dataItems = this.projectCanvasDataItems(file.canvas);

        const result: Record<string, unknown> = { nodes, edges };
        if (dataItems.length > 0) {
            result["data_items"] = dataItems;
        }

        return JSON.stringify(result, null, 2);
    }

    /**
     * Projects the canvas data_items to the minimal-format array.
     * Delegates to {@link readDataItems} so that the same traversal logic is
     * not duplicated here.  Items with missing required fields are emitted with
     * their partial state (empty string for absent required fields); the
     * DfdValidator surfaces missing-field conditions as user-visible warnings.
     *
     * @param canvas  The diagram canvas.
     * @returns       Array of DataItem records (may include partial items).
     */
    private projectCanvasDataItems(canvas: Canvas): DataItem[] {
        return readDataItems(canvas);
    }

    /**
     * Returns the publisher's file extension.
     */
    public getFileExtension(): string {
        return "json";
    }

}

export default DfdPublisher;
