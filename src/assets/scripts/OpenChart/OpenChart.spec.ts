import { Font } from "./Utilities";
import { describe, it, expect } from "vitest";
import { DarkStyle, ThemeLoader } from "./ThemeLoader";
import { sampleExport, sampleSchema } from "./DiagramModel/DiagramModel.spec";
import {
    Alignment, AnchorView, BlockView, CanvasView,
    DiagramObjectViewFactory, DiagramViewFile, FaceType,
    Focus, Hover, LineView, Orientation,
    GroupView, ResizeEdge
} from "./DiagramView";
import type { DiagramViewExport } from "./DiagramView";
import type { DiagramThemeConfiguration } from "./ThemeLoader";
import {
    createGroupTestingFactory,
    findGroupViewByInstance,
    loadGroupTheme,
    makeBlockView,
    makeGroupWithChildren
} from "./DiagramView/DiagramObjectView/Faces/Bases/GroupTestFixture";


///////////////////////////////////////////////////////////////////////////////
//  1. Sample Theme  /////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


const sampleTheme: DiagramThemeConfiguration = {
    id: "dark_theme",
    name: "Dark Theme",
    grid: [5, 5],
    scale: 2,
    designs: {
        generic_canvas: {
            type: FaceType.LineGridCanvas,
            attributes: Alignment.Grid,
            style: DarkStyle.Canvas()
        },
        generic_block: {
            type: FaceType.DictionaryBlock,
            attributes: Alignment.Grid,
            style: DarkStyle.DictionaryBlock()
        },
        dynamic_line: {
            type: FaceType.DynamicLine,
            attributes: Alignment.Grid,
            style: DarkStyle.Line()
        },
        generic_anchor: {
            type: FaceType.AnchorPoint,
            attributes: Orientation.D0,
            style: DarkStyle.Point()
        },
        generic_latch: {
            type: FaceType.LatchPoint,
            attributes: Alignment.Grid,
            style: DarkStyle.Point()
        },
        generic_handle: {
            type: FaceType.HandlePoint,
            attributes: Alignment.Grid,
            style: DarkStyle.Point()
        }
    }
};


///////////////////////////////////////////////////////////////////////////////
//  2. Sample Export  /////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


export const sampleViewExport: DiagramViewExport = {
    ...sampleExport,
    theme: "dark_theme",
    layout: {
        "9aee95bb-6c28-48ad-9ad1-1042ff3e0aaf": [7.5, 7.5],
        "6722ba7c-df56-4588-97e1-212c78f50b3e": [10, 10],
        "1dd3ff00-4931-4005-9e7b-b6511e9cd246": [5, 5]
    },
    // DiagramViewFile.toExport() unconditionally emits groupBounds, and the
    // "exports valid import" round-trip test asserts toEqual against this
    // fixture. An empty object is correct because the sample diagram has no
    // GroupView objects.
    groupBounds: {},
    camera: { x: 0, y: 0, k: 1 }
};


///////////////////////////////////////////////////////////////////////////////
//  3. Setup  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a new {@link DiagramViewFactory}.
 * @returns
 *  The {@link DiagramViewFactory}.
 */
async function createTestingFactory(): Promise<DiagramObjectViewFactory> {
    const theme = await ThemeLoader.load(sampleTheme);
    const factory = new DiagramObjectViewFactory(sampleSchema, theme);
    return factory;
}

/**
 * Creates a new {@link DiagramViewFile}.
 * @returns
 *  The {@link DiagramViewFile}.
 */
async function createTestingFile(): Promise<DiagramViewFile> {
    const factory = await createTestingFactory();
    return new DiagramViewFile(factory, sampleViewExport);
}

/**
 * Creates a new {@link BlockView}.
 * @returns
 *  The {@link BlockView}.
 */
async function createTestingBlock(): Promise<BlockView> {
    const factory = await createTestingFactory();
    return factory.createNewDiagramObject("generic_block", BlockView);
}

/**
 * Creates a new {@link LineView}.
 * @returns
 *  The {@link LineView}.
 */
async function createTestingLine(): Promise<LineView> {
    const factory = await createTestingFactory();
    return factory.createNewDiagramObject("dynamic_line", LineView);
}

/**
 * Creates a new {@link AnchorView}.
 * @returns
 *  The {@link AnchorView}.
 */
async function createTestingAnchor(): Promise<AnchorView> {
    const factory = await createTestingFactory();
    return factory.createNewDiagramObject("generic_anchor", AnchorView);
}


///////////////////////////////////////////////////////////////////////////////
//  3. Tests  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


describe("OpenChart", () => {
    describe("Theme Loader", () => {
        it("converts properties to camelcase", async () => {
            const theme = await ThemeLoader.load(sampleTheme);
            const canvas = theme.designs["generic_canvas"];
            if (canvas.type === FaceType.LineGridCanvas) {
                expect(canvas.style.gridColor).toBeDefined();
            } else {
                expect(canvas.type).toBe(FaceType.LineGridCanvas);
            }
        });
        it("loads font descriptors", async () => {
            const theme = await ThemeLoader.load(sampleTheme);
            const block = theme.designs["generic_block"];
            if (block.type === FaceType.DictionaryBlock) {
                expect(block.style.head.oneTitle.title.font).toBeInstanceOf(Font);
            } else {
                expect(block.type).toBe(FaceType.DictionaryBlock);
            }
        });
    });
    describe("Diagram View Factory", () => {
        describe("Block", () => {
            it("is a block", async () => {
                const block = await createTestingBlock();
                expect(block).toBeInstanceOf(BlockView);
            });
            it("correctly moves to", async () => {
                const block = await createTestingBlock();
                block.moveTo(10, 15);
                expect(block.x).toBe(10);
                expect(block.y).toBe(15);
            });
            it("correctly moves by", async () => {
                const block = await createTestingBlock();
                block.moveTo(10, 15);
                block.moveBy(5, 5);
                expect(block.x).toBe(15);
                expect(block.y).toBe(20);
            });
            it("is selectable", async () => {
                const block = await createTestingBlock();
                expect(block.focused).toBe(false);
                block.focused = Focus.True;
                expect(block.focused).toBe(true);
            });
            it("is hover-able", async () => {
                const block = await createTestingBlock();
                expect(block.hovered).toBe(Hover.Off);
                block.hovered = Hover.Direct;
                expect(block.hovered).toBe(Hover.Direct);
            });
        });
        describe("Line", () => {
            it("is a line", async () => {
                const line = await createTestingLine();
                expect(line).toBeInstanceOf(LineView);
            });
            it("correctly scales by", async () => {
                const line = await createTestingLine();
                line.source.moveTo(5, 5);
                line.target.moveBy(5, 5);
                expect(line.handles[0].x).toBe(55);
                expect(line.handles[0].y).toBe(55);
            });
            it("correctly scales to", async () => {
                const line = await createTestingLine();
                line.target.moveTo(20, 20);
                expect(line.handles[0].x).toBe(10);
                expect(line.handles[0].y).toBe(10);
            });
            it("correctly computes bounding box", async () => {
                const line = await createTestingLine();
                line.target.moveTo(3, 3);
                expect(line.face.boundingBox).toEqual({
                    xMin: 0, yMin: 0,
                    x: 1.5,  y: 1.5,
                    xMax: 3, yMax: 3
                });
            });
            it("is selectable", async () => {
                const line = await createTestingLine();
                expect(line.focused).toBe(false);
                line.focused = Focus.True;
                expect(line.focused).toBe(true);
            });
            it("is hover-able", async () => {
                const line = await createTestingLine();
                expect(line.hovered).toBe(Hover.Off);
                line.hovered = Hover.Direct;
                expect(line.hovered).toBe(Hover.Direct);
            });
        });
        describe("Anchor", () => {
            it("is an anchor", async () => {
                const anchor = await createTestingAnchor();
                expect(anchor).toBeInstanceOf(AnchorView);
            });
            it("correctly links to line", async () => {
                const line = await createTestingLine();
                const anchor = await createTestingAnchor();
                anchor.link(line.source);
                expect(line.source.isLinked(anchor)).toBe(true);
            });
            it("moves linked latch", async () => {
                const line = await createTestingLine();
                const anchor = await createTestingAnchor();
                anchor.link(line.source);
                anchor.moveTo(10, 15);
                expect(line.source.x).toBe(10);
                expect(line.source.y).toBe(15);
                anchor.moveBy(5, -5);
                expect(line.source.x).toBe(15);
                expect(line.source.y).toBe(10);
            });
            it("is selectable", async () => {
                const anchor = await createTestingAnchor();
                expect(anchor.focused).toBe(false);
                anchor.focused = Focus.True;
                expect(anchor.focused).toBe(true);
            });
            it("is hover-able", async () => {
                const anchor = await createTestingAnchor();
                expect(anchor.hovered).toBe(Hover.Off);
                anchor.hovered = Hover.Direct;
                expect(anchor.hovered).toBe(Hover.Direct);
            });
        });
    });
    describe("Diagram Imports", () => {
        it("imports valid export", async () => {
            const file = await createTestingFile();
            expect(file.canvas).toBeInstanceOf(CanvasView);
        });
        it("import valid layout", async () => {
            const file = await createTestingFile();
            const objects = [...file.canvas.objects];
            expect([file.canvas.x, file.canvas.y]).toEqual([11, 11]);
            expect([objects[0].x, objects[0].y]).toEqual([11, 11]);
            expect([objects[1].x, objects[1].y]).toEqual([10, 10]);
        });
    });
    describe("Diagram Exports", () => {
        it("exports valid import", async () => {
            const file = await createTestingFile();
            const expected = file.toExport();
            expected.layout!["1dd3ff00-4931-4005-9e7b-b6511e9cd246"] = [5, 5];
            expected.layout!["9aee95bb-6c28-48ad-9ad1-1042ff3e0aaf"] = [7.5, 7.5];
            for (const obj of expected.objects) {
                if (typeof obj.properties === "undefined") {
                    delete obj.properties;
                }
            }
            const importExport = expected;
            expect(sampleViewExport).toEqual(importExport);
        });
    });
    describe("Themes", () => {
        it("restyles diagram correctly", async () => {
            const file = await createTestingFile();
            // Restyle diagram
            const theme = await ThemeLoader.load(sampleTheme);
            file.applyTheme(theme);
            // Validate view and face are mutually linked
            file.canvas.face.moveTo(-20, 124);
            expect(file.canvas.x).toEqual(-20);
            expect(file.canvas.y).toEqual(124);
        });
    });


    ///////////////////////////////////////////////////////////////////////////
    //  4. Group Bounds Persistence Tests  ////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    describe("Group Bounds Persistence", () => {

        describe("round-trip test", () => {

            it("preserves userBounds of a resized group with children after export+reimport", async () => {
                const factory = await createGroupTestingFactory();

                // (a) Resized trust boundary with two child blocks
                const blockA1 = makeBlockView(factory);
                const blockA2 = makeBlockView(factory);
                blockA1.moveTo(50, 50);
                blockA2.moveTo(200, 200);
                const groupA = makeGroupWithChildren(factory, [blockA1, blockA2], [-150, -100, 150, 100]);
                groupA.face.calculateLayout();
                groupA.resizeBy(ResizeEdge.E, 80, 0);
                groupA.resizeBy(ResizeEdge.S, 0, 60);

                // (c) Nested trust boundary inside (a) — add BEFORE capturing boundsA,
                // because addObject triggers calculateLayout which may grow groupA's bounds
                const groupC = makeGroupWithChildren(factory, [], [-150, -100, 150, 100]);
                groupA.addObject(groupC);
                groupC.face.calculateLayout();
                groupC.resizeBy(ResizeEdge.SE, 30, 30);

                // (b) Empty trust boundary at a non-origin coordinate (~500, 500)
                const groupB = makeGroupWithChildren(factory, [], [425, 425, 575, 575]);
                groupB.face.calculateLayout();

                // Assemble a canvas for export using a fresh file.
                const file = new DiagramViewFile(factory);
                file.canvas.addObject(groupA);
                file.canvas.addObject(groupB);
                file.canvas.calculateLayout();

                // Capture bounds after canvas layout (canvas.calculateLayout may
                // recursively call calculateLayout on children, re-expanding bounds)
                const finalBoundsA = groupA.face.userBounds;
                const finalBoundsC = groupC.face.userBounds;
                const finalBoundsB = groupB.face.userBounds;

                // Export then re-import
                const exported = file.toExport();
                const file2 = new DiagramViewFile(factory, exported);

                const importedA = findGroupViewByInstance(file2.canvas, groupA.instance);
                const importedB = findGroupViewByInstance(file2.canvas, groupB.instance);
                const importedC = findGroupViewByInstance(file2.canvas, groupC.instance);

                expect(importedA).toBeInstanceOf(GroupView);
                expect(importedB).toBeInstanceOf(GroupView);
                expect(importedC).toBeInstanceOf(GroupView);

                // Each group's userBounds must match the pre-export tuple exactly
                expect(importedA!.face.userBounds).toEqual(finalBoundsA);
                expect(importedB!.face.userBounds).toEqual(finalBoundsB);
                expect(importedC!.face.userBounds).toEqual(finalBoundsC);

                // (b) is still empty
                expect([...importedB!.groups].length).toBe(0);
                expect([...importedB!.blocks].length).toBe(0);

                // (b) encodes the ~(500, 500) position: center between 425 and 575
                const [bXMin, bYMin, bXMax, bYMax] = importedB!.face.userBounds;
                const bCenterX = (bXMin + bXMax) / 2;
                const bCenterY = (bYMin + bYMax) / 2;
                expect(bCenterX).toBeCloseTo(500, 5);
                expect(bCenterY).toBeCloseTo(500, 5);
            });

            it("preserves nested group bounds when the inner group extends beyond the outer's child footprint", async () => {
                // Approach (a): forge the export map directly to isolate the reimport
                // contract from any construction-side calculateLayout behaviour.
                //
                // Contract under test (I1 / I-B):
                //   GroupBoundsEngine is authoritative — persisted bounds must not be
                //   reshaped by calculateLayout's child-expansion logic on reimport,
                //   and both userBounds and boundingBox must reflect the persisted
                //   four-tuples after import.
                //
                // How this falsifies the two broken worlds:
                //
                // (I-A broken world) If GroupBoundsEngine.run calls calculateLayout()
                //   after setBounds, the engine visits outer before inner (BFS from
                //   canvas).  At that moment, inner still has its default bounding box
                //   (DEFAULT_HW=150, DEFAULT_HH=100).  calculateLayout on outer then
                //   sees inner's default bb as a child that overflows the persisted
                //   outer bounds of [-100,-80,100,80] (padded inner default footprint
                //   is [-170,-120,170,120] which exceeds the outer bounds on all
                //   sides), so calculateLayout grows outer to [-170,-120,170,120].
                //   The userBounds assertion on outer then fails.
                //
                // (I-B broken world) If the six boundingBox sync lines are removed
                //   from GroupFace.setBounds, the bounding box is never updated to
                //   reflect the persisted values and stays at whatever calculateLayout
                //   left it during the constructor's initial canvas.calculateLayout()
                //   call ([-170,-120,170,120] for outer, [-150,-100,150,100] for
                //   inner).  The boundingBox assertions then fail.
                //
                // Note: outer bounds [-100,-80,100,80] are intentionally smaller than
                //   the inner group's default auto-fit footprint ([-170,-120,170,120])
                //   so that calculateLayout would corrupt them if allowed to run after
                //   setBounds.

                const factory = await createGroupTestingFactory();

                const outerInst = "cccc0000-0000-0000-0000-000000000001";
                const innerInst = "dddd0000-0000-0000-0000-000000000002";
                const canvasInst = "eeee0000-0000-0000-0000-000000000003";

                // Outer bounds are smaller than the inner group's default auto-fit
                // footprint plus padding ([-150,-100,150,100] + 20 = [-170,-120,170,120]).
                // calculateLayout would grow outer to [-170,-120,170,120] if called
                // after setBounds in the engine (the I-A broken world).
                const outerBounds: [number, number, number, number] = [-100, -80, 100, 80];
                // Inner bounds are much larger than its default auto-fit, so the
                // boundingBox assertion clearly distinguishes persisted vs default.
                const innerBounds: [number, number, number, number] = [-500, -500, 500, 500];

                const forgedExport: DiagramViewExport = {
                    schema: "sample_schema",
                    theme: "dark_theme",
                    objects: [
                        {
                            id: "generic_canvas",
                            instance: canvasInst,
                            objects: [outerInst]
                        },
                        {
                            id: "generic_group",
                            instance: outerInst,
                            objects: [innerInst]
                        },
                        {
                            id: "generic_group",
                            instance: innerInst,
                            objects: []
                        }
                    ],
                    layout: {},
                    groupBounds: {
                        [outerInst]: outerBounds,
                        [innerInst]: innerBounds
                    },
                    camera: { x: 0, y: 0, k: 1 }
                };

                const file2 = new DiagramViewFile(factory, forgedExport);

                const reimportedOuter = findGroupViewByInstance(file2.canvas, outerInst);
                const reimportedInner = findGroupViewByInstance(file2.canvas, innerInst);

                expect(reimportedOuter).toBeInstanceOf(GroupView);
                expect(reimportedInner).toBeInstanceOf(GroupView);

                // userBounds must match the forged tuples exactly (I-A contract).
                // With I-A broken (calculateLayout in engine after setBounds): outer
                // grows to [-170,-120,170,120] because inner's default bb overflows
                // the persisted outer bounds on reimport.
                expect(reimportedOuter!.face.userBounds).toEqual(outerBounds);
                expect(reimportedInner!.face.userBounds).toEqual(innerBounds);

                // boundingBox must also reflect the persisted values directly (I-B
                // contract).  If the six boundingBox sync lines are removed from
                // setBounds, boundingBox stays at calculateLayout's auto-grown values
                // ([-170,-120,170,120] for outer, [-150,-100,150,100] for inner).
                const outerBB = reimportedOuter!.face.boundingBox;
                expect(outerBB.xMin).toBe(-100);
                expect(outerBB.yMin).toBe(-80);
                expect(outerBB.xMax).toBe(100);
                expect(outerBB.yMax).toBe(80);
                expect(outerBB.x).toBe(0);
                expect(outerBB.y).toBe(0);

                const innerBB = reimportedInner!.face.boundingBox;
                expect(innerBB.xMin).toBe(-500);
                expect(innerBB.yMin).toBe(-500);
                expect(innerBB.xMax).toBe(500);
                expect(innerBB.yMax).toBe(500);
                expect(innerBB.x).toBe(0);
                expect(innerBB.y).toBe(0);
            });

        });

        describe("backward compat test", () => {

            it("imports a file with no groupBounds field without throwing", async () => {
                const factory = await createGroupTestingFactory();

                // Build a minimal export with no groupBounds field at all
                const groupInst = "aaaa0000-0000-0000-0000-000000000001";
                const canvasInst = "bbbb0000-0000-0000-0000-000000000001";
                const exportWithoutGroupBounds: DiagramViewExport = {
                    schema: "sample_schema",
                    theme: "dark_theme",
                    objects: [
                        {
                            id: "generic_canvas",
                            instance: canvasInst,
                            objects: [groupInst]
                        },
                        {
                            id: "generic_group",
                            instance: groupInst,
                            objects: []
                        }
                    ],
                    layout: {},
                    camera: { x: 0, y: 0, k: 1 }
                    // groupBounds intentionally omitted
                };

                // Must not throw
                let file: DiagramViewFile | undefined;
                expect(() => {
                    file = new DiagramViewFile(factory, exportWithoutGroupBounds);
                }).not.toThrow();

                // Groups should fall back to auto-fit defaults — userBounds are finite.
                expect(file).toBeDefined();
                const groups = findGroupViewByInstance(file!.canvas, groupInst);
                expect(groups).toBeInstanceOf(GroupView);
                const [xMin, yMin, xMax, yMax] = groups!.face.userBounds;
                expect(Number.isFinite(xMin)).toBe(true);
                expect(Number.isFinite(yMin)).toBe(true);
                expect(Number.isFinite(xMax)).toBe(true);
                expect(Number.isFinite(yMax)).toBe(true);
            });

        });

        describe("clone preserves bounds", () => {

            it("cloned file's group userBounds match the source's userBounds", async () => {
                const factory = await createGroupTestingFactory();

                // Build a file with a single resized group
                const group = makeGroupWithChildren(factory, [], [100, 200, 400, 500]);
                const sourceBounds = group.face.userBounds;

                const file = new DiagramViewFile(factory);
                file.canvas.addObject(group);
                file.canvas.calculateLayout();

                // Clone the file
                const cloned = file.clone();

                // The cloned canvas should have exactly one group.
                const clonedGroups = cloned.canvas.groups as ReadonlyArray<GroupView>;
                expect(clonedGroups.length).toBe(1);

                // Its userBounds must exactly match the source's pre-clone bounds
                expect(clonedGroups[0].face.userBounds).toEqual(sourceBounds);
            });

        });

        describe("restyle preserves bounds", () => {

            it("applyTheme does not reset userBounds on a resized group", async () => {
                const factory = await createGroupTestingFactory();

                // Build a file with a resized group
                const group = makeGroupWithChildren(factory, [], [-300, -200, 300, 200]);
                const bounds = group.face.userBounds;

                const file = new DiagramViewFile(factory);
                file.canvas.addObject(group);
                file.canvas.calculateLayout();

                // Apply the same theme (simulates a theme switch)
                const freshTheme = await loadGroupTheme();
                await file.applyTheme(freshTheme);

                // The group object reference may have changed (restyle replaces faces),
                // so look it up fresh from the canvas.
                const groups = file.canvas.groups as ReadonlyArray<GroupView>;
                expect(groups.length).toBe(1);

                // userBounds must be unchanged after restyle
                expect(groups[0].face.userBounds).toEqual(bounds);
            });

        });

    });
});
