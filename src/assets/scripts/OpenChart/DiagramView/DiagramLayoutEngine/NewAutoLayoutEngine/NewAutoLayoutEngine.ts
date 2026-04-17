// pattern: Imperative Shell
import { serializeToD2, parseTalaSvg } from "./D2Bridge";
import type { SerializableBlock, SerializableCanvas, SerializableGroup, TalaPlacement } from "./D2Bridge";
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
 * A node from the live canvas that can be repositioned given a TALA
 * placement (top-left x/y with optional width/height).
 *
 * Blocks translate the placement into `moveTo(center)` using TALA's size
 * (or the block's own face size as fallback when TALA didn't emit a rect
 * with width/height — e.g. cylinder shapes rendered via `<path>`).
 *
 * Groups call `setBounds` with TALA's exact rectangle so the container's
 * displayed size matches TALA's auto-computed container size.  `moveTo`
 * on a group only *translates* the group — it does not resize it — so
 * using `moveTo` for containers would leave them at their default
 * 300×200 user bounds and cause sibling boundaries to visually overlap.
 *
 * `kind` discriminates the two passes in {@link NewAutoLayoutEngine.run}:
 * blocks are placed first so that group `setBounds` runs AFTER the
 * ripple of `calculateLayout` triggered by child moves (which expands
 * user bounds to default-positioned siblings during the ripple).
 */
interface PositionableNode {
    readonly kind: "block" | "group";
    placeAt(placement: TalaPlacement): void;
}

/**
 * A block from the canvas extended with the `moveTo` method.
 *
 * The serializable interfaces (`SerializableBlock`, `SerializableGroup`) only
 * describe the fields that the D2 bridge reads.  The actual `BlockView` and
 * `GroupView` instances also expose movement methods.  These interfaces
 * capture that without using an unsafe intersection cast.
 */
interface PositionableBlock extends SerializableBlock {
    moveTo(x: number, y: number): void;
}

interface PositionableGroupMixin extends SerializableGroup {
    readonly face: SerializableGroup["face"] & {
        setBounds(xMin: number, yMin: number, xMax: number, yMax: number): void;
    };
    moveTo(x: number, y: number): void;
    readonly blocks: ReadonlyArray<PositionableBlock>;
    readonly groups: ReadonlyArray<PositionableGroup>;
}

// Recursive alias — must be declared as an interface to allow self-reference.
type PositionableGroup = PositionableGroupMixin;

/**
 * Converts a TALA placement into a `moveTo(center)` call for a block.
 *
 * TALA's rect `width` / `height` win over the block's own face dimensions
 * when present; the fallback to `face.width` / `face.height` covers the
 * cylinder case where `parseTalaSvg` returns only the top-left coordinate.
 */
function placeBlock(block: PositionableBlock, p: TalaPlacement): void {
    const halfW = p.width  !== undefined ? p.width  / 2 : block.face.width  / 2;
    const halfH = p.height !== undefined ? p.height / 2 : block.face.height / 2;
    block.moveTo(p.x + halfW, p.y + halfH);
}

/**
 * Applies a TALA placement to a group by writing TALA's exact bounds
 * into the group's user bounds via `setBounds`.
 *
 * Why not `moveTo`?  `GroupFace.moveTo` only translates — it leaves the
 * user bounds' *size* unchanged (default 300×200).  After translation,
 * `calculateLayout` expands the displayed bounding box to max(user bounds,
 * children hull + padding), which leaves sibling containers overlapping at
 * their default half-dimensions.  Writing TALA's size directly into user
 * bounds makes the displayed size match TALA's intent.
 *
 * If TALA did not return a size (cylinder fallback), we still translate
 * the group to `(x, y)` via `moveTo` as a best-effort — groups rendered
 * as cylinders aren't a real case today, but the engine shouldn't crash.
 */
function placeGroup(group: PositionableGroup, p: TalaPlacement): void {
    if (p.width !== undefined && p.height !== undefined) {
        group.face.setBounds(p.x, p.y, p.x + p.width, p.y + p.height);
    } else {
        group.moveTo(p.x, p.y);
    }
}

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
            kind: "block",
            placeAt: (p) => placeBlock(block, p)
        });
    }

    function visitGroup(group: PositionableGroup, qualifiedPath: string): void {
        result.set(qualifiedPath, {
            kind: "group",
            placeAt: (p) => placeGroup(group, p)
        });
        for (const child of group.blocks) {
            const childPath = `${qualifiedPath}.${child.instance}`;
            visitBlock(child, childPath);
        }
        for (const nested of group.groups) {
            const nestedPath = `${qualifiedPath}.${nested.instance}`;
            visitGroup(nested, nestedPath);
        }
    }

    for (const block of canvas.blocks) {
        visitBlock(block as PositionableBlock, block.instance);
    }
    for (const group of canvas.groups) {
        visitGroup(group as PositionableGroup, group.instance);
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
     * **Coordinate semantics**: TALA returns top-left `(x, y, width, height)`
     * for every node via the SVG `<rect>` attributes.  Blocks are placed via
     * `moveTo(top-left + half-dimensions)`, converting to the center-based
     * target that `DiagramFace.moveTo` expects.  Groups are placed via
     * `GroupFace.setBounds(xMin, yMin, xMax, yMax)`, which writes TALA's
     * exact bounds directly into the group's user bounds — this is how the
     * group's displayed size matches TALA's auto-computed container size.
     * Using `moveTo` on groups would only translate them, leaving their
     * size at the default 300×200 user bounds and causing sibling
     * containers to overlap visually.
     *
     * **Two-pass order**: blocks first, then groups.  Each `BlockView.moveTo`
     * propagates via `handleUpdate` → `GroupFace.calculateLayout`, which
     * expands the parent group's user bounds to include the hull of its
     * children (still at their default positions while other blocks are
     * mid-pass).  Running group `setBounds` after all block moves means
     * `setBounds` overwrites whatever `calculateLayout` expanded to, pinning
     * the group to TALA's exact reported bounds regardless of the ripple.
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

        // 5. Apply each TALA placement in two passes (see `run` JSDoc):
        //    pass 1 — blocks (triggers parent calculateLayout ripple);
        //    pass 2 — groups (setBounds overwrites the ripple-expanded user
        //    bounds with TALA's exact rectangle).
        let warnedMissing = false;
        const applyPass = (kind: PositionableNode["kind"]): void => {
            for (const [qualifiedPath, node] of nodes) {
                if (node.kind !== kind) {
                    continue;
                }
                const placement = coords.get(qualifiedPath);
                if (placement === undefined) {
                    if (!warnedMissing) {
                        console.warn(
                            `NewAutoLayoutEngine: one or more canvas nodes were not found in the TALA SVG (first missing qualified path: "${qualifiedPath}"). Those nodes will keep their current positions.`
                        );
                        warnedMissing = true;
                    }
                    continue;
                }
                node.placeAt(placement);
            }
        };
        applyPass("block");
        applyPass("group");
    }

}
