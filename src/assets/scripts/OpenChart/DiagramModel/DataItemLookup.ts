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
import { traverse } from "./DiagramNavigators";

// ---------------------------------------------------------------------------
// Shared chip-geometry constants
// ---------------------------------------------------------------------------
// Exported so that both DictionaryBlock and LabeledDynamicLine share the
// same numeric values, keeping chip geometry visually consistent across
// block faces and line faces without coupling the two modules directly.

/**
 * Horizontal padding inside each chip as a fraction of chip height.
 * Used by both DictionaryBlock and LabeledDynamicLine.
 */
export const CHIP_PAD_X_OF_HEIGHT = 0.5;

/**
 * Font size as a fraction of chip height.
 * Used by LabeledDynamicLine for its dynamic font-size calculation.
 */
export const CHIP_FONT_SIZE_OF_HEIGHT = 0.65;

/**
 * Text baseline offset as a fraction of chip height (top-to-baseline).
 * Used by both DictionaryBlock and LabeledDynamicLine.
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
 * falls back to `"default"` via {@link narrowClassification}.
 */
export type PillClassificationKey = "pii" | "secret" | "public" | "internal" | "default";

// ---------------------------------------------------------------------------
// Shared classification helpers
// ---------------------------------------------------------------------------

/**
 * Narrows an arbitrary `classification` string to the known
 * {@link PillClassificationKey} union.  Values not in the known set fall back
 * to `"default"`.
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
        classification === "internal"
    ) {
        return classification;
    }
    return "default";
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
 * Returns the filtered, non-empty GUID strings from a `data_item_refs`
 * ListProperty held in the supplied `RootProperty`.  Returns an empty array
 * when the property does not exist or has no entries.
 *
 * This is the single authoritative place to extract ref GUIDs — avoids
 * duplicating the ListProperty-iteration pattern in LabeledDynamicLine,
 * DfdValidator, and any future caller.
 *
 * Accepts a `RootProperty` rather than a full `DiagramObject` so that it
 * works for both model objects (`DiagramObject.properties`) and semantic-graph
 * wrappers (`SemanticGraphEdge.props`), which share the same `RootProperty`
 * type but differ in their containing class API.
 *
 * @param props  The root property bag of the object to inspect.
 */
export function readDataItemRefs(props: RootProperty): string[] {
    const refsProp = props.value.get("data_item_refs");
    if (!(refsProp instanceof ListProperty)) {
        return [];
    }
    const guids: string[] = [];
    for (const [, entry] of refsProp.value) {
        const val = entry.toJson();
        if (typeof val === "string" && val.length > 0) {
            guids.push(val);
        }
    }
    return guids;
}

/**
 * Maps an ordered list of GUIDs to their corresponding DataItem records.
 * Unknown GUIDs (items deleted since the ref was recorded) are silently
 * skipped — validator-surface concerns belong in Step 5.
 *
 * @param canvas  The diagram canvas.
 * @param guids   Ordered list of data-item GUIDs to resolve.
 */
export function resolveRefs(canvas: Canvas, guids: string[]): DataItem[] {
    if (guids.length === 0) {
        return [];
    }
    const all = readDataItems(canvas);
    const byGuid = new Map(all.map(item => [item.guid, item]));
    const result: DataItem[] = [];
    for (const guid of guids) {
        const item = byGuid.get(guid);
        if (item !== undefined) {
            result.push(item);
        }
        // Unknown GUIDs are silently skipped.
    }
    return result;
}

/**
 * Builds a guid → name index by making a single traversal of the canvas.
 * Pass the result to {@link pillLabel} as `parentNameIndex` to avoid one
 * O(N) traversal per chip when rendering multiple items.
 *
 * @param canvas  The diagram canvas to traverse.
 * @returns       A Map from object instance guid to the object's `name` field.
 */
export function buildParentNameIndex(canvas: Canvas): Map<string, string> {
    const index = new Map<string, string>();
    for (const obj of traverse(canvas)) {
        const nameProp = obj.properties?.value.get("name");
        if (nameProp) {
            const nameVal = nameProp.toJson();
            index.set(obj.instance, typeof nameVal === "string" ? nameVal : "");
        }
    }
    return index;
}

/**
 * Returns the display label for a data item as seen from a specific node.
 *
 * - **Owner view** (`viewedFromGuid === item.parent`): bare identifier, e.g. `"D1"`.
 * - **Non-owner / no-owner view** (`viewedFromGuid === null` or differs from
 *   `item.parent`): qualified as `"ParentName.D1"` where the parent name is
 *   truncated to 12 characters with a trailing `…` when longer.
 *
 * Pass `null` when there is no "viewing from" node (e.g. a data flow, which
 * can never own a data item).  The `null` sentinel replaces the previous
 * `""` empty-string convention and makes intent explicit at every call site.
 *
 * @param item             The data item to label.
 * @param viewedFromGuid   The GUID of the node requesting the label, or `null`
 *                         to always produce the qualified form.
 * @param canvas           The diagram canvas (used to look up the parent name
 *                         when `parentNameIndex` is not supplied).
 * @param parentNameIndex  Optional precomputed guid→name map from
 *                         {@link buildParentNameIndex}.  When provided, the
 *                         canvas traversal is skipped — pass this when
 *                         resolving labels for multiple items to amortise the
 *                         O(N) walk across all chips.
 */
export function pillLabel(
    item: DataItem,
    viewedFromGuid: string | null,
    canvas: Canvas,
    parentNameIndex?: Map<string, string>
): string {
    if (viewedFromGuid !== null && viewedFromGuid === item.parent) {
        // Owner view — bare identifier.
        return item.identifier;
    }
    // Non-owner view — qualified with (possibly truncated) parent name.
    const parentName = parentNameIndex !== undefined
        ? (parentNameIndex.get(item.parent) ?? item.parent)
        : resolveParentName(canvas, item.parent);
    const truncated = truncate(parentName, 12);
    return `${truncated}.${item.identifier}`;
}

/**
 * Looks up the `name` property of the canvas node whose instance id is
 * `parentGuid`. Falls back to the raw GUID when the node is not found.
 *
 * TODO(Step 4/5): the face builder should memoize parent-name lookups per
 * render frame once pill rendering lands; this O(N) traversal is fine for
 * the current Step 2 / lookup context but will become a hot path.
 */
function resolveParentName(canvas: Canvas, parentGuid: string): string {
    for (const obj of traverse(canvas)) {
        if (obj.instance === parentGuid) {
            const nameProp = obj.properties?.value.get("name");
            if (nameProp) {
                // toJson() returns null for an unset StringProperty; fall
                // back to "" so we produce a qualifying prefix like ".D1"
                // rather than "None.D1".
                const nameVal = nameProp.toJson();
                return typeof nameVal === "string" ? nameVal : "";
            }
        }
    }
    // Node not found — fall back to the raw GUID.
    return parentGuid;
}

/**
 * Truncates `str` to `maxLength` Unicode code points, appending `…` when
 * truncation occurs. Uses spread (`[...str]`) to count code points rather
 * than UTF-16 code units, which avoids splitting surrogate pairs for emoji
 * or non-BMP characters.
 *
 * The `…` character is added on top — the result is at most
 * `maxLength + 1` code points long when truncation occurs, matching the
 * spec's "~12 chars with ellipsis" language.
 */
export function truncate(str: string, maxLength: number): string {
    const codePoints = [...str];
    if (codePoints.length <= maxLength) {
        return str;
    }
    return codePoints.slice(0, maxLength).join("") + "…";
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
