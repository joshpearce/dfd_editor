import { describe, it, expect, vi } from "vitest";
import {
    CanvasView,
    LineView,
    ManualLayoutEngine,
    PositionSetByUser
} from "@OpenChart/DiagramView";
import { DiagramObjectSerializer } from "@OpenChart/DiagramModel";
import { NativeLayoutEngine } from "./NativeLayoutEngine";
import type { NativeLayoutDocument, NativeLayoutSource } from "./NativeLayoutEngine";
import { createLinesTestingFactory } from "../../DiagramObjectView/Faces/Lines/Lines.testing";


describe("NativeLayoutEngine", () => {

    async function buildFixture() {
        const factory = await createLinesTestingFactory();
        const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
        const line = factory.createNewDiagramObject("data_flow", LineView);
        canvas.addObject(line);

        // Position the reference handle so it is included in the position map
        // and is movable by ManualLayoutEngine (requires userSetPosition = True).
        line.handles[0].userSetPosition = PositionSetByUser.True;
        line.handles[0].face.moveTo(50, 75);

        return { factory, canvas, line, handle: line.handles[0] };
    }

    describe("run — empty objects array", () => {

        it("resolves without calling the source", async () => {
            const src = vi.fn<NativeLayoutSource>().mockResolvedValue({});
            await new NativeLayoutEngine(src).run([]);
            expect(src).not.toHaveBeenCalled();
        });

    });

    describe("run — empty position map returned", () => {

        it("leaves object positions unchanged and calls source with serialized doc", async () => {
            const { canvas, handle } = await buildFixture();
            const src = vi.fn<NativeLayoutSource>().mockResolvedValue({});

            await new NativeLayoutEngine(src).run([canvas]);

            expect(handle.x).toBe(50);
            expect(handle.y).toBe(75);
            expect(src).toHaveBeenCalledOnce();

            const doc: NativeLayoutDocument = src.mock.calls[0][0];
            expect(Array.isArray(doc.objects)).toBe(true);
            expect(doc.objects.length).toBeGreaterThan(0);
            expect(typeof doc.layout).toBe("object");
        });

    });

    describe("run — non-empty position map returned", () => {

        it("moves the object to the coordinates in the map", async () => {
            const { canvas, handle } = await buildFixture();
            // The key ManualLayoutEngine uses is obj.instance.
            const src = vi.fn<NativeLayoutSource>().mockImplementation(async (doc) => {
                // Reflect the handle instance key back with new coords.
                const layout: Record<string, [number, number]> = {};
                for (const key of Object.keys(doc.layout)) {
                    layout[key] = [123, 456];
                }
                return layout;
            });

            await new NativeLayoutEngine(src).run([canvas]);

            expect(handle.x).toBe(123);
            expect(handle.y).toBe(456);
        });

    });

    describe("run — source rejects", () => {

        it("propagates the rejection unchanged", async () => {
            const { canvas } = await buildFixture();
            const boom = new Error("native source failed");
            const engine = new NativeLayoutEngine(() => Promise.reject(boom));

            await expect(engine.run([canvas])).rejects.toBe(boom);
        });

    });

    describe("source invocation contract", () => {

        it("doc passed to source includes objects from DiagramObjectSerializer and layout from ManualLayoutEngine.generatePositionMap", async () => {
            const { canvas } = await buildFixture();
            let capturedDoc: NativeLayoutDocument | undefined;
            const src = vi.fn<NativeLayoutSource>().mockImplementation(async (doc) => {
                capturedDoc = doc;
                return {};
            });

            await new NativeLayoutEngine(src).run([canvas]);

            const expectedObjects = DiagramObjectSerializer.exportObjects([canvas]);
            const expectedLayout = ManualLayoutEngine.generatePositionMap([canvas]);

            expect(capturedDoc).toBeDefined();
            expect(JSON.stringify(capturedDoc!.objects)).toBe(JSON.stringify(expectedObjects));
            expect(capturedDoc!.layout).toEqual(expectedLayout);
        });

    });

});
