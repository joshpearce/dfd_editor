/**
 * @file PolyLine.endpointMove.spec.ts
 *
 * Step 3 (issue #19) — interactive + round-trip integration spec.
 *
 * These tests drive a real block move through the PowerEditPlugin /
 * BlockMover harness and assert that PolyLine.calculateLayout's end-elbow
 * correction (Step 2) fires correctly, produces axis-aligned end segments,
 * and that the corrected geometry survives a full export/import round-trip.
 *
 * ## Construction approach: (a) — real driveDrag BlockMover harness
 *
 * All five tests wire a PolyLine's node1 to a real block anchor so that
 * `BlockMover.moveSubject → MoveObjectsBy → block.moveBy → AnchorFace.moveBy
 * → LatchView.moveBy → line.handleUpdate → PolyLine.calculateLayout` triggers
 * the end-elbow correction through exactly the same code path as production.
 *
 * The `createTestableEditor` factory from `PowerEditPlugin.testing` is used
 * to obtain a wired-up `DiagramViewEditor` + `TestablePowerEditPlugin`; the
 * PolyLine itself is built manually (not via CanvasSpec) so that handles can
 * be positioned precisely and node1 can be linked to the block anchor.
 *
 * ## Coordinate system
 *
 * Block is placed at (200, 200).  After `canvas.calculateLayout()` the block's
 * anchor position (`ax`, `ay`) is read from the live view.  All line endpoints
 * and handles are placed at integer offsets of (`ax`, `ay`) so that:
 *   - The initial route is fully orthogonal (correction is a no-op at setup).
 *   - Every expected post-move coordinate can be derived deterministically
 *     from the known block-move delta without any reference to the block's
 *     internal bounding-box arithmetic.
 *
 * Both tests 1–3 and tests 4–5 call `block.moveBy(dx, dy)` directly (via
 * `MoveObjectsBy.execute`, the same call issued by BlockMover.moveSubject) to
 * avoid coupling expected handle positions to the grid-snap rounding that
 * `BlockMover.getPositionOnGrid` would introduce.  Test 5 (regression) runs
 * through the full `driveDrag` / BlockMover path — multiples-of-10 cursor
 * deltas are used so that grid-snap (grid=[5,5]) does not alter the delta.
 *
 * ## Test file registration
 *
 * `@OpenChart/DiagramInterface` is stubbed globally via
 * `PowerEditPlugin.testing.setup.ts`, which is registered in vitest.config.ts
 * `setupFiles`.  No inline `vi.mock()` is needed in this file.
 */

import { describe, it, expect, beforeAll } from "vitest";

// Harness imports
import { createGroupTestingFactory } from "../Bases/GroupFace.testing";
import {
    createTestableEditor,
    driveDrag,
    findById
} from "../../../../DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.testing";

// View types
import {
    BlockView,
    CanvasView,
    DiagramViewFile,
    FaceType,
    HandleView,
    LineView,
    ManualLayoutEngine,
    PolyLine,
    PositionSetByUser
} from "@OpenChart/DiagramView";

// Internal-lens types (test-only; not exported from barrels)
import { PolyLineSpanView } from "./PolyLineSpanView";
import { AXIS_EPSILON } from "./LineLayoutStrategies";
import type { GenericLineInternalState } from "./GenericLineInternalState";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";

// DiagramObjectSerializer (model-layer serialiser)
import { DiagramObjectSerializer } from "@OpenChart/DiagramModel";


///////////////////////////////////////////////////////////////////////////////
//  Lens type  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Extends `GenericLineInternalState` with the PolyLine-specific `spans` field.
 * Use this for casts that need to inspect `face.spans`.
 */
type PolyLineInternalState = GenericLineInternalState & {
    spans: PolyLineSpanView[];
};


///////////////////////////////////////////////////////////////////////////////
//  Fixture helpers  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Builds a ready-to-drag integration fixture:
 *   - A `DiagramViewEditor` + `TestablePowerEditPlugin` backed by a real canvas.
 *   - A `generic_block` at `(200, 200)` with id `"blk"`.
 *   - A 3-handle PolyLine whose `node1` is LINKED to the block's first anchor.
 *   - All initial segments are orthogonal so `calculateLayout` is a no-op at
 *     this point (TALA-parity condition).
 *
 * The returned positions `ax`, `ay` are the anchor's world coordinates
 * AFTER setup.  All handle offsets are expressed relative to `(ax, ay)`.
 *
 * Layout for `endSegmentAxis = "V"` (V-oriented node1→h[0]):
 *
 *   node1 = (ax,       ay)        ← linked to block anchor
 *   h[0]  = (ax,       ay + 100)  ← V end segment: same x as node1
 *   h[1]  = (ax + 100, ay + 100)  ← H interior span: same y as h[0]
 *   h[2]  = (ax + 100, ay + 200)  ← V interior span: same x as h[1]
 *   node2 = (ax + 200, ay + 200)  ← H end segment: same y as h[2]
 *
 * Layout for `endSegmentAxis = "H"` (H-oriented node1→h[0]):
 *
 *   node1 = (ax,       ay)        ← linked to block anchor
 *   h[0]  = (ax + 100, ay)        ← H end segment: same y as node1
 *   h[1]  = (ax + 100, ay + 100)  ← V interior span: same x as h[0]
 *   h[2]  = (ax + 200, ay + 100)  ← H interior span: same y as h[1]
 *   node2 = (ax + 200, ay + 200)  ← V end segment: same x as h[2]
 *
 * @param factory   - Factory from `createGroupTestingFactory()`.
 * @param endSegmentAxis - Axis of the end segment connecting node1 to h[0].
 *   `"V"` ← same x (node1.x === h[0].x).
 *   `"H"` ← same y (node1.y === h[0].y).
 */
async function createIntegrationFixture(
    factory: DiagramObjectViewFactory,
    endSegmentAxis: "V" | "H" = "V"
): Promise<{
        editor: ReturnType<typeof createTestableEditor>["editor"];
        plugin: ReturnType<typeof createTestableEditor>["plugin"];
        canvas: CanvasView;
        block: BlockView;
        line: LineView;
        ax: number;
        ay: number;
    }> {
    // Build editor with a single block at (200, 200).
    const { editor, plugin, canvas } = createTestableEditor(factory, {
        blocks: [{ id: "blk", x: 200, y: 200 }]
    });

    const block = findById(canvas, "blk") as BlockView;
    expect(block).toBeInstanceOf(BlockView);

    // Read the block's first anchor position AFTER canvas.calculateLayout()
    // (createTestableEditor already ran it).
    const blockAnchor = block.anchors.values().next().value!;
    const ax = blockAnchor.x;
    const ay = blockAnchor.y;

    // Create a PolyLine with 3 handles.
    const line = factory.createNewDiagramObject("dynamic_line", LineView);
    // Add 2 more handles (factory creates 1 by default → total 3).
    for (let i = 1; i < 3; i++) {
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
    }

    // Swap to PolyLine face.  The line style comes from the "dynamic_line"
    // design in groupTheme (DynamicLine face type, same style object).
    const design = factory.resolveDesign("dynamic_line");
    // design.style is typed as the union of all style types; narrow it here.
    // groupTheme.designs.dynamic_line is FaceType.DynamicLine, so style is LineStyle.
    if (design.type !== FaceType.DynamicLine && design.type !== FaceType.PolyLine) {
        throw new Error(`Expected dynamic_line design to be a line face; got ${design.type}.`);
    }
    line.replaceFace(new PolyLine(design.style, factory.theme.grid));

    // Position latches and handles via face-level moveTo (no cascade) to avoid
    // the LineView.handleUpdate → dropHandles mid-loop issue (see CLAUDE.md).
    if (endSegmentAxis === "V") {
        // V end segment: node1.x === h[0].x
        line.node1.face.moveTo(ax,           ay);
        (line.handles[0] as HandleView).face.moveTo(ax,           ay + 100);
        (line.handles[1] as HandleView).face.moveTo(ax + 100,     ay + 100);
        (line.handles[2] as HandleView).face.moveTo(ax + 100,     ay + 200);
        line.node2.face.moveTo(ax + 200,     ay + 200);
    } else {
        // H end segment: node1.y === h[0].y
        line.node1.face.moveTo(ax,           ay);
        (line.handles[0] as HandleView).face.moveTo(ax + 100,     ay);
        (line.handles[1] as HandleView).face.moveTo(ax + 100,     ay + 100);
        (line.handles[2] as HandleView).face.moveTo(ax + 200,     ay + 100);
        line.node2.face.moveTo(ax + 200,     ay + 200);
    }

    // Link node1 to the block's anchor.  `link` sets userSetPosition=False so
    // the latch will follow the anchor through moveBy.
    line.node1.link(blockAnchor);

    // Mark all handles as user-set (required for the round-trip test's
    // ManualLayoutEngine.generatePositionMap to include them).
    for (const h of line.handles) {
        (h as HandleView).userSetPosition = PositionSetByUser.True;
    }

    // Add line to canvas and run a full layout pass so every object's
    // bounding box is up to date before the test begins.
    canvas.addObject(line);
    canvas.calculateLayout();

    return { editor, plugin, canvas, block, line, ax, ay };
}


///////////////////////////////////////////////////////////////////////////////
//  Tests  /////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("PolyLine — issue #19 end-segment orthogonality (interactive + round-trip)", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    // -------------------------------------------------------------------------
    // Test 1: X-axis block move → V end segment corrected, span exists
    // -------------------------------------------------------------------------

    it("block move on X axis corrects the V end-elbow and the H interior span is still draggable", async () => {
        /**
         * Initial layout (V end segment, ax/ay from block anchor):
         *
         *   node1 = (ax,       ay)        ← V-aligned with h[0] (same x)
         *   h[0]  = (ax,       ay + 100)
         *   h[1]  = (ax + 100, ay + 100)  ← H neighbor of h[0] (same y)
         *   h[2]  = (ax + 100, ay + 200)
         *   node2 = (ax + 200, ay + 200)
         *
         * Block moves +50 in X:
         *   latch node1 follows → node1 = (ax + 50, ay)
         *   h[0] stays at        → h[0]  = (ax, ay + 100)  [not yet corrected]
         *   End segment (ax+50, ay) → (ax, ay+100): diagonal (both axes differ).
         *
         * Neighbor analysis: h[1] = (ax+100, ay+100) vs h[0] = (ax, ay+100)
         *   dy = 0 → H neighbor
         *   H-neighbor rule: end segment must be V → snap h[0].x = node1.x = ax+50
         *
         * Corrected h[0] = (ax+50, ay+100).
         * Post-correction end segment:
         *   (ax+50, ay) → (ax+50, ay+100): same x → V-aligned ✓
         *
         * h[0]→h[1]: (ax+50, ay+100) → (ax+100, ay+100): same y → H span ✓
         */
        const { block, line, ax, ay } = await createIntegrationFixture(factory, "V");
        const face = line.face as unknown as PolyLineInternalState;

        // Sanity: initial route is orthogonal (correction is a no-op).
        expect(Math.abs(line.node1.x - line.handles[0].x)).toBeLessThan(AXIS_EPSILON); // same x
        expect(face.spans).toHaveLength(2);

        // Snapshot interior handles before block move.
        const beforeH1 = { x: line.handles[1].x, y: line.handles[1].y };
        const beforeH2 = { x: line.handles[2].x, y: line.handles[2].y };

        // Move block +50 in X.  MoveObjectsBy calls block.moveBy(50, 0);
        // the latch follows via AnchorFace.moveBy → LatchView.moveBy, which
        // then triggers line.handleUpdate → PolyLine.calculateLayout → correction.
        block.moveBy(50, 0);

        // node1 followed the anchor exactly by the same delta.
        expect(line.node1.x).toBe(ax + 50);
        expect(line.node1.y).toBe(ay);

        // h[0] corrected: snap h[0].x = node1.x = ax+50, y unchanged = ay+100.
        expect(line.handles[0].x).toBe(ax + 50);
        expect(line.handles[0].y).toBe(ay + 100);

        // End segment is V-aligned: |dx| < AXIS_EPSILON.
        expect(Math.abs(line.node1.x - line.handles[0].x)).toBeLessThan(AXIS_EPSILON);

        // A PolyLineSpanView must exist for h[0]→h[1] (the corrected H span).
        // h[0]=(ax+50, ay+100) → h[1]=(ax+100, ay+100): same y → H.
        const srcSpan = face.spans.find(s => s.handleA === line.handles[0]);
        expect(srcSpan).toBeInstanceOf(PolyLineSpanView);
        expect(srcSpan!.axis).toBe("H");

        // Interior handles must be untouched (policy A: snap-elbow, no insert).
        expect(line.handles[1].x).toBe(beforeH1.x);
        expect(line.handles[1].y).toBe(beforeH1.y);
        expect(line.handles[2].x).toBe(beforeH2.x);
        expect(line.handles[2].y).toBe(beforeH2.y);

        // Handle count unchanged: policy A.
        expect(line.handles.length).toBe(3);
    });


    // -------------------------------------------------------------------------
    // Test 2: Y-axis block move → H end segment corrected, span exists
    // -------------------------------------------------------------------------

    it("block move on Y axis corrects the H end-elbow and the V interior span is still draggable", async () => {
        /**
         * Initial layout (H end segment):
         *
         *   node1 = (ax,       ay)        ← H-aligned with h[0] (same y)
         *   h[0]  = (ax + 100, ay)
         *   h[1]  = (ax + 100, ay + 100)  ← V neighbor of h[0] (same x)
         *   h[2]  = (ax + 200, ay + 100)
         *   node2 = (ax + 200, ay + 200)
         *
         * Block moves +50 in Y:
         *   latch node1 follows → node1 = (ax, ay + 50)
         *   h[0] stays at        → h[0]  = (ax+100, ay) [not yet corrected]
         *   End segment (ax, ay+50) → (ax+100, ay): diagonal.
         *
         * Neighbor analysis: h[1] = (ax+100, ay+100) vs h[0] = (ax+100, ay)
         *   dx = 0 → V neighbor
         *   V-neighbor rule: end segment must be H → snap h[0].y = node1.y = ay+50
         *
         * Corrected h[0] = (ax+100, ay+50).
         * Post-correction end segment:
         *   (ax, ay+50) → (ax+100, ay+50): same y → H-aligned ✓
         *
         * h[0]→h[1]: (ax+100, ay+50) → (ax+100, ay+100): same x → V span ✓
         */
        const { block, line, ax, ay } = await createIntegrationFixture(factory, "H");
        const face = line.face as unknown as PolyLineInternalState;

        // Sanity: initial route is orthogonal.
        expect(Math.abs(line.node1.y - line.handles[0].y)).toBeLessThan(AXIS_EPSILON); // same y

        // Move block +50 in Y.
        block.moveBy(0, 50);

        // node1 followed anchor.
        expect(line.node1.x).toBe(ax);
        expect(line.node1.y).toBe(ay + 50);

        // h[0] corrected: snap h[0].y = node1.y = ay+50, x unchanged = ax+100.
        expect(line.handles[0].x).toBe(ax + 100);
        expect(line.handles[0].y).toBe(ay + 50);

        // End segment is H-aligned: |dy| < AXIS_EPSILON.
        expect(Math.abs(line.node1.y - line.handles[0].y)).toBeLessThan(AXIS_EPSILON);

        // A PolyLineSpanView must exist for h[0]→h[1].
        // h[0]=(ax+100, ay+50) → h[1]=(ax+100, ay+100): same x → V.
        const srcSpan = face.spans.find(s => s.handleA === line.handles[0]);
        expect(srcSpan).toBeInstanceOf(PolyLineSpanView);
        expect(srcSpan!.axis).toBe("V");

        // Handle count unchanged.
        expect(line.handles.length).toBe(3);
    });


    // -------------------------------------------------------------------------
    // Test 3: Diagonal block move → end segment still orthogonal, span present
    // -------------------------------------------------------------------------

    it("diagonal block move corrects the end-elbow via the larger-displacement rule, span present", async () => {
        /**
         * Initial layout (V end segment, same as test 1).
         *
         * Block moves +40 in X, +30 in Y (diagonal):
         *   latch node1 follows → node1 = (ax+40, ay+30)
         *   h[0] stays at        → h[0]  = (ax, ay+100)
         *   End segment (ax+40, ay+30) → (ax, ay+100): diagonal.
         *
         * Neighbor analysis: h[1] = (ax+100, ay+100) vs h[0] = (ax, ay+100)
         *   dx=100, dy=0 → H neighbor (same y)
         *   H-neighbor rule: snap h[0].x = node1.x = ax+40
         *
         * Corrected h[0] = (ax+40, ay+100).
         * Post-correction: (ax+40, ay+30) → (ax+40, ay+100): same x → V-aligned ✓
         *
         * h[0]→h[1]: (ax+40, ay+100) → (ax+100, ay+100): same y → H span ✓
         */
        const { block, line, ax, ay } = await createIntegrationFixture(factory, "V");
        const face = line.face as unknown as PolyLineInternalState;

        // Move block diagonally.
        block.moveBy(40, 30);

        // node1 followed anchor.
        expect(line.node1.x).toBe(ax + 40);
        expect(line.node1.y).toBe(ay + 30);

        // h[0] corrected: H-neighbor rule → snap x to node1.x = ax+40, y stays ay+100.
        expect(line.handles[0].x).toBe(ax + 40);
        expect(line.handles[0].y).toBe(ay + 100);

        // End segment V-aligned.
        expect(Math.abs(line.node1.x - line.handles[0].x)).toBeLessThan(AXIS_EPSILON);

        // H span for h[0]→h[1] still exists.
        const srcSpan = face.spans.find(s => s.handleA === line.handles[0]);
        expect(srcSpan).toBeInstanceOf(PolyLineSpanView);
        expect(srcSpan!.axis).toBe("H");

        // Handle count unchanged.
        expect(line.handles.length).toBe(3);
    });


    // -------------------------------------------------------------------------
    // Test 4: Round-trip — corrected geometry persists through export/import
    // -------------------------------------------------------------------------

    it("corrected handle geometry is byte-identical after export/import and re-running calculateLayout is a no-op", async () => {
        /**
         * Hand-trace of expected handle positions post-move:
         *
         *   Initial (V end segment):
         *     h[0] = (ax,       ay + 100)
         *     h[1] = (ax + 100, ay + 100)
         *     h[2] = (ax + 100, ay + 200)
         *
         *   After block.moveBy(50, 0):
         *     node1 = (ax+50, ay)
         *     Correction: H-neighbor → h[0].x = node1.x = ax+50
         *     h[0] corrected = (ax+50, ay+100)  ← this is the value we round-trip
         *     h[1] unchanged = (ax+100, ay+100)
         *     h[2] unchanged = (ax+100, ay+200)
         *
         * The persisted geometry must be the corrected values.  Reloading must:
         *   1. Restore the PolyLine face (inferLineFaces: 3 handles ≥ 2).
         *   2. Preserve handle coords byte-identically.
         *   3. Be idempotent: calculateLayout on the reloaded line must be a no-op.
         */
        const { canvas, block, line, ax, ay } = await createIntegrationFixture(factory, "V");
        // `factory` is available from the outer beforeAll scope.

        // Apply block move to trigger end-elbow correction.
        block.moveBy(50, 0);

        // Capture corrected positions before export.
        const correctedH0 = { x: line.handles[0].x, y: line.handles[0].y };
        const correctedH1 = { x: line.handles[1].x, y: line.handles[1].y };
        const correctedH2 = { x: line.handles[2].x, y: line.handles[2].y };

        // Verify correction was applied before round-trip.
        expect(correctedH0.x).toBe(ax + 50);   // h[0].x snapped to node1.x = ax+50
        expect(correctedH0.y).toBe(ay + 100);  // h[0].y unchanged
        expect(correctedH1.x).toBe(ax + 100);
        expect(correctedH1.y).toBe(ay + 100);
        expect(correctedH2.x).toBe(ax + 100);
        expect(correctedH2.y).toBe(ay + 200);

        // Export to wire format.  ManualLayoutEngine.generatePositionMap includes
        // every handle with userSetPosition === PositionSetByUser.True (already
        // marked in the fixture helper).
        const exported = {
            schema:  factory.id,
            theme:   factory.theme.id,
            objects: DiagramObjectSerializer.exportObjects([canvas]),
            layout:  ManualLayoutEngine.generatePositionMap([canvas])
        };

        // Reload through DiagramViewFile.  The constructor calls inferLineFaces
        // which swaps the line back to PolyLine (3 handles ≥ 2 threshold).
        const reloaded = new DiagramViewFile(factory, exported);

        const reloadedLine = reloaded.canvas.lines.find(
            l => l.instance === line.instance
        );
        expect(reloadedLine).toBeDefined();
        expect(reloadedLine!.face).toBeInstanceOf(PolyLine);
        expect(reloadedLine!.handles.length).toBe(3);

        // Handle positions are byte-identical to the pre-export corrected values.
        expect(reloadedLine!.handles[0].x).toBe(correctedH0.x);
        expect(reloadedLine!.handles[0].y).toBe(correctedH0.y);
        expect(reloadedLine!.handles[1].x).toBe(correctedH1.x);
        expect(reloadedLine!.handles[1].y).toBe(correctedH1.y);
        expect(reloadedLine!.handles[2].x).toBe(correctedH2.x);
        expect(reloadedLine!.handles[2].y).toBe(correctedH2.y);

        // Idempotence: re-running calculateLayout on the reloaded line must be a
        // no-op — the persisted geometry is already orthogonal.
        // Snapshot positions, then re-run layout, then compare.
        const snapH0 = { x: reloadedLine!.handles[0].x, y: reloadedLine!.handles[0].y };
        const snapH1 = { x: reloadedLine!.handles[1].x, y: reloadedLine!.handles[1].y };
        const snapH2 = { x: reloadedLine!.handles[2].x, y: reloadedLine!.handles[2].y };

        reloadedLine!.calculateLayout();

        expect(reloadedLine!.handles[0].x).toBe(snapH0.x);
        expect(reloadedLine!.handles[0].y).toBe(snapH0.y);
        expect(reloadedLine!.handles[1].x).toBe(snapH1.x);
        expect(reloadedLine!.handles[1].y).toBe(snapH1.y);
        expect(reloadedLine!.handles[2].x).toBe(snapH2.x);
        expect(reloadedLine!.handles[2].y).toBe(snapH2.y);
    });


    // -------------------------------------------------------------------------
    // Test 5: No-regression — orthogonal block move is a no-op (driveDrag path)
    // -------------------------------------------------------------------------

    it("block move that keeps the end segment axis-aligned does not perturb the end-elbow (driveDrag path)", async () => {
        /**
         * Initial layout (V end segment):
         *
         *   node1 = (ax,   ay)       ← V-aligned with h[0] (same x)
         *   h[0]  = (ax,   ay + 100)
         *
         * Move block by (0, +50) in Y only (path multiples of 10; grid=[5,5],
         * so grid-snap produces exactly the requested delta):
         *   node1 follows → node1 = (ax, ay+50)
         *   h[0] stays    → h[0]  = (ax, ay+100)
         *   End segment: same x = ax → already V-aligned → correction is a no-op.
         *
         * Expected: h[0].x === ax (unchanged), h[0].y === ay+100 (unchanged).
         * The correction must NOT have been applied (it's a no-op).
         */
        const { editor, plugin, block, line, ax, ay }
            = await createIntegrationFixture(factory, "V");

        // Snapshot all handle positions before the drag.
        const beforeHandles = line.handles.map(h => ({ x: h.x, y: h.y }));

        // Drive the full BlockMover path via driveDrag.
        // Path: start at block centre, move 50 units down (Y-axis only).
        // 50 is a multiple of 10 (also of 5), so grid-snap is exact.
        // The block starts with a V end segment, so a Y-only move keeps the
        // end segment V-aligned (same x both before and after).
        const startX = block.x;
        const startY = block.y;
        driveDrag(
            editor,
            plugin.moverFactoryFor(block),
            [[startX, startY], [startX, startY + 50]]
        );

        // node1 must have followed the block's Y movement.
        expect(line.node1.x).toBe(ax);
        expect(Math.abs(line.node1.y - (ay + 50))).toBeLessThanOrEqual(5); // grid-snap ≤ 5 px

        // End segment is still V-aligned (same x): |node1.x - h[0].x| < AXIS_EPSILON.
        expect(Math.abs(line.node1.x - line.handles[0].x)).toBeLessThan(AXIS_EPSILON);

        // h[0] must NOT have been perturbed beyond any intended translation
        // (correction is a no-op when the end segment stays on-axis).
        // h[0].x is still ax (no correction applied, no snapping occurred).
        expect(line.handles[0].x).toBe(ax);
        // h[0].y is still ay+100 (the elbow did not move in Y, only node1 did).
        expect(line.handles[0].y).toBe(ay + 100);

        // Interior handles h[1] and h[2] are also untouched.
        expect(line.handles[1].x).toBe(beforeHandles[1].x);
        expect(line.handles[1].y).toBe(beforeHandles[1].y);
        expect(line.handles[2].x).toBe(beforeHandles[2].x);
        expect(line.handles[2].y).toBe(beforeHandles[2].y);

        // Spans are still present and correctly classified.
        const face = line.face as unknown as PolyLineInternalState;
        expect(face.spans.length).toBeGreaterThan(0);
    });

});
