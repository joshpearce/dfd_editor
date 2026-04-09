import { SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
import type { SynchronousCommandProcessor } from "@OpenChart/DiagramEditor";

export class DfdCommandProcessor implements SynchronousCommandProcessor {

    /**
     * Pass-through command processor — no auto-name sync needed.
     */
    public process(_cmd: SynchronousEditorCommand): SynchronousEditorCommand | undefined {
        return undefined;
    }

}

export default DfdCommandProcessor;
