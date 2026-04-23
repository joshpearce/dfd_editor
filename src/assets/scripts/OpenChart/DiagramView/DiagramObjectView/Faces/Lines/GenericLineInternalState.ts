import type { LineStyle } from "../Styles";
import type { DiagramObjectView } from "../../Views";
import type { PolyLineSpanView } from "./PolyLineSpanView";

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

    /**
     * Axis-aligned interior spans built by {@link PolyLine.calculateLayout}.
     * Only populated on `PolyLine` instances — `DynamicLine` leaves this
     * undefined.  Tests access it via the `as unknown as GenericLineInternalState`
     * cast pattern to avoid duplicating the cast on a per-test basis.
     */
    spans?: PolyLineSpanView[];

}
