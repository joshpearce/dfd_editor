import { layoutDiagram } from "@/assets/scripts/api/DfdApiClient";
import { AppCommand } from "../AppCommand";
import { GroupCommand } from "@OpenChart/DiagramEditor/Commands";
import { NewAutoLayoutEngine } from "@OpenChart/DiagramView";
import { diffAutoLayout } from "./diffAutoLayout";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";

export class AutoLayoutActiveFile extends AppCommand {

    private readonly editor: DiagramViewEditor;

    /**
     * Re-runs TALA layout on a clone of the active file, diffs the result
     * against the live canvas, and pushes a single {@link GroupCommand} of
     * existing primitives onto the undo stack.  When the diff is empty (the
     * canvas is already optimally positioned) no command is pushed.
     * @param editor
     *  The file's editor.
     */
    constructor(editor: DiagramViewEditor) {
        super();
        this.editor = editor;
    }

    public async execute(): Promise<void> {
        const instanceMap = new Map<string, string>();
        const clone = this.editor.file.clone(undefined, instanceMap);
        await clone.runLayout(new NewAutoLayoutEngine(layoutDiagram));
        const cmds = diffAutoLayout(this.editor.file.canvas, clone.canvas, instanceMap);
        if (cmds.length === 0) {
            return;
        }
        const group = new GroupCommand();
        for (const c of cmds) {
            group.do(c);
        }
        this.editor.execute(group);
    }

}
