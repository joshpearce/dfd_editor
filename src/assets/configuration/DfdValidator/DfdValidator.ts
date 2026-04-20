import { FileValidator } from "@/assets/scripts/Application";
import { DiagramModelFile, ListProperty, SemanticAnalyzer } from "@OpenChart/DiagramModel";
import type { Canvas, SemanticGraphEdge, SemanticGraphNode } from "@OpenChart/DiagramModel";

const PRIVILEGE_RANK: Record<string, number> = {
    internet: 0,
    dmz: 1,
    corporate: 2,
    restricted: 3
};

function privilegeRankOf(node: SemanticGraphNode): number {
    const ancestors = node.trustBoundaryAncestors;
    if (ancestors.length === 0) { return -1; }
    const level = ancestors[0].props.value.get("privilege_level")?.toJson();
    return (typeof level === "string" ? PRIVILEGE_RANK[level] : undefined) ?? -1;
}

class DfdValidator extends FileValidator {

    protected validate(file: DiagramModelFile): void {
        const graph = SemanticAnalyzer.toGraph(file.canvas);
        const knownDataItemGuids = this.collectDataItemGuids(file.canvas);

        for (const [instance, node] of graph.nodes) {
            this.validateNode(instance, node);
        }

        for (const [instance, node] of graph.nodes) {
            if (node.id === "trust_boundary") {
                this.validateBoundary(instance, node);
            }
        }

        for (const [id, edge] of graph.edges) {
            this.validateEdge(id, edge);
            this.validateDataItemRefs(id, edge, knownDataItemGuids);
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

    private validateBoundary(instance: string, node: SemanticGraphNode): void {
        // C5: empty boundary
        if (node.children.length === 0) {
            this.addWarning(instance, "Trust boundary has no child objects.");
        }
        // C4: out-of-scope external entity in restricted zone.
        // Note: only checks direct children; entities nested inside an inner
        // boundary that is itself inside this restricted boundary are not caught.
        if (node.props.value.get("privilege_level")?.toJson() === "restricted") {
            for (const child of node.children) {
                if (
                    child.id === "external_entity" &&
                    child.props.value.get("out_of_scope")?.toJson() === "true"
                ) {
                    this.addWarning(
                        child.instance,
                        "Out-of-scope external entity is inside a restricted trust boundary."
                    );
                }
            }
        }
    }

    /**
     * Collects all data-item GUIDs declared in the canvas's `data_items`
     * ListProperty.  Returns an empty Set for legacy diagrams that have no
     * such property.
     */
    private collectDataItemGuids(canvas: Canvas): Set<string> {
        const guids = new Set<string>();
        const dataItemsProp = canvas.properties.value.get("data_items");
        if (!(dataItemsProp instanceof ListProperty)) {
            return guids;
        }
        for (const [guid] of dataItemsProp.value) {
            guids.add(guid);
        }
        return guids;
    }

    /**
     * Warns when a flow's `data_item_refs` list contains a GUID that doesn't
     * correspond to any canvas data item.  Does not block save/publish.
     */
    private validateDataItemRefs(
        id: string,
        edge: SemanticGraphEdge,
        knownGuids: Set<string>
    ): void {
        if (knownGuids.size === 0) {
            // No data items defined — nothing to check.
            return;
        }
        const refsProp = edge.props.value.get("data_item_refs");
        if (!(refsProp instanceof ListProperty)) {
            return;
        }
        for (const [, entry] of refsProp.value) {
            const val = entry.toJson();
            if (typeof val === "string" && val.length > 0 && !knownGuids.has(val)) {
                this.addWarning(
                    id,
                    `Data flow references unknown data item '${val}'.`
                );
            }
        }
    }

    private validateEdge(id: string, edge: SemanticGraphEdge): void {
        if (!(edge.source && edge.target)) {
            this.addWarning(id, "Data flow should connect on both ends.");
        }
        if (edge.crossings.length > 0) {
            if (edge.props.value.get("authenticated")?.toJson() === "false") {
                this.addWarning(id,
                    "Data flow crosses a trust boundary but is not authenticated.");
            }
            if (edge.props.value.get("encrypted_in_transit")?.toJson() === "false") {
                this.addWarning(id,
                    "Data flow crosses a trust boundary but is not encrypted in transit.");
            }
            const classification = edge.props.value.get("data_classification")?.toJson();
            if (classification === "secret" || classification === "confidential") {
                const sourceRank = privilegeRankOf(edge.source!);
                const targetRank = privilegeRankOf(edge.target!);
                if (sourceRank > targetRank) {
                    this.addWarning(id,
                        "High-classification data flow exits into a less-privileged trust zone.");
                }
            }
        }
    }

}

export default DfdValidator;
