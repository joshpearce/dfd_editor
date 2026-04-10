import { LatchView } from "./Views";
import { Tangibility } from "./ViewAttributes";
import type { CanvasView, DiagramObjectView, GroupView } from "./Views";

/**
 * Finds and returns the topmost view within a given set of views at the
 * specified coordinates.
 * @param views
 *  The views to search.
 * @param x
 *  The x coordinate.
 * @param y
 *  The y coordinate.
 * @returns
 *  The topmost view. `undefined` if there isn't one.
 */
export function findObjectAt(views: DiagramObjectView[], x: number, y: number): DiagramObjectView | undefined {
    let select = undefined;
    let object = undefined;
    for (let i = views.length - 1; 0 <= i; i--) {
        const view = views[i];
        // If no object, skip
        if (!(object = view.getObjectAt(x, y))) {
            continue;
        }
        // Update selection
        if (object?.tangibility === Tangibility.Priority) {
            return object;
        } else {
            select ??= object;
        }
    }
    return select;
}

/**
 * Finds and returns the topmost unlinked view within a given set of views at
 * the specified coordinates.
 * @param views
 *  The views to search.
 * @param x
 *  The x coordinate.
 * @param y
 *  The y coordinate.
 * @returns
 *  The topmost unlinked view. `undefined` if there isn't one.
 */
export function findUnlinkedObjectAt(views: DiagramObjectView[], x: number, y: number): DiagramObjectView | undefined {
    let select = undefined;
    let object = undefined;
    for (let i = views.length - 1; 0 <= i; i--) {
        const view = views[i];
        // If linked latch, skip
        if (view instanceof LatchView && view.isLinked()) {
            continue;
        }
        // If no object, skip
        if (!(object = view.getObjectAt(x, y))) {
            continue;
        }
        // Update selection
        if (object?.tangibility === Tangibility.Priority) {
            return object;
        } else {
            select ??= object;
        }
    }
    return select;
}

/**
 * Walks a container's group tree and returns the deepest (innermost) group
 * whose bounding box contains `(x, y)`. Iteration is in draw order (topmost
 * sibling first), so overlapping siblings are disambiguated by z-order.
 *
 * Used by reparent-on-drop and spawn-into-deepest-group logic.
 *
 * @param root
 *  The root container to walk (usually the canvas).
 * @param x
 *  The x coordinate in diagram space.
 * @param y
 *  The y coordinate in diagram space.
 * @param exclude
 *  Optional. If provided, this group and any of its descendants are
 *  skipped. Needed when reparenting a group so it doesn't become its own
 *  ancestor.
 * @returns
 *  The deepest containing {@link GroupView}, or `null` if nothing (other
 *  than `root` itself) contains the point.
 */
export function findDeepestContainingGroup(
    root: CanvasView | GroupView,
    x: number, y: number,
    exclude?: GroupView
): GroupView | null {
    const groups = root.groups;
    for (let i = groups.length - 1; 0 <= i; i--) {
        const g = groups[i] as GroupView;
        if (exclude && (g === exclude || isDescendantOf(g, exclude))) {
            continue;
        }
        if (!g.face.boundingBox.contains(x, y)) {
            continue;
        }
        const deeper = findDeepestContainingGroup(g, x, y, exclude);
        return deeper ?? g;
    }
    return null;
}

/**
 * Returns true if `candidate` is a descendant of `ancestor` in the parent
 * chain (i.e. walking `candidate.parent` upward eventually hits `ancestor`).
 */
function isDescendantOf(candidate: GroupView, ancestor: GroupView): boolean {
    let current = candidate.parent as GroupView | null;
    while (current) {
        if (current === ancestor) {
            return true;
        }
        current = current.parent as GroupView | null;
    }
    return false;
}
