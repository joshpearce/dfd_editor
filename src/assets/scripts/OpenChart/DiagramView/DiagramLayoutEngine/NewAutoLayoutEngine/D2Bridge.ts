// pattern: Functional Core
import type { Point } from "./AnchorRebind";
export type { Point };

///////////////////////////////////////////////////////////////////////////////
//  Serializable interfaces (test-friendly structural surface)  ///////////////
///////////////////////////////////////////////////////////////////////////////
//
//  These interfaces describe only the fields that D2Bridge actually reads.
//  They are exported so spec files can build typed stubs without importing the
//  full View class hierarchy (which has a circular-init chain that breaks the
//  jsdom test environment).  The public `serializeToD2` signature still accepts
//  the concrete `CanvasView` type — these interfaces are a subset of it.
//
//  Node identity in the D2 output uses `instance` (the globally-unique UUID)
//  rather than `id` (the template id, e.g. "trust_boundary").  Two sibling
//  groups built from the same template share the same `id`, so using `id`
//  here would cause D2 to merge them into a single node — see
//  docs/auto-layout-boundary-overlap-plan.md.


/** Minimal property surface that serializeToD2 reads. */
export interface SerializableProperties {
    isDefined(): boolean;
    toString(): string;
}

/** Minimal face surface for a block node. */
export interface SerializableBlockFace {
    readonly width:  number;
    readonly height: number;
}

/** Minimal block surface that serializeToD2 reads. */
export interface SerializableBlock {
    readonly instance:   string;
    readonly properties: SerializableProperties;
    readonly face:       SerializableBlockFace;
}

/** Minimal bounding-box surface for a group face. */
export interface SerializableBoundingBox {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
}

/** Minimal face surface for a group node. */
export interface SerializableGroupFace {
    readonly boundingBox: SerializableBoundingBox;
}

/** Minimal group surface that serializeToD2 reads (recursive). */
export interface SerializableGroup {
    readonly instance:   string;
    readonly properties: SerializableProperties;
    readonly face:       SerializableGroupFace;
    readonly blocks:     ReadonlyArray<SerializableBlock>;
    readonly groups:     ReadonlyArray<SerializableGroup>;
    readonly lines:      ReadonlyArray<SerializableLine>;
}

/** Minimal endpoint surface that resolveLineEndpoints reads. */
export interface SerializableEndpoint {
    readonly instance: string;
}

/** Minimal line surface that serializeToD2 reads. */
export interface SerializableLine {
    readonly sourceObject: SerializableEndpoint | null;
    readonly targetObject: SerializableEndpoint | null;
}

/** Minimal canvas surface that serializeToD2 reads. */
export interface SerializableCanvas {
    readonly blocks: ReadonlyArray<SerializableBlock>;
    readonly groups: ReadonlyArray<SerializableGroup>;
    readonly lines:  ReadonlyArray<SerializableLine>;
}


///////////////////////////////////////////////////////////////////////////////
//  D2 escaping  //////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Characters that require a D2 string to be quoted.
 * Includes D2 operators written as two-char sequences.
 * Backslash is included so bare backslashes are always quoted + doubled.
 * Dot is included because D2 treats `.` as a path separator in identifiers.
 */
const QUOTE_PATTERN = /[ :{}[\];#"<>\\.]|->/;

/**
 * Returns a D2-safe representation of a string value.
 * UUIDs (all hex + hyphens, no spaces) pass through unquoted.
 * Anything else is double-quoted with internal backslashes and quotes escaped.
 */
export function d2Escape(value: string): string {
    if (!QUOTE_PATTERN.test(value)) {
        return value;
    }
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return `"${escaped}"`;
}

/**
 * Builds the fully-qualified D2 path for a node given its ancestor path
 * segments and its own id.
 *
 * In D2, a node nested inside containers is addressed by joining each
 * ancestor's escaped id with a literal `.` and appending the node's own
 * escaped id.  Segments that contain special characters must be
 * individually escaped before joining.
 *
 * Example: `qualifiedD2Path(["group-g"], "block-c")` → `"group-g.block-c"`
 *
 * @param ancestorIds - The ids of all ancestor containers, outermost first.
 * @param nodeId      - The leaf node's own id.
 * @returns The qualified D2 path as a raw string (NOT re-escaped as a unit;
 *          each segment is escaped individually and then joined with `.`).
 */
export function qualifiedD2Path(ancestorIds: string[], nodeId: string): string {
    return [...ancestorIds, nodeId].map(d2Escape).join(".");
}


///////////////////////////////////////////////////////////////////////////////
//  Serializer helpers  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


function serializeBlock(
    block: SerializableBlock,
    indent: string,
    _ancestors: string[]
): string {
    const id     = d2Escape(block.instance);
    const label  = block.properties.isDefined() ? d2Escape(block.properties.toString()) : "";
    const header = label ? `${indent}${id}: ${label} {` : `${indent}${id} {`;
    const width  = Math.round(block.face.width);
    const height = Math.round(block.face.height);
    return [
        header,
        `${indent}  shape: rectangle`,
        `${indent}  width: ${width}`,
        `${indent}  height: ${height}`,
        `${indent}}`
    ].join("\n");
}

/**
 * Resolves the source/target instance identifiers for a line.
 * Returns null for either endpoint that cannot be traced to an instance.
 *
 * Reads `line.sourceObject` / `line.targetObject` directly.  On a real
 * `LineView` those getters throw when the underlying latch has no
 * attached endpoint ("No source/target latch assigned"); the try/catch
 * here turns that throw into a null return so the caller silently
 * skips the line.  Test stubs pass through the same path because they
 * set the properties as plain fields.
 *
 * @param line - The line to resolve endpoints for.
 * @returns An object with `sourceInstance` and `targetInstance`, or null
 *          if either endpoint is unresolvable (floating latch, dangling
 *          line, etc.).
 */
function resolveLineEndpoints(
    line: SerializableLine
): { sourceInstance: string, targetInstance: string } | null {
    try {
        const src = line.sourceObject;
        const tgt = line.targetObject;
        if (!src || !tgt) {
            return null;
        }
        return { sourceInstance: src.instance, targetInstance: tgt.instance };
    } catch {
        // sourceObject / targetObject throw when the underlying latch is null.
        return null;
    }
}

function serializeGroup(
    group: SerializableGroup,
    indent: string,
    ancestors: string[]
): string {
    const id     = d2Escape(group.instance);
    const label  = group.properties.isDefined() ? d2Escape(group.properties.toString()) : "";
    const header = label ? `${indent}${id}: ${label} {` : `${indent}${id} {`;

    // The qualified ancestor chain for children of this group.
    const childAncestors = [...ancestors, group.instance];

    // TALA auto-sizes containers from their contents; emitting explicit
    // width/height from a pre-layout boundingBox (all zeros) would collapse
    // sibling containers on top of each other.
    const lines: string[] = [header];

    for (const child of group.blocks) {
        lines.push(serializeBlock(child, `${indent}  `, childAncestors));
    }
    for (const nested of group.groups) {
        lines.push(serializeGroup(nested, `${indent}  `, childAncestors));
    }

    // Lines whose both endpoints live inside this group (LCA = this group).
    for (const line of group.lines) {
        const endpoints = resolveLineEndpoints(line);
        if (!endpoints) {
            continue;
        }
        const { sourceInstance, targetInstance } = endpoints;
        const srcPath = qualifiedD2Path(childAncestors, sourceInstance);
        const tgtPath = qualifiedD2Path(childAncestors, targetInstance);
        lines.push(`${indent}  ${srcPath} -> ${tgtPath}`);
    }

    lines.push(`${indent}}`);
    return lines.join("\n");
}


///////////////////////////////////////////////////////////////////////////////
//  Public API  ///////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Walks a {@link CanvasView} (or any {@link SerializableCanvas}) and emits a
 * D2 source string suitable for piping through `d2 --layout=tala`.
 *
 * Top-level blocks and groups (recursively nested) are declared first so
 * that D2's forward-reference support for connections-to-nested-nodes works
 * without relying on source order.  Lines are emitted last at each level:
 *
 * - Lines at the canvas root (connecting two top-level nodes, or crossing
 *   group boundaries) are emitted at the top level after all node declarations.
 * - Lines whose both endpoints are inside a group (LCA = that group) are
 *   emitted inside that group's `{ ... }` block, using the qualified D2
 *   path relative to that group.
 *
 * Cross-boundary edges at the canvas root (source and target live in
 * different groups) currently emit the raw leaf `instance` for each
 * endpoint, NOT a qualified container.leaf path.  D2 resolves those by
 * unique-leaf search, which works as long as leaf instances are unique
 * across the canvas (they are — `instance` is a UUID).  This is out of
 * scope for the boundary-overlap fix and is pinned by the
 * `C2 — cross-group edge qualified paths (currently broken)` spec in
 * `D2Bridge.spec.ts`.
 */
export function serializeToD2(canvas: SerializableCanvas): string {
    const parts: string[] = [];

    // Top-level blocks
    for (const block of canvas.blocks) {
        parts.push(serializeBlock(block, "", []));
    }

    // Top-level groups (recurse inside serializeGroup)
    for (const group of canvas.groups) {
        parts.push(serializeGroup(group, "", []));
    }

    // Canvas-level lines — connecting top-level nodes or crossing boundaries.
    for (const line of canvas.lines) {
        const endpoints = resolveLineEndpoints(line);
        if (!endpoints) {
            // Floating latch or dangling line — skip silently.
            continue;
        }
        const { sourceInstance, targetInstance } = endpoints;
        // Top-level nodes have no ancestors, so their qualified path is just
        // their escaped instance.  Cross-boundary lines need the target's
        // qualified path; at the canvas level we only have the leaf instance,
        // which IS the qualified path for a top-level node.
        parts.push(`${d2Escape(sourceInstance)} -> ${d2Escape(targetInstance)}`);
    }

    return parts.join("\n");
}


/**
 * A node's placement as reported by TALA.
 *
 * Discriminated by the presence of `width` / `height` — either BOTH are
 * present (the `<rect>` path) or NEITHER is present (the rect-less path,
 * e.g. a cylinder emitted as `<path>`).  Half-populated placements are
 * not representable; parsers must produce one of the two shapes.  Using
 * a discriminated union rather than two independently-optional fields
 * lets the type system reject accidental partial populations at the
 * engine's consumer callsites (placeBlock / placeGroup).
 *
 * `x` / `y` are the top-left coordinate of the node in TALA's coordinate
 * space.  `width` / `height`, when present, are the node's rendered size.
 * For containers (groups) this is TALA's auto-computed size from the
 * container's contents, which is the only place that size is available —
 * we don't send explicit group dimensions into D2 (see `serializeGroup`).
 *
 * The rect-less branch exists because D2 emits a `<path>` (not a `<rect>`)
 * for cylinder shapes; the path's bounding rect is non-trivial to extract,
 * so we fall back to reading only the top-left coordinate.
 */
export type TalaPlacement =
    | { readonly x: number, readonly y: number, readonly width: number, readonly height: number }
    | { readonly x: number, readonly y: number, readonly width?: undefined, readonly height?: undefined };

/**
 * The start and end coordinates of a connection (edge) as reported by TALA.
 *
 * Both points are in TALA's coordinate space.  `start` corresponds to the
 * `M x y` move-to command at the beginning of the SVG path data; `end`
 * corresponds to the last absolute coordinate pair in the path data (the
 * arrowhead tip).
 *
 * @see parseTalaSvg
 */
export type TalaEdge = {
    readonly start: Point;
    readonly end:   Point;
};

/**
 * Parses a TALA-rendered SVG string and returns a map of node path to
 * its {@link TalaPlacement} and an array of {@link TalaEdge} values for
 * every connection element found in the SVG.
 *
 * **Node parsing**: D2 encodes each node's id as the base64 of the node's
 * full D2 path (e.g. `cGFyZW50LmNoaWxk` decodes to `parent.child`).  The
 * full decoded path is used as the map key so that nodes at different
 * nesting depths with the same leaf id can be distinguished.
 *
 * Position and size are read from the `x`/`y`/`width`/`height` attributes
 * of the first `<rect>` child of the `<g class="shape">` element that
 * immediately follows the node's outer `<g class="<encoded-id>">`.  For
 * cylinder shapes D2 uses a `<path>` instead; in that case we fall back
 * to parsing the `M x y` from the path data and omit the size.
 *
 * **Edge parsing**: `<g class="connection">` elements do NOT have a base64
 * class — they are matched directly by class name.  For each, the inner
 * `<path>` element's `d` attribute is inspected:
 *   - `start` is extracted from the leading `M x y` command.
 *   - `end`   is extracted from the last numeric coordinate pair in the
 *             path data (after stripping a trailing `Z`/`z` close-path).
 * Connections whose `<path>` is absent or whose `d` attribute does not
 * match either regex are silently skipped (no throw).
 *
 * @throws {Error} if the SVG string cannot be parsed (DOMParser returns a
 *   `<parsererror>` document).  `NewAutoLayoutEngine.run` propagates this
 *   throw rather than recovering — there is no partial-result mode, and
 *   the call-site's outer `try`/`catch` in `src/assets/scripts/Application/`
 *   is expected to surface the failure as a user-visible error.
 */
export function parseTalaSvg(svg: string): {
    nodes: Map<string, TalaPlacement>;
    edges: TalaEdge[];
} {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, "image/svg+xml");

    if (doc.querySelector("parsererror")) {
        throw new Error("failed to parse TALA SVG");
    }

    const nodes = new Map<string, TalaPlacement>();

    // Collect all <g> elements whose class decodes to a recognisable node id.
    const allGroups = doc.querySelectorAll("g[class]");

    for (const g of allGroups) {
        const cls = g.getAttribute("class") ?? "";

        // Skip internal D2 groups (shape, connection, blend, etc.)
        // Only try to decode classes that look like base64 (alphanumeric + /+=).
        if (!/^[A-Za-z0-9+/=]+$/.test(cls)) {
            continue;
        }

        let decoded: string;
        try {
            decoded = atob(cls);
        } catch {
            continue;
        }

        // Use the full decoded path as the map key so that nodes at different
        // nesting levels with the same leaf id can be distinguished.
        const nodeId = decoded;
        if (!nodeId || nodes.has(nodeId)) {
            // Already resolved — first occurrence wins (SVG document order).
            continue;
        }

        // Find the position from the first <g class="shape"> child's rect or path.
        const shapeGroup = g.querySelector(":scope > g.shape");
        if (!shapeGroup) {
            continue;
        }

        const rect = shapeGroup.querySelector(":scope > rect");
        if (rect) {
            const x = parseFloat(rect.getAttribute("x") ?? "NaN");
            const y = parseFloat(rect.getAttribute("y") ?? "NaN");
            if (!isNaN(x) && !isNaN(y)) {
                const width  = parseFloat(rect.getAttribute("width")  ?? "NaN");
                const height = parseFloat(rect.getAttribute("height") ?? "NaN");
                const placement: TalaPlacement = !isNaN(width) && !isNaN(height)
                    ? { x, y, width, height }
                    : { x, y };
                nodes.set(nodeId, placement);
            }
            continue;
        }

        // Cylinder: D2 emits <path d="M x y C ..."> — top of the ellipse cap.
        const path = shapeGroup.querySelector(":scope > path");
        if (path) {
            const d = path.getAttribute("d") ?? "";
            const m = /^M\s*([\d.]+)\s+([\d.]+)/.exec(d);
            if (m) {
                nodes.set(nodeId, { x: parseFloat(m[1]), y: parseFloat(m[2]) });
            }
        }
    }

    // Parse connection (edge) elements — these use the plain class "connection"
    // and are NOT base64-encoded, so they fall outside the node-parsing loop.
    const edges: TalaEdge[] = [];
    const connectionGroups = doc.querySelectorAll("g.connection");

    for (const connG of connectionGroups) {
        const pathEl = connG.querySelector("path");
        if (!pathEl) {
            continue;
        }
        const d = pathEl.getAttribute("d") ?? "";

        // Extract the start point from the leading "M x y" command.
        const startMatch = /^M\s*([-\d.]+)[,\s]+([-\d.]+)/.exec(d);
        if (!startMatch) {
            continue;
        }

        // Extract the end point from the last numeric pair, after stripping
        // any trailing close-path command (Z or z).
        const dStripped = d.replace(/[Zz]\s*$/, "").trimEnd();
        const endMatch = /([-\d.]+)[,\s]+([-\d.]+)\s*$/.exec(dStripped);
        if (!endMatch) {
            continue;
        }

        edges.push({
            start: { x: parseFloat(startMatch[1]), y: parseFloat(startMatch[2]) },
            end:   { x: parseFloat(endMatch[1]),   y: parseFloat(endMatch[2])   }
        });
    }

    return { nodes, edges };
}
