// @vitest-environment jsdom

/**
 * @file D2Bridge.spec.ts
 *
 * Unit tests for `serializeToD2` and `parseTalaSvg`.
 *
 * Key contracts verified:
 *
 * serializeToD2:
 *   - Happy path: 2 blocks + 1 line → one D2 declaration per block
 *     (with matching width/height) + one `source -> target` connection.
 *   - Groups: a block nested in a group is emitted inside the group's
 *     `{ ... }` container. Groups themselves do NOT emit width/height — TALA
 *     auto-sizes containers from their contents.
 *   - Nested lines (C1): a line connecting two blocks inside a group is
 *     emitted inside the group's `{ ... }` block, not at the canvas root.
 *   - Edge qualified paths (C2): edge endpoints inside groups use the
 *     fully-qualified D2 path (e.g. `group-g.block-c`); top-level endpoints
 *     use the plain leaf id.
 *   - Cross-group line (currently broken): a line from a top-level block to
 *     a nested block emits the RAW leaf id (`block-a -> block-c`) at the
 *     canvas root, NOT the qualified `group-g.block-c`.  The "C2 —
 *     cross-group edge qualified paths (currently broken)" test pins this
 *     status quo; see the comment in `serializeToD2` for the full
 *     explanation and the plan for a proper fix.
 *   - Edge-id resolution: connected line emits `sourceId -> targetId`;
 *     a line with a missing endpoint is silently skipped.
 *   - Label/ID escaping: spaces, double quotes, and D2 reserved chars
 *     (`:`, `{`, `#`, `->`) are double-quoted with internal backslashes
 *     and quotes escaped.
 *
 * parseTalaSvg:
 *   - Two sibling nodes each with a `<rect>` inside `<g class="shape">`
 *     are returned in the map with correct x/y.
 *   - Nested id (base64 of `parent.child`) → full path `parent.child` is
 *     used as the map key (C2).
 *   - `<g>` elements with no recognised class, or no `<g class="shape">`
 *     child, are silently skipped.
 *   - Malformed SVG throws an Error (M5).
 *
 * @see {@link serializeToD2}
 * @see {@link parseTalaSvg}
 *
 * pattern: Functional Core
 */

import { describe, it, expect } from "vitest";

import {
    serializeToD2,
    parseTalaSvg,
    qualifiedD2Path,
    d2Escape,
    type SerializableBlock,
    type SerializableGroup,
    type SerializableLine,
    type SerializableCanvas,
    type TalaEdge
} from "./D2Bridge";


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Minimal stub for the `properties` object that D2Bridge reads via
 * `isDefined()` and `toString()`.
 */
function makeProperties(label: string): { isDefined(): boolean, toString(): string } {
    return {
        isDefined: () => label.length > 0,
        toString:  () => label
    };
}

/**
 * Builds a minimal SerializableBlock stub for the serializer.
 *
 * @param instance
 *  The unique D2 node identifier — in production this is the model's
 *  `instance` uuid, not the template `id`.  Tests pass human-readable
 *  strings here for legibility.
 */
function makeBlock(instance: string, label: string, width: number, height: number): SerializableBlock {
    return {
        instance,
        properties: makeProperties(label),
        face: { width, height }
    };
}

/**
 * Builds a minimal SerializableGroup stub.
 * `blocks` and `groups` are the direct children of this group.
 * `lines` are lines whose LCA is this group (both endpoints inside).
 */
function makeGroup(
    instance: string,
    label: string,
    bb: { xMin: number, yMin: number, xMax: number, yMax: number },
    blocks: SerializableBlock[] = [],
    groups: SerializableGroup[] = [],
    lines:  SerializableLine[]  = []
): SerializableGroup {
    return {
        instance,
        properties: makeProperties(label),
        face: { boundingBox: { ...bb } },
        blocks,
        groups,
        lines
    };
}

/**
 * Builds a minimal SerializableLine stub.
 * Pass `null` for sourceObject or targetObject to simulate a floating latch.
 */
function makeLine(
    sourceObject: { instance: string } | null,
    targetObject: { instance: string } | null
): SerializableLine {
    return { sourceObject, targetObject };
}

/**
 * Builds a minimal SerializableCanvas stub with the given top-level blocks,
 * groups, and lines.
 */
function makeCanvas(
    blocks: SerializableBlock[],
    groups: SerializableGroup[],
    lines:  SerializableLine[]
): SerializableCanvas {
    return { blocks, groups, lines };
}


///////////////////////////////////////////////////////////////////////////////
//  qualifiedD2Path  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("qualifiedD2Path", () => {

    it("returns the escaped leaf id when there are no ancestors", () => {
        expect(qualifiedD2Path([], "block-a")).toBe("block-a");
    });

    it("joins ancestor and leaf with a dot", () => {
        expect(qualifiedD2Path(["group-g"], "block-c")).toBe("group-g.block-c");
    });

    it("joins multiple ancestors with dots", () => {
        expect(qualifiedD2Path(["outer", "inner"], "leaf")).toBe("outer.inner.leaf");
    });

    it("quotes segments that contain spaces", () => {
        expect(qualifiedD2Path(["my group"], "my block")).toBe("\"my group\".\"my block\"");
    });

});


///////////////////////////////////////////////////////////////////////////////
//  serializeToD2  /////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("serializeToD2", () => {

    describe("happy path — 2 blocks + 1 line", () => {

        it("emits one D2 declaration per block containing explicit width and height", () => {
            const blockA = makeBlock("block-a", "Block A", 120, 60);
            const blockB = makeBlock("block-b", "Block B", 200, 80);
            const line   = makeLine(blockA, blockB);
            const canvas = makeCanvas([blockA, blockB], [], [line]);

            const output = serializeToD2(canvas);

            // Both block ids must appear in the output
            expect(output).toContain("block-a");
            expect(output).toContain("block-b");

            // Each block declaration must carry the correct width and height
            expect(output).toMatch(/width:\s*120/);
            expect(output).toMatch(/height:\s*60/);
            expect(output).toMatch(/width:\s*200/);
            expect(output).toMatch(/height:\s*80/);
        });

        it("emits the correct source -> target connection", () => {
            const blockA = makeBlock("block-a", "A", 100, 50);
            const blockB = makeBlock("block-b", "B", 100, 50);
            const line   = makeLine(blockA, blockB);
            const canvas = makeCanvas([blockA, blockB], [], [line]);

            const output = serializeToD2(canvas);

            expect(output).toContain("block-a -> block-b");
        });

        it("emitted width/height values match the face dimensions from the fixture", () => {
            const blockA = makeBlock("node-1", "Node 1", 150, 75);
            const canvas = makeCanvas([blockA], [], []);

            const output = serializeToD2(canvas);

            // Verify that Math.round(150) = 150 and Math.round(75) = 75 are present.
            expect(output).toMatch(/width:\s*150/);
            expect(output).toMatch(/height:\s*75/);
        });

    });

    // -------------------------------------------------------------------------

    describe("groups — nested block inside a group", () => {

        it("emits the child block's id after the group's opening brace and before its closing brace", () => {
            const child  = makeBlock("child-block", "Child", 80, 40);
            const group  = makeGroup(
                "my-group",
                "My Group",
                { xMin: 0, yMin: 0, xMax: 300, yMax: 200 },
                [child]
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            // Group opens a block
            const groupOpenIdx  = output.indexOf("my-group");
            const openBraceIdx  = output.indexOf("{", groupOpenIdx);
            const closeBraceIdx = output.lastIndexOf("}");
            const childIdx      = output.indexOf("child-block");

            expect(groupOpenIdx).toBeGreaterThanOrEqual(0);
            expect(openBraceIdx).toBeGreaterThanOrEqual(0);
            expect(childIdx).toBeGreaterThan(openBraceIdx);
            expect(childIdx).toBeLessThan(closeBraceIdx);
        });

        it("does not emit width or height for a group (TALA auto-sizes containers)", () => {
            // Pre-layout bounding boxes are all-zero, and even when non-zero
            // they do not reflect the post-layout container size. Emitting
            // `width:` / `height:` would constrain TALA and collapse sibling
            // containers at the origin — see auto-layout-boundary-overlap fix.
            const group  = makeGroup(
                "g1",
                "G1",
                { xMin: 0, yMin: 0, xMax: 300, yMax: 200 },
                [makeBlock("inner", "Inner", 100, 50)]
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            // The inner block still carries width/height. Only the group must not.
            // Split on the group's opening brace and closing brace to isolate the
            // group-level lines (direct properties of the group), excluding nested
            // block declarations.  Rebuild the header via `d2Escape` so this test
            // stays in sync with escape-rule changes (e.g. if unconditionally
            // quoting labels ever becomes the policy).
            const groupHeader = `${d2Escape("g1")}: ${d2Escape("G1")} {`;
            const headerIdx   = output.indexOf(groupHeader);
            expect(headerIdx).toBeGreaterThanOrEqual(0);

            // Between the header and the first nested `{` (the inner block's
            // opening brace) there should be no `width:` or `height:` line —
            // that slice represents lines that are direct properties of the group.
            const afterHeader    = headerIdx + groupHeader.length;
            const firstChildOpen = output.indexOf("{", afterHeader);
            const groupOwnLines  = output.slice(afterHeader, firstChildOpen);

            expect(groupOwnLines).not.toMatch(/width:/);
            expect(groupOwnLines).not.toMatch(/height:/);
        });

    });

    // -------------------------------------------------------------------------

    describe("C1 — nested lines inside a group", () => {

        it("emits the edge at the canvas root using absolute paths rooted at the canvas", () => {
            const blockA = makeBlock("block-a", "A", 100, 50);
            const blockB = makeBlock("block-b", "B", 100, 50);
            const innerLine = makeLine(blockA, blockB);
            const group = makeGroup(
                "group-g",
                "G",
                { xMin: 0, yMin: 0, xMax: 400, yMax: 300 },
                [blockA, blockB],
                [],
                [innerLine]
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            // Absolute path from canvas root: group-g.block-a -> group-g.block-b
            expect(output).toContain("group-g.block-a -> group-g.block-b");

            // The edge must be OUTSIDE the group's braces (at canvas root),
            // not inside — emitting inside the group's scope would either
            // require bare names (which D2 only resolves against direct
            // children of the current scope) or group-prefixed paths (which
            // D2 auto-materializes as a phantom container).
            const closeBraceIdx = output.lastIndexOf("}");
            expect(output.indexOf("->", closeBraceIdx)).toBeGreaterThan(closeBraceIdx);
        });

        it("emits exactly one arrow at the canvas root for a single inner-group edge", () => {
            const blockA = makeBlock("block-a", "A", 100, 50);
            const blockB = makeBlock("block-b", "B", 100, 50);
            const innerLine = makeLine(blockA, blockB);
            const group = makeGroup(
                "group-g",
                "G",
                { xMin: 0, yMin: 0, xMax: 400, yMax: 300 },
                [blockA, blockB],
                [],
                [innerLine]
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            const arrowCount = (output.match(/->/g) ?? []).length;
            expect(arrowCount).toBe(1);
        });

    });

    // -------------------------------------------------------------------------

    describe("instance-based node identity — sibling groups do not collide", () => {

        // Regression: pre-fix, production view objects exposed the template id
        // on `.id` (e.g. two trust-boundary siblings both named `trust_boundary`).
        // D2 merged redeclarations of the same identifier into one node, which
        // collapsed sibling containers into a single overlapping shape.
        it("emits distinct D2 declarations for each unique instance even when labels differ", () => {
            const aws      = makeGroup(
                "uuid-aws",
                "AWS Private Subnet",
                { xMin: 0, yMin: 0, xMax: 100, yMax: 100 }
            );
            const internet = makeGroup(
                "uuid-internet",
                "Internet",
                { xMin: 0, yMin: 0, xMax: 100, yMax: 100 }
            );
            const canvas   = makeCanvas([], [aws, internet], []);

            const output = serializeToD2(canvas);

            // Rebuild both headers via `d2Escape` so these assertions stay in
            // sync with escape-rule changes (e.g. if unconditionally quoting
            // labels ever becomes the policy).
            expect(output).toContain(
                `${d2Escape("uuid-aws")}: ${d2Escape("AWS Private Subnet")}`
            );
            expect(output).toContain(
                `${d2Escape("uuid-internet")}: ${d2Escape("Internet")}`
            );
        });

        it("uses the instance uuid (not the template id) when emitting nested edges", () => {
            const blockA = makeBlock("uuid-block-a", "A", 100, 50);
            const blockB = makeBlock("uuid-block-b", "B", 100, 50);
            const line   = makeLine(blockA, blockB);
            const group  = makeGroup(
                "uuid-group",
                "G",
                { xMin: 0, yMin: 0, xMax: 400, yMax: 300 },
                [blockA, blockB],
                [],
                [line]
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            // Absolute path rooted at canvas: uuid-group.uuid-block-a -> uuid-group.uuid-block-b
            expect(output).toContain("uuid-group.uuid-block-a -> uuid-group.uuid-block-b");
        });

    });

    // -------------------------------------------------------------------------

    describe("C2 — cross-group edge uses absolute path for nested endpoint", () => {

        it("emits a cross-boundary line using the absolute path for the nested endpoint", () => {
            // top-level block-a → nested group-g.block-c
            const blockA = makeBlock("block-a", "A", 100, 50);
            const blockC = makeBlock("block-c", "C", 80, 40);
            const group  = makeGroup(
                "group-g",
                "G",
                { xMin: 0, yMin: 0, xMax: 400, yMax: 300 },
                [blockC]
            );
            // Cross-boundary line lives at the canvas root
            const crossLine = makeLine(blockA, blockC);
            const canvas = makeCanvas([blockA], [group], [crossLine]);

            const output = serializeToD2(canvas);

            // Cross-boundary endpoints use absolute paths rooted at the
            // canvas, so D2 connects to the pre-declared nested block
            // instead of fabricating a phantom top-level stub named
            // `block-c`.
            expect(output).toContain("block-a -> group-g.block-c");
            expect(output).not.toMatch(/^block-a -> block-c$/m);
        });

    });

    // -------------------------------------------------------------------------

    describe("edge-id resolution", () => {

        it("emits a connection when both source and target are present", () => {
            const src    = makeBlock("src-id", "", 100, 50);
            const tgt    = makeBlock("tgt-id", "", 100, 50);
            const line   = makeLine(src, tgt);
            const canvas = makeCanvas([src, tgt], [], [line]);

            const output = serializeToD2(canvas);

            expect(output).toContain("src-id -> tgt-id");
        });

        it("skips a line whose source endpoint is null", () => {
            const tgt    = makeBlock("tgt-id", "", 100, 50);
            const line   = makeLine(null, tgt);
            const canvas = makeCanvas([tgt], [], [line]);

            const output = serializeToD2(canvas);

            // No arrow notation should appear at all
            expect(output).not.toContain("->");
        });

        it("skips a line whose target endpoint is null", () => {
            const src    = makeBlock("src-id", "", 100, 50);
            const line   = makeLine(src, null);
            const canvas = makeCanvas([src], [], [line]);

            const output = serializeToD2(canvas);

            expect(output).not.toContain("->");
        });

        it("emits only the valid connection when one line is complete and another is dangling", () => {
            const blockA = makeBlock("a", "", 80, 40);
            const blockB = makeBlock("b", "", 80, 40);
            const good   = makeLine(blockA, blockB);
            const bad    = makeLine(null, blockB);
            const canvas = makeCanvas([blockA, blockB], [], [good, bad]);

            const output = serializeToD2(canvas);

            // Exactly one arrow
            const arrowCount = (output.match(/->/g) ?? []).length;
            expect(arrowCount).toBe(1);
            expect(output).toContain("a -> b");
        });

        it("skips a line that throws when accessing endpoints (I1 — null-safe resolution)", () => {
            // Simulate a LineView where sourceObject getter throws (null latch).
            const throwingLine: SerializableLine = {
                get sourceObject(): { instance: string } | null {
                    throw new Error("No source latch assigned.");
                },
                targetObject: { instance: "tgt-id" }
            };
            const tgt    = makeBlock("tgt-id", "", 100, 50);
            const canvas = makeCanvas([tgt], [], [throwingLine]);

            const output = serializeToD2(canvas);

            expect(output).not.toContain("->");
        });

    });

    // -------------------------------------------------------------------------

    describe("label/id escaping", () => {

        it("wraps an id containing a space in double quotes", () => {
            const block  = makeBlock("my node", "", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            expect(output).toContain("\"my node\"");
        });

        it("escapes an embedded double quote inside a label as \\\"", () => {
            const block  = makeBlock("safe-id", "say \"hello\"", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            // The label portion must contain escaped quote characters.
            expect(output).toContain("\\\"hello\\\"");
        });

        it("escapes a bare backslash in a label as \\\\ (backslash alone triggers quoting)", () => {
            // A bare backslash is now in QUOTE_PATTERN, so it triggers quoting even
            // without any other special char.  The result is a quoted string with
            // the backslash doubled: "path\\to".
            const block  = makeBlock("safe-id", "path\\to", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            // After quoting: "path\\to" — backslash doubled, whole value quoted.
            expect(output).toContain("\"path\\\\to\"");
        });

        it("wraps a label containing a colon in double quotes", () => {
            const block  = makeBlock("safe-id", "key: value", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            expect(output).toContain("\"key: value\"");
        });

        it("wraps a label containing a # in double quotes", () => {
            const block  = makeBlock("safe-id", "item #1", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            expect(output).toContain("\"item #1\"");
        });

        it("wraps a label containing -> in double quotes", () => {
            const block  = makeBlock("safe-id", "a -> b", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            expect(output).toContain("\"a -> b\"");
        });

        it("wraps an id containing a dot in double quotes (dot is a D2 path separator)", () => {
            // D2 treats `foo.bar` as a nested-path reference in identifiers.
            // A dot in the id must force quoting so it is treated as a literal.
            const block  = makeBlock("foo.bar", "", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            expect(output).toContain("\"foo.bar\"");
        });

        it("does not quote a plain UUID-style id (no special chars)", () => {
            const id     = "550e8400-e29b-41d4-a716-446655440000";
            const block  = makeBlock(id, "", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            // The id should appear unquoted (immediately followed by a space then `{`)
            expect(output).toContain(`${id} {`);
        });

    });

});


///////////////////////////////////////////////////////////////////////////////
//  parseTalaSvg  //////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("parseTalaSvg", () => {

    /**
     * Builds a minimal D2/TALA SVG string containing the supplied nodes.
     * Each node is encoded as:
     *   <g class="<base64(id)>">
     *     <g class="shape">
     *       <rect x="<x>" y="<y>" width="50" height="30"/>
     *     </g>
     *   </g>
     */
    function buildSvg(nodes: Array<{ id: string, x: number, y: number }>): string {
        const inner = nodes.map(({ id, x, y }) => {
            const cls = btoa(id);
            return [
                `  <g class="${cls}">`,
                "    <g class=\"shape\">",
                `      <rect x="${x}" y="${y}" width="50" height="30"/>`,
                "    </g>",
                "  </g>"
            ].join("\n");
        }).join("\n");

        return `<svg xmlns="http://www.w3.org/2000/svg">\n${inner}\n</svg>`;
    }

    // -------------------------------------------------------------------------

    describe("two sibling nodes — basic rectangle positions", () => {

        it("returns both node ids with their correct x/y coordinates", () => {
            const svg = buildSvg([
                { id: "alpha", x: 10,  y: 20  },
                { id: "beta",  x: 100, y: 200 }
            ]);

            const { nodes: result } = parseTalaSvg(svg);

            expect(result.size).toBe(2);

            // buildSvg uses width=50, height=30 for every rect.
            expect(result.get("alpha")).toEqual({ x: 10,  y: 20,  width: 50, height: 30 });
            expect(result.get("beta")).toEqual({ x: 100, y: 200, width: 50, height: 30 });
        });

    });

    // -------------------------------------------------------------------------

    describe("C2 — nested id: full path is the map key", () => {

        it("uses the full decoded path as the map key for a two-level path", () => {
            // base64("parent.child") → the parser should use "parent.child" as the key
            const svg = buildSvg([{ id: "parent.child", x: 50, y: 80 }]);

            const { nodes: result } = parseTalaSvg(svg);

            // Should use the FULL path "parent.child" as key, not just the leaf.
            expect(result.get("parent.child")).toEqual({ x: 50, y: 80, width: 50, height: 30 });
            // The leaf alone must NOT be present as a separate key.
            expect(result.has("child")).toBe(false);
        });

        it("uses the full decoded path as the map key for a three-level path", () => {
            const svg = buildSvg([{ id: "a.b.c", x: 7, y: 13 }]);

            const { nodes: result } = parseTalaSvg(svg);

            expect(result.get("a.b.c")).toEqual({ x: 7, y: 13, width: 50, height: 30 });
            expect(result.has("c")).toBe(false);
            expect(result.has("b.c")).toBe(false);
        });

    });

    // -------------------------------------------------------------------------

    describe("unrecognised / unclassed <g> elements", () => {

        it("skips a <g> with no class attribute", () => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g>
    <g class="shape">
      <rect x="5" y="5" width="50" height="30"/>
    </g>
  </g>
</svg>`;

            const { nodes: result } = parseTalaSvg(svg);

            expect(result.size).toBe(0);
        });

        it("skips a <g> whose class contains non-base64 characters (D2 internal marker)", () => {
            // D2 uses plain class names like "shape", "connection", "blend", etc.
            // These must not be decoded as node ids.
            const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g class="shape">
    <rect x="1" y="2" width="40" height="20"/>
  </g>
  <g class="connection">
    <rect x="3" y="4" width="40" height="20"/>
  </g>
</svg>`;

            const { nodes: result } = parseTalaSvg(svg);

            expect(result.size).toBe(0);
        });

        it("skips a <g> with a valid base64 class but no <g class=\"shape\"> child", () => {
            const id  = "orphan";
            const cls = btoa(id);
            const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g class="${cls}">
    <rect x="9" y="9" width="50" height="30"/>
  </g>
</svg>`;

            const { nodes: result } = parseTalaSvg(svg);

            expect(result.size).toBe(0);
        });

        it("still returns valid nodes when mixed with skippable elements", () => {
            const goodCls = btoa("good-node");
            const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g class="shape-internal-marker">
    <rect x="0" y="0" width="50" height="30"/>
  </g>
  <g class="${goodCls}">
    <g class="shape">
      <rect x="42" y="17" width="50" height="30"/>
    </g>
  </g>
</svg>`;

            const { nodes: result } = parseTalaSvg(svg);

            expect(result.size).toBe(1);
            expect(result.get("good-node")).toEqual({ x: 42, y: 17, width: 50, height: 30 });
        });

    });

    // -------------------------------------------------------------------------

    describe("M5 — malformed SVG throws", () => {

        it("throws an Error when the SVG string is not valid XML", () => {
            const badSvg = "<svg><unclosed";

            expect(() => parseTalaSvg(badSvg)).toThrow("failed to parse TALA SVG");
        });

    });

});


///////////////////////////////////////////////////////////////////////////////
//  parseTalaSvg — edges  //////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("parseTalaSvg — edges", () => {

    /**
     * Builds an SVG containing the given nodes (base64-encoded) and the
     * given connection elements (raw <g class="connection"> with a path).
     */
    function buildSvgWithConnections(
        nodes: Array<{ id: string, x: number, y: number }>,
        connections: Array<{ d: string }>
    ): string {
        const nodeMarkup = nodes.map(({ id, x, y }) => {
            const cls = btoa(id);
            return [
                `  <g class="${cls}">`,
                "    <g class=\"shape\">",
                `      <rect x="${x}" y="${y}" width="50" height="30"/>`,
                "    </g>",
                "  </g>"
            ].join("\n");
        }).join("\n");

        const connMarkup = connections.map(({ d }) => [
            "  <g class=\"connection\">",
            `    <path d="${d}"/>`,
            "  </g>"
        ].join("\n")).join("\n");

        const inner = [nodeMarkup, connMarkup].filter(Boolean).join("\n");
        return `<svg xmlns="http://www.w3.org/2000/svg">\n${inner}\n</svg>`;
    }

    // -------------------------------------------------------------------------

    it("two connections → two TalaEdges with correct start/end", () => {
        const svg = buildSvgWithConnections([], [
            { d: "M 10 20 L 100 200" },
            { d: "M 30 40 L 300 400" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(2);

        const first: TalaEdge = edges[0];
        expect(first.start).toEqual({ x: 10, y: 20 });
        expect(first.end).toEqual({ x: 100, y: 200 });

        const second: TalaEdge = edges[1];
        expect(second.start).toEqual({ x: 30, y: 40 });
        expect(second.end).toEqual({ x: 300, y: 400 });
    });

    // -------------------------------------------------------------------------

    it("no <path> child → skipped silently", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g class="connection">
    <rect x="0" y="0" width="10" height="10"/>
  </g>
</svg>`;

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(0);
    });

    it("malformed path d falls through silently — unparseable d attribute", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g class="connection">
    <path d="not-a-valid-path"/>
  </g>
</svg>`;

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(0);
    });

    // -------------------------------------------------------------------------

    it("cubic Bezier path C x1 y1 x2 y2 x y → start is M point, end is curve endpoint", () => {
        // TALA typically emits cubic Beziers for curved connection paths.
        const svg = buildSvgWithConnections([], [
            { d: "M 10 20 C 30 40 50 60 70 80" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 10, y: 20 });
        expect(edges[0].end).toEqual({ x: 70, y: 80 });
    });

    it("multi-segment cubic Bezier → end is the last curve's endpoint", () => {
        const svg = buildSvgWithConnections([], [
            { d: "M 10 20 C 30 40 50 60 70 80 C 90 100 110 120 130 140" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 10, y: 20 });
        expect(edges[0].end).toEqual({ x: 130, y: 140 });
    });

    it("comma-separated coordinates → parsed correctly", () => {
        const svg = buildSvgWithConnections([], [
            { d: "M 10,20 C 30,40 50,60 70,80" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 10, y: 20 });
        expect(edges[0].end).toEqual({ x: 70, y: 80 });
    });

    it("negative coordinates → parsed correctly", () => {
        const svg = buildSvgWithConnections([], [
            { d: "M -10 -20 L -100 -200" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: -10, y: -20 });
        expect(edges[0].end).toEqual({ x: -100, y: -200 });
    });

    it("implicit negative-sign separator (L 100-20) → end extracted correctly", () => {
        // SVG allows omitting the separator when the next number starts with a minus,
        // e.g. "L 100-20" is valid and means L x=100 y=-20.
        const svg = buildSvgWithConnections([], [
            { d: "M 10 20 L 100-200" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 10, y: 20 });
        expect(edges[0].end).toEqual({ x: 100, y: -200 });
    });

    it("trailing Z with no space before it (L100,200Z) → end extracted correctly", () => {
        const svg = buildSvgWithConnections([], [
            { d: "M 10 20 L 100,200Z" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 10, y: 20 });
        expect(edges[0].end).toEqual({ x: 100, y: 200 });
    });

    it("polyline with bend points → `points` captures every vertex in order", () => {
        // TALA emits orthogonal U-routes as `M x0 y0 L x1 y1 L x2 y2 L x3 y3`.
        // The rebind pass needs the intermediate (x1,y1)/(x2,y2) vertices so it
        // can steer the line's handle onto TALA's bend, so `points` must
        // surface them in order.
        const svg = buildSvgWithConnections([], [
            { d: "M 150 100 L 250 100 L 250 200 L 350 100" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].points).toEqual([
            { x: 150, y: 100 },
            { x: 250, y: 100 },
            { x: 250, y: 200 },
            { x: 350, y: 100 }
        ]);
        expect(edges[0].start).toEqual(edges[0].points[0]);
        expect(edges[0].end).toEqual(edges[0].points[edges[0].points.length - 1]);
    });

    it("straight two-point polyline → `points` has exactly the two endpoints", () => {
        const svg = buildSvgWithConnections([], [
            { d: "M 10 20 L 100 200" }
        ]);

        const { edges } = parseTalaSvg(svg);

        expect(edges).toHaveLength(1);
        expect(edges[0].points).toEqual([
            { x: 10, y: 20 },
            { x: 100, y: 200 }
        ]);
    });

    it("connection group with arrowhead sibling <path> → only the direct-child edge path is read", () => {
        // Real D2 connection groups contain the edge <path> plus nested arrowhead
        // paths. The selector :scope > path must match only the direct child.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g class="connection">
    <path d="M 5 10 L 50 100"/>
    <g class="arrowhead">
      <path d="M 999 999 L 888 888"/>
    </g>
  </g>
</svg>`;

        const { edges } = parseTalaSvg(svg);

        // Only the direct-child edge path should be read; arrowhead path ignored.
        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 5, y: 10 });
        expect(edges[0].end).toEqual({ x: 50, y: 100 });
    });

    it("node parsing and edge parsing coexist independently", () => {
        // An SVG with both a base64-encoded node and a connection element.
        const nodeId = "my-node";
        const svg = buildSvgWithConnections(
            [{ id: nodeId, x: 5, y: 15 }],
            [{ d: "M 1 2 L 3 4" }]
        );

        const { nodes, edges } = parseTalaSvg(svg);

        // Node was parsed correctly.
        expect(nodes.size).toBe(1);
        expect(nodes.get(nodeId)).toEqual({ x: 5, y: 15, width: 50, height: 30 });

        // Edge was parsed correctly.
        expect(edges).toHaveLength(1);
        expect(edges[0].start).toEqual({ x: 1, y: 2 });
        expect(edges[0].end).toEqual({ x: 3, y: 4 });
    });

});
