import { LatchView } from "./Views";
import { PolyLineSpanView } from "./Faces/Lines/PolyLineSpanView";
import { Tangibility } from "./ViewAttributes";
import type { CanvasView, DiagramObjectView, GroupView, HitTarget } from "./Views";

/**
 * Finds and returns the topmost view within a given set of views at the
 * specified coordinates.
 *
 * The return type is {@link HitTarget} so that callers passing arrays that
 * include {@link LineView} instances (e.g. via `view.objects`) receive
 * {@link PolyLineSpanView} hits intact rather than having them silently
 * swallowed.
 *
 * @param views
 *  The views to search.
 * @param x
 *  The x coordinate.
 * @param y
 *  The y coordinate.
 * @returns
 *  The topmost view. `undefined` if there isn't one.
 */
export function findObjectAt(views: DiagramObjectView[], x: number, y: number): HitTarget | undefined {
    let select: HitTarget | undefined;
    for (let i = views.length - 1; 0 <= i; i--) {
        const view = views[i];
        const object = view.getObjectAt(x, y);
        if (!object) {
            continue;
        }
        // PolyLineSpanView has no tangibility field — treat it like a
        // non-priority DiagramObjectView (it never claims priority).
        if (object instanceof PolyLineSpanView || object.tangibility !== Tangibility.Priority) {
            select ??= object;
        } else {
            return object;
        }
    }
    return select;
}

/**
 * Finds and returns the topmost unlinked view within a given set of views at
 * the specified coordinates.
 *
 * The return type is {@link HitTarget} so that callers passing arrays that
 * include {@link LineView} instances (e.g. via `view.objects`) receive
 * {@link PolyLineSpanView} hits intact rather than having them silently
 * swallowed.
 *
 * @param views
 *  The views to search.
 * @param x
 *  The x coordinate.
 * @param y
 *  The y coordinate.
 * @returns
 *  The topmost unlinked view. `undefined` if there isn't one.
 */
export function findUnlinkedObjectAt(views: DiagramObjectView[], x: number, y: number): HitTarget | undefined {
    let select: HitTarget | undefined;
    for (let i = views.length - 1; 0 <= i; i--) {
        const view = views[i];
        // If linked latch, skip
        if (view instanceof LatchView && view.isLinked()) {
            continue;
        }
        const object = view.getObjectAt(x, y);
        if (!object) {
            continue;
        }
        // PolyLineSpanView has no tangibility field — treat it like a
        // non-priority DiagramObjectView (it never claims priority).
        if (object instanceof PolyLineSpanView || object.tangibility !== Tangibility.Priority) {
            select ??= object;
        } else {
            return object;
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
 * Returns the lowest (deepest) common container of two views — the innermost
 * `CanvasView | GroupView` that contains both `a` and `b` in its subtree via
 * the parent chain.
 *
 * For two views whose common ancestor is the canvas root, returns the
 * `CanvasView`. Returns `null` only when the two views belong to disjoint
 * trees with no shared ancestor (should not occur in a well-formed diagram).
 *
 * Implementation: collects `a`'s parent chain into a Set, then walks `b`'s
 * parent chain and returns the first element already in the set. O(depth)
 * memory and time.
 *
 * @param a - First view.
 * @param b - Second view.
 * @returns
 *  The lowest common container, or `null` if the two views are in disjoint
 *  trees.
 */
export function findLowestCommonContainer(
    a: DiagramObjectView,
    b: DiagramObjectView
): CanvasView | GroupView | null {
    const aAncestors = new Set<DiagramObjectView>();
    let current: DiagramObjectView | null = a.parent;
    while (current !== null) {
        aAncestors.add(current);
        current = current.parent;
    }
    current = b.parent;
    while (current !== null) {
        if (aAncestors.has(current)) {
            return current as CanvasView | GroupView;
        }
        current = current.parent;
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
