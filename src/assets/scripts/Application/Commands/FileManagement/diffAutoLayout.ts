import { traverse } from "@OpenChart/DiagramModel";
import { MoveObjectsTo, ResizeGroupBy, SetLineFace } from "@OpenChart/DiagramEditor/Commands/View/index.commands";
import { AddHandleToLine, RemoveHandleFromLine, DetachLatchFromAnchor, AttachLatchToAnchor } from "@OpenChart/DiagramEditor/Commands/Model/index.commands";
import { AnchorView, CanvasView, GroupView, HandleView, LatchView, LineView, ResizeEdge } from "@OpenChart/DiagramView";
import type { DiagramObjectView } from "@OpenChart/DiagramView";
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
 * Anchors are skipped: their position is derived state cascaded from the
 * parent block's moveTo, so no MoveObjectsTo is ever emitted for an anchor.
 * Linked latches whose anchor is unchanged are also not moved explicitly —
 * the parent block's move cascades the latch position automatically.
 *
 * @param live        - The live canvas (owns the JS objects that will be mutated).
 * @param planned     - A canvas snapshot of the desired post-layout state.
 * @param liveToPlanned - The instance-id map returned by
 *   {@link DiagramViewFile.clone}: keys are live instance ids, values are
 *   the corresponding clone (planned) instance ids.  Built by the inner
 *   `Canvas.clone` machinery via `instanceMap.set(original, clone)`, so
 *   direction is always **live → planned**.
 */
export function diffAutoLayout(
    live: CanvasView,
    planned: CanvasView,
    liveToPlanned: Map<string, string>
): SynchronousEditorCommand[] {

    // Index the live canvas by instance id.
    // traverse() yields canvas + descendants depth-first; canvas root is
    // skipped explicitly below.
    const liveById = new Map<string, DiagramObjectView>();
    for (const obj of traverse<DiagramObjectView>(live)) {
        liveById.set(obj.instance, obj);
    }

    // Build the inverse map: planned id → live id.
    // liveToPlanned was populated by Canvas.clone() as
    //   instanceMap.set(original.instance, clone.instance)
    // so inverting gives us plannedToLive for lookups in the walker below.
    const plannedToLive = new Map<string, string>();
    for (const [liveId, plannedId] of liveToPlanned) {
        plannedToLive.set(plannedId, liveId);
    }

    // Command buckets ordered for correct execution dependency.
    const faceSwaps: SynchronousEditorCommand[] = [];
    const handleAdds: SynchronousEditorCommand[] = [];
    const handleRemoves: SynchronousEditorCommand[] = [];
    const detaches: SynchronousEditorCommand[] = [];
    const attaches: SynchronousEditorCommand[] = [];
    const moves: SynchronousEditorCommand[] = [];

    for (const plannedObj of traverse<DiagramObjectView>(planned)) {
        // Translate the planned clone id back to its original live id, then
        // look up the live JS object.  Objects absent from the map (e.g.
        // objects added to planned after the clone) are skipped.
        const liveId  = plannedToLive.get(plannedObj.instance);
        const liveObj = liveId !== undefined ? liveById.get(liveId) : undefined;
        if (liveObj === undefined) {
            continue;
        }

        // Canvas (root) — skip; there is no editor command to move/resize it.
        if (plannedObj instanceof CanvasView) {
            continue;
        }

        // Anchor — skip; anchors are derived state cascaded from the parent
        // block's position.  Emitting MoveObjectsTo for an anchor is redundant
        // on execute and corrupts undo: the anchor's captured px/py is the
        // original live position, so undo restores it directly while the parent
        // block's undo also cascades the anchor by the inverse delta — leaving
        // the anchor at live_anchor − block_delta, which is wrong by block_delta.
        if (plannedObj instanceof AnchorView) {
            continue;
        }

        // Handle — position is managed per-line in the Line branch below.
        if (plannedObj instanceof HandleView) {
            continue;
        }

        // Line — face swap and handle add/remove/move.
        if (plannedObj instanceof LineView) {
            const plannedLine = plannedObj;
            const liveLine    = liveObj as LineView;

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

            // Build a O(1)-lookup map from planned handle instance → HandleView.
            const plannedHandleById = new Map<string, HandleView>();
            for (const ph of plannedHandles) {
                plannedHandleById.set(ph.instance, ph);
            }

            // Removes: live handles whose mapped planned id is absent from the
            // planned handle set.  Collected and sorted in descending live-index
            // order so that executing them sequentially does not shift earlier
            // indices.
            const toRemove: number[] = [];
            for (let i = 0; i < liveHandles.length; i++) {
                const plannedHandleId = liveToPlanned.get(liveHandles[i].instance);
                if (plannedHandleId === undefined || !plannedHandleById.has(plannedHandleId)) {
                    toRemove.push(i);
                }
            }
            toRemove.sort((a, b) => b - a);
            for (const idx of toRemove) {
                handleRemoves.push(new RemoveHandleFromLine(liveLine, idx));
            }

            // Adds: planned handles whose instance has no live counterpart (i.e.,
            // not present as a value in liveToPlanned, meaning plannedToLive has
            // no entry for them).  Emitted in ascending planned-index order so
            // that earlier inserts do not shift later ones.
            for (let i = 0; i < plannedHandles.length; i++) {
                const ph = plannedHandles[i];
                if (!plannedToLive.has(ph.instance)) {
                    handleAdds.push(new AddHandleToLine(liveLine, ph.x, ph.y, i));
                }
            }

            // Moves: handles present in both canvases whose positions differ.
            // Walk live handles in order; look up the planned counterpart by
            // identity via the instance map.  Newly added handles (no live
            // counterpart) are positioned at construction time via AddHandleToLine
            // and are skipped here.
            for (const lh of liveHandles) {
                const plannedHandleId = liveToPlanned.get(lh.instance);
                if (plannedHandleId === undefined) { continue; }
                const ph = plannedHandleById.get(plannedHandleId);
                if (ph === undefined) { continue; }
                if (differs(lh.x, ph.x) || differs(lh.y, ph.y)) {
                    moves.push(new MoveObjectsTo(lh, ph.x, ph.y));
                }
            }

            // Lines themselves have no independently movable position —
            // their position is determined by latches and handles.
            continue;
        }

        // Latch — anchor rebind + position.
        if (plannedObj instanceof LatchView) {
            const plannedLatch = plannedObj;
            const liveLatch    = liveObj as LatchView;

            const liveAnchor    = liveLatch.anchor;
            const plannedAnchor = plannedLatch.anchor;

            // Translate the planned anchor's clone id back to the live id so
            // we compare apples-to-apples (both in live-id space).
            const plannedAnchorLiveId =
                plannedAnchor !== null
                    ? plannedToLive.get(plannedAnchor.instance)
                    : undefined;

            // Determine whether the anchor identity changed.
            // live=A, planned=A (same)            → anchorChanged = false
            // live=A, planned=B (different)       → anchorChanged = true
            // live=null, planned=A                → anchorChanged = true (need Attach)
            // live=null, planned=null             → anchorChanged = false, falls through
            //                                       to position-diff via the unlinked branch
            //
            // live=A, planned=null: TALA never produces an unlinked latch where
            // the live latch is still linked, so throw immediately — silent
            // drop here would hide bugs.
            if (liveAnchor !== null && plannedAnchor === null) {
                throw new Error(
                    `diffAutoLayout: live latch ${liveLatch.instance} is linked to anchor ` +
                    `${liveAnchor.instance}, but planned latch ${plannedObj.instance} is ` +
                    "unlinked. This case is not currently supported."
                );
            }
            const anchorChanged =
                plannedAnchorLiveId !== undefined &&
                plannedAnchorLiveId !== (liveAnchor?.instance ?? null);

            if (anchorChanged) {
                // live=A, planned=B  OR  live=null, planned=A

                // Resolve the target anchor from the LIVE canvas using the
                // translated live id (the planned anchor is a clone object and
                // must not be passed to commands).
                const newLiveAnchor = liveById.get(plannedAnchorLiveId) as AnchorView | undefined;
                if (newLiveAnchor === undefined) {
                    // Contract violation: planned latch references an anchor with no live counterpart.
                    throw new Error(
                        `diffAutoLayout: live latch ${liveLatch.instance} / planned latch ` +
                        `${plannedObj.instance} references anchor ${plannedAnchor!.instance} ` +
                        "which has no live counterpart"
                    );
                }

                if (liveAnchor !== null) {
                    // Detach from the old anchor first (live=A → planned=B).
                    detaches.push(new DetachLatchFromAnchor(liveLatch));
                }
                attaches.push(new AttachLatchToAnchor(liveLatch, newLiveAnchor));

                // Latch position: AttachLatchToAnchor.execute (which calls
                // Latch.link()) does NOT move the latch to the anchor's
                // position, so emit a move if the position also changed.
                if (differs(liveLatch.x, plannedLatch.x) || differs(liveLatch.y, plannedLatch.y)) {
                    moves.push(new MoveObjectsTo(liveLatch, plannedLatch.x, plannedLatch.y));
                }
            } else if (liveAnchor === null) {
                // Unlinked, free-floating latch — anchor unchanged (both null).
                // Must emit an explicit move because no parent block cascades it.
                if (differs(liveLatch.x, plannedLatch.x) || differs(liveLatch.y, plannedLatch.y)) {
                    moves.push(new MoveObjectsTo(liveLatch, plannedLatch.x, plannedLatch.y));
                }
            }
            // else: anchorChanged=false, liveAnchor !== null — linked latch,
            // anchor unchanged.  The parent block's MoveObjectsTo cascades the
            // latch position; no explicit latch move is emitted.
            continue;
        }

        // Group — resize using two ResizeGroupBy calls (NW then SE) so both
        // corners land exactly on the planned bounding box regardless of whether
        // the center, the size, or both have changed.
        if (plannedObj instanceof GroupView) {
            const plannedGroup = plannedObj;
            const liveGroup    = liveObj as GroupView;

            const liveBB    = liveGroup.face.boundingBox;
            const plannedBB = plannedGroup.face.boundingBox;

            // NW corner delta — moves the NW corner while keeping SE fixed.
            // Note: ResizeGroupBy applies its delta to GroupFace._userX/Y*
            // (the user-set bound), not to face.boundingBox. The math here
            // is correct because GroupFace.calculateLayout (called during
            // file construction and clone setup) writes face.boundingBox into
            // _userX/Y* whenever children push beyond the user bounds, so at
            // the time we read boundingBox.{xMin,yMin,xMax,yMax} they equal
            // _userX/Y*.
            const dxNW = plannedBB.xMin - liveBB.xMin;
            const dyNW = plannedBB.yMin - liveBB.yMin;
            if (differs(dxNW, 0) || differs(dyNW, 0)) {
                moves.push(new ResizeGroupBy(liveGroup, ResizeEdge.NW, dxNW, dyNW));
            }

            // SE corner delta — moves the SE corner while keeping NW fixed.
            // Two ResizeGroupBy calls reach the planned bbox: NW first
            // (only writes _userXMin/_userYMin), then SE (only writes
            // _userXMax/_userYMax). GroupFace.resizeBy invokes
            // calculateLayout at the end of each, which rounds bounds to
            // children-plus-padding — but TALA outputs always enclose
            // their children so the rounding is a no-op in practice.
            // Both deltas are computed against the current (pre-execute)
            // live bounding box because commands are collected before any
            // of them run.
            const dxSE = plannedBB.xMax - liveBB.xMax;
            const dySE = plannedBB.yMax - liveBB.yMax;
            if (differs(dxSE, 0) || differs(dySE, 0)) {
                moves.push(new ResizeGroupBy(liveGroup, ResizeEdge.SE, dxSE, dySE));
            }

            continue;
        }

        // Block (and any other movable object not matched above).
        if (differs(plannedObj.x, liveObj.x) || differs(plannedObj.y, liveObj.y)) {
            moves.push(new MoveObjectsTo(liveObj, plannedObj.x, plannedObj.y));
        }
    }

    return [
        ...faceSwaps,
        ...handleAdds,
        ...handleRemoves,
        ...detaches,
        ...attaches,
        ...moves
    ];
}

/**
 * Returns true when two floating-point positions differ by more than a small
 * epsilon, avoiding spurious commands for sub-pixel jitter.
 */
function differs(a: number, b: number): boolean {
    return Math.abs(a - b) > 1e-3;
}
