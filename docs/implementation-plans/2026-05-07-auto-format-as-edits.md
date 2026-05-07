# Auto Format as a GroupCommand of Edits — Implementation Plan

Last written: 2026-05-07
Design source: `docs/design-plans/2026-05-07-auto-format-as-edits.md`
Branch: fresh off `main` (do **not** use the `undoable-auto-format` WIP).

## Summary

Add a File menu **Auto Format** action that re-runs TALA on a clone of
the active file, diffs the result against the live canvas, and emits a
single `GroupCommand` of existing primitives (`MoveObjectsTo`,
`ResizeGroupBy`, `Detach…`/`AttachLatchToAnchor`) plus three new ones
(`AddHandleToLine`, `RemoveHandleFromLine`, `SetLineFace`). The
canvas tree's identity never changes, so prior commands on the undo
stack stay valid.

## Resolved open questions (from design plan)

- **Latch movement vs anchor rebind.** `Latch.link()`
  (`DiagramModel/DiagramObject/Models/Latch.ts:58`) only updates
  linkage; it does **not** set coordinates. `AttachLatchToAnchor`
  delegates to `link()`. Therefore the diff walker emits
  `Detach`/`Attach` **and** `MoveObjectsTo(latch, x, y)` whenever
  TALA's anchor rebind also changes the latch position.
- **Handle-add ordering.** `AddHandleToLine` takes the handle's
  position as a constructor argument and inserts at that position in
  one shot — no separate `MoveObjectsTo(handle)` is emitted for newly
  inserted handles.
- **No-op suppression.** Empty diff → AppCommand short-circuits, no
  GroupCommand pushed.
- **Failure path.** Any throw from `clone.runLayout` propagates;
  nothing is pushed onto the undo stack.

---

## Step 1 — `AddHandleToLine` and `RemoveHandleFromLine` commands

Add two `SynchronousEditorCommand` subclasses under
`OpenChart/DiagramEditor/Commands/Model/`. Both follow the existing
pattern in `Model/AttachLatchToAnchor.ts` (capture state in ctor,
`execute` mutates + issues `Record | Autosave`, `undo` reverses).

**Handle construction.** Use the same trick `ensureHandleCount` uses
in `NewAutoLayoutEngine.ts:762` — clone the line's first handle
(`line.handles[0].clone()`). Every line is guaranteed to have a
reference handle because `DiagramObjectViewFactory` attaches one at
line creation (`DiagramObjectViewFactory.ts:209-210`); document this
precondition on `AddHandleToLine`. After cloning, position the new
handle via the same face-level path TALA uses
(`handle.face.moveTo(x, y)` — see `NewAutoLayoutEngine.ts:755-758`)
to avoid triggering `DynamicLine.calculateLayout` →
`view.dropHandles(1)` mid-execute. (See `OpenChart/CLAUDE.md`
"Gotchas" on the `face.moveTo` vs `handle.moveTo` distinction.)

`AddHandleToLine(line: Line, x: number, y: number, atIndex: number)`
clones `line.handles[0]`, positions it via `face.moveTo`, splices it
into the handle list at `atIndex`. `undo` removes the handle at
`atIndex` (capture the inserted handle reference so undo/redo are
referentially symmetric).

`RemoveHandleFromLine(line: Line, atIndex: number)` captures the
handle reference and its `(x, y)` before splicing out. `undo`
re-inserts the *same* handle at the same index (no fresh clone — the
captured reference goes back).

**Files**
- New: `Commands/Model/AddHandleToLine.ts`,
  `Commands/Model/RemoveHandleFromLine.ts`.
- Modified: `Commands/Model/index.ts`, `Commands/Model/index.commands.ts`,
  `Commands/index.ts` (add factory functions matching `attachLatchToAnchor`).

**Acceptance**
- Both classes compile; type-check passes.
- A unit test that constructs a Line with N handles, runs `execute`
  on `AddHandleToLine` then `undo`, verifies handle list returns to
  original (length, references, positions). Same for
  `RemoveHandleFromLine`.

---

## Step 2 — `SetLineFace` command

A `SynchronousEditorCommand` under `Commands/View/SetLineFace.ts`. Ctor
takes `(line: LineView, faceCtor: LineFaceCtor)`, captures the previous
face class (`line.face.constructor`). `execute` calls
`line.replaceFace(new faceCtor(...))` — match the construction pattern
used in `DiagramObjectViewFactory.inferLineFaces`
(`DiagramView/DiagramObjectViewFactory/DiagramObjectViewFactory.ts`,
around the `replaceFace(face)` call sites). `undo` swaps back to the
captured prior class. Issues `Record | Autosave`.

**Files**
- New: `Commands/View/SetLineFace.ts`.
- Modified: `Commands/View/index.ts`, `Commands/View/index.commands.ts`,
  `Commands/index.ts`.

**Acceptance**
- Type-check passes.
- Unit test: build a `LineView` with `DynamicLine`, run `SetLineFace`
  with `PolyLine`, assert `line.face instanceof PolyLine`; undo, assert
  `DynamicLine` again.

---

## Step 3 — `diffAutoLayout` walker

Add `Application/Commands/FileManagement/diffAutoLayout.ts`. Pure
function:

```
diffAutoLayout(live: CanvasView, planned: CanvasView): SynchronousEditorCommand[]
```

Implementation outline:

1. Build `Map<string, DiagramObjectView>` from `traverse(live)` keyed
   by `instance` id.
2. Walk `traverse(planned)`. For each planned object whose `instance`
   exists in the live map, compare:
   - `(x, y)` differs → `MoveObjectsTo(liveObj, plannedX, plannedY)`.
     *(For latches, only emit if anchor identity is unchanged or in
     addition to the Detach/Attach pair below — see latch case.)*
   - Group `width` / `height` differs →
     `ResizeGroupBy(liveGroup, dw, dh)`.
   - For each `Latch` whose `anchor.instance` differs:
     `DetachLatchFromAnchor(liveLatch, oldLiveAnchor)` +
     `AttachLatchToAnchor(liveLatch, newLiveAnchor)`. Then, if the
     latch's `(x, y)` also changed, append
     `MoveObjectsTo(liveLatch, x, y)` (since `link()` doesn't move).
   - For each `Line`, walk handles by index. If planned has more
     handles than live → emit `AddHandleToLine(liveLine, x, y, i)` for
     each new handle. If fewer → emit `RemoveHandleFromLine(liveLine, i)`
     for each removed handle (in reverse-index order).
   - If the live line's face class differs from the planned line's
     (`DynamicLine` ↔ `PolyLine`) → `SetLineFace(liveLine, plannedFaceCtor)`.
3. Return commands in dependency order: face-swaps and handle-adds
   before moves; detach before attach; attach before any latch move.

**Files**
- New: `Application/Commands/FileManagement/diffAutoLayout.ts`.

**Acceptance**
- Unit test (`diffAutoLayout.spec.ts`): build a tiny canvas with one
  block + one line, clone it, mutate the clone (move block, add a
  handle, swap face), run `diffAutoLayout`, assert the returned command
  list contains the right primitives in the right order (and only
  references *live* JS instances, not clone instances — assert by
  identity).
- No-op case: identical inputs → empty array.

---

## Step 4 — `AutoLayoutActiveFile` AppCommand + menu entry

Add `Application/Commands/FileManagement/AutoLayoutActiveFile.ts`
extending the base `AppCommand` (single class — `AppCommand.execute()`
returns `Promise<void>`, so async work happens directly inside it; no
separate async base class exists in this codebase).

Match the existing factory shape of `saveActiveFileToServer`
(`FileManagement/index.ts:500`): synchronous factory returns the
AppCommand instance, and the AppCommand's `execute` does the async
work. `layoutDiagram` is a plain function exported from
`@/assets/scripts/api/DfdApiClient`, already imported and used twice
in `FileManagement/index.ts` (lines 78 and 220) — reuse the same
import. This satisfies the `NewAutoLayoutEngine` HTTP-free rule
because the engine receives the callback at construction; nothing in
OpenChart imports the API client.

```
// Application/Commands/FileManagement/index.ts
export function autoLayoutActiveFile(context: ApplicationStore): AppCommand {
  const editor = context.activeEditor;
  if (editor.id === PhantomEditor.id) return new DoNothing();
  return new AutoLayoutActiveFile(editor);
}

// Application/Commands/FileManagement/AutoLayoutActiveFile.ts
class AutoLayoutActiveFile extends AppCommand {
  constructor(private readonly editor: DiagramViewEditor) { super(); }
  async execute(): Promise<void> {
    const clone = this.editor.file.clone();
    await clone.runLayout(new NewAutoLayoutEngine(layoutDiagram));
    const cmds = diffAutoLayout(this.editor.file.canvas, clone.canvas);
    if (cmds.length === 0) return;
    const group = new GroupCommand();
    for (const c of cmds) group.do(c);
    this.editor.execute(group);
  }
}
```

Re-export `AutoLayoutActiveFile` and the `autoLayoutActiveFile`
factory from `FileManagement/index.commands.ts` and the top-level
`Application/Commands/index.ts`, matching how `SaveDiagramFileToServer`
+ `saveActiveFileToServer` are re-exported.

Add a `formatFileMenu` section to `src/stores/ContextMenuStore.ts`
between `saveFileMenu` and `publishFileMenu`, with one
`MenuType.Action` item ("Auto Format") that dispatches
`AppCommands.autoLayoutActiveFile(app)`. `disabled` when
`editor.id === PhantomEditor.id`.

**Files**
- New: `Application/Commands/FileManagement/AutoLayoutActiveFile.ts`.
- Modified: `Application/Commands/FileManagement/index.ts`,
  `Application/Commands/FileManagement/index.commands.ts`,
  `Application/Commands/index.ts`,
  `src/stores/ContextMenuStore.ts`.

**Acceptance**
- Type-check + lint pass.
- Menu item appears under File when a real diagram is open and is
  disabled on the phantom editor.
- Clicking it on a coord-bearing diagram visibly reflows; on an empty
  / phantom file it is a no-op (item disabled).

---

## Step 5 — Manual end-to-end verification

Run through the 6-case manual checklist from the design plan §
Verification, in order:

1. Open a server diagram with multi-bend flows; Auto Format reflows.
2. Ctrl+Z restores pre-format state (positions, handles, latches,
   line faces, group bounds). Selection + camera unchanged.
3. Ctrl+Y replays.
4. **Critical regression case.** Move a block manually → Auto Format
   → Ctrl+Z → Ctrl+Z. The manual move must visibly reverse on the
   second undo.
5. Auto Format twice in a row — second invocation pushes nothing
   onto the undo stack (`canUndo` unchanged after second run).
6. Stop the Flask server, click Auto Format, confirm the error
   surfaces and `canUndo` is unchanged.

**Acceptance**
- All 6 cases pass. Note any deviations in the PR description.

---

## Definition of Done

- All step-level acceptance criteria met.
- `npm run type-check`, `npm run lint`, `npm run test:unit` all green.
- The 6-case manual checklist passes.
- No changes to: `DiagramModelEditor` / `DiagramViewEditor`
  mutability (`file` and `interface` stay `readonly`), `ApplicationStore`,
  `BlockDiagram.vue`, `ViewEditorEvents`, `useEditorEditEvent`. No
  `__command_stack:` localStorage. No `replaceFile`. No `file-replaced`
  event.
- `inferLineFaces` is **left in place** at file-import time
  (`DiagramViewFile` constructor) — only the post-`runLayout`
  inference becomes redundant for the Auto Format path, which now
  emits explicit `SetLineFace` commands.
