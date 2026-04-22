import type { SemanticGraphNode } from "./SemanticGraphNode";
import type { DiagramObject, RootProperty } from "../DiagramObject";

export class SemanticGraphEdge {

    /**
     * The object's id.
     */
    public id: string;

    /**
     * The object's properties.
     */
    public props: RootProperty;

    /**
     * Trust-boundary nodes this edge crosses (symmetric difference of
     * source and target trustBoundaryAncestors). Empty for unbound edges
     * or edges fully contained within shared ancestry.
     * Set by SemanticAnalyzer.toGraph.
     */
    public crossings: SemanticGraphNode[] = [];

    /**
     * The edge's node1 (first node endpoint).
     */
    private _node1: SemanticGraphNode | null;

    /**
     * The node1 anchor's position.
     */
    private _node1Via: string | null;

    /**
     * The edge's node2 (second node endpoint).
     */
    private _node2: SemanticGraphNode | null;

    /**
     * The node2 anchor's position.
     */
    private _node2Via: string | null;


    /**
     * The edge's node1 (first node endpoint).
     */
    public get node1(): SemanticGraphNode | null {
        return this._node1;
    }

    /**
     * The node1 anchor's position.
     */
    public get node1Via(): string | null {
        return this._node1Via;
    }

    /**
     * The edge's node2 (second node endpoint).
     */
    public get node2(): SemanticGraphNode | null {
        return this._node2;
    }

    /**
     * The node2 anchor's position.
     */
    public get node2Via(): string | null {
        return this._node2Via;
    }


    /**
     * Creates a new {@link SemanticGraphNode}.
     * @param object
     *  The node object.
     */
    constructor(object: DiagramObject) {
        this.id = object.id;
        this.props = object.properties;
        this._node1 = null;
        this._node2 = null;
        this._node1Via = null;
        this._node2Via = null;
    }

}
