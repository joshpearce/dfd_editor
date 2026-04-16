import { serializeToD2, parseTalaSvg } from "./D2Bridge";
import type { SerializableBlock, SerializableCanvas, SerializableGroup } from "./D2Bridge";
import type { DiagramObjectView } from "../../DiagramObjectView";
import type { DiagramLayoutEngine } from "../DiagramLayoutEngine";

/**
 * A function that accepts a D2 source string and returns a Promise that
 * resolves to the TALA-rendered SVG string.  Injected at construction time so
 * the engine does not import from src/assets/scripts/api/ directly (OpenChart
 * boundary: the engine layer must stay framework-agnostic and HTTP-free).
 */
export type LayoutSource = (d2Source: string) => Promise<string>;

/**
 * Minimal view surface needed to reposition a node.  BlockView and GroupView
 * both satisfy this interface.
 */
interface PositionableNode {
    readonly id: string;
    moveTo(x: number, y: number): void;
}

/**
 * Collects all blocks and groups from the canvas (top-level and recursively
 * nested) into a flat map keyed by schema id.
 *
 * Traversal order is breadth-first: groups first at each level, then their
 * children.  When TALA's moveTo cascades to children (GroupFace.moveBy moves
 * all children by the delta), subsequent calls to moveTo on each child block
 * override that cascade with the correct absolute coordinate — so insertion
 * order does not affect correctness.
 *
 * Only blocks and groups are collected; lines, anchors, and latches are
 * ignored because D2/TALA does not emit positions for them.
 */
function collectNodes(canvas: SerializableCanvas): Map<string, PositionableNode> {
    const result = new Map<string, PositionableNode>();

    function visitBlock(block: SerializableBlock & PositionableNode): void {
        result.set(block.id, block);
    }

    function visitGroup(group: SerializableGroup & PositionableNode): void {
        result.set(group.id, group);
        for (const child of group.blocks) {
            visitBlock(child as SerializableBlock & PositionableNode);
        }
        for (const nested of group.groups) {
            visitGroup(nested as SerializableGroup & PositionableNode);
        }
    }

    for (const block of canvas.blocks) {
        visitBlock(block as SerializableBlock & PositionableNode);
    }
    for (const group of canvas.groups) {
        visitGroup(group as SerializableGroup & PositionableNode);
    }

    return result;
}

export class NewAutoLayoutEngine implements DiagramLayoutEngine {

    /**
     * Creates a new {@link NewAutoLayoutEngine}.
     * @param fetchSvg
     *  A provider that accepts a D2 source string and returns the TALA-rendered
     *  SVG string.  Injected to keep the engine layer free of HTTP concerns.
     */
    constructor(private readonly fetchSvg: LayoutSource) {}

    /**
     * Runs the TALA layout engine on the canvas root.
     *
     * Position-application strategy: TALA returns absolute SVG-root
     * coordinates for every node (both top-level and nested).  We call
     * `moveTo(x, y)` on each block or group individually using the raw
     * absolute value.  Because `GroupFace.moveBy` cascades to children,
     * calling `moveTo` on a group first shifts its children by a delta; the
     * subsequent `moveTo` calls on those children then correct them to their
     * own absolute TALA coordinates.  The net result is correct regardless of
     * traversal order.
     *
     * @param objects
     *  The canvas root is expected at `objects[0]`.
     */
    public async run(objects: DiagramObjectView[]): Promise<void> {
        const canvas = objects[0] as unknown as SerializableCanvas;
        if (!canvas) {
            return;
        }

        // 1. Serialize to D2
        const source = serializeToD2(canvas);

        // 2. Fetch TALA SVG (throws on failure — caller wraps in try/catch)
        const svg = await this.fetchSvg(source);

        // 3. Parse SVG → id → {x, y}
        const coords = parseTalaSvg(svg);

        // 4. Build id → node map from the live canvas
        const nodes = collectNodes(canvas);

        // 5. Apply positions
        let warnedMissing = false;
        for (const [id, node] of nodes) {
            const pos = coords.get(id);
            if (pos === undefined) {
                if (!warnedMissing) {
                    console.warn(
                        `NewAutoLayoutEngine: one or more canvas nodes were not found in the TALA SVG (first missing id: "${id}"). Those nodes will keep their current positions.`
                    );
                    warnedMissing = true;
                }
                continue;
            }
            node.moveTo(pos.x, pos.y);
        }
    }

}
