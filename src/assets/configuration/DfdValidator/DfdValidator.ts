import { FileValidator } from "@/assets/scripts/Application";
import { DiagramModelFile, SemanticAnalyzer } from "@OpenChart/DiagramModel";
import type { SemanticGraphEdge, SemanticGraphNode } from "@OpenChart/DiagramModel";

class DfdValidator extends FileValidator {

    protected validate(file: DiagramModelFile): void {
        const graph = SemanticAnalyzer.toGraph(file.canvas);

        for (const [instance, node] of graph.nodes) {
            this.validateNode(instance, node);
        }

        for (const [id, edge] of graph.edges) {
            this.validateEdge(id, edge);
        }
    }

    private validateNode(instance: string, node: SemanticGraphNode): void {
        // Validate required fields
        for (const [key, prop] of node.props.value) {
            const metadata = prop.metadata?.validator ?? {};
            if (metadata.is_required && !prop.isDefined()) {
                this.addError(instance, `Missing required field: '${key}'`);
            }
        }
    }

    private validateEdge(id: string, edge: SemanticGraphEdge): void {
        if (!(edge.source && edge.target)) {
            this.addWarning(id, "Data flow should connect on both ends.");
        }
    }

}

export default DfdValidator;
