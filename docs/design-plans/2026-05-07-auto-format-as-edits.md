# Auto Format as a GroupCommand of Edits — Design Plan

Last written: 2026-05-07 · Status: ready for implementation

## Goal

Add a File menu **Auto Format** action that re-runs TALA auto-layout
on the active diagram and lands on the editor's existing undo stack
as a single, reversible `GroupCommand` of fine-grained edits — not as
a snapshot-and-replace operation. Auto Format should behave like any
other user edit: undo reverses it, redo replays it, every preceding
and following entry on the undo stack remains valid.

## Why this shape

The naive implementation — call `viewFile.runLayout(...)` and ship —
produces a layout change that bypasses undo entirely. The first
attempt to make it undoable went through snapshot-and-replace:
serialize the file, run layout, serialize again, and restore via
`replaceFile(newFile)` on undo/redo. That works for Auto Format
itself but creates a class of stale-reference bugs because **JS object
identity does not survive an export/import round-trip**. Existing
editor commands on the undo stack (`MoveObjectsBy`, `AddObjectToGroup`,
`AttachLatchToAnchor`, etc.) hold direct `DiagramObjectView`
references; after `replaceFile`, those references point at orphaned
JS instances that are no longer reachable from the live canvas, and
calling `.moveBy(...)` on them mutates orphans the renderer never
sees. UUIDs are preserved by the serializer, so a "rebind by instance
id" pass on the undo stack would fix the symptom — but only by
introducing a new contract that every present and future ref-holding
command must implement.

The simpler design exploits a structural property of TALA: the
operation it performs is expressible entirely as **changes the
existing editor commands already model**. Block positions move
(`MoveObjectsTo`). Latches rebind to different anchors
(`Detach…`/`AttachLatchToAnchor`). Group bounds shift
(`ResizeGroupBy`). The only operations TALA performs that have no
existing command primitive are *handle insertion / removal on a line*
and *line face swap* (`DynamicLine` ↔ `PolyLine`). Those gaps are
small and worth filling.

If Auto Format produces a `GroupCommand` whose children are these
primitives, then:

- The canvas tree's identity never changes — no other command on the
  stack is invalidated.
- Undo/redo flow through the existing `SynchronousCommandProcessor`
  with no new mechanism (`AsynchronousEditorCommand` is unused
  again).
- No `__command_stack:` localStorage, no `replaceFile`, no
  `file-replaced` event, no `bindInterface` extraction.
- Every future use of "compute a layout, apply it" — `Reflow Group`,
  `Restore Saved Layout`, etc. — gets the same shape for free.

## Mechanism

### 1. Plan on a clone, apply on the live canvas

`DiagramViewFile.clone()` already exists and round-trips through the
serializer to produce a structurally-fresh copy. The Auto Format
AppCommand:

1. Clones `editor.file`.
2. Awaits `clone.runLayout(new NewAutoLayoutEngine(layoutDiagram))`
   on the clone. Engine remains unmodified.
3. Diffs the live canvas against the clone, walking by `instance` id
   (preserved by the serializer round-trip — see
   `DiagramObjectSerializer.importObjects`).
4. Emits one editor command per atomic difference and accumulates
   them into a `GroupCommand`.
5. Calls `editor.execute(groupCmd)` — synchronously, since the only
   async step (the server round-trip) has already completed.

### 2. Diff walker

A pure function `diffAutoLayout(live: CanvasView, planned: CanvasView):
SynchronousEditorCommand[]`. For every shared instance id between the
two trees, emit:

| Shape change | Command(s) emitted |
|---|---|
| Block / handle / latch / group `(x, y)` differs | `MoveObjectsTo(liveObj, x, y)` |
| Group `width` / `height` differs | `ResizeGroupBy(liveGroup, dw, dh)` |
| Line's latch points at a different anchor instance | `DetachLatchFromAnchor(liveLatch, oldAnchor)` + `AttachLatchToAnchor(liveLatch, newAnchor)` |
| Line gained a handle (interior vertex) | `AddHandleToLine(liveLine, position, atIndex)` *(new)* |
| Line lost a handle | `RemoveHandleFromLine(liveLine, atIndex)` *(new)* |
| Line's face class changed (`DynamicLine` ↔ `PolyLine`) | `SetLineFace(liveLine, FaceCtor)` *(new)* |

The walker must take care to look up *live* JS instances (not clone
instances) when constructing each command, because the GroupCommand
will execute against the live canvas. Helper: a one-shot
`Map<string, DiagramObjectView>` built from
`traverse(live)` and looked up by `instance` id.

### 3. Three new commands

All three are `SynchronousEditorCommand` subclasses, colocated under
`src/assets/scripts/OpenChart/DiagramEditor/Commands/Model/` (handle
add/remove are model topology changes) and
`Commands/View/SetLineFace.ts` (face is view-layer, mirrors how
`PolyLine` lives under `DiagramView`). Each is small.

- **`AddHandleToLine(line, position, atIndex)`** — inserts a new
  handle at the given index in the line's handle list, using the
  factory to construct a `Handle` view from the line template's
  handle template. Undo removes that handle.
- **`RemoveHandleFromLine(line, atIndex)`** — captures the handle
  reference and its position before splicing it out. Undo re-inserts.
- **`SetLineFace(line, faceCtor)`** — captures the previous face
  class, calls `LineView.replaceFace(faceCtor)` (already exists,
  established for PolyLine swap by `inferLineFaces`). Undo restores.

Each command issues `EditorDirective.Record | EditorDirective.Autosave`,
matching every other model/view command.

The `inferLineFaces` post-pass that today follows `runLayout` becomes
redundant for Auto Format: the diff walker emits an explicit
`SetLineFace` whenever the handle count crossed the `1↔2` boundary,
and the GroupCommand's atomic execute applies face change and handle
changes together. `inferLineFaces` is still wanted on file *import*
(constructor of `DiagramViewFile`) where there is no command
processor — leave it where it is.

### 4. AppCommand wrapper

`Application/Commands/FileManagement/AutoLayoutActiveFile.ts`:

```
async execute() {
  const editor = ctx.activeEditor;
  const clone = editor.file.clone();
  await clone.runLayout(new NewAutoLayoutEngine(layoutDiagram));
  const cmds = diffAutoLayout(editor.file.canvas, clone.canvas, editor.file);
  if (cmds.length === 0) return;
  const group = new GroupCommand();
  for (const c of cmds) group.do(c);
  editor.execute(group);
}
```

`GroupCommand` is the existing concrete class from
`Commands/index.commands.ts` — re-exporting `newGroupCommand()` from
`Commands/index.ts` is also fine. The single-entry `_undoStack` push
happens via the standard `editor.execute` path; `Record` + `Autosave`
are issued by each child command, the GroupCommand aggregates.

### 5. Menu entry

`src/stores/ContextMenuStore.ts` gets a new `formatFileMenu` section
(between `saveFileMenu` and `publishFileMenu`) with one item:

```
{ text: "Auto Format", type: MenuType.Action,
  data: () => AppCommands.autoLayoutActiveFile(app),
  disabled: editor.id === PhantomEditor.id }
```

## Files

New:

- `src/assets/scripts/OpenChart/DiagramEditor/Commands/Model/AddHandleToLine.ts`
- `src/assets/scripts/OpenChart/DiagramEditor/Commands/Model/RemoveHandleFromLine.ts`
- `src/assets/scripts/OpenChart/DiagramEditor/Commands/View/SetLineFace.ts`
- `src/assets/scripts/Application/Commands/FileManagement/AutoLayoutActiveFile.ts`
- `src/assets/scripts/Application/Commands/FileManagement/diffAutoLayout.ts` —
  the pure-function diff walker.

Modified:

- `Commands/Model/index.commands.ts`, `Commands/View/index.commands.ts` —
  re-export the new commands.
- `Commands/index.ts` — add factory functions for each new command,
  matching the existing `setCamera`/`runAnimation` pattern.
- `Application/Commands/FileManagement/index.commands.ts`,
  `index.ts` — re-export `AutoLayoutActiveFile` + factory.
- `src/stores/ContextMenuStore.ts` — wire the menu entry.

Not modified, not added:

- `DiagramModelEditor` / `DiagramViewEditor` (no `replaceFile`,
  no mutability changes — `file` and `interface` stay `readonly`).
- `ApplicationStore` (no `commandStack`, no seq counter).
- `BlockDiagram.vue` (no new event listeners, no rebind).
- `ViewEditorEvents` (no `file-replaced`).
- `useEditorEditEvent` (no overload-resolution side effects).

The `undoable-auto-format` branch's WIP commit is not the basis for
this work — a fresh branch off `main` should land just the design above.

## Open questions

- **Latch movement vs anchor rebind.** When TALA rebinds a latch to a
  new anchor, the latch's coordinates also change to land on the new
  anchor. The diff walker should emit `Detach`/`Attach` and rely on
  `AttachLatchToAnchor` to handle positioning, *not* also emit
  `MoveObjectsTo` for the latch — confirm by reading
  `AttachLatchToAnchor.execute` to see whether it sets the latch's
  coordinates from the anchor.
- **Handle-add ordering.** TALA's polyline pass calls
  `ensureHandleCount` then writes positions. The diff walker should
  emit `AddHandleToLine` before `MoveObjectsTo(handle, ...)` so the
  handle exists by the time the move runs. Either enforce the
  ordering in the walker, or fold position into `AddHandleToLine`'s
  constructor (the latter is cleaner — pass position at insertion
  time).
- **No-op suppression.** When the diff produces an empty command
  list, the AppCommand should short-circuit (no GroupCommand pushed
  on the undo stack). This is the case where the current layout
  already matches what TALA would produce — common when running
  Auto Format twice in a row.
- **Failure path.** If `clone.runLayout` throws (server down, d2 not
  on PATH), the AppCommand surfaces the error and pushes nothing
  onto the undo stack. Existing behavior is preserved — TALA failure
  is already handled by the `runLayout` try/catch in the file-load
  path.

## Verification

Manual end-to-end (no automated tests for this AppCommand surface):

1. Open a server diagram with multi-bend flows. Click File → Auto
   Format. Confirm the layout reflows and the diagram renders
   correctly.
2. Press Ctrl+Z. Confirm every block, handle, latch, line face, and
   group bound is back to where it was before Auto Format. Selection
   and camera unchanged.
3. Press Ctrl+Y. Confirm the post-layout state is restored.
4. **The previously-broken case.** Move a block manually, click Auto
   Format, press Ctrl+Z (undoes Auto Format), press Ctrl+Z again
   (should undo the manual move). Confirm the manual move *visibly
   reverses* — this is the symptom that breaks under the snapshot
   approach.
5. Auto Format on an already-laid-out diagram (run it twice in a
   row). Confirm the second invocation is a no-op (no undo entry
   pushed).
6. Stop the Flask server. Click Auto Format. Confirm the error
   surfaces and `canUndo` is unchanged.

## Out of scope

- Any persistence of Auto Format snapshots to localStorage. The
  `__command_stack:` mechanism prototyped on the WIP branch is not
  needed for this design.
- Read-only `editor.file` / `editor.interface` mutability. They stay
  `readonly`.
- A general-purpose "rebind commands by instance id" pass on the
  undo/redo stacks. Not needed because the canvas tree is never
  swapped.
