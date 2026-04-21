import { DiagramModelFile, ListProperty, SemanticAnalyzer } from "@OpenChart/DiagramModel";
import type { Canvas } from "@OpenChart/DiagramModel";
import { readDataItems } from "@OpenChart/DiagramModel/DataItemLookup";
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
            // Collect data_item_refs from both directions (node1 and node2).
            // For now, we combine them into a single "data_item_refs" field for the minimal format.
            const node1Refs = this.projectDataItemRefs(edge.props.value.get("node1_src_data_item_refs"));
            const node2Refs = this.projectDataItemRefs(edge.props.value.get("node2_src_data_item_refs"));
            const allRefs = [...node1Refs, ...node2Refs];
            const edgeRecord: Record<string, unknown> = {
                id,
                source: edge.source?.instance ?? null,
                target: edge.target?.instance ?? null,
                crosses: edge.crossings.map(n => n.instance)
            };
            if (allRefs.length > 0) {
                edgeRecord["data_item_refs"] = allRefs;
            }
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
     * Projects a flow's data_item_refs ListProperty to a string[] of GUIDs.
     * @param prop
     *  The data_item_refs property (may be undefined for legacy flows).
     * @returns
     *  Ordered list of data-item GUIDs; empty array if none.
     */
    private projectDataItemRefs(prop: unknown): string[] {
        if (!(prop instanceof ListProperty)) {
            return [];
        }
        const refs: string[] = [];
        for (const [, entry] of prop.value) {
            const val = entry.toJson();
            if (typeof val === "string") {
                refs.push(val);
            }
        }
        return refs;
    }

    /**
     * Returns the publisher's file extension.
     */
    public getFileExtension(): string {
        return "json";
    }

}

export default DfdPublisher;
