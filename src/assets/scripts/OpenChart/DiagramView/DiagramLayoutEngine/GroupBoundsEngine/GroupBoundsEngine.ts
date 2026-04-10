import { traverse } from "@OpenChart/DiagramModel";
import type { GroupBoundsMap } from "./GroupBoundsMap";
import { GroupView, type DiagramObjectView } from "../../DiagramObjectView";

export class GroupBoundsEngine {

    /**
     * The engine's bounds map.
     */
    private bounds: GroupBoundsMap;


    /**
     * Creates a new {@link GroupBoundsEngine}.
     * @param bounds
     *  The engine's bounds map.
     */
    constructor(bounds: GroupBoundsMap) {
        this.bounds = bounds;
    }


    /**
     * Runs the bounds engine on a set of objects.
     * @param objects
     *  The objects.
     */
    public run(objects: DiagramObjectView[]): void {
        for (const object of traverse(objects)) {
            if (!(object instanceof GroupView)) {
                continue;
            }
            const bounds = this.bounds[object.instance];
            if (!bounds) {
                continue;
            }
            object.face.setBounds(bounds[0], bounds[1], bounds[2], bounds[3]);
            object.face.calculateLayout();
        }
    }


    /**
     * Generates a {@link GroupBoundsMap} from a list of objects.
     * @param objects
     *  The objects.
     * @returns
     *  The {@link GroupBoundsMap}.
     */
    public static generateGroupBoundsMap(objects: DiagramObjectView[]): GroupBoundsMap {
        const map: GroupBoundsMap = {};
        for (const object of traverse(objects)) {
            if (object instanceof GroupView) {
                map[object.instance] = object.face.userBounds;
            }
        }
        return map;
    }

}
