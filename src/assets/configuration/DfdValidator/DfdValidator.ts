import { FileValidator } from "@/assets/scripts/Application";
import { DiagramModelFile, SemanticAnalyzer } from "@OpenChart/DiagramModel";
import { readDataItems, readFlowRefs } from "@OpenChart/DiagramModel/DataItemLookup";
import type { Canvas, SemanticGraphEdge, SemanticGraphNode } from "@OpenChart/DiagramModel";

class DfdValidator extends FileValidator {

    protected validate(file: DiagramModelFile): void {
        const graph = SemanticAnalyzer.toGraph(file.canvas);
        const knownDataItemGuids = this.collectDataItemGuids(file.canvas);

        this.validateDataItemFields(file.canvas);

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
     * property.  Returns an empty Set for legacy diagrams that have no
     * such property.
     *
     * Delegates to {@link readDataItems} to avoid duplicating the
     * ListProperty-iteration pattern.
     */
    private collectDataItemGuids(canvas: Canvas): Set<string> {
        return new Set(readDataItems(canvas).map(i => i.guid));
    }

    /**
     * Warns when a canvas data item is missing a required field (`parent`,
     * `identifier`, or `name`).  Does not block save/publish — the item is
     * still persisted and published with its partial state.
     *
     * @param canvas  The diagram canvas to inspect.
     */
    private validateDataItemFields(canvas: Canvas): void {
        for (const item of readDataItems(canvas)) {
            const missingFields: string[] = [];
            if (!item.parent)     { missingFields.push("parent"); }
            if (!item.identifier) { missingFields.push("identifier"); }
            if (!item.name)       { missingFields.push("name"); }
            if (missingFields.length > 0) {
                this.addWarning(
                    item.guid,
                    `Data item is missing required field(s): ${missingFields.join(", ")}.`
                );
            }
        }
    }

    /**
     * Warns when a flow's directional ref arrays contain GUIDs that don't
     * correspond to any canvas data item (AC5.2). Does not block save/publish.
     *
     * Per AC5.3, empty-both-sides flows do NOT warn. AC5.2 requires warnings
     * to include the direction key name so the user can identify which direction
     * is dangling.
     *
     * NOTE: the early-return for `knownGuids.size === 0` was intentionally
     * removed.  A flow that holds refs when the canvas has zero data items is
     * a dangling-ref condition that should warn — the canvas may have had items
     * that were later deleted.
     */
    private validateDataItemRefs(
        id: string,
        edge: SemanticGraphEdge,
        knownGuids: Set<string>
    ): void {
        const flowRefs = readFlowRefs(edge.props);

        // Warn per-direction with the direction key in the message (AC5.2).
        for (const guid of flowRefs.node1ToNode2) {
            if (!knownGuids.has(guid)) {
                this.addWarning(
                    id,
                    `Data flow references unknown data item '${guid}' (direction: node1_src_data_item_refs).`
                );
            }
        }
        for (const guid of flowRefs.node2ToNode1) {
            if (!knownGuids.has(guid)) {
                this.addWarning(
                    id,
                    `Data flow references unknown data item '${guid}' (direction: node2_src_data_item_refs).`
                );
            }
        }
    }

    private validateEdge(id: string, edge: SemanticGraphEdge): void {
        if (!(edge.node1 && edge.node2)) {
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
        }
    }

}

export default DfdValidator;
