import type { SemanticGraphNode } from "./SemanticGraphNode";

export interface SemanticGraphEdgeInternalState {

    /**
     * The edge's node1 (first node endpoint).
     */
    _node1: SemanticGraphNode | null;

    /**
     * The node1 anchor's position.
     */
    _node1Via: string | null;

    /**
     * The edge's node2 (second node endpoint).
     */
    _node2: SemanticGraphNode | null;

    /**
     * The node2 anchor's position.
     */
    _node2Via: string | null;

}
