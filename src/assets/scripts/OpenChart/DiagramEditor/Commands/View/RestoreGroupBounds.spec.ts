/**
 * @file RestoreGroupBounds.spec.ts
 *
 * Unit tests for the `RestoreGroupBounds` command and its ordering
 * contract inside a `GroupCommand`. The load-bearing case is the
 * end-to-end test: it exercises the same auto-grow side-effect that
 * a real drag triggers, and fails if `RestoreGroupBounds` is placed
 * anywhere other than first in the stream.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { GroupCommand } from "../GroupCommand";
import { MoveObjectsBy } from "./MoveObjectsBy";
import { RestoreGroupBounds } from "./RestoreGroupBounds";
import {
    createGroupTestingFactory,
    makeBlockView,
    makeGroupWithChildren
} from "../../../DiagramView/DiagramObjectView/Faces/Bases/GroupFace.testing";
import type { DiagramObjectViewFactory } from "@OpenChart/DiagramView";


describe("RestoreGroupBounds", () => {

    let factory: DiagramObjectViewFactory;

    beforeAll(async () => {
        factory = await createGroupTestingFactory();
    });


    describe("execute", () => {

        it("is a no-op on the group's bounds", () => {
            const group = makeGroupWithChildren(factory, [], [-100, -100, 100, 100]);
            const snapshot = group.face.userBounds;

            const cmd = new RestoreGroupBounds([{ group, bounds: snapshot }]);
            cmd.execute();

            expect(group.face.userBounds).toEqual(snapshot);
        });

        it("accepts an empty snapshot list without throwing", () => {
            const cmd = new RestoreGroupBounds([]);
            expect(() => cmd.execute()).not.toThrow();
            expect(() => cmd.undo()).not.toThrow();
        });

    });


    describe("undo", () => {

        it("restores userBounds and boundingBox authoritatively", () => {
            const group = makeGroupWithChildren(factory, [], [-100, -100, 100, 100]);
            const original: [number, number, number, number] = [-100, -100, 100, 100];
            const cmd = new RestoreGroupBounds([{ group, bounds: original }]);

            // Mutate via setBounds to simulate auto-grow having already
            // bloated the group during a hypothetical drag.
            group.face.setBounds(-200, -200, 200, 200);
            expect(group.face.userBounds).toEqual([-200, -200, 200, 200]);

            cmd.undo();

            // userBounds restored
            expect(group.face.userBounds).toEqual(original);
            // boundingBox also restored — all six fields
            const bb = group.face.boundingBox;
            expect(bb.xMin).toBe(-100);
            expect(bb.yMin).toBe(-100);
            expect(bb.xMax).toBe(100);
            expect(bb.yMax).toBe(100);
            expect(bb.x).toBe(0);
            expect(bb.y).toBe(0);
        });

        it("restores multiple groups in one call", () => {
            const outer = makeGroupWithChildren(factory, [], [-300, -300, 300, 300]);
            const inner = makeGroupWithChildren(factory, [], [-100, -100, 100, 100]);
            const outerOriginal: [number, number, number, number] = [-300, -300, 300, 300];
            const innerOriginal: [number, number, number, number] = [-100, -100, 100, 100];
            const cmd = new RestoreGroupBounds([
                { group: outer, bounds: outerOriginal },
                { group: inner, bounds: innerOriginal }
            ]);

            // Bloat both groups.
            outer.face.setBounds(-500, -500, 500, 500);
            inner.face.setBounds(-200, -200, 200, 200);

            cmd.undo();

            expect(outer.face.userBounds).toEqual(outerOriginal);
            expect(inner.face.userBounds).toEqual(innerOriginal);
        });

    });


    describe("end-to-end ordering inside a GroupCommand", () => {

        it("restores group bounds after a drag-style auto-grow is reverted", () => {
            // Build a group with a block inside.
            const block = makeBlockView(factory);
            block.moveTo(0, 0);
            const group = makeGroupWithChildren(
                factory, [block], [-100, -100, 100, 100]
            );

            const originalBounds = group.face.userBounds;
            const originalBlockX = block.x;
            const originalBlockY = block.y;

            // Build the drag stream: RestoreGroupBounds must land FIRST.
            // Subsequent MoveObjectsBy commands push the block east past
            // the group's xMax, forcing GroupFace.calculateLayout to
            // auto-grow the group via its write-back path.
            const stream = new GroupCommand();
            stream.do(new RestoreGroupBounds([
                { group, bounds: originalBounds }
            ]));
            stream.do(new MoveObjectsBy(block, 50, 0));
            stream.do(new MoveObjectsBy(block, 50, 0));
            stream.do(new MoveObjectsBy(block, 50, 0));
            stream.do(new MoveObjectsBy(block, 50, 0));
            // Block is now 200 units east of origin.

            // Execute the whole stream (simulates drag playback).
            stream.execute();

            // Sanity check: the group DID auto-grow during execute.
            // Without this assertion holding, the rest of the test is
            // not actually exercising the bug.
            const grownBounds = group.face.userBounds;
            expect(grownBounds[2]).toBeGreaterThan(originalBounds[2]);

            // Undo the whole stream.
            stream.undo();

            // Block is back where it started.
            expect(block.x).toBe(originalBlockX);
            expect(block.y).toBe(originalBlockY);

            // Group bounds are back to the pre-drag snapshot. This is
            // the load-bearing assertion: without `RestoreGroupBounds`
            // at index 0 of the stream, the moveBy undos would re-grow
            // the group via calculateLayout's write-back as the block
            // walked back home, and this assertion would fail.
            expect(group.face.userBounds).toEqual(originalBounds);
            const bb = group.face.boundingBox;
            expect(bb.xMin).toBe(originalBounds[0]);
            expect(bb.yMin).toBe(originalBounds[1]);
            expect(bb.xMax).toBe(originalBounds[2]);
            expect(bb.yMax).toBe(originalBounds[3]);
        });

    });

});
