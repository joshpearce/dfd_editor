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
 *   - Cross-group line: a line from a top-level block to a nested block
 *     emits `block-a -> group-g.block-c` at the canvas root.
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
    type SerializableBlock,
    type SerializableGroup,
    type SerializableLine,
    type SerializableCanvas
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
            // block declarations.
            const groupHeader = "g1: G1 {";
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

        it("emits a line between two children of a group inside the group block", () => {
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

            // The edge must be inside the group's braces
            const groupOpenIdx  = output.indexOf("group-g");
            const openBraceIdx  = output.indexOf("{", groupOpenIdx);
            const closeBraceIdx = output.lastIndexOf("}");
            const arrowIdx      = output.indexOf("->");

            expect(arrowIdx).toBeGreaterThan(openBraceIdx);
            expect(arrowIdx).toBeLessThan(closeBraceIdx);

            // No edge at the canvas root level (no -> after the last `}`)
            expect(output.indexOf("->", closeBraceIdx)).toBe(-1);
        });

        it("emits the inner-group edge with qualified paths for both endpoints", () => {
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

            // Qualified paths: group-g.block-a -> group-g.block-b
            expect(output).toContain("group-g.block-a -> group-g.block-b");
        });

        it("does not emit inner-group lines at the canvas root", () => {
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

            // Arrow count must be exactly 1 (inside the group)
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

            expect(output).toContain("uuid-aws: \"AWS Private Subnet\"");
            expect(output).toContain("uuid-internet: Internet");
        });

        it("uses the instance uuid (not the template id) in the qualified path for nested edges", () => {
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

            expect(output).toContain("uuid-group.uuid-block-a -> uuid-group.uuid-block-b");
        });

    });

    // -------------------------------------------------------------------------

    describe("C2 — cross-group edge qualified paths", () => {

        it("emits a cross-boundary line as top-level-block -> qualified-nested-block", () => {
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

            // The canvas-level line should use the leaf id for block-a (top-level)
            // and the leaf id for block-c (also top-level from the canvas line
            // perspective — the canvas only knows the endpoint ids).
            // Note: canvas-level lines have no ancestor context for nested nodes;
            // they emit the raw ids as provided by resolveLineEndpoints.
            expect(output).toContain("block-a -> block-c");
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

            const result = parseTalaSvg(svg);

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

            const result = parseTalaSvg(svg);

            // Should use the FULL path "parent.child" as key, not just the leaf.
            expect(result.get("parent.child")).toEqual({ x: 50, y: 80, width: 50, height: 30 });
            // The leaf alone must NOT be present as a separate key.
            expect(result.has("child")).toBe(false);
        });

        it("uses the full decoded path as the map key for a three-level path", () => {
            const svg = buildSvg([{ id: "a.b.c", x: 7, y: 13 }]);

            const result = parseTalaSvg(svg);

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

            const result = parseTalaSvg(svg);

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

            const result = parseTalaSvg(svg);

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

            const result = parseTalaSvg(svg);

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

            const result = parseTalaSvg(svg);

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
