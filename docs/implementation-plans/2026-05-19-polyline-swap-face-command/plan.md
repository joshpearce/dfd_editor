> ✅ **RE-EVALUATION COMPLETE (2026-05-19, post-#19-landing).** #19
> (`2d4bca1`, PR #20) is merged; this plan now builds on top of it.
> Findings against the three original re-check questions:
>
> - **(a) Handle state to capture/restore — UNCHANGED.**
>   `orthogonalizeEndElbows` only *repositions* existing handles via
>   `handle.face.moveTo` inside `PolyLine.calculateLayout`; it never
>   adds/drops handles. The sole data-loss vector is still
>   `DynamicLine`'s layouts calling `view.dropHandles(1)`
>   (`LineLayoutStrategies.ts:41/111/182/243`) after a
>   PolyLine→DynamicLine swap. `keptHandles` capture/restore as specified
>   is sufficient.
> - **(b) Landing order — MOOT.** #19 already landed; no merge-ordering
>   concern. The "parallel with #19" framing below is historical.
> - **(c) "No reachable interactive trigger" — STILL HOLDS.** #19 changed
>   `calculateLayout` *geometry*, not its callers. `inferLineFaces` still
>   has exactly the two `DiagramViewFile` callers (constructor `:51`,
>   `runLayout` `:95`), both with empty/cleared undo stacks.
>
> **Amendment to Step 4 (only change):** the regression spec must run a
> `calculateLayout` *after* `undo()` and assert exact handle-position
> restoration — #19's `orthogonalizeEndElbow` re-runs on the restored
> geometry; it is a proven no-op on orthogonal routes, and the spec must
> pin that. Plan for #19 (historical):
> `docs/implementation-plans/2026-05-19-polyline-endpoint-orthogonality/plan.md`.

# Plan: Undoable PolyLine⇄DynamicLine face transition (issue #15)

**Issue:** [#15](https://github.com/joshpearce/dfd_editor/issues/15) — PolyLine
face downgrade in `inferLineFaces` is destructive and not undoable.
**Parent:** #14. **Blocks:** #17 (interactive bend add/delete).
**Related:** #19 (see warning above).

## Problem & Decided Scope

`DiagramObjectViewFactory.inferLineFaces` (`DiagramObjectViewFactory.ts:490-518`)
calls a bare `object.replaceFace(...)` when a line crosses the 2-handle
PolyLine threshold. No command wraps it, so the transition is invisible to
undo, and a `PolyLine→DynamicLine` downgrade lets the next
`DynamicLine.calculateLayout` call `dropHandles(1)` and silently destroy
every interior bend.

**Established context (do not re-litigate):** `inferLineFaces` has exactly
two callers, both in `DiagramViewFile` — the constructor (empty undo stack)
and `runLayout` (reached only via `AutoLayoutActiveFile`, which deliberately
clears undo history). So the undo path has **no reachable interactive
trigger today**. The user has chosen to build the **literal `SwapLineFace`
command** anyway: it is the reusable, tested undo primitive that #17
(interactive bend delete) will require. We front-load the infrastructure now
so #17 inherits it rather than reinventing it. `replaceFace` itself is
handle-side-effect-free; geometry is lost only when a later `calculateLayout`
runs `dropHandles`, so the command must capture/restore dropped handles, not
just the face object.

## Data Model

New command type `SwapLineFace extends SynchronousEditorCommand`, holding:

```
line:        LineView
fromFace:    LineFace          // the face instance before the swap
toFace:      LineFace          // the face instance after the swap
keptHandles: ReadonlyArray<HandleView>   // handles present before swap
```

`execute()`: `line.replaceFace(toFace)`. `undo()`: re-attach any handles
that a post-swap `calculateLayout` would have dropped (re-`addHandle` the
missing members of `keptHandles` in original order), then
`line.replaceFace(fromFace)`. `redo()` defaults to `execute`. `merge()`
returns `null` (face swaps do not coalesce). No new persisted/serialized
shape — this is a pure in-memory editor command; file format unchanged.

`inferLineFaces` changes signature to **return** `SwapLineFace[]` instead of
calling `replaceFace` inline. `DiagramViewFile`'s two callers receive the
array and apply it: constructor executes each command bare (no undo stack
exists yet — behavior-identical to today); `runLayout` does the same. The
commands are *constructed* uniformly so #17 and any future interactive
caller can route them through the editor's command stream instead.

## Steps

### Step 1 — `SwapLineFace` command + unit specs
Add `Commands/View/SwapLineFace.ts` and export from
`Commands/View/index.commands.ts`. Implement execute/undo/redo/merge per the
data model above, modeled on `RestoreGroupBounds` (snapshot-on-construct,
restore-on-undo). **Files:** `Commands/View/SwapLineFace.ts` (new),
`index.commands.ts`. **Tests (new `SwapLineFace.spec.ts`):** construct a
3-handle line as `PolyLine`; `SwapLineFace`→`DynamicLine`, run
`calculateLayout` (drops handles), `undo()`, assert handle count + positions
+ `face instanceof PolyLine` restored; redo re-applies.

### Step 2 — `inferLineFaces` returns commands
Refactor `inferLineFaces` to build and return `SwapLineFace[]` (one per
line whose face must change) instead of calling `replaceFace`. Do **not**
execute inside the factory. **Files:** `DiagramObjectViewFactory.ts:490-518`.
**Tests:** update `inferLineFaces.spec.ts` — assert it returns the right
commands for upgrade/downgrade/no-op cases; assert no face mutation occurs
until a returned command's `execute()` is called.

### Step 3 — Wire `DiagramViewFile` callers
Both call sites (`DiagramViewFile.ts:51` constructor, `:95` `runLayout`)
capture the returned array and `execute()` each command immediately
(bare — no editor available here). Net runtime behavior at these two sites
is identical to today; only the mechanism changes. **Files:**
`DiagramViewFile.ts`. **Tests:** existing `DiagramViewFile` /
auto-layout-fidelity specs pass unchanged; add one asserting a loaded
multi-handle diagram still resolves to `PolyLine`.

### Step 4 — Regression + round-trip pin
Add an integration-style spec: load a 3-bend serialized diagram → assert
`PolyLine`; drop to 1 handle + re-run `inferLineFaces` commands → assert
`DynamicLine`; `undo()` the downgrade command → assert all 3 handles +
`PolyLine` restored (the data-loss scenario from the issue). **Files:**
new spec under `DiagramObjectViewFactory/` or `DiagramView/`.

## Acceptance Criteria

- **S1:** `SwapLineFace` exists and is exported; spec proves a
  PolyLine→DynamicLine→`calculateLayout`→`undo` cycle restores handle
  count, every handle position, and the `PolyLine` face; redo re-applies.
  `merge()` returns `null`.
- **S2:** `inferLineFaces` returns `SwapLineFace[]` and performs **zero**
  face mutation itself; spec covers upgrade, downgrade, and no-op (returns
  empty array) cases.
- **S3:** Both `DiagramViewFile` callers apply the commands; full existing
  test suite (esp. auto-layout-fidelity / TALA round-trip specs) passes
  unchanged; a freshly loaded ≥2-handle diagram renders as `PolyLine`.
- **S4:** Regression spec reproduces the issue's data-loss scenario and
  proves `undo()` recovers all bends and the `PolyLine` face.
- No change to serialized file format; no new dependency on Vue/Pinia in
  the engine layer.

## Definition of Done

All four steps' criteria met; `npm run test:unit`, `npm run type-check`,
and `npm run lint` all green; no behavioral change at the two existing
`inferLineFaces` call sites (verified by unchanged-passing fidelity specs);
`SwapLineFace` is a standalone reusable command ready for #17 to route
through `beginCommandStream`/`endCommandStream`. Update issue #15 with the
"no interactive trigger today; primitive built for #17" finding so the
parent (#14) ordering rationale stays accurate.
