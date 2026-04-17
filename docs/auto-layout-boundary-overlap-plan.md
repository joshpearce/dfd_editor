# Auto-layout: sibling trust boundaries overlap

## Problem

Loading a coord-less diagram (no `layout` property) triggers
`NewAutoLayoutEngine`, which serializes the canvas to D2 and asks the
Flask backend to render it via `d2 --layout=tala`. For diagrams with two
top-level sibling trust boundaries (e.g. `AWS Private Subnet` and
`Internet` in `server/temp/bdf1c563-...json`), TALA places the containers
on top of each other instead of side-by-side.

## Root cause

Pre-fix, `serializeGroup` in `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`
(originally lines 183–194; post-fix the function sits around line 190 with
the width/height lines removed) unconditionally emitted `width` and `height`
derived from `group.face.boundingBox`:

```
const width  = Math.round(bb.xMax - bb.xMin);
const height = Math.round(bb.yMax - bb.yMin);
lines.push(`  width: ${width}`);
lines.push(`  height: ${height}`);
```

When the diagram has no prior layout, every group's bounding box is
`{xMin:0, yMin:0, xMax:0, yMax:0}`. The serializer therefore emits
`width: 0` and `height: 0` for each container. TALA respects the hard
constraint and collapses both sibling containers into zero-area nodes at
the origin — visually overlapping.

Blocks are unaffected: `SerializableBlockFace.width`/`height` come from
template-defined default sizes, not from layout data.

## Fix

Stop emitting `width`/`height` for groups in the D2 output. TALA
auto-sizes containers from their contents, which is the intended
behavior for content-only diagrams (the primary authoring model). The
current call site only runs pre-layout, so there are never real group
bounds to preserve at this point in the flow.

## Steps

### Step 1 — Drop group dimension emission

In `serializeGroup`
(`src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`),
remove the two lines that push `width:` and `height:` into the output.
Also remove the now-unused local `bb`, `width`, and `height` bindings.
The `SerializableGroupFace`/`SerializableBoundingBox` interfaces can
stay — they carry no cost and removing them touches more files than
needed.

Pseudocode for the resulting function body:

```
header = label ? "${id}: ${label} {" : "${id} {"
lines  = [ header ]
for child in group.blocks: lines.push(serializeBlock(child, ...))
for nested in group.groups: lines.push(serializeGroup(nested, ...))
for line in group.lines (resolved): lines.push("  src -> tgt")
lines.push("}")
```

Update `D2Bridge.spec.ts` fixtures that currently assert on `width:` /
`height:` lines inside a group block — those expectations should be
removed. Block-level `width`/`height` assertions stay unchanged.

**Files touched**:
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.spec.ts`

**Acceptance criteria**:
- `npm run test:unit` passes.
- `npm run type-check` clean.
- `npm run lint` clean.
- Grepping the updated spec for `width:` or `height:` inside a group
  block returns nothing; block-level occurrences remain.

### Step 2 — Manual verification with the repro diagram

Start `npm run dev:all`. Import or load
`server/temp/bdf1c563-0a37-41fd-b0e6-d146d2cb49a7.json` via the existing
server-load path. Confirm visually that `AWS Private Subnet` and
`Internet` render as non-overlapping sibling containers. Save the
diagram and inspect the resulting `server/data/<id>.json` — every child
block in the `layout` map should have coordinates that place it within
exactly one of the two boundaries' convex hulls, with no horizontal or
vertical overlap between the two hulls.

No code change in this step unless verification reveals the fix is
incomplete. If incomplete, re-open step 1 with the new observation.

**Files touched**: none (verification only).

**Acceptance criteria**:
- The two top-level boundaries are visually non-overlapping in the
  editor after auto-layout.
- Nested containment is preserved: `Kubernetes` sits inside
  `AWS Private Subnet`; `Salesforce` sits inside `Internet`.
- No console errors during layout.

## Definition of done

- Step 1 acceptance criteria all met.
- Step 2 manual verification passes.
- `npm run build` succeeds (type-check + bundler).
- No regressions: existing `D2Bridge.spec.ts` and
  `NewAutoLayoutEngine.spec.ts` cases continue to pass unchanged except
  where they asserted the now-suppressed `width: 0` / `height: 0` lines.

## Scope note (updated after Step 2 verification)

Initial Step 1 was scoped as "a single-file code edit plus its test; no
API, schema, or file-format change." Step 2 verification surfaced two
additional problems that required re-opening Step 1 per the escape
clause ("If incomplete, re-open step 1 with the new observation"):

1. **Sibling-group instance collision**: `serializeToD2` used each
   template's `id` rather than the per-object `instance` uuid, so every
   group of the same template collapsed onto a single D2 node. Renaming
   the `Serializable*` surface from `id` → `instance` was needed to make
   qualified paths unambiguous across siblings.
2. **`GroupView.moveTo` doesn't resize**: placing a group by translation
   left user bounds at the default 300×200, so even with `width`/`height`
   stripped from D2 the sibling containers still overlapped after layout.
   The engine was changed to call `GroupFace.setBounds(...)` directly
   with TALA's reported rectangle, plus a two-pass order (blocks before
   groups) so that the `GroupFace.calculateLayout` ripple triggered by
   child moves does not overwrite TALA's bounds.

As a result the shipped change touches four files rather than one —
`D2Bridge.ts`, `D2Bridge.spec.ts`, `NewAutoLayoutEngine.ts`,
`NewAutoLayoutEngine.spec.ts` — and renames exported `Serializable*`
field `id` to `instance`, adds an exported `TalaPlacement` type, and
changes the engine's group-placement API from `moveTo` to
`GroupFace.setBounds`. These are internal-only API shifts within
`src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/`;
no user-facing API, persisted schema, or file-format changes.

## Scope note (follow-up hardening on the same files)

Post-fix review surfaced a handful of small hardening opportunities on
the same four engine files.  Because they share the same blast radius
as the fix — and because bad test fixtures, half-populated placements,
and indistinguishable skip causes were all concrete risks surfaced by
Step 2 — they ship together with the fix rather than as a separate
commit.  No user-facing API, persisted schema, or file-format changes.

1. **`TalaPlacement` is now a discriminated union** (`D2Bridge.ts`)
   over `{ x, y, width, height }` vs `{ x, y }`.  Replaces two
   independently-optional fields with a union that makes
   half-populated placements non-representable at the type level.
   `parseTalaSvg` is required to produce one of the two shapes;
   `placeBlock` / `placeGroup` narrow on `width !== undefined` and
   can rely on `height` being present in the same branch without a
   separate check.

2. **`collectNodes` returns `{ blocks, groups }` partitioned by kind**
   (`NewAutoLayoutEngine.ts`).  The pre-refactor shape was a single
   `Map<string, PositionableNode>` keyed by qualified path, with the
   block/group distinction carried on a `PositionableNode.kind`
   discriminator.  The partitioned shape makes the two-pass
   invariant ("every block `moveTo` before any group `setBounds`")
   trivially enforced by the shape of `run()` itself — there's no
   way to "accidentally" iterate the wrong kind in the wrong pass.
   The `kind` discriminator is removed.

3. **Runtime fixture guards `asPositionableBlock` /
   `asPositionableGroup`** (`NewAutoLayoutEngine.ts`).  The
   `Serializable*` interfaces only describe the read-side surface
   `D2Bridge` touches; the engine additionally requires `moveTo` on
   blocks and groups and `setBounds` on group faces.  Production
   `BlockView` / `GroupView` instances supply those; a test fixture
   that forgets to would otherwise crash inside `placeBlock` or
   `placeGroup` with a `.moveTo is not a function` error.  The guards
   throw a diagnostic error naming the offending qualified path so
   bad-fixture failures point at the fixture, not the engine.

4. **`applyPlacements` and `formatSkippedWarning` extracted from
   `run`** (`NewAutoLayoutEngine.ts`).  Keeps `run` at the level of
   "serialize → fetch → parse → apply → warn" and puts the per-pass
   placement-application contract and the warning-formatting
   display-cap policy each in one named function.

5. **Skip-vs-missing outcome distinction with elision cap**
   (`NewAutoLayoutEngine.ts`).  `placeAt` now returns `"placed"`,
   `"skipped-rect-less"` (rect-less TALA placement AND zero-bbox
   fallback), or `"skipped-non-positive"` (rect with non-positive
   dimensions).  Each unplaced cause ships to the end-of-run warning
   under its own cause label, so an operator diagnosing "why did
   this specific group get skipped?" can answer the question from
   the single warning line.  A `MAX_MISSING_DISPLAYED = 10` cap plus
   `", ... and N more"` elision keeps a badly-malformed canvas from
   producing a megabyte-wide console line.

6. **`.gitignore` adds `server/temp/`** (paperwork).  Matches the
   "Out of scope" intent below (user's `server/temp/` fixture stays
   local).  Strictly a tracking-hygiene change; no runtime effect.

Each of these items has at least one dedicated test in
`NewAutoLayoutEngine.spec.ts` or `D2Bridge.spec.ts` (full suite: 204
tests passing; type-check clean; lint clean in the changed
directory).

## Out of scope

- Reworking how `GroupFace.boundingBox` is computed pre-layout.
- Replacing or supplementing TALA with a different layout algorithm.
- Committing the user's local `server/temp/` fixture into the repo —
  `server/data/` and `server/temp/` are not versioned (see CLAUDE.md).
  If a committed regression fixture is desired later, it should be a
  minimal synthetic canvas constructed in-test, not a copy of the user's
  diagram.
