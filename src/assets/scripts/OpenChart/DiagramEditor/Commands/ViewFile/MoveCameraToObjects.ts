import { SynchronousEditorCommand } from "../SynchronousEditorCommand";
import { computeFitCamera } from "@OpenChart/DiagramView";
import type { DiagramInterface } from "@OpenChart/DiagramInterface";
import type { CameraLocation, DiagramObjectView } from "@OpenChart/DiagramView";


export class MoveCameraToObjects extends SynchronousEditorCommand {

    /**
     * The objects' interface.
     */
    public readonly interface: DiagramInterface;

    /**
     * The camera's location.
     */
    public readonly camera: CameraLocation;


    /**
     * Focuses the camera on a set of objects.
     * @param editor
     *  The objects' interface.
     * @param objects
     *  The objects.
     */
    constructor(ui: DiagramInterface, objects: DiagramObjectView[]) {
        super();
        this.interface = ui;
        // Fall back to origin at 1× when none of the objects has a non-empty
        // bounding box — avoids sending NaN through setCameraLocation for a
        // pathological "zoom to empty selection".  In practice the menu item
        // is disabled on empty selections so this branch is a safety net.
        this.camera = computeFitCamera(objects, ui.width, ui.height)
            ?? { x: 0, y: 0, k: 1 };
    }


    /**
     * Executes the page command.
     * @returns
     *  True if the command should be recorded, false otherwise.
     */
    public execute(): void {
        this.interface.setCameraLocation(this.camera);
    }

    /**
     * Undoes the page command.
     */
    public undo() {}

}
