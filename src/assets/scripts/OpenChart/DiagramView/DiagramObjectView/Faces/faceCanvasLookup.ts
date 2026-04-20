/**
 * @file faceCanvasLookup.ts
 *
 * Shared helper for walking a view's parent chain to find the nearest Canvas
 * ancestor.  Extracted so that line faces (e.g. LabeledDynamicLine) and block
 * faces (DictionaryBlock) share the same walk without duplicating code.
 *
 * No DiagramView or DOM imports — safe to use in any Face context.
 */

import { Canvas } from "@OpenChart/DiagramModel";
import type { DiagramObjectView } from "../Views";

/**
 * Walks the view's parent chain and returns the first {@link Canvas} ancestor.
 * Returns `null` when the view is not yet attached to a canvas (e.g. during a
 * clone that hasn't been grafted into the tree).
 *
 * The walk is O(depth) — typically 2–4 hops for objects inside at most one or
 * two trust-boundary groups.
 *
 * @param view  The view to start the walk from.
 */
export function findCanvas(view: DiagramObjectView): Canvas | null {
    let cursor: DiagramObjectView | null = view;
    while (cursor !== null) {
        if (cursor instanceof Canvas) {
            return cursor;
        }
        cursor = cursor.parent;
    }
    return null;
}
