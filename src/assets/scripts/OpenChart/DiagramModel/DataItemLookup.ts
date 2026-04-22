/**
 * @file DataItemLookup.ts
 *
 * Pure helper functions for working with the canvas-level DataItem collection.
 * No DiagramView or DOM imports — safe to use in pure model / publisher
 * contexts and in Vitest without a browser environment.
 */

// pattern: Functional Core

import { ListProperty, DictionaryProperty, RootProperty } from "./DiagramObject";
import type { Canvas } from "./DiagramObject";

// ---------------------------------------------------------------------------
// Shared chip-geometry constants
// ---------------------------------------------------------------------------
// Exported so that DictionaryBlock can reference the same numeric values
// without hardcoding them locally.

/**
 * Horizontal padding inside each chip as a fraction of chip height.
 * Used by DictionaryBlock.
 */
export const CHIP_PAD_X_OF_HEIGHT = 0.5;

/**
 * Text baseline offset as a fraction of chip height (top-to-baseline).
 * Used by DictionaryBlock.
 */
export const CHIP_BASELINE_OF_HEIGHT = 0.75;

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * A single data item, mirroring the schema.py DataItem model fields.
 * `description` and `classification` are optional.
 */
export type DataItem = {
    /** Stable GUID for this item (the ListProperty entry key). */
    guid: string;
    /** GUID of the owning canvas node. */
    parent: string;
    /** Display token, e.g. "D1" or "CARD-NUM". */
    identifier: string;
    /** Human-readable name. */
    name: string;
    /** Optional free-text description. */
    description?: string;
    /** Optional classification label, e.g. "pii" | "secret" | "public". */
    classification?: string;
};

/**
 * The set of known pill-classification keys.  Any value outside this set
 * falls back to `"unclassified"` via {@link narrowClassification}.
 */
export type PillClassificationKey = "pii" | "secret" | "public" | "internal" | "unclassified";

// ---------------------------------------------------------------------------
// Shared classification helpers
// ---------------------------------------------------------------------------

/**
 * Narrows an arbitrary `classification` string to the known
 * {@link PillClassificationKey} union.  Values not in the known set fall back
 * to `"unclassified"`.
 *
 * Used by both DictionaryBlock and LabeledDynamicLine so the narrowing logic
 * is not duplicated between the two faces.
 *
 * @param classification  The raw classification string (may be null/undefined).
 * @returns               A PillClassificationKey safe to index into a dataPill
 *                        style object.
 */
export function narrowClassification(classification: string | null | undefined): PillClassificationKey {
    if (
        classification === "pii" ||
        classification === "secret" ||
        classification === "public" ||
        classification === "internal" ||
        classification === "unclassified"
    ) {
        return classification;
    }
    return "unclassified";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reads all data items from a canvas's `data_items` ListProperty.
 * Returns an empty array for canvases without the property (legacy diagrams).
 *
 * Items with missing required fields (`parent`, `identifier`, `name`) are
 * included with those fields set to empty string rather than silently dropped.
 * Validation responsibility belongs to `DfdValidator`, not here.
 */
export function readDataItems(canvas: Canvas): DataItem[] {
    const prop = canvas.properties.value.get("data_items");
    if (!(prop instanceof ListProperty)) {
        return [];
    }
    const items: DataItem[] = [];
    for (const [guid, entry] of prop.value) {
        if (!(entry instanceof DictionaryProperty)) {
            continue;
        }
        const fields = entry.value;
        const parentVal = fields.get("parent")?.toJson();
        const identifierVal = fields.get("identifier")?.toJson();
        const nameVal = fields.get("name")?.toJson();
        // Emit the item with whatever required fields are available; use empty
        // string for missing ones.  DfdValidator surfaces the missing-field
        // condition as a user-visible warning.
        const item: DataItem = {
            guid,
            parent:     typeof parentVal     === "string" ? parentVal     : "",
            identifier: typeof identifierVal === "string" ? identifierVal : "",
            name:       typeof nameVal       === "string" ? nameVal       : ""
        };
        const description = fields.get("description")?.toJson();
        if (typeof description === "string") {
            item.description = description;
        }
        const classification = fields.get("classification")?.toJson();
        if (typeof classification === "string") {
            item.classification = classification;
        }
        items.push(item);
    }
    return items;
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all canvas data items whose `parent` matches `nodeGuid`,
 * preserving list order. Returns an empty array when none match.
 *
 * @param canvas   The diagram canvas.
 * @param nodeGuid The GUID of the owning node to filter by.
 */
export function dataItemsForParent(canvas: Canvas, nodeGuid: string): DataItem[] {
    return readDataItems(canvas).filter(item => item.parent === nodeGuid);
}

/**
 * Returns per-direction GUID arrays from a bidirectional flow's ref properties.
 *
 * Reads `node1_src_data_item_refs` and `node2_src_data_item_refs` as separate
 * `ListProperty<StringProperty>` objects, extracting non-empty string GUIDs
 * in order. If either key is absent or the wrong type, that direction returns
 * an empty array (no silent fallback to legacy `data_item_refs`; hard cutover).
 *
 * This is the single authoritative place to extract per-direction ref GUIDs —
 * avoids duplicating the ListProperty-iteration pattern in DfdValidator,
 * DfdPublisher, and any future caller.
 *
 * Accepts a `RootProperty` rather than a full `DiagramObject` so that it
 * works for both model objects (`DiagramObject.properties`) and semantic-graph
 * wrappers (`SemanticGraphEdge.props`), which share the same `RootProperty`
 * type but differ in their containing class API.
 *
 * @param props  The root property bag of the object to inspect.
 * @returns      Object with `node1ToNode2` and `node2ToNode1` ref arrays.
 */
export function readFlowRefs(props: RootProperty): {
    node1ToNode2: string[];
    node2ToNode1: string[];
} {
    const result = { node1ToNode2: [] as string[], node2ToNode1: [] as string[] };

    // Read node1 → node2 direction
    const node1Prop = props.value.get("node1_src_data_item_refs");
    if (node1Prop instanceof ListProperty) {
        for (const [, entry] of node1Prop.value) {
            const val = entry.toJson();
            if (typeof val === "string" && val.length > 0) {
                result.node1ToNode2.push(val);
            }
        }
    }

    // Read node2 → node1 direction
    const node2Prop = props.value.get("node2_src_data_item_refs");
    if (node2Prop instanceof ListProperty) {
        for (const [, entry] of node2Prop.value) {
            const val = entry.toJson();
            if (typeof val === "string" && val.length > 0) {
                result.node2ToNode1.push(val);
            }
        }
    }

    return result;
}

/**
 * Computes a lightweight change-detection hash over a list of data items.
 *
 * Intentionally cheap (djb2-style fold over guid + identifier + classification)
 * so that the layout-invalidation check in DictionaryBlock.calculateLayout()
 * stays fast.  Not cryptographically strong — collision resistance is not
 * required here.
 *
 * Hash used only for layout invalidation: folds guid + identifier + classification
 * of items visible on a given block.  `name` and `parent` are intentionally
 * excluded — the pill row renders neither (DictionaryBlock shows bare
 * `identifier` in owner view; the parent is always `this.view.instance`), and
 * name/parent changes don't alter chip width or color.  If pill labels ever
 * start displaying `name` or `parent` (e.g. on hover), those fields must join
 * the hash.
 *
 * @param items  The data items to hash (typically the result of
 *               {@link dataItemsForParent} for a single node).
 * @returns  A 32-bit unsigned integer hash.
 */
export function hashDataItems(items: DataItem[]): number {
    const source = items.map(
        i => `${i.guid}:${i.identifier}:${i.classification ?? ""}`
    ).join("|");
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
        hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
    }
    return hash;
}
