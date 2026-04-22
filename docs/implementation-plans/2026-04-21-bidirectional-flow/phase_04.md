# Phase 4 — DynamicLine dual-arrow rendering

**Goal:** Arrowheads are drawn at 0, 1, or 2 endpoints of a flow edge, driven by the Flow's two ref-array properties. The single `arrow: number[]` slot becomes two nullable slots `arrowAtNode1: number[] | null` and `arrowAtNode2: number[] | null`; the layout strategy populates each slot only when the corresponding ref array is non-empty.

**Architecture:** `DynamicLine` holds two nullable slots. `LineLayoutStrategies.runMultiElbowLayout` computes both arrow heads in-line. The layout strategy (or a new helper) reads `line.properties.value.get("node1_src_data_item_refs")` and `...node2_src_data_item_refs` as `ListProperty<StringProperty>`, checks `.value.size > 0` on each, and calls `getAbsoluteArrowHead(...)` with swapped arguments for the node1-end case. `renderTo` guards each `drawAbsolutePolygon` call with a null check.

**Tech Stack:** TypeScript, Vitest. Strict `vue-tsc`.

**Scope:** Phase 4 of 7. Depends on Phases 1-3 (server schema, renamed Line API, `DataItemRefList` template).

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### bidirectional-flow.AC3: Arrow rendering is driven by ref-array state

- **bidirectional-flow.AC3.1 Success:** Flow with only `node1_src_data_item_refs` populated renders a single arrowhead at the `node2` end.
- **bidirectional-flow.AC3.2 Success:** Flow with only `node2_src_data_item_refs` populated renders a single arrowhead at the `node1` end.
- **bidirectional-flow.AC3.3 Success:** Flow with both ref arrays populated renders two arrowheads (one at each end).
- **bidirectional-flow.AC3.4 Success:** Flow with both ref arrays empty renders a plain line with no arrowheads.
- **bidirectional-flow.AC3.5 Edge:** Editing a ref array (add or remove) triggers a re-layout that updates the arrowhead count without a full canvas rebuild. *(Reactivity gate: the existing canvas re-layout pipeline is triggered by property mutations; verify with an observable spec.)*

---

## Context for the executor

**Arrow direction convention (core invariant from design):**

- `node1_src_data_item_refs` non-empty → data flows `node1 → node2` → arrowhead renders at the `node2` end.
- `node2_src_data_item_refs` non-empty → data flows `node2 → node1` → arrowhead renders at the `node1` end.
- Both non-empty → arrowheads at both ends.
- Both empty → no arrowheads (valid presence-only line).

**Codebase verification findings (2026-04-21):**

- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts`:
  - `private arrow: number[]` at line 71.
  - Initialised in constructor at line 92 via `getAbsoluteArrowHead(0, 0, 0, 0, style.capSize)` (zero-length placeholder).
  - Drawn in `renderTo` at lines 254-256 (`drawAbsolutePolygon(ctx, this.arrow); ctx.fill();`) — unconditional, a single triangle per render.
  - `GenericLineInternalState` interface cast at line 199 exposes the face to layout strategies (so they can assign `face.arrow`).
- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts`:
  - `runMultiElbowLayout(face, vertices, includeArrow)` at lines ~360-380 — the single hook that populates `face.arrow`.
  - Current behavior: when `includeArrow`, assigns `face.arrow = getAbsoluteArrowHead(t[lx], t[ly], t[nx], t[ny], face.style.capSize)` and then does a cap-size offset adjustment on the final vertex. When `!includeArrow`, `face.arrow = []`.
  - Four orientation variants (`runHorizontalTwoElbowLayout`, `runVerticalTwoElbowLayout`, `runHorizontalElbowLayout`, `runVerticalElbowLayout`) each compute a bool like `sx !== tx` and forward it.
  - Vertex array `t` indexing: `t[0], t[1]` is the first vertex (node1 end); `t[2], t[3]` is the second; ...; `t[nx], t[ny]` is the final pair (node2 end).
- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/Utilities/Drawing/Shapes.ts` lines 61-79: `getAbsoluteArrowHead(sx, sy, tx, ty, h=12)` — pure function, returns a 6-tuple of triangle vertex coordinates. Swapping `(sx,sy)` ↔ `(tx,ty)` produces an arrow at the opposite end with identical line body.
- ✓ Property access pattern — from `dataItems.test-utils.ts`:
  ```typescript
  const refsProp = line.properties.value.get("data_item_refs");
  if (!(refsProp instanceof ListProperty)) { throw new Error("..."); }
  // refsProp.value is Map<string, StringProperty>; use .size or .values()
  ```
  Apply symmetrically to the new keys `node1_src_data_item_refs` and `node2_src_data_item_refs`.
- ✓ Themes at `/Users/josh/code/dfd_editor/src/assets/configuration/DfdThemes/DarkTheme.ts:72-76` and `.../LightTheme.ts:72-76` already register `data_flow → FaceType.DynamicLine`. No theme changes needed in Phase 4.
- ✓ No existing spec tests `renderTo` directly. Tests assert layout outputs (vertices, bounds, slot contents). Phase 4's spec asserts the two `arrowAt*` slots contain expected values given a ref-array state, not canvas pixels.
- ✓ `FaceType` enum has only one line face (`DynamicLine`). No sibling updates needed.

**Ambiguity resolved (decision for the executor):**

- **Arrow style / color:** the existing canvas-context `fillStyle` applies to both triangles (they inherit theme stroke). No new theme hooks in this phase.
- **Reactivity AC3.5 mechanism:** the canvas re-layout hook is the existing property-change observer. Phase 4 does NOT add a new hook; it relies on the existing one firing on `ListProperty` mutations. If this hook is not firing for these specific property keys today, that's a separate bug — flag and surface via AskUserQuestion rather than quietly adding plumbing.

**File inventory for this phase:**

Production:
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts`
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts`
- (potentially) `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/Utilities/Drawing/Shapes.ts` — if the executor extracts a dual-arrow helper; otherwise no change.

Spec:
- `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts` — **new file** (no existing spec for DynamicLine). Sibling of the production file per the colocation convention.

**Skills to activate before implementing:**

- `ed3d-house-style:coding-effectively`
- `ed3d-house-style:howto-code-in-typescript`
- `ed3d-house-style:writing-good-tests`
- `ed3d-house-style:howto-functional-vs-imperative` — `getAbsoluteArrowHead` is a pure helper; add a sibling pure helper if needed, keep I/O at the face/layout boundary.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Replace single `arrow` slot with `arrowAtNode1` / `arrowAtNode2` in `DynamicLine`

**Verifies:** bidirectional-flow.AC3.1, AC3.2, AC3.3, AC3.4 (foundation — rendering guards)

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.ts`

**Implementation:**

1. Replace the field at line 71:
   ```typescript
   // remove
   private arrow: number[];
   // add
   private arrowAtNode1: number[] | null;
   private arrowAtNode2: number[] | null;
   ```

2. Update constructor initialisers (around line 92):
   ```typescript
   this.arrowAtNode1 = null;
   this.arrowAtNode2 = null;
   ```
   (Both start null — a zero-length arrow is no longer a valid "no arrow" marker; null is.)

3. Update the `GenericLineInternalState` interface (or wherever it's declared — grep for `arrow:` near `GenericLineInternalState`). The interface currently declares `arrow: number[]`. Replace with the two nullable slots so layout strategies can populate each independently.

4. Update `renderTo` (around lines 254-256):
   ```typescript
   // replace the single drawAbsolutePolygon/fill pair:
   if (this.arrowAtNode1 !== null) {
       drawAbsolutePolygon(ctx, this.arrowAtNode1);
       ctx.fill();
   }
   if (this.arrowAtNode2 !== null) {
       drawAbsolutePolygon(ctx, this.arrowAtNode2);
       ctx.fill();
   }
   ```
   Order does not matter (both draws are independent).

**Implementation notes:**
- `vue-tsc` will flag every lingering `this.arrow` reference. Fix each one.
- Do NOT introduce a `this.arrow` getter that proxies to one of the two — that would defeat the semantic rename.

**Verification:** defer to Task 3.

**Commit:** (hold — single commit at end of Task 3).
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Populate two arrow slots in `runMultiElbowLayout` based on ref-array state

**Verifies:** bidirectional-flow.AC3.1, AC3.2, AC3.3, AC3.4, AC3.5

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/LineLayoutStrategies.ts`

**Implementation:**

1. Change the signature of `runMultiElbowLayout` to accept the Line's properties (so it can read the two ref arrays) OR change the four orientation variants to read the properties and forward two booleans. The simpler refactor: keep a single helper that takes a `view: LineView` parameter, reads its properties, and populates both slots.

2. Replace the current `includeArrow` boolean path. Concretely, inside `runMultiElbowLayout` around lines 361-380:

   ```typescript
   // Read the Line's two ref arrays
   const props = view.properties.value;
   const node1Refs = props.get("node1_src_data_item_refs");
   const node2Refs = props.get("node2_src_data_item_refs");
   const hasNode1Src = node1Refs instanceof ListProperty && node1Refs.value.size > 0;
   const hasNode2Src = node2Refs instanceof ListProperty && node2Refs.value.size > 0;

   // Arrow at node2 end (data flowing node1 → node2)
   if (hasNode1Src) {
       face.arrowAtNode2 = getAbsoluteArrowHead(
           t[lx], t[ly],   // second-to-last vertex (direction from)
           t[nx], t[ny],   // last vertex (tip at node2)
           face.style.capSize
       );
   } else {
       face.arrowAtNode2 = null;
   }

   // Arrow at node1 end (data flowing node2 → node1)
   if (hasNode2Src) {
       face.arrowAtNode1 = getAbsoluteArrowHead(
           t[2], t[3],     // second vertex (direction from)
           t[0], t[1],     // first vertex (tip at node1)
           face.style.capSize
       );
   } else {
       face.arrowAtNode1 = null;
   }
   ```

3. **Vertex offset / cap-size adjustment:** the current code does a cap-size offset on the final vertex to prevent the line from overshooting the arrow tip. Preserve that offset **for node2** when `hasNode1Src`, and add a symmetric offset **on the first vertex** when `hasNode2Src`. If the existing code does:
   ```typescript
   // pseudocode of the current cap-size offset
   t[nx] -= Math.cos(angle) * face.style.capSize;
   t[ny] -= Math.sin(angle) * face.style.capSize;
   ```
   add a mirror for the node1 end when `hasNode2Src`:
   ```typescript
   // mirror at node1 end: inset t[0], t[1] along the direction toward t[2], t[3]
   const a2 = Math.atan2(t[3] - t[1], t[2] - t[0]);
   t[0] += Math.cos(a2) * face.style.capSize;
   t[1] += Math.sin(a2) * face.style.capSize;
   ```
   Do NOT inset an end whose arrow slot is null; the line should reach the block face cleanly.

4. Remove the obsolete `includeArrow` boolean parameter from the four orientation variants (`runHorizontalTwoElbowLayout`, etc. at lines 80, 155, 216, 278). Each caller stops computing `sx !== tx` / equivalent — the arrow-presence decision now lives entirely inside `runMultiElbowLayout` based on props.

5. Update the four variants' signatures to forward `view` (the LineView) to `runMultiElbowLayout` so property access is available.

**Important:** do NOT change the vertex-computation logic (where the bends are placed, which orientation is picked). That logic is independent of arrow placement.

**Verification:** defer to Task 3.

**Commit:** (hold).
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: New spec `DynamicLine.spec.ts` covering 0 / 1 / 2 arrows + full verification

**Verifies:** bidirectional-flow.AC3.1, AC3.2, AC3.3, AC3.4, AC3.5

**Files:**
- Create: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramObjectView/Faces/Lines/DynamicLine.spec.ts`
- Modify (minor): `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/OpenChart.spec.ts` — if the existing line-layout smoke tests reference `face.arrow`, update them to read from the new slots.

**Implementation:**

1. **New spec `DynamicLine.spec.ts`:**
   - Follow the project's colocated-spec convention (sibling of `DynamicLine.ts`).
   - Node environment (no jsdom comment needed — all layout math is pure, no DOM).
   - Construct a `LineView` via the testing factory (see `OpenChart.spec.ts`'s `createTestingLine()` helper at lines 130-133 for the idiom):
     ```typescript
     async function createTestingLine(): Promise<LineView> {
         const factory = await createTestingFactory();
         return factory.createNewDiagramObject("data_flow", LineView) as LineView;
     }
     ```
   - For each AC case, build a Line with specific ref-array state, run the layout (call `line.calculateLayout()` or the face's layout entry point), then assert the slot values on the face.
   - Use `dataItems.test-utils.ts` helpers (`addDataItem`, `addDataItemRef`) to seed ref arrays — but update those helpers OR use them at the corresponding new keys (since Phase 3 retired the legacy `data_item_refs`, the helpers should target `node1_src_data_item_refs` / `node2_src_data_item_refs` explicitly via an updated signature, e.g., `addDataItemRef(line, itemGuid, "node1")`).

   **Tests** (one per AC case):

   - `"renders an arrowhead at node2 when only node1_src is populated" (AC3.1)`:
     - Build a Line with `node1_src_data_item_refs = [someGuid]`, `node2_src_data_item_refs = []`.
     - Run layout.
     - Assert: `face.arrowAtNode1 === null` AND `face.arrowAtNode2 !== null` AND `face.arrowAtNode2.length === 6` (six numbers = three 2D vertices).

   - `"renders an arrowhead at node1 when only node2_src is populated" (AC3.2)` — symmetric.

   - `"renders arrowheads at both ends when both arrays are populated" (AC3.3)` — both slots non-null, both length 6.

   - `"renders no arrowheads when both ref arrays are empty" (AC3.4)` — both slots null.

   - `"toggling a ref array re-layouts and updates arrowhead count" (AC3.5)`:
     - Build a Line with both arrays empty.
     - Run layout → assert both slots null.
     - Mutate `node1_src_data_item_refs` to add one entry (via the editor-command pipeline if accessible, else via `ListProperty.addProperty(...)` direct mutation).
     - Run layout again → assert `face.arrowAtNode2 !== null`.
     - Clear the array → re-layout → assert back to null.
     - The intent is a reactivity regression guard; if the existing property-observer doesn't fire layout recomputation automatically in a test env, the spec can trigger recomputation manually (document why in a comment).

   - `"line body geometry is independent of arrow state"`: snapshot `face.points` for a Line with `node1_src` populated, then snapshot with `node2_src` populated, and with both. Assert the vertex list is identical across the three cases (modulo the cap-size inset on whichever end has an arrow — assert this inset is symmetric).

2. **`OpenChart.spec.ts`**: if the existing line-layout assertions reference `face.arrow`, migrate them. The investigator found no `renderTo` tests but there may be layout-smoke tests.

**Verification:**

```
cd /Users/josh/code/dfd_editor
npm run type-check
npm run test:unit -- DynamicLine.spec
npm run test:unit
npm run build
npm run lint
```

All must pass.

Manual smoke test (not a gate): `npm run dev:all`. Import `server/temp/aws-ecs-webapp-with-reverse-flows.json`. Every flow should display arrowheads at both ends. Also import `aws-ecs-webapp.json` (unidirectional flows); arrows appear only at node2 for each. No lingering console errors about property shape.

**Commit** (one commit covering Tasks 1-3):

```
feat(dynamic-line): render arrowheads based on per-direction ref-array state

Flow edges now show zero, one, or two arrowheads based on which ref
arrays are populated. Drives AC3 of the bidirectional flow design.
```
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->
