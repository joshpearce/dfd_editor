/**
 * @file DataItemLookup.ts
 *
 * Pure helper functions for working with the canvas-level DataItem collection.
 * No DiagramView or DOM imports — safe to use in pure model / publisher
 * contexts and in Vitest without a browser environment.
 */

import { ListProperty, DictionaryProperty } from "./DiagramObject";
import type { Canvas } from "./DiagramObject";
import { traverse } from "./DiagramNavigators";

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reads all data items from a canvas's `data_items` ListProperty.
 * Returns an empty array for canvases without the property (legacy diagrams).
 */
function readDataItems(canvas: Canvas): DataItem[] {
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
        const parent = fields.get("parent")?.toJson();
        const identifier = fields.get("identifier")?.toJson();
        const name = fields.get("name")?.toJson();
        if (
            typeof parent !== "string" ||
            typeof identifier !== "string" ||
            typeof name !== "string"
        ) {
            // Required fields missing — skip and warn; the validator surfaces
            // this as a user-visible error so we don't throw here.
            console.warn(
                `DataItemLookup: skipping data item ${guid} — required fields ` +
                "(parent, identifier, name) are missing or not strings."
            );
            continue;
        }
        const item: DataItem = { guid, parent, identifier, name };
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
 * Returns the display label for a data item as seen from a specific node.
 *
 * - **Owner view** (`viewedFromGuid === item.parent`): bare identifier, e.g. `"D1"`.
 * - **Non-owner view**: qualified as `"ParentName.D1"` where the parent name
 *   is truncated to 12 characters with a trailing `…` when longer.
 *
 * @param item           The data item to label.
 * @param viewedFromGuid The GUID of the node requesting the label.
 * @param canvas         The diagram canvas (used to look up the parent name).
 */
export function pillLabel(
    item: DataItem,
    viewedFromGuid: string,
    canvas: Canvas
): string {
    if (viewedFromGuid === item.parent) {
        // Owner view — bare identifier.
        return item.identifier;
    }
    // Non-owner view — qualified with (possibly truncated) parent name.
    const parentName = resolveParentName(canvas, item.parent);
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
