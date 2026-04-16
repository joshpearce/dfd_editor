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
    readonly constructor: { readonly name: string };
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
//  Shape mapping  ////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Maps a BlockFace concrete class name to the D2 shape keyword.
 * Keyed by `constructor.name` so we avoid the `Function` type.
 * Unknown face types fall back to `rectangle`.
 */
// Keys are face class names — stable because Vite preserves class names. Revisit in Step 3 if TALA needs shape differentiation.
const FACE_NAME_TO_D2_SHAPE: Record<string, string> = {
    DictionaryBlock: "rectangle",
    TextBlock:       "rectangle",
    BranchBlock:     "rectangle"
};

function d2ShapeFor(face: object): string {
    return FACE_NAME_TO_D2_SHAPE[face.constructor.name] ?? "rectangle";
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
function d2Escape(value: string): string {
    if (!QUOTE_PATTERN.test(value)) {
        return value;
    }
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return `"${escaped}"`;
}


///////////////////////////////////////////////////////////////////////////////
//  Serializer helpers  ///////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


function serializeBlock(block: SerializableBlock, indent: string): string {
    const id     = d2Escape(block.id);
    const label  = block.properties.isDefined() ? d2Escape(block.properties.toString()) : "";
    const header = label ? `${indent}${id}: ${label} {` : `${indent}${id} {`;
    const shape  = d2ShapeFor(block.face);
    const width  = Math.round(block.face.width);
    const height = Math.round(block.face.height);
    return [
        header,
        `${indent}  shape: ${shape}`,
        `${indent}  width: ${width}`,
        `${indent}  height: ${height}`,
        `${indent}}`
    ].join("\n");
}

function serializeGroup(group: SerializableGroup, indent: string): string {
    const id     = d2Escape(group.id);
    const label  = group.properties.isDefined() ? d2Escape(group.properties.toString()) : "";
    const header = label ? `${indent}${id}: ${label} {` : `${indent}${id} {`;
    const bb     = group.face.boundingBox;
    const width  = Math.round(bb.xMax - bb.xMin);
    const height = Math.round(bb.yMax - bb.yMin);

    const lines: string[] = [
        header,
        `${indent}  width: ${width}`,
        `${indent}  height: ${height}`
    ];

    for (const child of group.blocks) {
        lines.push(serializeBlock(child, `${indent}  `));
    }
    for (const nested of group.groups) {
        lines.push(serializeGroup(nested, `${indent}  `));
    }

    lines.push(`${indent}}`);
    return lines.join("\n");
}

/**
 * Resolves the block ids for the source and target endpoints of a line.
 * Returns null for either endpoint that cannot be traced to a block id.
 * Lines with unresolved endpoints are skipped by the caller (documented
 * here because floating latches — not yet connected — are the common case).
 */
function resolveLineEndpoints(
    line: SerializableLine
): { sourceId: string, targetId: string } | null {
    const src = line.sourceObject;
    const tgt = line.targetObject;
    if (!src || !tgt) {
        return null;
    }
    // sourceObject / targetObject are the latch parents — they are blocks.
    return { sourceId: src.id, targetId: tgt.id };
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
 * without relying on source order. Lines are emitted last.
 */
export function serializeToD2(canvas: SerializableCanvas): string {
    const parts: string[] = [];

    // Top-level blocks
    for (const block of canvas.blocks) {
        parts.push(serializeBlock(block, ""));
    }

    // Top-level groups (recurse inside serializeGroup)
    for (const group of canvas.groups) {
        parts.push(serializeGroup(group, ""));
    }

    // Lines — emitted after all containers
    for (const line of canvas.lines) {
        const endpoints = resolveLineEndpoints(line);
        if (!endpoints) {
            // Floating latch or dangling line — skip silently.
            continue;
        }
        const { sourceId, targetId } = endpoints;
        parts.push(`${d2Escape(sourceId)} -> ${d2Escape(targetId)}`);
    }

    return parts.join("\n");
}


/**
 * Parses a TALA-rendered SVG string and returns a map of node id to
 * top-left position.
 *
 * D2 encodes each node's id as the base64 of the node's full D2 path
 * (e.g. `cGFyZW50LmNoaWxk` decodes to `parent.child`).  We take only the
 * last `.`-separated segment as the canonical node id so that both
 * top-level nodes and nested nodes resolve to the same id the DFD model
 * uses.
 *
 * Position is read from the `x`/`y` attributes of the first `<rect>` child
 * of the `<g class="shape">` element that immediately follows the node's
 * outer `<g class="<encoded-id>">`.  For cylinder shapes D2 uses a `<path>`
 * instead; in that case we fall back to parsing the `M x y` from the path
 * data.
 */
export function parseTalaSvg(svg: string): Map<string, { x: number, y: number }> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, "image/svg+xml");

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

        // D2 encodes the full dotted path; we want only the leaf segment.
        const segments = decoded.split(".");
        const nodeId = segments[segments.length - 1];
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
