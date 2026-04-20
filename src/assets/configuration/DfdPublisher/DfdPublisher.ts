import { DiagramModelFile, ListProperty, DictionaryProperty, SemanticAnalyzer } from "@OpenChart/DiagramModel";
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
            const dataItemRefs = this.projectDataItemRefs(edge.props.value.get("data_item_refs"));
            const edgeRecord: Record<string, unknown> = {
                id,
                source: edge.source?.instance ?? null,
                target: edge.target?.instance ?? null,
                crosses: edge.crossings.map(n => n.instance)
            };
            if (dataItemRefs.length > 0) {
                edgeRecord["data_item_refs"] = dataItemRefs;
            }
            edges.push(edgeRecord);
        }

        // Project canvas-level data_items.
        const dataItems = this.projectCanvasDataItems(file.canvas.properties.value.get("data_items"));

        const result: Record<string, unknown> = { nodes, edges };
        if (dataItems.length > 0) {
            result["data_items"] = dataItems;
        }

        return JSON.stringify(result, null, 2);
    }

    /**
     * Projects the canvas data_items ListProperty to the minimal-format array.
     * Each ListProperty entry is a DictionaryProperty keyed by the item's guid.
     * @param prop
     *  The data_items property (may be undefined for legacy canvases).
     * @returns
     *  Array of minimal DataItem records.
     */
    private projectCanvasDataItems(prop: unknown): DataItem[] {
        if (!(prop instanceof ListProperty)) {
            return [];
        }
        const result: DataItem[] = [];
        for (const [guid, entry] of prop.value) {
            if (!(entry instanceof DictionaryProperty)) {
                continue;
            }
            const fields = entry.value;
            const parent = fields.get("parent")?.toJson();
            const identifier = fields.get("identifier")?.toJson();
            const name = fields.get("name")?.toJson();
            // Only emit items with the three required fields populated.
            // `typeof x === "string"` already excludes null (typeof null === "object").
            if (
                typeof parent !== "string" ||
                typeof identifier !== "string" ||
                typeof name !== "string"
            ) {
                console.warn(
                    `DfdPublisher: skipping data item ${guid} — required fields ` +
                    "(parent, identifier, name) are missing or not strings. " +
                    "This item will be dropped from the published output."
                );
                continue;
            }
            const item: DataItem = { guid, parent, identifier, name };
            const description = fields.get("description")?.toJson();
            if (typeof description === "string") {
                item.description = description;
            }
            const classification = fields.get("classification")?.toJson();
            if (typeof classification === "string") {
                item.classification = classification;
            }
            result.push(item);
        }
        return result;
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
