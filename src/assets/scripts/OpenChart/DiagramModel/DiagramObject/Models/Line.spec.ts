/**
 * @file Line.spec.ts
 *
 * Unit tests for the model-layer Line class.  Focused on the handle-list
 * mutation API (`addHandle` / `dropHandles`) since those are the
 * load-bearing operations for the auto-layout engine's
 * `ensureHandleCount` and the DynamicLine layout strategies'
 * `view.dropHandles(1)` calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Crypto } from "@OpenChart/Utilities";
import {
    Handle,
    Latch,
    Line,
    RootProperty
} from "@OpenChart/DiagramModel";

function makeLine(): Line {
    return new Line("test_line", Crypto.randomUUID(), 0, new RootProperty());
}

function makeHandle(): Handle {
    return new Handle("test_handle", Crypto.randomUUID(), 0, new RootProperty());
}

function makeLatch(): Latch {
    return new Latch("test_latch", Crypto.randomUUID(), 0, new RootProperty());
}

describe("Line", () => {

    describe("dropHandles", () => {

        let line: Line;

        beforeEach(() => {
            line = makeLine();
            // A real line carries two latches; populate them so `addHandle`
            // doesn't fail any future invariant guard.
            line.node1 = makeLatch();
            line.node2 = makeLatch();
        });

        it("dropHandles(1) on a 1-handle line is a no-op past the boundary", () => {
            line.addHandle(makeHandle());
            line.dropHandles(1);
            expect(line.handles.length).toBe(1);
        });

        it("dropHandles(1) on a 3-handle line leaves exactly 1 handle", () => {
            line.addHandle(makeHandle());
            line.addHandle(makeHandle());
            line.addHandle(makeHandle());
            expect(line.handles.length).toBe(3);

            line.dropHandles(1);

            // Regression test: previous implementation iterated with `i++`
            // after each splice, which skipped every other element and
            // left this list at length 2 instead of 1.
            expect(line.handles.length).toBe(1);
        });

        it("dropHandles(2) on a 5-handle line leaves exactly 2 handles", () => {
            for (let i = 0; i < 5; i++) {
                line.addHandle(makeHandle());
            }
            expect(line.handles.length).toBe(5);

            line.dropHandles(2);

            expect(line.handles.length).toBe(2);
        });

        it("dropHandles(0) on a multi-handle line removes every handle", () => {
            for (let i = 0; i < 4; i++) {
                line.addHandle(makeHandle());
            }
            line.dropHandles(0);
            expect(line.handles.length).toBe(0);
        });

        it("dropHandles unparents removed handles", () => {
            const h0 = makeHandle();
            const h1 = makeHandle();
            const h2 = makeHandle();
            line.addHandle(h0);
            line.addHandle(h1);
            line.addHandle(h2);
            expect(h1.parent).toBe(line);
            expect(h2.parent).toBe(line);

            line.dropHandles(1);

            // Removed handles are detached from the line so they can be
            // reused or garbage-collected without dangling parent refs.
            expect(h1.parent).toBeNull();
            expect(h2.parent).toBeNull();
            // The retained handle keeps its parent.
            expect(h0.parent).toBe(line);
        });

    });

});
