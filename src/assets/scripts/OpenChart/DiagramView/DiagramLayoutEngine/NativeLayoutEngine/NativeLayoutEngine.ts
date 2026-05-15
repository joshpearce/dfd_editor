// pattern: Imperative Shell
import { ManualLayoutEngine } from "../ManualLayoutEngine";
import type { PositionMap } from "../ManualLayoutEngine";
import { DiagramObjectSerializer } from "@OpenChart/DiagramModel";
import type { DiagramObjectExport } from "@OpenChart/DiagramModel";
import type { DiagramObjectView } from "../../DiagramObjectView";
import type { AsyncDiagramLayoutEngine } from "../DiagramLayoutEngine";

/**
 * Serialized canvas handed to the {@link NativeLayoutSource}.  Produced by
 * the same serialization path `DiagramViewFile.toExport()` uses for its
 * layout-relevant fields.
 */
export interface NativeLayoutDocument {
    objects: DiagramObjectExport[];
    layout:  PositionMap;
}

/**
 * A function that accepts a serialized diagram document and resolves to a
 * {@link PositionMap}.  Injected at construction so the engine does not import
 * from `src/assets/scripts/api/` (OpenChart boundary: the engine layer stays
 * framework-agnostic and HTTP-free).
 */
export type NativeLayoutSource = (doc: NativeLayoutDocument) => Promise<PositionMap>;

/**
 * Async layout engine that serializes the canvas, passes it to an injected
 * {@link NativeLayoutSource}, and applies the returned {@link PositionMap} via
 * {@link ManualLayoutEngine}.
 *
 * Key invariants:
 *  - The {@link NativeLayoutSource} callback is injected at construction so
 *    the engine makes no HTTP calls and imports nothing from
 *    `src/assets/scripts/api/`.
 *  - An empty {@link PositionMap} returned by the source is a provable no-op:
 *    {@link ManualLayoutEngine.run} skips every object absent from the map,
 *    so positions are left unchanged.
 *  - A rejected source Promise propagates to the caller unchanged; the engine
 *    does not swallow it.  `DiagramViewFile.runLayout`'s call site handles
 *    failures, exactly as with {@link NewAutoLayoutEngine}.
 */
export class NativeLayoutEngine implements AsyncDiagramLayoutEngine {

    /**
     * Creates a new {@link NativeLayoutEngine}.
     *
     * @param source
     *  A provider that accepts a serialized canvas document and returns the
     *  positions to apply.  Injected to keep the engine layer free of HTTP
     *  concerns.
     */
    constructor(private readonly source: NativeLayoutSource) {}

    /**
     * Runs the native layout engine on the canvas root.
     *
     * Serializes the canvas using the same path as `DiagramViewFile.toExport()`
     * (via {@link DiagramObjectSerializer.exportObjects} and
     * {@link ManualLayoutEngine.generatePositionMap}), passes the document to
     * the injected {@link NativeLayoutSource}, then applies the returned
     * {@link PositionMap} in-place via {@link ManualLayoutEngine}.
     *
     * @param objects
     *  The canvas root is expected at `objects[0]`.  If `objects` is empty,
     *  `run` returns without calling the source.
     */
    public async run(objects: DiagramObjectView[]): Promise<void> {
        if (objects.length === 0) {
            return;
        }

        const doc: NativeLayoutDocument = {
            objects: DiagramObjectSerializer.exportObjects(objects),
            layout:  ManualLayoutEngine.generatePositionMap(objects)
        };

        const map = await this.source(doc);
        new ManualLayoutEngine(map).run(objects);
    }

}
