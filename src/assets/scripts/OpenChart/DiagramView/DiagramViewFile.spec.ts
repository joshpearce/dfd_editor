/**
 * @file DiagramViewFile.spec.ts
 *
 * Round-trip tests for the import path that drives PolyLine inference.
 *
 * The constructor's `inferLineFaces([this.canvas])` call is the load-time
 * face-swap hook: a stored line with two or more handles must reload as
 * a PolyLine so the multi-bend route renders verbatim.  These tests
 * export a PolyLine-backed canvas, reload it through a new
 * `DiagramViewFile`, and assert both the face instance and the handle
 * positions are preserved.
 */

import { describe, it, expect } from "vitest";
import {
    CanvasView,
    DiagramViewFile,
    DynamicLine,
    HandleView,
    LineView,
    ManualLayoutEngine,
    PolyLine,
    PositionSetByUser
} from "@OpenChart/DiagramView";
import { DiagramObjectSerializer } from "@OpenChart/DiagramModel";
import { createLinesTestingFactory } from "./DiagramObjectView/Faces/Lines/Lines.testing";


describe("DiagramViewFile — import-time PolyLine inference", () => {

    it("PolyLine-backed line round-trips through export → import without losing handles or face", async () => {
        // Build a canvas with a 3-handle line and upgrade it to PolyLine
        // (the same path the auto-layout engine produces).
        const factory = await createLinesTestingFactory();
        const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
        const line = factory.createNewDiagramObject("data_flow", LineView);
        canvas.addObject(line);

        // Position the reference handle and add two more.  Mark each as
        // user-set so the export's PositionMap includes their coords —
        // matching what the auto-layout engine does in production.
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        line.addHandle(factory.createNewDiagramObject("generic_handle", HandleView));
        const positions: Array<[number, number]> = [
            [100, 50],
            [200, 100],
            [300, 50]
        ];
        for (let i = 0; i < positions.length; i++) {
            line.handles[i].userSetPosition = PositionSetByUser.True;
            line.handles[i].face.moveTo(positions[i][0], positions[i][1]);
        }

        factory.inferLineFaces([canvas]);
        expect(line.face).toBeInstanceOf(PolyLine);
        expect(line.handles.length).toBe(3);

        // Export the canvas to the wire format and reload through a fresh
        // DiagramViewFile.  The constructor's inferLineFaces call should
        // see the 3-handle line and rebuild it as a PolyLine.
        const exported = {
            schema: factory.id,
            theme: factory.theme.id,
            objects: DiagramObjectSerializer.exportObjects([canvas]),
            layout: ManualLayoutEngine.generatePositionMap([canvas])
        };
        const reloaded = new DiagramViewFile(factory, exported);

        const reloadedLine = reloaded.canvas.lines.find(
            l => l.instance === line.instance
        );
        expect(reloadedLine).toBeDefined();
        expect(reloadedLine!.face).toBeInstanceOf(PolyLine);
        expect(reloadedLine!.handles.length).toBe(3);
        // Handle positions survive the round-trip.
        expect(reloadedLine!.handles[0].x).toBe(100);
        expect(reloadedLine!.handles[0].y).toBe(50);
        expect(reloadedLine!.handles[1].x).toBe(200);
        expect(reloadedLine!.handles[1].y).toBe(100);
        expect(reloadedLine!.handles[2].x).toBe(300);
        expect(reloadedLine!.handles[2].y).toBe(50);
    });

    it("Single-handle line reloads as DynamicLine", async () => {
        // The other side of the contract: a one-handle line must NOT
        // upgrade to PolyLine on reload.  Confirms the inference rule
        // is tied to handle count, not to any persisted face marker.
        const factory = await createLinesTestingFactory();
        const canvas = factory.createNewDiagramObject(factory.canvas.name, CanvasView);
        const line = factory.createNewDiagramObject("data_flow", LineView);
        canvas.addObject(line);
        expect(line.handles.length).toBe(1);

        const exported = {
            schema: factory.id,
            theme: factory.theme.id,
            objects: DiagramObjectSerializer.exportObjects([canvas]),
            layout: ManualLayoutEngine.generatePositionMap([canvas])
        };
        const reloaded = new DiagramViewFile(factory, exported);

        const reloadedLine = reloaded.canvas.lines.find(
            l => l.instance === line.instance
        );
        expect(reloadedLine).toBeDefined();
        expect(reloadedLine!.face).toBeInstanceOf(DynamicLine);
    });

});
