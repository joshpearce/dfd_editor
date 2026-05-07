// pattern: Functional Core
import { Canvas, Group, Line, Handle, Latch, traverse } from "@OpenChart/DiagramModel";
import { MoveObjectsTo, ResizeGroupBy, SetLineFace } from "@OpenChart/DiagramEditor/Commands/View/index.commands";
import { AddHandleToLine, RemoveHandleFromLine, DetachLatchFromAnchor, AttachLatchToAnchor } from "@OpenChart/DiagramEditor/Commands/Model/index.commands";
import { GroupView, LineView, LatchView, ResizeEdge } from "@OpenChart/DiagramView";
import type { AnchorView } from "@OpenChart/DiagramView";
import type { CanvasView, DiagramObjectView } from "@OpenChart/DiagramView";
import type { SynchronousEditorCommand } from "@OpenChart/DiagramEditor/Commands/SynchronousEditorCommand";
import type { LineFaceCtor } from "@OpenChart/DiagramEditor/Commands/View/SetLineFace";

/**
 * Compares two canvas snapshots (live vs. post-layout planned) and emits the
 * minimum set of {@link SynchronousEditorCommand}s that, when executed
 * sequentially against the live canvas, make it identical to the planned
 * canvas.
 *
 * All commands in the returned list reference **live** JS objects so they can
 * be executed directly against the live editor.  The planned canvas is used
 * only as a source of target coordinates and topology.
 *
 * Commands are returned in dependency order:
 *   1. Face swaps      (SetLineFace)           — before handle adds/removes
 *   2. Handle adds     (AddHandleToLine)        — ascending index, after face swap
 *   3. Handle removes  (RemoveHandleFromLine)   — descending index, after adds
 *   4. Detach          (DetachLatchFromAnchor)  — before attach
 *   5. Attach          (AttachLatchToAnchor)    — before latch moves
 *   6. Moves + resizes (MoveObjectsTo / ResizeGroupBy) — last
 *
 * Returns an empty array when the two canvases are already identical.
 *
 * @param live    - The live canvas (owns the JS objects that will be mutated).
 * @param planned - A canvas snapshot of the desired post-layout state, matched
 *                  to the live canvas by `instance` id.
 */
export function diffAutoLayout(
    live: CanvasView,
    planned: CanvasView
): SynchronousEditorCommand[] {

    ///////////////////////////////////////////////////////////////////////////
    //  Step 1 — index the live canvas by instance id                        //
    ///////////////////////////////////////////////////////////////////////////

    const liveById = new Map<string, DiagramObjectView>();
    for (const obj of traverse<DiagramObjectView>(live)) {
        liveById.set(obj.instance, obj);
    }

    ///////////////////////////////////////////////////////////////////////////
    //  Step 2 — walk the planned canvas and collect diffs                   //
    ///////////////////////////////////////////////////////////////////////////

    // Command buckets ordered for correct execution dependency.
    const faceSwaps:     SynchronousEditorCommand[] = [];
    const handleAdds:    SynchronousEditorCommand[] = [];
    const handleRemoves: SynchronousEditorCommand[] = [];
    const detaches:      SynchronousEditorCommand[] = [];
    const attaches:      SynchronousEditorCommand[] = [];
    const moves:         SynchronousEditorCommand[] = [];

    for (const plannedObj of traverse<DiagramObjectView>(planned)) {
        const liveObj = liveById.get(plannedObj.instance);
        if (liveObj === undefined) {
            // Object exists only in planned — no command to emit.
            continue;
        }

        // ------------------------------------------------------------------ //
        // Canvas (root) — skip; there is no editor command to move/resize it. //
        // ------------------------------------------------------------------ //
        if (plannedObj instanceof Canvas) {
            continue;
        }

        // ------------------------------------------------------------------ //
        // Handle — position is managed per-line in the Line branch below.    //
        // ------------------------------------------------------------------ //
        if (plannedObj instanceof Handle) {
            continue;
        }

        // ------------------------------------------------------------------ //
        // Line — face swap and handle add/remove/move.                       //
        // ------------------------------------------------------------------ //
        if (plannedObj instanceof Line) {
            const plannedLine = plannedObj as unknown as LineView;
            const liveLine    = liveObj       as LineView;

            // Face class diff.  Must run before handle adds so the line is
            // already a PolyLine when interior handles are inserted.
            const liveFaceCtor    = liveLine.face.constructor    as LineFaceCtor;
            const plannedFaceCtor = plannedLine.face.constructor as LineFaceCtor;
            if (liveFaceCtor !== plannedFaceCtor) {
                faceSwaps.push(new SetLineFace(liveLine, plannedFaceCtor));
            }

            // Handle count and position diffs.
            const liveHandles    = liveLine.handles;
            const plannedHandles = plannedLine.handles;
            const liveLen    = liveHandles.length;
            const plannedLen = plannedHandles.length;

            if (plannedLen > liveLen) {
                // Add handles that are present in planned but absent in live.
                // Ascending index keeps earlier inserts from shifting later ones.
                for (let i = liveLen; i < plannedLen; i++) {
                    const ph = plannedHandles[i];
                    handleAdds.push(new AddHandleToLine(liveLine, ph.x, ph.y, i));
                }
            } else if (plannedLen < liveLen) {
                // Remove surplus handles.  Descending index keeps earlier
                // indices stable as later ones are removed.
                for (let i = liveLen - 1; i >= plannedLen; i--) {
                    handleRemoves.push(new RemoveHandleFromLine(liveLine, i));
                }
            }

            // Position diff for handles shared by both canvases.  Newly added
            // handles are already positioned at construction time via
            // AddHandleToLine, so only the min-length overlap is checked.
            const sharedLen = Math.min(liveLen, plannedLen);
            for (let i = 0; i < sharedLen; i++) {
                const lh = liveHandles[i];
                const ph = plannedHandles[i];
                if (lh.x !== ph.x || lh.y !== ph.y) {
                    moves.push(new MoveObjectsTo(lh, ph.x, ph.y));
                }
            }

            // Lines themselves have no independently movable position —
            // their position is determined by latches and handles.
            continue;
        }

        // ------------------------------------------------------------------ //
        // Latch — anchor rebind + position.                                  //
        // ------------------------------------------------------------------ //
        if (plannedObj instanceof Latch) {
            const plannedLatch = plannedObj as unknown as LatchView;
            const liveLatch    = liveObj       as LatchView;

            const liveAnchor    = liveLatch.anchor;
            const plannedAnchor = plannedLatch.anchor;

            const anchorChanged =
                plannedAnchor !== null &&
                liveAnchor    !== null &&
                plannedAnchor.instance !== liveAnchor.instance;

            if (anchorChanged) {
                // Detach from the old anchor first.
                detaches.push(new DetachLatchFromAnchor(liveLatch));

                // Resolve the target anchor from the LIVE canvas (the planned
                // anchor is a clone object and must not be passed to commands).
                const newLiveAnchor = liveById.get(plannedAnchor.instance) as AnchorView | undefined;
                if (newLiveAnchor !== undefined) {
                    attaches.push(new AttachLatchToAnchor(liveLatch, newLiveAnchor));
                }
            }

            // Latch position — emit regardless of anchor rebind, because
            // AttachLatchToAnchor.execute (which calls Latch.link()) does NOT
            // move the latch to the anchor's position.
            if (liveLatch.x !== plannedLatch.x || liveLatch.y !== plannedLatch.y) {
                moves.push(new MoveObjectsTo(liveLatch, plannedLatch.x, plannedLatch.y));
            }
            continue;
        }

        // ------------------------------------------------------------------ //
        // Group — position (center) and size (width / height).              //
        // ------------------------------------------------------------------ //
        if (plannedObj instanceof Group) {
            const plannedGroup = plannedObj as unknown as GroupView;
            const liveGroup    = liveObj       as GroupView;

            const liveBB    = liveGroup.face.boundingBox;
            const plannedBB = plannedGroup.face.boundingBox;

            // Position (center) diff.  Emit before resize so the NW corner is
            // in the right place before the SE corner is extended.
            if (liveBB.x !== plannedBB.x || liveBB.y !== plannedBB.y) {
                moves.push(new MoveObjectsTo(liveGroup, plannedBB.x, plannedBB.y));
            }

            // Size diff — use SE edge (expands/contracts bottom-right corner).
            // dw and dh are signed deltas of total width and height.
            const dw = plannedBB.width  - liveBB.width;
            const dh = plannedBB.height - liveBB.height;
            if (dw !== 0 || dh !== 0) {
                moves.push(new ResizeGroupBy(liveGroup, ResizeEdge.SE, dw, dh));
            }
            continue;
        }

        // ------------------------------------------------------------------ //
        // Block (and any other movable object not matched above).            //
        // ------------------------------------------------------------------ //
        if (plannedObj.x !== liveObj.x || plannedObj.y !== liveObj.y) {
            moves.push(new MoveObjectsTo(liveObj, plannedObj.x, plannedObj.y));
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    //  Step 3 — return in dependency order                                  //
    ///////////////////////////////////////////////////////////////////////////

    return [
        ...faceSwaps,
        ...handleAdds,
        ...handleRemoves,
        ...detaches,
        ...attaches,
        ...moves
    ];
}
