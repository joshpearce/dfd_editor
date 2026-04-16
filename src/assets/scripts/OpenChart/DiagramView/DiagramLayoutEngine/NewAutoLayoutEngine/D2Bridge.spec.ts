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
 *     `{ ... }` container; group emits width/height from its bounding box.
 *   - Edge-id resolution: connected line emits `sourceId -> targetId`;
 *     a line with a missing endpoint is silently skipped.
 *   - Label/ID escaping: spaces, double quotes, and D2 reserved chars
 *     (`:`, `{`, `#`, `->`) are double-quoted with internal backslashes
 *     and quotes escaped.
 *
 * parseTalaSvg:
 *   - Two sibling nodes each with a `<rect>` inside `<g class="shape">`
 *     are returned in the map with correct x/y.
 *   - Nested id (base64 of `parent.child`) → leaf id `child` is used as
 *     the map key.
 *   - `<g>` elements with no recognised class, or no `<g class="shape">`
 *     child, are silently skipped.
 *
 * @see {@link serializeToD2}
 * @see {@link parseTalaSvg}
 *
 * pattern: Functional Core
 */

import { describe, it, expect, vi } from "vitest";

// D2Bridge imports DictionaryBlock, TextBlock, BranchBlock from the Face
// hierarchy which contains a circular module-initialization chain that causes
// `AnchorPoint extends AnchorFace` to see `AnchorFace` as `undefined` at class
// definition time in vitest's jsdom environment.
//
// The bridge only reads `<FaceClass>.name` (the constructor's static `name`
// property) to build the FACE_NAME_TO_D2_SHAPE lookup.  We stub the entire
// Blocks barrel with three minimal named classes so the bridge initializes
// correctly without pulling in the problematic inheritance graph.
//
// vi.mock() is hoisted above all `import` statements by vitest, so the stub is
// in place before D2Bridge's top-level import of "./DiagramObjectView/Faces/Blocks"
// executes.
vi.mock(
    "../../DiagramObjectView/Faces/Blocks",
    () => ({
        DictionaryBlock: class DictionaryBlock {},
        TextBlock:       class TextBlock {},
        BranchBlock:     class BranchBlock {}
    })
);

import {
    serializeToD2,
    parseTalaSvg,
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
 * The face's constructor.name must be one the FACE_NAME_TO_D2_SHAPE map
 * recognises, or an unknown name (falls back to "rectangle" either way).
 * We use a plain object whose prototype carries a fixed `name` so that
 * `face.constructor.name` returns the supplied value.
 */
function makeBlock(id: string, label: string, width: number, height: number): SerializableBlock {
    const face = Object.create({ constructor: { name: "DictionaryBlock" } }) as {
        constructor: { name: string };
        width:  number;
        height: number;
    };
    face.width  = width;
    face.height = height;

    return { id, properties: makeProperties(label), face };
}

/**
 * Builds a minimal SerializableGroup stub.
 * `blocks` and `groups` are the direct children of this group.
 */
function makeGroup(
    id: string,
    label: string,
    bb: { xMin: number, yMin: number, xMax: number, yMax: number },
    blocks: SerializableBlock[] = [],
    groups: SerializableGroup[] = []
): SerializableGroup {
    return {
        id,
        properties: makeProperties(label),
        face: { boundingBox: { ...bb } },
        blocks,
        groups
    };
}

/**
 * Builds a minimal SerializableLine stub.
 * Pass `null` for sourceObject or targetObject to simulate a floating latch.
 */
function makeLine(
    sourceObject: { id: string } | null,
    targetObject: { id: string } | null
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

        it("emits group width and height derived from its bounding box", () => {
            // xMax - xMin = 300 - 0 = 300; yMax - yMin = 200 - 0 = 200
            const group  = makeGroup(
                "g1",
                "G1",
                { xMin: 0, yMin: 0, xMax: 300, yMax: 200 },
                []
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            expect(output).toMatch(/width:\s*300/);
            expect(output).toMatch(/height:\s*200/);
        });

        it("emits non-zero fractional bounding-box dimensions rounded to the nearest integer", () => {
            // Bounding box with non-integer values: 299.7 → 300; 199.3 → 199
            const group  = makeGroup(
                "g-frac",
                "",
                { xMin: 0, yMin: 0, xMax: 299.7, yMax: 199.3 },
                []
            );
            const canvas = makeCanvas([], [group], []);

            const output = serializeToD2(canvas);

            expect(output).toMatch(/width:\s*300/);
            expect(output).toMatch(/height:\s*199/);
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

        it("escapes an embedded backslash inside a label as \\\\", () => {
            // The label must also contain a quoting-trigger char (here: a space)
            // because d2Escape only escapes backslashes when the string is already
            // being quoted.  Without a quoting trigger the backslash passes through
            // unquoted and unescaped.
            const block  = makeBlock("safe-id", "path\\to node", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            // After quoting: "path\\to node" — the backslash is doubled.
            expect(output).toContain("\\\\to node");
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

        it("does not quote a plain UUID-style id (no special chars)", () => {
            const id     = "550e8400-e29b-41d4-a716-446655440000";
            const block  = makeBlock(id, "", 100, 50);
            const canvas = makeCanvas([block], [], []);

            const output = serializeToD2(canvas);

            // The id should appear unquoted (immediately followed by `:`)
            expect(output).toContain(`${id}:`);
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

            expect(result.get("alpha")).toEqual({ x: 10,  y: 20  });
            expect(result.get("beta")).toEqual({ x: 100, y: 200 });
        });

    });

    // -------------------------------------------------------------------------

    describe("nested id — base64 of parent.child", () => {

        it("uses the leaf segment of a dotted path as the map key", () => {
            // base64("parent.child") → the parser should extract "child" as the key
            const svg = buildSvg([{ id: "parent.child", x: 50, y: 80 }]);

            const result = parseTalaSvg(svg);

            // Should NOT use the full "parent.child" string as key.
            expect(result.has("parent.child")).toBe(false);
            // Should use only the leaf segment.
            expect(result.get("child")).toEqual({ x: 50, y: 80 });
        });

        it("uses only the rightmost segment even with three-level nesting", () => {
            const svg = buildSvg([{ id: "a.b.c", x: 7, y: 13 }]);

            const result = parseTalaSvg(svg);

            expect(result.has("a.b.c")).toBe(false);
            expect(result.has("a.b")).toBe(false);
            expect(result.get("c")).toEqual({ x: 7, y: 13 });
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
            expect(result.get("good-node")).toEqual({ x: 42, y: 17 });
        });

    });

});
