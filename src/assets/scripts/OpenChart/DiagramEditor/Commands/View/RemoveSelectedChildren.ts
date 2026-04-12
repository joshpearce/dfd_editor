import { HoverObject } from "./HoverObject";
import { GroupCommand } from "../GroupCommand";
import { SelectObjects } from "./SelectObjects";
import { removeObjectFromGroup } from "../Model";
import { traverse } from "@OpenChart/DiagramModel";
import type { CanvasView, DiagramObjectView } from "@OpenChart/DiagramView";

export class RemoveSelectedChildren extends GroupCommand {

    /**
     * Removes all selected objects from a canvas.
     * @param canvas
     *  The canvas.
     */
    constructor(canvas: CanvasView) {
        super();
        // Collect all focused objects anywhere in the canvas tree. The original
        // `canvas.objects` only yields direct children, which misses blocks (and
        // other objects) that live inside a trust boundary (GroupView).
        const objects = [...traverse(canvas, o => o.focused)] as DiagramObjectView[];
        // Clear hover
        for (const obj of objects) {
            this.do(new HoverObject(obj, false));
        }
        // Clear selection
        const all = [...canvas.objects];
        this.do(new SelectObjects(objects, false, true));
        this.do(new SelectObjects(all, false, false));
        // Remove children, grouped by immediate parent. RemoveObjectFromGroup
        // requires all objects in a single call to share the same parent.
        const byParent = new Map<string, DiagramObjectView[]>();
        for (const obj of objects) {
            const parentId = obj.parent?.instance;
            if (!parentId) { continue; }
            if (!byParent.has(parentId)) {
                byParent.set(parentId, []);
            }
            byParent.get(parentId)!.push(obj);
        }
        for (const group of byParent.values()) {
            this.do(removeObjectFromGroup(group));
        }
    }

}
