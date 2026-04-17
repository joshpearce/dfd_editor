import type { DiagramObjectView } from "../DiagramObjectView";

/**
 * Synchronous layout engine contract.  Implementations such as
 * {@link ManualLayoutEngine}, {@link GroupBoundsEngine}, and
 * {@link AutomaticLayoutEngine} satisfy this interface because their
 * `run()` methods perform no I/O and complete synchronously.
 */
export interface DiagramLayoutEngine {

    /**
     * Runs the layout engine on a set of objects.
     * @param objects
     *  The objects.
     */
    run(objects: DiagramObjectView[]): void;

}

/**
 * Async layout engine contract.  Implementations that perform I/O (e.g.
 * {@link NewAutoLayoutEngine}, which fetches TALA-rendered SVG over HTTP)
 * satisfy this interface.  Call sites that hold an
 * {@link AsyncDiagramLayoutEngine} must `await` the returned Promise.
 */
export interface AsyncDiagramLayoutEngine {

    /**
     * Runs the layout engine on a set of objects.
     * @param objects
     *  The objects.
     */
    run(objects: DiagramObjectView[]): Promise<void>;

}
