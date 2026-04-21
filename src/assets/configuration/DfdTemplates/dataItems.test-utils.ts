/**
 * @file dataItems.test-utils.ts
 *
 * Shared test helper for data-item operations on a canvas's `data_items`
 * ListProperty.  Consumed by DfdPublisher, DataItemLookup, and preprocessor
 * specs to avoid duplicating the same mutation logic in every test file.
 */

import { ListProperty, DictionaryProperty, StringProperty } from "@OpenChart/DiagramModel";
import type { Canvas } from "@OpenChart/DiagramModel";
import type { Line } from "@OpenChart/DiagramModel";

/**
 * Adds a data item entry to a canvas's data_items ListProperty.
 *
 * @param canvas         The canvas to mutate.
 * @param guid           The item guid (used as the ListProperty entry key).
 * @param parent         The parent node guid.
 * @param identifier     Display token, e.g. "D1".
 * @param name           Human-readable name.
 * @param description    Optional description.
 * @param classification Optional classification.
 */
export function addDataItem(
    canvas: Canvas,
    guid: string,
    parent: string,
    identifier: string,
    name: string,
    description?: string,
    classification?: string
): void {
    const dataItemsProp = canvas.properties.value.get("data_items");
    if (!(dataItemsProp instanceof ListProperty)) {
        throw new Error("canvas.properties.data_items is not a ListProperty");
    }
    const entry = dataItemsProp.createListItem() as DictionaryProperty;
    const fields = entry.value;
    (fields.get("parent") as StringProperty).setValue(parent);
    (fields.get("identifier") as StringProperty).setValue(identifier);
    (fields.get("name") as StringProperty).setValue(name);
    if (description !== undefined) {
        (fields.get("description") as StringProperty).setValue(description);
    }
    if (classification !== undefined) {
        (fields.get("classification") as StringProperty).setValue(classification);
    }
    dataItemsProp.addProperty(entry, guid);
}

/**
 * Adds a data_item_ref GUID to a flow's node1_src_data_item_refs or node2_src_data_item_refs
 * ListProperty.
 *
 * @param line       The data_flow Line to mutate.
 * @param refGuid    The GUID of the data item to reference.
 * @param direction  Which direction: "node1" for node1_src_data_item_refs, "node2" for node2_src_data_item_refs. Defaults to "node1".
 */
export function addDataItemRef(line: Line, refGuid: string, direction: "node1" | "node2" = "node1"): void {
    const propName = direction === "node1" ? "node1_src_data_item_refs" : "node2_src_data_item_refs";
    const refsProp = line.properties.value.get(propName);
    if (!(refsProp instanceof ListProperty)) {
        throw new Error(`line.properties.${propName} is not a ListProperty`);
    }
    const entry = refsProp.createListItem() as StringProperty;
    entry.setValue(refGuid);
    refsProp.addProperty(entry);
}
