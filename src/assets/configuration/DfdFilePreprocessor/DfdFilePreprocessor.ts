import type { FilePreprocessor } from "@/assets/scripts/Application";
import type { DiagramViewExport } from "@OpenChart/DiagramView";

export class DfdFilePreprocessor implements FilePreprocessor {

    /**
     * Pass-through preprocessor — no legacy migration needed yet.
     */
    public process(file: DiagramViewExport): DiagramViewExport {
        return file;
    }

}

export default DfdFilePreprocessor;
