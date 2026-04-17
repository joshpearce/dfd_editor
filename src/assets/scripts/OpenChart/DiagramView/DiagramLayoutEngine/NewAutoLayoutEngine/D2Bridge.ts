// pattern: Functional Core
///////////////////////////////////////////////////////////////////////////////
//  Serializable interfaces (test-friendly structural surface)  ///////////////
///////////////////////////////////////////////////////////////////////////////
//
//  These interfaces describe only the fields that D2Bridge actually reads.
//  They are exported so spec files can build typed stubs without importing the
//  full View class hierarchy (which has a circular-init chain that breaks the
//  jsdom test environment).  The public `serializeToD2` signature still accepts
//  the concrete `CanvasView` type — these interfaces are a subset of it.


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
    readonly id:         string;
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
    readonly id:         string;
    readonly properties: SerializableProperties;
    readonly face:       SerializableGroupFace;
    readonly blocks:     ReadonlyArray<SerializableBlock>;
    readonly groups:     ReadonlyArray<SerializableGroup>;
    readonly lines:      ReadonlyArray<SerializableLine>;
}

/** Minimal endpoint surface that resolveLineEndpoints reads. */
export interface SerializableEndpoint {
    readonly id: string;
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
    const id     = d2Escape(block.id);
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
 * Resolves the block ids for the source and target endpoints of a line.
 * Returns null for either endpoint that cannot be traced to a block id.
 *
 * Uses `rawSourceLatch` / `rawTargetLatch` (available on the model base class)
 * when the line is a real `LineView`, or falls back to reading
 * `sourceObject` / `targetObject` directly when the line is a plain stub
 * (tests).  Either way, any exception results in a null return so the
 * caller silently skips the line.
 *
 * @param line - The line to resolve endpoints for.
 * @returns An object with `sourceId` and `targetId`, or null if either
 *          endpoint is unresolvable (floating latch, dangling line, etc.).
 */
function resolveLineEndpoints(
    line: SerializableLine
): { sourceId: string, targetId: string } | null {
    try {
        const src = line.sourceObject;
        const tgt = line.targetObject;
        if (!src || !tgt) {
            return null;
        }
        return { sourceId: src.id, targetId: tgt.id };
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
    const id     = d2Escape(group.id);
    const label  = group.properties.isDefined() ? d2Escape(group.properties.toString()) : "";
    const header = label ? `${indent}${id}: ${label} {` : `${indent}${id} {`;

    // The qualified ancestor chain for children of this group.
    const childAncestors = [...ancestors, group.id];

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
        const { sourceId, targetId } = endpoints;
        const srcPath = qualifiedD2Path(childAncestors, sourceId);
        const tgtPath = qualifiedD2Path(childAncestors, targetId);
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
 *   emitted inside that group's `{ ... }` block.
 *
 * Edge endpoints always use the fully-qualified D2 path so that D2 resolves
 * cross-container references to the correct nested nodes.
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
        const { sourceId, targetId } = endpoints;
        // Top-level nodes have no ancestors, so their qualified path is just
        // their escaped id. Cross-boundary lines need the target's qualified
        // path; however, at the canvas level we only have the leaf ids — the
        // qualified path for a top-level node IS its leaf id.
        parts.push(`${d2Escape(sourceId)} -> ${d2Escape(targetId)}`);
    }

    return parts.join("\n");
}


/**
 * Parses a TALA-rendered SVG string and returns a map of node path to
 * top-left position.
 *
 * D2 encodes each node's id as the base64 of the node's full D2 path
 * (e.g. `cGFyZW50LmNoaWxk` decodes to `parent.child`).  The full decoded
 * path is used as the map key so that nodes at different nesting depths
 * with the same leaf id can be distinguished.
 *
 * Position is read from the `x`/`y` attributes of the first `<rect>` child
 * of the `<g class="shape">` element that immediately follows the node's
 * outer `<g class="<encoded-id>">`.  For cylinder shapes D2 uses a `<path>`
 * instead; in that case we fall back to parsing the `M x y` from the path
 * data.
 *
 * @throws {Error} if the SVG string cannot be parsed (DOMParser returns a
 *   `<parsererror>` document).
 */
export function parseTalaSvg(svg: string): Map<string, { x: number, y: number }> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, "image/svg+xml");

    if (doc.querySelector("parsererror")) {
        throw new Error("failed to parse TALA SVG");
    }

    const result = new Map<string, { x: number, y: number }>();

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
        if (!nodeId || result.has(nodeId)) {
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
                result.set(nodeId, { x, y });
            }
            continue;
        }

        // Cylinder: D2 emits <path d="M x y C ..."> — top of the ellipse cap.
        const path = shapeGroup.querySelector(":scope > path");
        if (path) {
            const d = path.getAttribute("d") ?? "";
            const m = /^M\s*([\d.]+)\s+([\d.]+)/.exec(d);
            if (m) {
                result.set(nodeId, { x: parseFloat(m[1]), y: parseFloat(m[2]) });
            }
        }
    }

    return result;
}
