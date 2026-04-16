// pattern: Imperative Shell
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
 * A node from the live canvas that can be repositioned.
 *
 * `BlockView` and `GroupView` both satisfy this interface.
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
 * A block or group from the canvas extended with the `moveTo` method.
 *
 * The serializable interfaces (`SerializableBlock`, `SerializableGroup`) only
 * describe the fields that the D2 bridge reads.  The actual `BlockView` and
 * `GroupView` instances also expose `moveTo`.  This interface captures that
 * without using an unsafe intersection cast.
 */
interface PositionableBlock extends SerializableBlock {
    moveTo(x: number, y: number): void;
}

interface PositionableGroupMixin extends SerializableGroup {
    moveTo(x: number, y: number): void;
    readonly blocks: ReadonlyArray<PositionableBlock>;
    readonly groups: ReadonlyArray<PositionableGroup>;
}

// Recursive alias — must be declared as an interface to allow self-reference.
type PositionableGroup = PositionableGroupMixin;

/**
 * Collects all blocks and groups from the canvas (top-level and recursively
 * nested) into a flat map keyed by **qualified D2 path**.
 *
 * The qualified path matches exactly what `serializeToD2` emits for edge
 * endpoints (e.g. `group-g.block-c` for a block nested one level deep).
 * This keeps the serialize → SVG → parse → apply id round-trip consistent.
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

    function visitBlock(block: PositionableBlock, qualifiedPath: string): void {
        result.set(qualifiedPath, {
            id:    block.id,
            halfW: block.face.width  / 2,
            halfH: block.face.height / 2,
            moveTo: (x, y) => block.moveTo(x, y)
        });
    }

    function visitGroup(group: PositionableGroup, qualifiedPath: string): void {
        const bb = group.face.boundingBox;
        result.set(qualifiedPath, {
            id:    group.id,
            halfW: (bb.xMax - bb.xMin) / 2,
            halfH: (bb.yMax - bb.yMin) / 2,
            moveTo: (x, y) => group.moveTo(x, y)
        });
        for (const child of group.blocks) {
            const childPath = `${qualifiedPath}.${child.id}`;
            visitBlock(child, childPath);
        }
        for (const nested of group.groups) {
            const nestedPath = `${qualifiedPath}.${nested.id}`;
            visitGroup(nested, nestedPath);
        }
    }

    for (const block of canvas.blocks) {
        visitBlock(block as PositionableBlock, block.id);
    }
    for (const group of canvas.groups) {
        visitGroup(group as PositionableGroup, group.id);
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
     *  The canvas root is expected at `objects[0]`.  If `objects` is empty
     *  or `objects[0]` is not a canvas-shaped object, `run` returns without
     *  calling `layoutSource`.
     */
    public async run(objects: DiagramObjectView[]): Promise<void> {
        if (objects.length === 0) {
            return;
        }

        const first = objects[0];
        // The concrete CanvasView is in the OpenChart module; we cannot import
        // it here without creating a circular reference.  We guard by checking
        // that the object has the minimal canvas surface we need.
        const canvas = first as unknown as SerializableCanvas;
        if (
            !canvas ||
            !Array.isArray((canvas as { blocks?: unknown }).blocks) ||
            !Array.isArray((canvas as { groups?: unknown }).groups) ||
            !Array.isArray((canvas as { lines?: unknown }).lines)
        ) {
            throw new Error(
                "NewAutoLayoutEngine: objects[0] is not a canvas — expected SerializableCanvas surface"
            );
        }

        // 1. Serialize to D2
        const source = serializeToD2(canvas);

        // 2. Fetch TALA SVG (throws on failure — caller wraps in try/catch)
        const svg = await this.layoutSource(source);

        // 3. Parse SVG → qualified-path → {x, y}  (top-left coordinates)
        const coords = parseTalaSvg(svg);

        // 4. Build qualified-path → node map from the live canvas
        const nodes = collectNodes(canvas);

        // 5. Apply positions — convert TALA top-left to center before moveTo
        let warnedMissing = false;
        for (const [qualifiedPath, node] of nodes) {
            const pos = coords.get(qualifiedPath);
            if (pos === undefined) {
                if (!warnedMissing) {
                    console.warn(
                        `NewAutoLayoutEngine: one or more canvas nodes were not found in the TALA SVG (first missing qualified path: "${qualifiedPath}"). Those nodes will keep their current positions.`
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
