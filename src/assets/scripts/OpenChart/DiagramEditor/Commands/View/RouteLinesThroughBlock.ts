import { distance } from "@OpenChart/Utilities";
import { GroupCommand } from "../GroupCommand";
import { MoveObjectsTo } from "./MoveObjectsTo";
import { AnchorView, findLowestCommonContainer, GroupView, Orientation } from "@OpenChart/DiagramView";
import { AddObjectToGroup, AttachLatchToAnchor } from "../Model/index.commands";
import type { BlockView, CanvasView, DiagramObjectView, LatchView, LineView } from "@OpenChart/DiagramView";

export class RouteLinesThroughBlock extends GroupCommand {

    /**
     * Routes a set of lines through a block.
     * @param group
     *  The block's group.
     * @param block
     *  The block.
     * @param lines
     *  The lines.
     */
    constructor(group: CanvasView | GroupView, block: BlockView, lines: LineView[]) {
        super();
        for (const line of lines) {
            if (line.node1Object === block || line.node2Object === block) {
                continue;
            }
            const oSource = line.node1.anchor;
            const oTarget = line.node2.anchor;
            const [nTarget, nSource] = this.getBestAnchors(block, line);
            // Connect source
            if (oTarget && !oSource) {
                this.do(new AttachLatchToAnchor(line.node1, nSource));
                this.do(new MoveObjectsTo(line.node1, nSource.x, nSource.y));
            }
            // Connect target
            else if (!oTarget && oSource) {
                this.do(new AttachLatchToAnchor(line.node2, nTarget));
                this.do(new MoveObjectsTo(line.node2, nTarget.x, nTarget.y));
            }
            // Route line
            else if (oTarget && oSource) {
                this.do(new AttachLatchToAnchor(line.node2, nTarget));
                this.do(new MoveObjectsTo(line.node2, nTarget.x, nTarget.y));
                const clone = line.clone();
                const cloneContainer = findLowestCommonContainer(block, oTarget.parent as DiagramObjectView) ?? group;
                this.do(new AddObjectToGroup(clone, cloneContainer));
                this.do(new MoveObjectsTo(clone.node1, nSource.x, nSource.y));
                this.do(new MoveObjectsTo(clone.node2, oTarget.x, oTarget.y));
                this.do(new AttachLatchToAnchor(clone.node1, nSource));
                this.do(new AttachLatchToAnchor(clone.node2, oTarget));
                // Update layout
                // TODO: Run layout engine
            }
        }
    }

    /**
     * Returns the best anchors from `block` to route `line` through.
     * @param block
     *  The block.
     * @param line
     *  The line.
     * @returns
     *  The best [target, source] anchors.
     */
    private getBestAnchors(block: BlockView, line: LineView): [AnchorView, AnchorView] {
        const b1 = block.face.boundingBox;
        let target: AnchorView | undefined = undefined;
        let source: AnchorView | undefined = undefined;
        if (!line.node1.face.boundingBox.inside(b1)) {
            target = this.getNearestAnchor(block, line.node1);
        } else {
            target = this.getBestAnchor(block, line.node1, line.node2);
        }
        if (!line.node2.face.boundingBox.inside(b1)) {
            source = this.getNearestAnchor(block, line.node2);
        } else {
            source = this.getBestAnchor(block, line.node2, line.node1);
        }
        return [target, source];
    }

    /**
     * Returns the best anchor from `block` to link a line's `latch` to.
     * @param block
     *  The block.
     * @param latch
     *  The line's latch.
     * @param reference
     *  The line's opposing latch.
     * @returns
     *  The best anchor from `block`.
     */
    private getBestAnchor(block: BlockView, latch: LatchView, reference: LatchView) {
        const bb = block.face.boundingBox;
        // Resolve coordinates
        let x: number, y: number;
        switch (latch.orientation) {
            case Orientation.D0:
                x = latch.x <= reference.x ? bb.xMin : bb.xMax;
                y = latch.y;
                break;
            default:
            case Orientation.D90:
                x = latch.x;
                y = latch.y <= reference.y ? bb.yMin : bb.yMax;
                break;
        }
        return this.getNearestAnchor(block, { x, y });
    }

    /**
     * Returns the anchor from `block` that's nearest to `point`.
     * @param block
     *  The block.
     * @param point
     *  The point.
     * @returns
     *  The nearest anchor from `block`.
     */
    private getNearestAnchor(block: BlockView, point: { x: number, y: number }): AnchorView {
        // Select anchor
        let delta = Infinity;
        let anchor: AnchorView | null = null;
        for (const _anchor of block.anchors.values()) {
            const _delta = distance(_anchor, point);
            if (_delta < delta) {
                delta = _delta;
                anchor = _anchor;
            }
        }
        // Return anchor
        if (anchor) {
            return anchor;
        } else {
            throw new Error(`'${block.instance}' has no anchors.`);
        }
    }

}
