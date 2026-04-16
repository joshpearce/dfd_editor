import { traverse } from "@OpenChart/DiagramModel";
import type { GroupBoundsMap } from "./GroupBoundsMap";
import { GroupView, type DiagramObjectView } from "../../DiagramObjectView";
import type { DiagramLayoutEngine } from "../DiagramLayoutEngine";

/**
 * Persistence engine for user-set group bounds.
 *
 * Walks the view tree and either records or restores the
 * `[xMin, yMin, xMax, yMax]` four-tuple for every {@link GroupView}.
 * Every group is persisted unconditionally — unlike positions (where
 * multiple layout engines can compete and a `userSetBy` flag guards
 * which engine wins), group bounds have a single source of truth: user
 * resize plus `calculateLayout`'s auto-grow. A flag would be pure
 * overhead with no correctness benefit.
 */
export class GroupBoundsEngine implements DiagramLayoutEngine {

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
    public async run(objects: DiagramObjectView[]): Promise<void> {
        for (const object of traverse(objects)) {
            if (!(object instanceof GroupView)) {
                continue;
            }
            const bounds = this.bounds[object.instance];
            if (!bounds) {
                continue;
            }
            object.face.setBounds(bounds[0], bounds[1], bounds[2], bounds[3]);
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
