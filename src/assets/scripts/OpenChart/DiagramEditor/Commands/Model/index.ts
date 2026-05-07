import {
    AddGroupToGroup,
    AddHandleToLine,
    AddObjectToGroup,
    AttachLatchToAnchor,
    DetachLatchFromAnchor,
    RemoveHandleFromLine,
    RemoveObjectFromGroup,
    ReparentObject
} from "./index.commands";
import type { Latch, Anchor, DiagramObject, Group } from "@OpenChart/DiagramModel";
import type { LineView } from "@OpenChart/DiagramView/DiagramObjectView/Views/LineView";

///////////////////////////////////////////////////////////////////////////////
//  1. Handles  ///////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Adds a handle to a line at a specific index.
 * @param line
 *  The line. Must have at least one existing handle (index 0) to clone.
 * @param x
 *  The x coordinate of the new handle.
 * @param y
 *  The y coordinate of the new handle.
 * @param atIndex
 *  The index at which to insert the handle.
 * @returns
 *  A command that represents the action.
 */
export function addHandleToLine(
    line: LineView, x: number, y: number, atIndex: number
): AddHandleToLine {
    return new AddHandleToLine(line, x, y, atIndex);
}

/**
 * Removes a handle from a line at a specific index.
 * @param line
 *  The line.
 * @param atIndex
 *  The index of the handle to remove.
 * @returns
 *  A command that represents the action.
 */
export function removeHandleFromLine(
    line: LineView, atIndex: number
): RemoveHandleFromLine {
    return new RemoveHandleFromLine(line, atIndex);
}


///////////////////////////////////////////////////////////////////////////////
//  2. Anchors  ///////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Attaches a latch to an anchor.
 * @param latch
 *  The latch.
 * @param anchor
 *  The anchor.
 * @returns
 *  A command that represents the action.
 */
export function attachLatchToAnchor(
    latch: Latch, anchor: Anchor
): AttachLatchToAnchor {
    return new AttachLatchToAnchor(latch, anchor);
}

/**
 * Detaches a latch from its anchor.
 * @param object
 *  The latch.
 * @returns
 *  A command that represents the action.
 */
export function detachLatchFromAnchor(
    latch: Latch
): DetachLatchFromAnchor {
    return new DetachLatchFromAnchor(latch);
}


///////////////////////////////////////////////////////////////////////////////
//  3. Groups  ////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Adds a diagram object to a group.
 * @param object
 *  The diagram object.
 * @param group
 *  The group.
 * @returns
 *  A command that represents the action.
 */
export function addObjectToGroup(
    object: DiagramObject, group: Group
): AddObjectToGroup {
    return new AddObjectToGroup(object, group);
}

/**
 * Adds a diagram group to a group.
 * @param sourceGroup
 *  The source group.
 * @param targetGroup
 *  The target group.
 * @returns
 *  A command that represents the action.
 */
export function addGroupToGroup(
    sourceGroup: Group, targetGroup: Group
): AddGroupToGroup {
    return new AddGroupToGroup(sourceGroup, targetGroup);
}

/**
 * Removes one or more objects from their parent object.
 * @remarks
 *  Do NOT perform more than one `RemoveObjectFromGroup` in a single
 *  transaction. If removals are broken into separate requests, their
 *  mutual dependencies can't be determined. This may cause `undo()` and
 *  `redo()` to break as they can no longer reconstruct the objects and
 *  dependencies correctly.
 * @param objects
 *  The objects to remove from their parents.
 * @returns
 *  A command that represents the action.
 */
export function removeObjectFromGroup(
    objects: DiagramObject[]
): RemoveObjectFromGroup {
    return new RemoveObjectFromGroup(objects);
}

/**
 * Moves a diagram object from its current parent to a new group without
 * severing external anchor/latch connections.
 * @param object
 *  The object to reparent.
 * @param toGroup
 *  The group to move the object into.
 * @returns
 *  A command that represents the action.
 */
export function reparentObject(
    object: DiagramObject, toGroup: Group
): ReparentObject {
    return new ReparentObject(object, toGroup);
}
