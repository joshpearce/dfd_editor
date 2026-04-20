import { MD5 } from "@OpenChart/Utilities";
import type { FilePreprocessor } from "@/assets/scripts/Application";
import type { DiagramViewExport } from "@OpenChart/DiagramView";
import type { DiagramObjectExport } from "@OpenChart/DiagramModel";
import type { JsonEntries, JsonValue } from "@OpenChart/DiagramModel";

export class DfdFilePreprocessor implements FilePreprocessor {

    /**
     * Preprocesses a native dfd_v1 file before the OpenChart deserializer
     * loads it. Responsible for normalizing shapes that the backend emits
     * differently from what the OpenChart DiagramObjectFactory expects:
     *
     * - Flow `data_item_refs`: the backend emits a plain string array
     *   `["guid1", ...]` as the property value, but OpenChart's
     *   `ListProperty.createListProperty` expects `JsonEntries`
     *   (`[["opaqueKey", "guid"], ...]`).  We convert the former to the
     *   latter here so the deserializer can construct the right
     *   `ListProperty<StringProperty>` without error.
     *
     * - Canvas `data_items` and legacy payloads (no `data_items` or
     *   `data_item_refs` fields) pass through untouched — the engine
     *   handles absent optional properties by defaulting to empty
     *   ListProperty, and the DictionaryProperty sub-fields already match
     *   the OpenChart `JsonEntries` shape as emitted by `transform.py`.
     */
    public process(file: DiagramViewExport): DiagramViewExport {
        // Normalize each object's properties in-place (safe — we own the
        // parsed JSON at this point; nothing else has a reference to it).
        const objects: DiagramObjectExport[] = (file.objects ?? []).map(obj => {
            if (obj.id !== "data_flow") {
                return obj;
            }
            return {
                ...obj,
                properties: normalizeFlowProperties(obj.properties)
            };
        });
        return { ...file, objects };
    }

}

/**
 * Normalises a data_flow's properties array so that `data_item_refs` is in
 * the `[[opaqueKey, guidString], ...]` (JsonEntries) shape the OpenChart
 * ListProperty factory expects.
 *
 * The backend (`transform.to_native`) emits `data_item_refs` as a plain
 * string list: `["guid1", "guid2"]`.  Frontend saves already use the correct
 * JsonEntries format.  Both shapes are accepted; the plain-list form is
 * converted here before deserialization.
 *
 * @param properties - Raw properties array from the native file. May be
 *   undefined for flows with no properties.
 * @returns Normalized properties array.
 */
function normalizeFlowProperties(
    properties: JsonEntries | undefined
): JsonEntries | undefined {
    if (!properties) {
        return properties;
    }
    return properties.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2) {
            return entry;
        }
        const [key, value] = entry;
        if (key !== "data_item_refs") {
            return entry;
        }
        // Already in JsonEntries format: [[opaqueKey, guid], ...].
        if (isJsonEntries(value)) {
            return entry;
        }
        // Backend-native format: ["guid1", "guid2", ...].
        if (Array.isArray(value) && value.every(v => typeof v === "string" || v === null)) {
            const normalized: JsonEntries = (value as (string | null)[])
                .filter((v): v is string => typeof v === "string")
                .map(guid => [MD5(guid), guid]);
            return [key, normalized];
        }
        // Empty array — leave as-is; factory handles it fine.
        return entry;
    }) as JsonEntries;
}

/**
 * Returns true if `value` looks like a `JsonEntries` array (i.e. an array of
 * `[string, ...]` 2-tuples), as opposed to a plain scalar array.
 *
 * We use this to detect whether `data_item_refs` was already serialised in the
 * frontend-native `[[key, guid], ...]` format and therefore needs no
 * conversion.
 */
function isJsonEntries(value: JsonValue | JsonEntries): value is JsonEntries {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }
    // A JsonEntries array has entries that are themselves 2-element arrays
    // whose first element is a string.
    const first = value[0];
    return Array.isArray(first) && first.length === 2 && typeof first[0] === "string";
}

export default DfdFilePreprocessor;
