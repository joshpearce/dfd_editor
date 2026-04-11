import {
    ClearHover,
    HoverObject,
    RestoreGroupBounds,
    RouteLinesThroughBlock,
    MoveObjectsBy,
    MoveObjectsTo,
    ResizeGroupBy,
    SetTangibility,
    UserSetObjectPosition
} from "./index.commands";
import type { GroupBoundsSnapshot } from "./index.commands";
import type { BlockView, CanvasView, DiagramObjectView, GroupView, LineView, ResizeEdge } from "@OpenChart/DiagramView";

export type { GroupBoundsSnapshot };


///////////////////////////////////////////////////////////////////////////////
//  1. Hover  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Clears the hover state on an object and its descendants.
 * @param object
 *  The object.
 * @returns
 *  A command that represents the action.
 */
export function clearHover(
    object: DiagramObjectView
): ClearHover {
    return new ClearHover(object);
}

/**
 * Sets an object's hover state.
 * @param object
 *  The object to hover.
 * @param state
 *  The object's hover state.
 * @returns
 *  A command that represents the action.
 */
export function hoverObject(
    object: DiagramObjectView,
    state: boolean
): HoverObject {
    return new HoverObject(object, state);
}

/**
 * Sets a object's tangibility.
 * @param object
 *  The object to configure.
 * @param tangibility
 *  The object's tangibility.
 * @returns
 *  A command that represents the action.
 */
export function setTangibility(
    object: DiagramObjectView, tangibility: number
): SetTangibility {
    return new SetTangibility(object, tangibility);
}

/**
 * Routes a set of lines through a block.
 * @param group
 *  The block's group.
 * @param block
 *  The block.
 * @param lines
 *  The lines.
 * @returns
 *  A command that represents the action.
 */
export function routeLinesThroughBlock(
    group: CanvasView | GroupView, block: BlockView, lines: LineView[]
) {
    return new RouteLinesThroughBlock(group, block, lines);
}


///////////////////////////////////////////////////////////////////////////////
//  2. Movement ///////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Moves one or more objects relative to their current position.
 * @param object
 *  The object(s) to move.
 * @param dx
 *  The change in x.
 * @param dy
 *  The change in y.
 * @returns
 *  A command that represents the action.
 */
export function moveObjectsBy(
    object: DiagramObjectView | DiagramObjectView[], dx: number, dy: number
): MoveObjectsBy {
    return new MoveObjectsBy(object, dx, dy);
}

/**
 * Moves one or more objects to a specific coordinate.
 * @param object
 *  The object(s) to move.
 * @param x
 *  The x coordinate.
 * @param y
 *  The y coordinate.
 * @returns
 *  A command that represents the action.
 */
export function moveObjectsTo(
    object: DiagramObjectView | DiagramObjectView[], x: number, y: number
): MoveObjectsTo {
    return new MoveObjectsTo(object, x, y);
}

/**
 * Resizes a group by shifting one or more of its edges.
 * @param group
 *  The group to resize.
 * @param edge
 *  The edge bitmask identifying which sides (or corners) to move.
 * @param dx
 *  The desired change in x.
 * @param dy
 *  The desired change in y.
 * @returns
 *  A command that represents the action.
 */
export function resizeGroupBy(
    group: GroupView, edge: ResizeEdge, dx: number, dy: number
): ResizeGroupBy {
    return new ResizeGroupBy(group, edge, dx, dy);
}

/**
 * Records a set of group-bounds snapshots so a subsequent undo can
 * restore them. The returned command is a no-op on execute; its only
 * effect is on {@link RestoreGroupBounds.undo}. Intended to be emitted
 * as the first command of a drag stream so its undo runs last.
 * @param snapshots
 *  The groups and bounds to restore on undo.
 * @returns
 *  A command that represents the action.
 */
export function restoreGroupBounds(
    snapshots: ReadonlyArray<GroupBoundsSnapshot>
): RestoreGroupBounds {
    return new RestoreGroupBounds(snapshots);
}

/**
 * Declares that an object's position was set by the user.
 * @param object
 *  The object.
 * @returns
 *  A command that represents the action.
 */
export function userSetObjectPosition(
    object: DiagramObjectView
): UserSetObjectPosition {
    return new UserSetObjectPosition(object);
}
