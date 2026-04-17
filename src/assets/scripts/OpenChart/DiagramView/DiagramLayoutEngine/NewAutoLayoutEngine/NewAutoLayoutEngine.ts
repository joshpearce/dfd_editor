// pattern: Imperative Shell
import { serializeToD2, parseTalaSvg } from "./D2Bridge";
import type { SerializableBlock, SerializableCanvas, SerializableGroup, TalaEdge, TalaPlacement } from "./D2Bridge";
import { pickCardinalAnchor, rebindLatchToAnchor } from "./AnchorRebind";
import type { CardinalBlockSurface, LinkableAnchor, Point, RebindableLatch } from "./AnchorRebind";
import type { DiagramObjectView } from "../../DiagramObjectView";
import type { AsyncDiagramLayoutEngine } from "../DiagramLayoutEngine";

/**
 * Cap on the number of qualified paths enumerated in each bucket of the
 * end-of-run warning.  Keeps a badly-malformed canvas from producing a
 * megabyte-wide console line while still showing enough context to
 * diagnose the first few problems; anything beyond the cap is summarized
 * as `", ... and N more"` by {@link formatBucket}.
 */
const MAX_MISSING_DISPLAYED = 10;

/**
 * A function that accepts a D2 source string and returns a Promise that
 * resolves to the TALA-rendered SVG string.  Injected at construction time so
 * the engine does not import from src/assets/scripts/api/ directly (OpenChart
 * boundary: the engine layer must stay framework-agnostic and HTTP-free).
 */
export type LayoutSource = (d2Source: string) => Promise<string>;

/**
 * Controls how the engine rebinds line endpoints (latches to anchors) after
 * blocks and groups have been placed.
 *
 * - `"none"`      — no rebinding is performed; latches remain on whatever
 *                   anchor they were attached to before layout.
 * - `"geometric"` — each latch is rebound to the cardinal anchor of its
 *                   endpoint block that faces toward the opposite block,
 *                   computed purely from bounding-box centers.  See Step 2
 *                   of `docs/auto-layout-connector-anchoring-plan.md`.
 * - `"tala"`      — uses TALA's own SVG connection-point data to determine
 *                   exact anchor positions.  For each line, finds the TALA
 *                   edge whose start/end is nearest the source/target block
 *                   perimeter and picks anchors from those endpoints.  Falls
 *                   back to `"geometric"` per-line when no plausible TALA
 *                   edge is found (empty edge list, or best match exceeds one
 *                   block half-dimension away).
 */
export type AnchorStrategy = "none" | "geometric" | "tala";

///////////////////////////////////////////////////////////////////////////////
//  Engine-local structural types for line rebinding  /////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A block that exposes both the bounding-box surface needed by
 * {@link pickCardinalAnchor} and a map of cardinal anchors that can be
 * targeted by {@link rebindLatchToAnchor}.
 *
 * Mirrors the `asPositionable*` pattern: the serializable interfaces
 * (`SerializableBlock`, etc.) only describe the D2-bridge read surface.
 * This interface captures the additional surface the rebind pass needs
 * without importing the concrete `BlockView`.
 */
interface BlockWithAnchors extends CardinalBlockSurface {
    /** Map key is the string value of an `AnchorPosition` enum member (e.g. `"0"`, `"90"`, `"180"`, `"270"`). */
    readonly anchors: ReadonlyMap<string, LinkableAnchor>;
}

/**
 * An anchor that knows which {@link BlockWithAnchors} it belongs to.
 * Satisfies {@link LinkableAnchor} structurally so it can be passed to
 * {@link rebindLatchToAnchor} directly.
 */
interface AnchorWithParent extends LinkableAnchor {
    readonly parent: BlockWithAnchors | null;
}

/**
 * A latch whose `anchor` field is narrowed to {@link AnchorWithParent} so the
 * rebind pass can walk `latch.anchor.parent` to resolve the endpoint block
 * without a separate lookup.
 */
interface RebindableLatchWithAnchor extends RebindableLatch {
    readonly anchor: AnchorWithParent | null;
}

/**
 * The source and target latches of a line, each typed as
 * {@link RebindableLatchWithAnchor} so the rebind pass can resolve both
 * endpoint blocks and rebind both ends in one sweep.
 *
 * Getters on a real `LineView` throw when the underlying latch has no
 * attached endpoint; the runtime guard {@link asRebindableLine} catches
 * that and returns `null` so malformed lines are skipped silently.
 */
interface RebindableLineSurface {
    readonly source: RebindableLatchWithAnchor;
    readonly target: RebindableLatchWithAnchor;
}

/**
 * Runtime-narrows a raw line object to a {@link RebindableLineSurface}.
 *
 * The `source` / `target` getters on a real `LineView` throw when the
 * underlying latch has no attached endpoint.  A try/catch on each getter
 * turns that throw into a `null` return so the caller skips the line
 * silently — consistent with `serializeToD2`'s existing behavior for
 * lines with unresolved endpoints.
 *
 * @param line - The raw line object from the canvas.
 * @returns The narrowed surface, or `null` if either endpoint cannot be
 *          resolved.
 */
function asRebindableLine(
    line: unknown
): RebindableLineSurface | null {
    try {
        const l = line as RebindableLineSurface;
        // Access both getters — real LineView throws when the latch is null.
        const src = l.source;
        const tgt = l.target;
        if (!src || !tgt) {
            return null;
        }
        return l;
    } catch {
        // source / target threw — floating latch or dangling line.
        return null;
    }
}

/**
 * Outcome of applying a single TALA placement to a positionable node.
 *
 * - `"placed"`               — the node accepted and applied the placement.
 * - `"skipped-rect-less"`    — TALA emitted no rect (rect-less placement)
 *                              AND the node has no usable fallback size
 *                              (its bounding box is zero).  Placing would
 *                              leave user bounds at the default 300×200 and
 *                              re-introduce the sibling-overlap bug.
 * - `"skipped-non-positive"` — TALA emitted a rect with non-positive
 *                              dimensions.  Writing such a rect into user
 *                              bounds would produce an inverted/zero-area
 *                              rectangle that downstream code cannot handle
 *                              coherently.
 *
 * Both skipped outcomes flow into the aggregated end-of-run warning, but
 * are bucketed separately so the warning says _which_ skip cause applied
 * to _which_ path (so "why was this specific group skipped?" can be
 * answered from the log line alone).
 *
 * TALA-missing paths (no placement found for a qualified path at all) are
 * tracked separately in `run()` — they aren't a node-level outcome because
 * `placeAt` is never called for them.
 */
type PlacementOutcome = "placed" | "skipped-rect-less" | "skipped-non-positive";

/**
 * A node from the live canvas that can be repositioned given a TALA
 * placement.  `placeAt` is called exactly once per applied placement, by
 * {@link NewAutoLayoutEngine.run}.
 *
 * Returns a {@link PlacementOutcome} indicating whether the placement was
 * applied (`"placed"`) or skipped (`"skipped-rect-less"` /
 * `"skipped-non-positive"`).  Skipped outcomes flow into the single
 * aggregated end-of-run warning alongside TALA-missing paths, bucketed by
 * cause — see {@link NewAutoLayoutEngine.run}.
 *
 * The specifics of how each kind of node interprets the placement — blocks
 * via `moveTo(center)`, groups via `setBounds(...)`, and the cylinder
 * fallback in each case — live on {@link placeBlock} and {@link placeGroup},
 * which are bound into the closure returned by {@link collectNodes}.
 */
interface PositionableNode {
    placeAt(placement: TalaPlacement): PlacementOutcome;
}

/**
 * A block from the canvas extended with the `moveTo` method used by
 * {@link placeBlock}.
 *
 * The serializable interfaces (`SerializableBlock`, `SerializableGroup`) only
 * describe the fields that the D2 bridge reads.  The actual `BlockView` and
 * `GroupView` instances also expose movement methods.  These interfaces
 * capture that without using an unsafe intersection cast.
 */
interface PositionableBlock extends SerializableBlock {
    moveTo(x: number, y: number): void;
}

/**
 * A group from the canvas extended with the movement methods used by
 * {@link placeGroup}: `setBounds` on the face (primary path), and `moveTo`
 * on the group itself (cylinder fallback when TALA emits no rect).  Child
 * collections are typed as `PositionableBlock` / `PositionableGroup` so
 * recursive traversal in {@link collectNodes} picks up the same mix-in.
 */
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
 * when both are present; the fallback to `face.width` / `face.height`
 * covers the cylinder case where `parseTalaSvg` returns only the top-left
 * coordinate (`TalaPlacement`'s rect-less branch — see the discriminated
 * union in `D2Bridge.ts`).
 *
 * Returns the literal `"placed"` — blocks have no skip path today.  The
 * narrower return type (vs. the three-valued `PlacementOutcome`) lets the
 * caller see in the type system that this function never emits a skipped
 * outcome.  `applyPlacements` still handles the full union via control
 * flow, so if a skip cause is ever added to blocks the return type
 * widens naturally.
 */
function placeBlock(block: PositionableBlock, p: TalaPlacement): "placed" {
    // Narrow via the discriminated union: if `width` is defined, `height`
    // is defined too (and vice versa) — the type disallows half-populated
    // placements, so `parseTalaSvg` produces one of the two shapes.
    const halfW = p.width  !== undefined ? p.width  / 2 : block.face.width  / 2;
    const halfH = p.height !== undefined ? p.height / 2 : block.face.height / 2;
    block.moveTo(p.x + halfW, p.y + halfH);
    return "placed";
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
 * If TALA did not return a size (no `<rect>` — e.g. a future cylinder-
 * shaped group), we fall back to `moveTo(center)` using the group's
 * current bounding-box size to convert TALA's top-left into the center
 * that `moveTo` expects.  Groups rendered as cylinders aren't a real case
 * in the DFD schema today, but the engine shouldn't crash and — if it
 * ever does fire — the coordinate semantics should still be correct.
 *
 * Skipped outcomes, bucketed by cause so the end-of-run warning can say
 * which skip cause applied to which path:
 *  - `"skipped-non-positive"` — the rect branch has non-positive
 *    dimensions.  A backstop — TALA reliably emits positive dimensions
 *    for rects, but a degenerate rectangle would write inverted/zero-area
 *    user bounds that downstream face/layout code doesn't handle
 *    coherently.
 *  - `"skipped-rect-less"` — the rect-less fallback would be wrong
 *    (current bbox is zero, which would leave user bounds at their
 *    300×200 default and re-introduce the sibling-overlap bug).
 *
 * The caller aggregates skipped paths into a single end-of-run warning so
 * this path does not produce per-group console spam.
 */
function placeGroup(group: PositionableGroup, p: TalaPlacement): PlacementOutcome {
    if (p.width !== undefined && p.height !== undefined) {
        if (p.width <= 0 || p.height <= 0) {
            return "skipped-non-positive";
        }
        group.face.setBounds(p.x, p.y, p.x + p.width, p.y + p.height);
        return "placed";
    }
    const groupFallbackBoundingBox = group.face.boundingBox;
    const halfW = (groupFallbackBoundingBox.xMax - groupFallbackBoundingBox.xMin) / 2;
    const halfH = (groupFallbackBoundingBox.yMax - groupFallbackBoundingBox.yMin) / 2;
    // A zero-sized bounding box on a group means the group is pre-layout
    // (all-zero face.boundingBox default).  A `moveTo` with halfW=halfH=0
    // would translate the group's *origin* but leave user bounds at the
    // default 300x200 — re-introducing the sibling-overlap bug that the
    // primary `setBounds` path is meant to fix.  We'd rather leave the
    // group unplaced and let `run` include its qualified path in the
    // single end-of-run warning (unified with TALA-missing paths) than
    // log a per-group line here and then do the broken thing.
    if (halfW === 0 && halfH === 0) {
        return "skipped-rect-less";
    }
    group.moveTo(p.x + halfW, p.y + halfH);
    return "placed";
}

/**
 * A positionable canvas node paired with its qualified D2 path.  Used as the
 * element type in the block/group pass lists.
 */
interface PositionableEntry {
    readonly qualifiedPath: string;
    readonly node: PositionableNode;
}

/**
 * Collected positionables from the canvas, already partitioned by kind into
 * two ordered lists so `run` can iterate each kind directly without filtering.
 */
interface CollectedNodes {
    readonly blocks: ReadonlyArray<PositionableEntry>;
    readonly groups: ReadonlyArray<PositionableEntry>;
}

/**
 * Runtime-narrows a `SerializableBlock` to a `PositionableBlock`.
 *
 * The serializable interfaces only describe the read-side surface that
 * D2Bridge touches; the engine additionally requires the `moveTo` mover
 * method that real `BlockView` / `GroupView` instances expose.  A test
 * fixture that supplies only `SerializableBlock` would otherwise crash
 * deep inside `placeBlock` with a `.moveTo is not a function` error;
 * the guards throw a diagnostic error naming the offending path so
 * bad-fixture failures are obvious.
 */
function asPositionableBlock(
    block: SerializableBlock,
    qualifiedPath: string
): PositionableBlock {
    if (typeof (block as { moveTo?: unknown }).moveTo !== "function") {
        throw new Error(
            `NewAutoLayoutEngine: block "${qualifiedPath}" is not positionable — missing moveTo method`
        );
    }
    return block as PositionableBlock;
}

/**
 * Runtime-narrows a `SerializableGroup` to a `PositionableGroup`.
 *
 * Mirrors {@link asPositionableBlock}: the group must additionally carry
 * `moveTo` on the group and `setBounds` on its face.  Missing methods
 * produce a diagnostic error naming the offending qualified path.
 */
function asPositionableGroup(
    group: SerializableGroup,
    qualifiedPath: string
): PositionableGroup {
    if (typeof (group as { moveTo?: unknown }).moveTo !== "function") {
        throw new Error(
            `NewAutoLayoutEngine: group "${qualifiedPath}" is not positionable — missing moveTo method`
        );
    }
    const face = group.face as { setBounds?: unknown };
    if (typeof face.setBounds !== "function") {
        throw new Error(
            `NewAutoLayoutEngine: group "${qualifiedPath}" face is not positionable — missing setBounds method`
        );
    }
    return group as PositionableGroup;
}

/**
 * Collects all blocks and groups from the canvas (top-level and recursively
 * nested) into two lists keyed by **qualified D2 path**, partitioned by kind.
 *
 * The qualified path matches exactly what `serializeToD2` emits for edge
 * endpoints (e.g. `group-g.block-c` for a block nested one level deep).
 * This keeps the serialize → SVG → parse → apply id round-trip consistent.
 *
 * Traversal order is depth-first.  Within each list, parent-before-descendant
 * ordering is preserved (a group appears in `groups` before its nested
 * sub-groups; a block's parent group appears in `groups` before the block
 * appears in `blocks`).  Partitioning by kind lets `run` apply all block
 * placements before any group placement — see {@link NewAutoLayoutEngine.run}.
 *
 * Only blocks and groups are collected; lines, anchors, and latches are
 * ignored because D2/TALA does not emit positions for them.
 */
function collectNodes(canvas: SerializableCanvas): CollectedNodes {
    const blocks: PositionableEntry[] = [];
    const groups: PositionableEntry[] = [];

    function visitBlock(block: SerializableBlock, qualifiedPath: string): void {
        const positionable = asPositionableBlock(block, qualifiedPath);
        blocks.push({
            qualifiedPath,
            node: { placeAt: (p): PlacementOutcome => placeBlock(positionable, p) }
        });
    }

    function visitGroup(group: SerializableGroup, qualifiedPath: string): void {
        const positionable = asPositionableGroup(group, qualifiedPath);
        groups.push({
            qualifiedPath,
            node: { placeAt: (p): PlacementOutcome => placeGroup(positionable, p) }
        });
        for (const child of positionable.blocks) {
            const childPath = `${qualifiedPath}.${child.instance}`;
            visitBlock(child, childPath);
        }
        for (const nested of positionable.groups) {
            const nestedPath = `${qualifiedPath}.${nested.instance}`;
            visitGroup(nested, nestedPath);
        }
    }

    for (const block of canvas.blocks) {
        visitBlock(block, block.instance);
    }
    for (const group of canvas.groups) {
        visitGroup(group, group.instance);
    }

    return { blocks, groups };
}

/**
 * Aggregated lists of qualified paths that did not receive a placement,
 * bucketed by cause so the end-of-run warning can report each bucket
 * separately:
 *
 * - `missing`            — no placement in the TALA SVG for this path.
 * - `skippedRectLess`    — rect-less TALA placement AND the node has no
 *                          usable fallback bounding box (see `placeGroup`).
 * - `skippedNonPositive` — TALA emitted a rect with non-positive
 *                          dimensions (see `placeGroup`).
 */
interface UnplacedPaths {
    readonly missing:            string[];
    readonly skippedRectLess:    string[];
    readonly skippedNonPositive: string[];
}

/**
 * Applies placements from `coords` to every entry in `entries`, mutating
 * the buckets in `unplaced` for paths that did not receive a placement
 * (see {@link UnplacedPaths}).  Extracted from `run()` so the two-pass
 * logic and the aggregation contract are easy to reason about in
 * isolation.
 */
function applyPlacements(
    entries:  ReadonlyArray<PositionableEntry>,
    coords:   Map<string, TalaPlacement>,
    unplaced: UnplacedPaths
): void {
    for (const { qualifiedPath, node } of entries) {
        const placement = coords.get(qualifiedPath);
        if (placement === undefined) {
            unplaced.missing.push(qualifiedPath);
            continue;
        }
        const outcome = node.placeAt(placement);
        if (outcome === "skipped-rect-less") {
            unplaced.skippedRectLess.push(qualifiedPath);
        } else if (outcome === "skipped-non-positive") {
            unplaced.skippedNonPositive.push(qualifiedPath);
        }
    }
}

/**
 * Formats one bucket of the aggregated end-of-run warning.  Enforces the
 * per-bucket `MAX_MISSING_DISPLAYED` display cap and the `", ... and N
 * more"` elision suffix in one place.  Returns `null` if the bucket is
 * empty so callers can filter it out without boilerplate.
 */
function formatBucket(paths: ReadonlyArray<string>, cause: string): string | null {
    if (paths.length === 0) {
        return null;
    }
    const shown  = paths.slice(0, MAX_MISSING_DISPLAYED).map((p) => `"${p}"`).join(", ");
    const elided = paths.length - MAX_MISSING_DISPLAYED;
    const suffix = elided > 0 ? `, ... and ${elided} more` : "";
    return `${paths.length} ${cause}: ${shown}${suffix}`;
}

/**
 * Formats the aggregated end-of-run warning payload.  Each {@link
 * UnplacedPaths} bucket is reported as its own clause with a distinct
 * cause label so a reader can tell which cause applied to which path.
 *
 * Returns the warning string, or `null` if there is nothing to warn about.
 */
function formatSkippedWarning(unplaced: UnplacedPaths): string | null {
    const total
        = unplaced.missing.length
        + unplaced.skippedRectLess.length
        + unplaced.skippedNonPositive.length;
    if (total === 0) {
        return null;
    }
    const parts = [
        formatBucket(unplaced.missing,            "not found in the TALA SVG"),
        formatBucket(unplaced.skippedRectLess,    "skipped (rect-less placement with zero bbox)"),
        formatBucket(unplaced.skippedNonPositive, "skipped (non-positive rect dimensions)")
    ].filter((s): s is string => s !== null);
    return (
        `NewAutoLayoutEngine: ${total} canvas node(s) kept their current positions. `
        + parts.join("; ")
    );
}

///////////////////////////////////////////////////////////////////////////////
//  Line collection  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Collects all lines from the canvas (top-level and recursively inside groups)
 * that pass the {@link asRebindableLine} runtime guard.
 *
 * Lines with unresolved endpoints (null latch or throwing getter) are skipped
 * silently — consistent with `serializeToD2`'s existing behavior.
 *
 * @param canvas - The live canvas to collect lines from.
 * @returns An ordered list of {@link RebindableLineSurface} values ready for
 *          the rebind pass.
 */
function collectLines(canvas: SerializableCanvas): ReadonlyArray<RebindableLineSurface> {
    const result: RebindableLineSurface[] = [];

    function visitLines(lines: ReadonlyArray<unknown>): void {
        for (const line of lines) {
            const narrowed = asRebindableLine(line);
            if (narrowed !== null) {
                result.push(narrowed);
            }
        }
    }

    function visitGroup(group: SerializableGroup): void {
        visitLines(group.lines as ReadonlyArray<unknown>);
        for (const nested of group.groups) {
            visitGroup(nested);
        }
    }

    visitLines(canvas.lines as ReadonlyArray<unknown>);
    for (const group of canvas.groups) {
        visitGroup(group);
    }

    return result;
}

///////////////////////////////////////////////////////////////////////////////
//  Geometric rebind pass  /////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Resolves the endpoint block for a latch by walking `latch.anchor.parent`.
 *
 * Returns `null` when the latch has no attached anchor, or the anchor has no
 * parent block — which can happen for latches attached to a canvas anchor
 * rather than a block anchor, or for floating latches not yet connected.
 */
function resolveEndpointBlock(latch: RebindableLatchWithAnchor): BlockWithAnchors | null {
    return latch.anchor?.parent ?? null;
}

/**
 * Returns the center point of a block's bounding box.
 */
function centerOf(block: BlockWithAnchors): Point {
    const { xMin, xMax, yMin, yMax } = block.face.boundingBox;
    return { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2 };
}

/**
 * Rebinds every line's source and target latches to the cardinal anchor of
 * their respective endpoint blocks that geometrically faces toward the
 * opposite block.
 *
 * Uses {@link pickCardinalAnchor} (center-to-center direction) and
 * {@link rebindLatchToAnchor} (detach + reattach).  Lines whose endpoint
 * blocks cannot be resolved (floating latch, canvas-level anchor, etc.) are
 * skipped silently.
 *
 * The anchor map is keyed by `AnchorPosition` string values (`"0"`, `"90"`,
 * `"180"`, `"270"`).  `pickCardinalAnchor` returns an `AnchorPosition`, which
 * extends `string`, so `block.anchors.get(srcPos)` works directly without
 * importing `AnchorPosition` here.
 */
function rebindLinesGeometric(lines: ReadonlyArray<RebindableLineSurface>): void {
    for (const line of lines) {
        const srcBlock = resolveEndpointBlock(line.source);
        const tgtBlock = resolveEndpointBlock(line.target);
        if (!srcBlock || !tgtBlock) {
            continue;
        }
        const srcCenter = centerOf(srcBlock);
        const tgtCenter = centerOf(tgtBlock);
        const srcPos = pickCardinalAnchor(srcBlock, tgtCenter);
        const tgtPos = pickCardinalAnchor(tgtBlock, srcCenter);
        const newSrcAnchor = srcBlock.anchors.get(srcPos);
        const newTgtAnchor = tgtBlock.anchors.get(tgtPos);
        if (newSrcAnchor) {
            rebindLatchToAnchor(line.source, newSrcAnchor);
        }
        if (newTgtAnchor) {
            rebindLatchToAnchor(line.target, newTgtAnchor);
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
//  TALA-guided rebind pass  ///////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Returns the Euclidean distance from point `p` to the nearest point on the
 * boundary of the bounding box.  Returns 0 if `p` is inside the box (or on
 * its perimeter).
 *
 * Used by {@link rebindLinesTala} to score how well a TALA edge endpoint
 * aligns with a block's perimeter when selecting the best matching edge.
 */
function pointToBoxDistance(
    p: Point,
    box: CardinalBlockSurface["face"]["boundingBox"]
): number {
    const clampedX = Math.max(box.xMin, Math.min(box.xMax, p.x));
    const clampedY = Math.max(box.yMin, Math.min(box.yMax, p.y));
    const dx = p.x - clampedX;
    const dy = p.y - clampedY;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Rebinds every line's latches using TALA's own edge-endpoint data.
 *
 * For each line:
 * 1. Resolve source-block and target-block (same `latch.anchor.parent` walk
 *    as the geometric pass).
 * 2. Scan `edges` to find the one whose `start` is nearest the source-block
 *    perimeter AND `end` nearest the target-block perimeter (minimum combined
 *    distance).
 * 3. If the best match has `start` within one source half-dimension of the
 *    source perimeter AND `end` within one target half-dimension of the target
 *    perimeter, call `pickCardinalAnchor` with those TALA points and rebind.
 * 4. Otherwise fall back to geometric: rebind using the center-to-center
 *    direction (same logic as {@link rebindLinesGeometric}).
 *
 * Lines with unresolved endpoints are skipped silently.
 */
function rebindLinesTala(
    lines: ReadonlyArray<RebindableLineSurface>,
    edges: TalaEdge[]
): void {
    for (const line of lines) {
        const srcBlock = resolveEndpointBlock(line.source);
        const tgtBlock = resolveEndpointBlock(line.target);
        if (!srcBlock || !tgtBlock) {
            continue;
        }

        const srcBox = srcBlock.face.boundingBox;
        const tgtBox = tgtBlock.face.boundingBox;

        // Plausibility threshold: the larger of a block's two half-dimensions.
        // The plan says "one block's half-width"; `max(halfW, halfH)` is used
        // to avoid false rejections for anisotropic blocks — a connection
        // terminating on the wide face of a very narrow/tall block would
        // otherwise be rejected because its other dimension is small.
        const srcThreshold = Math.max(
            (srcBox.xMax - srcBox.xMin) / 2,
            (srcBox.yMax - srcBox.yMin) / 2
        );
        const tgtThreshold = Math.max(
            (tgtBox.xMax - tgtBox.xMin) / 2,
            (tgtBox.yMax - tgtBox.yMin) / 2
        );

        // Nearest-neighbor edge search.
        //
        // Direction assumption: TALA emits connections in source→target order
        // (matching the `srcInstance -> tgtInstance` edge in the D2 source).
        // If TALA reverses a specific connection, dStart/dEnd will both be
        // large and the match falls through to the geometric fallback.
        //
        // Many-to-one policy: for cardinal-only rebinding, two diagram lines
        // between the same block pair that both select the same TALA edge will
        // still receive the correct cardinal anchor (they both exit the same
        // face).  An assignment pass is not needed for this scope.
        //
        // Tie-break: when two edges have equal combined distance, the first
        // edge in document (SVG) order wins.
        let bestEdge: TalaEdge | null = null;
        let bestDStart = Infinity;
        let bestDEnd   = Infinity;

        for (const edge of edges) {
            const dStart = pointToBoxDistance(edge.start, srcBox);
            const dEnd   = pointToBoxDistance(edge.end,   tgtBox);
            if (dStart + dEnd < bestDStart + bestDEnd) {
                bestEdge  = edge;
                bestDStart = dStart;
                bestDEnd   = dEnd;
            }
        }

        if (bestEdge !== null && bestDStart <= srcThreshold && bestDEnd <= tgtThreshold) {
            // Use TALA edge endpoints to pick anchors.
            // Note: pickCardinalAnchor uses center-to-point direction, which
            // is exact when TALA terminates connections at face midpoints (the
            // normal case for rectangular blocks).  Corner terminations are
            // rare in practice; they may trigger the helper's tiebreak rule.
            const srcPos = pickCardinalAnchor(srcBlock, bestEdge.start);
            const tgtPos = pickCardinalAnchor(tgtBlock, bestEdge.end);
            const newSrcAnchor = srcBlock.anchors.get(srcPos);
            const newTgtAnchor = tgtBlock.anchors.get(tgtPos);
            if (newSrcAnchor) { rebindLatchToAnchor(line.source, newSrcAnchor); }
            if (newTgtAnchor) { rebindLatchToAnchor(line.target, newTgtAnchor); }
        } else {
            // Fallback: geometric center-to-center rebind for this line.
            rebindLinesGeometric([line]);
        }
    }
}

export class NewAutoLayoutEngine implements AsyncDiagramLayoutEngine {

    /**
     * Creates a new {@link NewAutoLayoutEngine}.
     *
     * @param layoutSource
     *  A provider that accepts a D2 source string and returns the TALA-rendered
     *  SVG string.  Injected to keep the engine layer free of HTTP concerns.
     * @param anchorStrategy
     *  Controls how line endpoints are rebound after block / group placement.
     *  Defaults to `"tala"`.  Pass `"geometric"` for the simpler center-to-
     *  center cardinal rebind, or `"none"` to skip all rebinding (preserves
     *  the pre-fix behavior where latches stay on their factory-default
     *  anchor sides).
     */
    constructor(
        private readonly layoutSource:   LayoutSource,
        private readonly anchorStrategy: AnchorStrategy = "tala"
    ) {}

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
        //    edges is used by the "tala" anchor strategy (Pass 6 below).
        const { nodes: coords, edges } = parseTalaSvg(svg);

        // 4. Build qualified-path lists from the live canvas, already
        //    partitioned by kind.
        const { blocks, groups } = collectNodes(canvas);

        // 5. Apply each TALA placement in two passes (see `run` JSDoc):
        //    pass 1 — blocks (triggers parent calculateLayout ripple);
        //    pass 2 — groups (setBounds overwrites the ripple-expanded user
        //    bounds with TALA's exact rectangle).
        //
        // Missing-placement policy: collect every qualified path that the
        // canvas has but the placement flow did not honor — whether (a) the
        // TALA SVG omitted it, (b) the node returned `"skipped-rect-less"`,
        // or (c) the node returned `"skipped-non-positive"` — across BOTH
        // passes, bucketed by cause.  Warn once at the end with the full
        // list.  Warning per-pass or per-node would either spam the console
        // or hide the fact that both blocks and groups went unplaced in the
        // same run; per-cause buckets let a reader tell why any given path
        // was left alone.
        const unplaced: UnplacedPaths = {
            missing:            [],
            skippedRectLess:    [],
            skippedNonPositive: []
        };
        applyPlacements(blocks, coords, unplaced);
        applyPlacements(groups, coords, unplaced);

        const warning = formatSkippedWarning(unplaced);
        if (warning !== null) {
            console.warn(warning);
        }

        // 6. Rebind line endpoints.  The unplaced-node warning fires in Pass 5
        //    (above) intentionally: placement diagnostics must be visible
        //    regardless of whether the rebind pass succeeds, and any rebind
        //    exceptions must not suppress placement warnings.
        if (this.anchorStrategy === "geometric") {
            const lines = collectLines(canvas);
            rebindLinesGeometric(lines);
        } else if (this.anchorStrategy === "tala") {
            const lines = collectLines(canvas);
            rebindLinesTala(lines, edges);
        }
        // "none" strategy → no rebinding; latches stay on factory-default sides.
    }

}
