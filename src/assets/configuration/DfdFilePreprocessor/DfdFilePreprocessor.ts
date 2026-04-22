import type { FilePreprocessor } from "@/assets/scripts/Application";
import type { DiagramViewExport } from "@OpenChart/DiagramView";

export class DfdFilePreprocessor implements FilePreprocessor {

    /**
     * Preprocesses a native dfd_v1 file before the OpenChart deserializer
     * loads it.
     *
     * The backend (`transform.to_native`) now emits `node1_src_data_item_refs`
     * and `node2_src_data_item_refs` in the OpenChart `ListProperty<StringProperty>`
     * wire shape — `[[syntheticKey, guidStr], ...]` — so no normalization is
     * needed here. Canvas `data_items` and all other properties already use the
     * correct `[[id, value], ...]` shape.  Legacy files (no `data_items` or
     * ref arrays) pass through without error because the engine defaults absent
     * optional properties to empty `ListProperty`.
     *
     * This preprocessor is intentionally pass-through.  It exists as the
     * single hook point for future shape migrations if the on-disk format
     * ever diverges from the engine's expectation again.
     */
    public process(file: DiagramViewExport): DiagramViewExport {
        return file;
    }

}

export default DfdFilePreprocessor;
