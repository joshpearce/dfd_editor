import type { GroupBoundsMap, PositionMap } from "./DiagramLayoutEngine";
import type { CameraLocation } from "./CameraLocation";
import type { DiagramModelExport } from "@OpenChart/DiagramModel";

export type DiagramViewExport = DiagramModelExport & {

    /**
     * The diagram's theme.
     */
    theme?: string;

    /**
     * The diagram's camera location.
     */
    camera?: CameraLocation;

    /**
     * The diagram's layout.
     */
    layout?: PositionMap;

    /**
     * The diagram's group bounds.
     */
    groupBounds?: GroupBoundsMap;

};
