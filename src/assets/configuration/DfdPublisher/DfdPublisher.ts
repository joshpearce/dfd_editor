import { DiagramModelFile, SemanticAnalyzer } from "@OpenChart/DiagramModel";
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
            edges.push({
                id,
                source: edge.source?.instance ?? null,
                target: edge.target?.instance ?? null,
                crosses: edge.crossings.map(n => n.instance)
            });
        }

        return JSON.stringify({ nodes, edges }, null, 2);
    }

    /**
     * Returns the publisher's file extension.
     */
    public getFileExtension(): string {
        return "json";
    }

}

export default DfdPublisher;
