import { DiagramModelFile } from "./DiagramModelFile";
import { describe, it, expect } from "vitest";
import { Block, Canvas, Latch, Line } from "../DiagramModel";
import { DiagramObjectFactory } from "./DiagramObjectFactory";
import { sampleSchema, sampleExport } from "./DiagramModel.fixture";

// Re-export for any callers that historically imported from this spec file.
// New code should import directly from DiagramModel.fixture.ts.
export { sampleSchema, sampleExport } from "./DiagramModel.fixture";


///////////////////////////////////////////////////////////////////////////////
//  1. Sample Factory  /////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const factory = new DiagramObjectFactory(sampleSchema);

///////////////////////////////////////////////////////////////////////////////
//  4. Tests  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("DiagramModelFile", () => {
    describe("Object Factory", () => {
        it("creates valid page from schema", () => {
            const file = new DiagramModelFile(factory);
            expect(file.canvas).toBeInstanceOf(Canvas);
        });
        it("creates valid line from schema", () => {
            const line = factory.createNewDiagramObject("dynamic_line", Line);
            expect(line).toBeInstanceOf(Line);
            expect(line.node1).toBeInstanceOf(Latch);
            expect(line.node2).toBeInstanceOf(Latch);
        });
        it("creates valid block from schema", () => {
            const block = factory.createNewDiagramObject("generic_block", Block);
            expect(block).toBeInstanceOf(Block);
            expect(block.anchors.size).toBe(4);
            expect(block.properties?.value.get("size")?.toString()).toBe("10");
        });
    });
    describe("Diagram Imports", () => {
        it("imports valid export", () => {
            const file = new DiagramModelFile(factory, sampleExport);
            expect(file.canvas).toBeInstanceOf(Canvas);
        });
    });
    describe("Diagram Exports", () => {
        it("exports valid import", () => {
            const file = new DiagramModelFile(factory, sampleExport);
            const importExport = file.toExport();
            expect(sampleExport).toEqual(importExport);
        });
    });
});
