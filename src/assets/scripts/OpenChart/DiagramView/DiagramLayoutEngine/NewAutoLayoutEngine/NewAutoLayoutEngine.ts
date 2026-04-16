import { serializeToD2, parseTalaSvg } from "./D2Bridge";
import type { SerializableBlock, SerializableCanvas, SerializableGroup } from "./D2Bridge";
import type { DiagramObjectView } from "../../DiagramObjectView";
import type { AsyncDiagramLayoutEngine } from "../DiagramLayoutEngine";

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
 *
 * `halfW` and `halfH` are the half-dimensions of the node, used to convert
 * TALA's top-left coordinates into the center-based coordinate expected by
 * `moveTo`.  See coordinate semantics note in {@link NewAutoLayoutEngine.run}.
 */
interface PositionableNode {
    readonly id: string;
    readonly halfW: number;
    readonly halfH: number;
    moveTo(x: number, y: number): void;
}

/**
 * Collects all blocks and groups from the canvas (top-level and recursively
 * nested) into a flat map keyed by schema id.
 *
 * Traversal order is depth-first: each group is inserted into the map before
 * its descendants.  This parent-before-descendant ordering is an invariant
 * required by {@link NewAutoLayoutEngine.run} — see its JSDoc for the full
 * explanation.  Do NOT change the traversal order without preserving this
 * invariant.
 *
 * Only blocks and groups are collected; lines, anchors, and latches are
 * ignored because D2/TALA does not emit positions for them.
 */
function collectNodes(canvas: SerializableCanvas): Map<string, PositionableNode> {
    const result = new Map<string, PositionableNode>();

    function visitBlock(block: SerializableBlock & { moveTo(x: number, y: number): void }): void {
        result.set(block.id, {
            id:    block.id,
            halfW: block.face.width  / 2,
            halfH: block.face.height / 2,
            moveTo: (x, y) => block.moveTo(x, y)
        });
    }

    function visitGroup(group: SerializableGroup & { moveTo(x: number, y: number): void }): void {
        const bb = group.face.boundingBox;
        result.set(group.id, {
            id:    group.id,
            halfW: (bb.xMax - bb.xMin) / 2,
            halfH: (bb.yMax - bb.yMin) / 2,
            moveTo: (x, y) => group.moveTo(x, y)
        });
        for (const child of group.blocks) {
            visitBlock(child as SerializableBlock & { moveTo(x: number, y: number): void });
        }
        for (const nested of group.groups) {
            visitGroup(nested as SerializableGroup & { moveTo(x: number, y: number): void });
        }
    }

    for (const block of canvas.blocks) {
        visitBlock(block as SerializableBlock & { moveTo(x: number, y: number): void });
    }
    for (const group of canvas.groups) {
        visitGroup(group as SerializableGroup & { moveTo(x: number, y: number): void });
    }

    return result;
}

export class NewAutoLayoutEngine implements AsyncDiagramLayoutEngine {

    /**
     * Creates a new {@link NewAutoLayoutEngine}.
     * @param layoutSource
     *  A provider that accepts a D2 source string and returns the TALA-rendered
     *  SVG string.  Injected to keep the engine layer free of HTTP concerns.
     */
    constructor(private readonly layoutSource: LayoutSource) {}

    /**
     * Runs the TALA layout engine on the canvas root.
     *
     * **Coordinate semantics**: TALA returns top-left `(x, y)` for every node
     * via the SVG `<rect x y>` attribute.  However, `BlockView.moveTo` and
     * `GroupView.moveTo` both place the node's **center** at `(x, y)` (because
     * `DiagramFace.moveTo` targets `boundingBox.x / boundingBox.y`, which are
     * the center coordinates in both `DictionaryBlock.calculateLayout` and
     * `GroupFace.calculateLayout`).  We therefore convert each TALA coordinate
     * to a center before calling `moveTo`:
     *
     *   `moveTo(talaX + halfW, talaY + halfH)`
     *
     * **Node iteration order MUST be parent-before-descendant** so that a
     * group's cascading `moveTo` (which shifts all children via `moveBy`) is
     * immediately overwritten by each descendant's own absolute `moveTo`.
     * `collectNodes` guarantees this by inserting each group ahead of its
     * children (DFS).  Do not reorder without preserving this invariant.
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
        const svg = await this.layoutSource(source);

        // 3. Parse SVG → id → {x, y}  (top-left coordinates)
        const coords = parseTalaSvg(svg);

        // 4. Build id → node map from the live canvas
        const nodes = collectNodes(canvas);

        // 5. Apply positions — convert TALA top-left to center before moveTo
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
            // TALA gives top-left; moveTo expects center — offset by half-dimensions.
            node.moveTo(pos.x + node.halfW, pos.y + node.halfH);
        }
    }

}
