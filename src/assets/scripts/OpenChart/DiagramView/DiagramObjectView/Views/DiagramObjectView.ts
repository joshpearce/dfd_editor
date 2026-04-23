import type { ViewObject } from "../ViewObject";
import type { DiagramObject } from "@OpenChart/DiagramModel";
import type { PolyLineSpanView } from "../Faces/Lines/PolyLineSpanView";

/**
 * A generic diagram object view.
 */
export type DiagramObjectView = DiagramObject & ViewObject;

/**
 * The union of all types that `getObjectAt` may return.
 *
 * Most hit targets are {@link DiagramObjectView} instances (blocks, lines,
 * latches, handles, etc.), but an interior segment of a {@link PolyLine}
 * resolves to a {@link PolyLineSpanView} — a pure data carrier that is not
 * part of the diagram model.  Callers that need to distinguish span hits
 * from model-object hits should use `instanceof PolyLineSpanView`.
 */
export type HitTarget = DiagramObjectView | PolyLineSpanView;
