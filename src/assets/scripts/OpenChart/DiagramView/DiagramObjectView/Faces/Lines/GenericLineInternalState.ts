import type { LineStyle } from "../Styles";
import type { DiagramObjectView } from "../../Views";

export interface GenericLineInternalState {

    /**
     * The line's style.
     */
    style: LineStyle;

    /**
     * The line's grid.
     */
    grid: [number, number];

    /**
     * The line's points.
     */
    points: DiagramObjectView[];

    /**
     * The line's vertices.
     */
    vertices: number[];

    /**
     * The line's arrow head shape at node1 end (when data flows node2 → node1).
     */
    arrowAtNode1: number[] | null;

    /**
     * The line's arrow head shape at node2 end (when data flows node1 → node2).
     */
    arrowAtNode2: number[] | null;

    /**
     * The line's hitboxes.
     */
    hitboxes: number[][];

}
