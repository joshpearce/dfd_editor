/**
 * @file GroupFace.testing.ts
 *
 * Test-only fixture helpers for GroupFace and GroupView unit tests.
 * NOT production code — do not add to any production barrel (index.ts).
 * Import via direct relative path from spec files only.
 *
 * Reused by:
 *   - GroupFace.spec.ts (Step 2)
 *   - ViewLocators.spec.ts (Step 3)
 */

import { ThemeLoader, DarkStyle } from "@OpenChart/ThemeLoader";
import {
    Alignment, BlockView, DiagramObjectViewFactory, FaceType,
    GroupView, Orientation
} from "@OpenChart/DiagramView";
import { sampleSchema } from "../../../../DiagramModel/DiagramModel.fixture";
import { DiagramObjectType } from "@OpenChart/DiagramModel";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
import type { DiagramThemeConfiguration } from "@OpenChart/ThemeLoader";
import type { DiagramSchemaConfiguration } from "@OpenChart/DiagramModel";
import type { CanvasView, DiagramTheme } from "@OpenChart/DiagramView";


///////////////////////////////////////////////////////////////////////////////
//  Minimal schema + theme  ///////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Schema extended with a `generic_group` template.
 * Mirrors the `groupSchema` definition in OpenChart.spec.ts.
 */
const groupSchema: DiagramSchemaConfiguration = {
    ...sampleSchema,
    templates: [
        ...sampleSchema.templates,
        {
            name: "generic_group",
            type: DiagramObjectType.Group,
            properties: {}
        }
    ]
};

/**
 * Minimal theme that registers all object types used in group-related tests.
 *
 * Includes canvas, block, anchor, latch, handle, line, and group designs so
 * the factory can produce every object type without throwing.
 */
const groupTheme: DiagramThemeConfiguration = {
    id: "test_group_theme",
    name: "Test Group Theme",
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
        },
        generic_group: {
            type: FaceType.Group,
            attributes: 0
        }
    }
};


///////////////////////////////////////////////////////////////////////////////
//  Factory  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a {@link DiagramObjectViewFactory} capable of producing GroupViews.
 *
 * Mirrors `createTestingGroupFactory` from OpenChart.spec.ts. Independent
 * copy so spec files never import from another spec file.
 */
export async function createGroupTestingFactory(): Promise<DiagramObjectViewFactory> {
    const theme = await ThemeLoader.load(groupTheme);
    return new DiagramObjectViewFactory(groupSchema, theme);
}

/**
 * Loads the group theme configuration via {@link ThemeLoader}.
 *
 * Exported so callers that need a loaded {@link DiagramTheme} (e.g. for
 * `DiagramViewFile.applyTheme`) can obtain it without re-defining the config.
 */
export async function loadGroupTheme(): Promise<DiagramTheme> {
    return ThemeLoader.load(groupTheme);
}


///////////////////////////////////////////////////////////////////////////////
//  Object builders  //////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Creates a new {@link GroupView} via the group-capable factory.
 * @param factory - The factory to create the group with.
 */
export function makeGroupView(factory: DiagramObjectViewFactory): GroupView {
    return factory.createNewDiagramObject("generic_group", GroupView);
}

/**
 * Creates a new {@link BlockView} via the group-capable factory.
 * @param factory - The factory to create the block with.
 */
export function makeBlockView(factory: DiagramObjectViewFactory): BlockView {
    return factory.createNewDiagramObject("generic_block", BlockView);
}

/**
 * Creates a {@link GroupView} with optional children and optional explicit bounds.
 *
 * When `bounds` is provided, calls `face.setBounds(...)` before adding children.
 * When omitted, the group keeps its default bounds (`[-150,-100,150,100]`).
 * After adding all children, calls `face.calculateLayout()` so the bounding box
 * is up-to-date on return.
 *
 * @param factory  - The factory to create objects with.
 * @param children - Child objects to add to the group (may be empty).
 * @param bounds   - Optional `[xMin, yMin, xMax, yMax]` to set before adding
 *                   children.
 * @returns The configured {@link GroupView}.
 */
export function makeGroupWithChildren(
    factory: DiagramObjectViewFactory,
    children: DiagramObjectView[],
    bounds?: [number, number, number, number]
): GroupView {
    const group = makeGroupView(factory);
    if (bounds !== undefined) {
        group.face.setBounds(...bounds);
    }
    for (const child of children) {
        group.addObject(child);
    }
    group.face.calculateLayout();
    return group;
}


///////////////////////////////////////////////////////////////////////////////
//  Lookup helpers  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Recursively searches a canvas or group for the first {@link GroupView} with
 * the given instance id.
 *
 * `canvas.groups` / `group.groups` are typed as `ReadonlyArray<Group>` from
 * the model base class, but in a {@link DiagramViewFile} they are always
 * {@link GroupView} instances. The cast is centralised here so callers do not
 * need to re-prove the invariant.
 *
 * @param root     - The root canvas or group to search from.
 * @param instance - The instance id to find.
 * @returns The matching {@link GroupView}, or `undefined` if not found.
 */
export function findGroupViewByInstance(
    root: CanvasView | GroupView,
    instance: string
): GroupView | undefined {
    const groups = root.groups as ReadonlyArray<GroupView>;
    for (const g of groups) {
        if (g.instance === instance) {
            return g;
        }
        const nested = findGroupViewByInstance(g, instance);
        if (nested) {
            return nested;
        }
    }
    return undefined;
}
