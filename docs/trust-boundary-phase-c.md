# Trust Boundary Integration — Phase C

**Scope.** Add the *semantic analysis* layer from
[trust-boundary-integration-plan.md](./trust-boundary-integration-plan.md)
§3.3 now that Phase B has structural correctness in place. Phase C makes
trust-boundary containment and crossing information machine-readable: a
validator that flags unsafe data flows, and a publisher that emits
parent/crossing metadata for downstream consumers.

**In scope:**

- **Semantic graph enrichment** — extend `SemanticAnalyzer.toGraph` to
  populate `SemanticGraphNode.parent` (the containing group node, or
  `null` for canvas-level objects), `SemanticGraphNode.children` (direct
  children), and `SemanticGraphEdge.crossings` (the trust-boundary nodes
  this edge crosses). These are the primitives TB-8 and TB-9 both read.
- **TB-8** — five `DfdValidator` checks: unauthenticated flows crossing
  a boundary, unencrypted flows crossing a boundary, high-classification
  data flowing into a less-privileged zone, out-of-scope external entities
  inside restricted boundaries, and empty trust boundary (warning).
- **TB-9** — `DfdPublisher` extended output: every node emits a `parent`
  field (instance ID of its containing trust boundary, or `null`) and
  every edge emits a `crosses` field (array of trust-boundary instance
  IDs). Native-JSON format — see the decision note in Design notes.
- **Unit tests for `toGraph` enrichment** (`SemanticAnalyzer.spec.ts`).

**Out of scope.** Explicitly deferred to later phases:

- **TB-4b** (block-move-triggered line LCA recomputation) — acknowledged
  gap from Phase B, still deferred.
- **TB-10, TB-11, TB-12** (UX polish) — Phase D.
- **TB-14** (`smartHover` integration test) — Phase D.
- **Full OTM output** — native JSON is Phase C's format. A future
  `DfdOtmPublisher` is Phase F or opportunistic.
- **Validator rule for stale LCAs** — after a block is dragged across a
  boundary, the attached lines can have stale structural parents (TB-4b).
  Do not write a crossing rule that would fire spuriously until TB-4b is
  fixed.
- **Mover-level and editor-layer unit tests** — same scaffolding concern
  as Phases A and B. Deferred to Phase D.

**Manual smoke-test checklist (run by hand at the end of Phase C).**

- **Unauthenticated cross-boundary flow (rule C1).** Block `A` inside a
  trust boundary, block `B` at the canvas root. Add a `data_flow` connector
  A→B. Leave `authenticated` at its default (`false`). Open the validator
  panel. Expect a warning on the data flow about authentication.
- **No warning when authenticated (C1 negative).** Same diagram; set
  `authenticated = true`. No C1 warning.
- **Unencrypted cross-boundary flow (rule C2).** Same cross-boundary
  setup; leave `encrypted_in_transit = false`. Expect an encryption
  warning.
- **High-classification cross-zone (rule C3).** Block `A` in a `restricted`
  boundary, block `B` at canvas root. Data flow A→B with
  `data_classification = secret`. Expect a warning. Same flow with
  `data_classification = public` → no warning.
- **Out-of-scope entity in restricted zone (rule C4).** Place an
  `external_entity` with `out_of_scope = true` inside a trust boundary
  whose `privilege_level = restricted`. Expect a warning. Move it outside
  the boundary → warning disappears.
- **Empty trust boundary (rule C5).** Place a trust boundary with no
  child objects. Expect a warning. Add a block inside → warning
  disappears.
- **No false positives for internal flows.** Two blocks both inside the
  same trust boundary, connected by a `data_flow`. Leave `authenticated =
  false` and `encrypted_in_transit = false`. Expect **no** C1 or C2
  warnings — the flow doesn't cross a boundary.
- **Publisher includes `parent` + `crosses` (TB-9).** Use the
  cross-boundary C1 scenario above. Publish the diagram. Open the output
  JSON. Confirm:
  - Block A (inside the boundary) has `"parent": "<boundary-instance>"`.
  - Block B (canvas root) has `"parent": null`.
  - The data flow has `"crosses": ["<boundary-instance>"]`.
- **Publisher nested boundary (TB-9).** Block inside inner boundary B1
  (which is inside B0). Confirm `"parent"` = B1's instance (not B0's).
  A flow from that block to a block directly in B0 has
  `"crosses": ["<B1-instance>"]` — crosses only B1.

---

## Design notes

### TB-9 format decision: native JSON, not OTM

The roadmap asks whether to emit native JSON or full
[Open Threat Model (OTM)](https://github.com/iriusrisk/OpenThreatModel)
format. **Decision: native JSON for Phase C.**

1. `DfdPublisher` already outputs `{ nodes, edges }`. Adding `parent` and
   `crosses` is a non-breaking additive change.
2. OTM has its own type names (`trustZone`, `component`, `dataFlow`) that
   don't map 1-to-1 to DFD template IDs. A faithful OTM emitter requires
   a separate mapping layer and its own test suite — its own workstream.
3. The Phase C fields are structurally compatible with OTM:
   `parent` ≡ OTM `trustZone.components[*].component`,
   `crosses` ≡ OTM `dataFlow.trustZones`. A future `DfdOtmPublisher` can
   read the same enriched graph without touching the validator or
   analyzer.

### `traverse` includes the starting node — canvas is in `nodes`

`Generators.ts:traverse` pushes the starting object into its queue first
and yields it. Since `Canvas extends Group`, `canvas instanceof Group` is
true, and the existing `toGraph` build loop puts the canvas into `nodes`
as a `SemanticGraphNode`. This is pre-existing behavior that the current
validator and publisher tolerate (the canvas template has no `is_required`
properties that would generate spurious errors).

Phase C must not treat the canvas node as a trust-boundary parent. The
parent-link pass (Pass 3 below) guards `parentObj !== canvas` explicitly
so canvas-level blocks and groups keep `parent = null`.

### Parent links — bottom-up vs. top-down

`Group.addObject` calls `this.makeChild(child)`, which sets
`child._parent` in the `DiagramObject` base class. `GroupView` redeclares
`_parent` with a narrower type (`DiagramObjectView | null`), confirming
the field exists in the model layer. So reading `obj.parent` on a
model-layer `Block` or `Group` returns its containing `Group` or the
canvas root.

The parent-link pass reads `obj.parent` on each item in `objMap` and
resolves the corresponding `SemanticGraphNode`:

```ts
for (const [instance, obj] of objMap) {
    const parentObj = (obj as DiagramObject & { parent: DiagramObject | null }).parent;
    if (parentObj === null || parentObj === canvas) {
        continue;  // canvas-level → node.parent stays null
    }
    if (parentObj instanceof Group) {
        const parentNode = nodes.get(parentObj.instance);
        if (parentNode) {
            const childNode = nodes.get(instance)!;
            childNode.parent = parentNode;
            parentNode.children.push(childNode);
        }
    }
}
```

**Fallback (if `DiagramObject.parent` is not directly accessible at
the model layer).** Walk the canvas top-down using `Group.objects`
and `Group.groups`:

```ts
function linkParents(
    container: Group,
    containerNode: SemanticGraphNode | undefined,
    nodes: Map<string, SemanticGraphNode>,
    canvas: Group
): void {
    for (const child of container.objects) {
        const childNode = nodes.get(child.instance);
        if (childNode && containerNode && container !== canvas) {
            childNode.parent = containerNode;
            containerNode.children.push(childNode);
        }
        if (child instanceof Group) {
            linkParents(child, nodes.get(child.instance), nodes, canvas);
        }
    }
}
linkParents(canvas as Group, undefined, nodes, canvas as Group);
```

This uses only `Group.objects` and `instanceof Group` — both provably
available. Prefer the bottom-up approach; fall back to top-down if
the TypeScript type check fails.

### `trustBoundaryAncestors` — placement and ordering

A getter on `SemanticGraphNode` that walks the parent chain returning
only nodes whose `id === "trust_boundary"`, innermost first:

```ts
public get trustBoundaryAncestors(): SemanticGraphNode[] {
    const result: SemanticGraphNode[] = [];
    let cur: SemanticGraphNode | null = this.parent;
    while (cur !== null) {
        if (cur.id === "trust_boundary") result.push(cur);
        cur = cur.parent;
    }
    return result;
}
```

Lives on `SemanticGraphNode` because the crossing pass and the validator
both need it, and it is a pure structural query with no external
dependencies.

### Crossings — symmetric difference

For an edge whose `source` and `target` nodes are both bound, the
crossing set is the symmetric difference of their `trustBoundaryAncestors`
arrays:

```
sourceTba = edge.source.trustBoundaryAncestors   // [S_inner, ..., S_outer]
targetTba = edge.target.trustBoundaryAncestors   // [T_inner, ..., T_outer]
crossings = (sourceTba \ targetTba) ∪ (targetTba \ sourceTba)
```

Concretely, a trust boundary is crossed if exactly one endpoint is
structurally inside it. Boundaries that contain both endpoints are shared
ancestry — not crossings.

For an unbound edge (source or target `null`), `crossings = []`.

### TB-8 rule definitions

All five rules read only the enriched `{ nodes, edges }` graph.

**C1 — Unauthenticated boundary crossing.**
```
edge.crossings.length > 0
AND edge.props.value.get("authenticated")?.value === "false"
```
Warning: `"Data flow crosses a trust boundary but is not authenticated."`

**C2 — Unencrypted boundary crossing.**
```
edge.crossings.length > 0
AND edge.props.value.get("encrypted_in_transit")?.value === "false"
```
Warning: `"Data flow crosses a trust boundary but is not encrypted in transit."`

**C3 — High-classification data into lower-trust zone.**
Define `PRIVILEGE_RANK: Record<string, number> = { internet: 0, dmz: 1, corporate: 2, restricted: 3 }`.
A node with no trust-boundary ancestors has effective rank `−1`.

```
sourceRank = PRIVILEGE_RANK[innermost ancestor of source] ?? -1
targetRank = PRIVILEGE_RANK[innermost ancestor of target] ?? -1
sourceRank > targetRank
AND edge.crossings.length > 0
AND data_classification in { "secret", "confidential" }
```
Warning: `"High-classification data flow exits into a less-privileged trust zone."`

`data_classification` has no default in the DFD template, so an unset
value (`undefined`) is treated as "not high-classification" — no warning.

**C4 — Out-of-scope external entity inside a restricted boundary.**
Applied in `validateBoundary`, iterating `node.children`:
```
node.id === "trust_boundary"
AND node.props.value.get("privilege_level")?.value === "restricted"
AND any child where child.id === "external_entity"
       AND child.props.value.get("out_of_scope")?.value === "true"
```
Warning on the external-entity instance:
`"Out-of-scope external entity is inside a restricted trust boundary."`

**C5 — Empty trust boundary.**
```
node.id === "trust_boundary"
AND node.children.length === 0
```
Warning: `"Trust boundary has no child objects."`

`FileValidator` exposes only `addWarning` and `addError` — no
`addInfo`. Rule C5 uses `addWarning`. If a future phase adds `addInfo`
to `FileValidator`, lower the severity then.

### `validateBoundary` — new method

Today `DfdValidator.validate` has two loops: nodes and edges. Add a
third that calls `validateBoundary(instance, node)` for every node with
`id === "trust_boundary"`. Rules C4 and C5 both live in
`validateBoundary`; rules C1, C2, and C3 live in `validateEdge`. This
keeps all "what does this boundary mean?" logic in one method.

---

## Steps

### Step 1 — Enrich the semantic graph (parent, children, crossings)

**Changes.**

1. `SemanticGraphNode.ts` — add three new members:
   ```ts
   /** Containing group node, or null for canvas-level objects.
    *  Set by SemanticAnalyzer.toGraph. */
   public parent: SemanticGraphNode | null = null;

   /** Nodes directly contained by this group node.
    *  Set by SemanticAnalyzer.toGraph; empty for non-group nodes. */
   public children: SemanticGraphNode[] = [];

   /** All trust-boundary ancestors, innermost first. */
   public get trustBoundaryAncestors(): SemanticGraphNode[] {
       const result: SemanticGraphNode[] = [];
       let cur: SemanticGraphNode | null = this.parent;
       while (cur !== null) {
           if (cur.id === "trust_boundary") result.push(cur);
           cur = cur.parent;
       }
       return result;
   }
   ```

2. `SemanticGraphEdge.ts` — add:
   ```ts
   /** Trust-boundary nodes this edge crosses (symmetric difference of
    *  source and target trustBoundaryAncestors). Empty for unbound edges
    *  or edges fully contained within shared ancestry.
    *  Set by SemanticAnalyzer.toGraph. */
   public crossings: SemanticGraphNode[] = [];
   ```

3. `SemanticAnalyzer.ts` — extend `toGraph` with two new passes:

   **Pass 3 — parent links.** Runs after the build loop. Simultaneously
   accumulate `objMap: Map<string, Group | Block>` during the build loop
   (alongside `nodes` and `edges`), then:

   ```ts
   for (const [instance, obj] of objMap) {
       // Read model-layer parent. Guard: canvas-level objects keep null.
       const parentObj = (obj as any).parent as DiagramObject | null;
       if (!parentObj || parentObj === canvas) continue;
       if (!(parentObj instanceof Group)) continue;
       const parentNode = nodes.get(parentObj.instance);
       if (!parentNode) continue;
       const childNode = nodes.get(instance)!;
       childNode.parent = parentNode;
       parentNode.children.push(childNode);
   }
   ```

   If `DiagramObject.parent` is not visible to the TypeScript type
   checker, use the top-down `Group.objects` walk documented in Design
   notes instead.

   **Pass 4 — crossings.** Runs after the connect loop (source/target
   are bound):

   ```ts
   for (const [, edge] of edges) {
       if (!edge.source || !edge.target) continue;
       const sa = edge.source.trustBoundaryAncestors;
       const ta = edge.target.trustBoundaryAncestors;
       const taSet = new Set(ta);
       const saSet = new Set(sa);
       edge.crossings = [
           ...sa.filter(n => !taSet.has(n)),
           ...ta.filter(n => !saSet.has(n)),
       ];
   }
   ```

**Files affected.**

- `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticGraphNode.ts`
- `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticGraphEdge.ts`
- `src/assets/scripts/OpenChart/DiagramModel/SemanticAnalysis/SemanticAnalyzer.ts`

**Test cases.** New file `SemanticAnalyzer.spec.ts`. Build model-layer
canvases using the same fixture patterns as `DiagramModel.spec.ts` (model
constructors, no view scaffolding).

- **Canvas-level block has null parent.** Block at root →
  `node.parent === null`.
- **Block inside a trust boundary.** Block in group `G` →
  `node.parent.instance === G.instance`.
- **Nested: block in B1 inside B0.** → `node.parent.instance === B1.instance`
  (direct parent, not B0).
- **`trustBoundaryAncestors` for nested block.** Block in B1 inside B0 →
  `[B1-node, B0-node]` (innermost first).
- **`trustBoundaryAncestors` for canvas-level block.** → `[]`.
- **`children` populated.** Group `G` with two child blocks →
  `G-node.children.length === 2`.
- **No crossings — both endpoints in same boundary.** Source and target
  both in `B` → `edge.crossings` is empty.
- **Crossing — one endpoint in B, one at canvas root.** →
  `edge.crossings === [B-node]`.
- **Crossing — source in B1 (inside B0), target in B0.** →
  `edge.crossings === [B1-node]` (B0 contains both endpoints).
- **Crossings — sibling boundaries.** Source in B1, target in B2, both
  inside B0 → `edge.crossings` contains both B1-node and B2-node.
- **Unbound edge.** Line with no target latch → `edge.crossings` is empty.

**Acceptance criteria.**

- All new tests pass under `npm run test:unit`.
- Existing tests (`DiagramModel.spec.ts`, `OpenChart.spec.ts`,
  `GroupFace.spec.ts`, `ViewLocators.spec.ts`,
  `RestoreGroupBounds.spec.ts`) pass unchanged.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **`DiagramObject.parent` TypeScript visibility.** `makeChild` in
  `Group.ts` sets the child's `_parent`, and `GroupView` uses `declare`
  to redeclare it — confirming the field exists at runtime. But if
  TypeScript's type for `DiagramObject` does not declare `parent` in
  its public interface, the access will need a cast. Read
  `DiagramObject/DiagramObject.ts` before writing Pass 3; fall back to
  the top-down walk if casting feels too fragile.
- **Canvas in `nodes`.** `traverse` yields the canvas as its first item,
  and `canvas instanceof Group` is true, so the canvas IS a node in the
  map. The `parentObj !== canvas` guard in Pass 3 keeps canvas-level
  objects' `parent` at `null`. Verify with the "Canvas-level block has
  null parent" test case.
- **Lines in `objMap` (unnecessary).** Only `Group | Block` objects need
  parent links (lines live in groups but aren't trust-zone containers).
  Filter to `instanceof Group || instanceof Block` when populating
  `objMap` — same predicate already used in the build loop.

### Step 2 — TB-8: `DfdValidator` boundary-crossing rules

**Changes.**

1. `DfdValidator.ts`:

   Add a private `validateBoundary` method:
   ```ts
   private validateBoundary(instance: string, node: SemanticGraphNode): void {
       // C5: empty boundary
       if (node.children.length === 0) {
           this.addWarning(instance, "Trust boundary has no child objects.");
       }
       // C4: out-of-scope external entity in restricted zone
       if (node.props.value.get("privilege_level")?.value === "restricted") {
           for (const child of node.children) {
               if (
                   child.id === "external_entity" &&
                   child.props.value.get("out_of_scope")?.value === "true"
               ) {
                   this.addWarning(
                       child.instance,
                       "Out-of-scope external entity is inside a restricted trust boundary."
                   );
               }
           }
       }
   }
   ```

   Extend `validateEdge` with rules C1, C2, C3:
   ```ts
   private validateEdge(id: string, edge: SemanticGraphEdge): void {
       if (!(edge.source && edge.target)) {
           this.addWarning(id, "Data flow should connect on both ends.");
       }
       if (edge.crossings.length > 0) {
           if (edge.props.value.get("authenticated")?.value === "false") {
               this.addWarning(id,
                   "Data flow crosses a trust boundary but is not authenticated.");
           }
           if (edge.props.value.get("encrypted_in_transit")?.value === "false") {
               this.addWarning(id,
                   "Data flow crosses a trust boundary but is not encrypted in transit.");
           }
           const classification = edge.props.value.get("data_classification")?.value;
           if (classification === "secret" || classification === "confidential") {
               const sourceRank = privilegeRankOf(edge.source);
               const targetRank = privilegeRankOf(edge.target);
               if (sourceRank > targetRank) {
                   this.addWarning(id,
                       "High-classification data flow exits into a less-privileged trust zone.");
               }
           }
       }
   }
   ```

   Add `validateBoundary` call in `validate`:
   ```ts
   for (const [instance, node] of graph.nodes) {
       if (node.id === "trust_boundary") {
           this.validateBoundary(instance, node);
       }
   }
   ```

   Add module-level privilege rank helpers (outside the class):
   ```ts
   const PRIVILEGE_RANK: Record<string, number> = {
       internet: 0,
       dmz: 1,
       corporate: 2,
       restricted: 3,
   };

   function privilegeRankOf(node: SemanticGraphNode): number {
       const ancestors = node.trustBoundaryAncestors;
       if (ancestors.length === 0) return -1;
       const level = ancestors[0].props.value.get("privilege_level")?.value ?? "";
       return PRIVILEGE_RANK[level] ?? -1;
   }
   ```

**Files affected.**

- `src/assets/configuration/DfdValidator/DfdValidator.ts`

**Acceptance criteria.**

- All eight validator smoke-test items pass by hand.
- `npm run test:unit` still green; `SemanticAnalyzer.spec.ts` and all
  existing tests pass unchanged.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **`data_classification` has no default.** An unset classification
  has `value === undefined`. The `=== "secret" || === "confidential"`
  check naturally skips `undefined` — no special guard needed.
- **C4 only checks `node.children` (direct children).** A
  `privilege_level = restricted` boundary with an out-of-scope external
  entity nested one level deeper (inside an inner boundary that itself
  is inside the restricted boundary) will not be caught by C4. This is
  intentional: the immediate structural parent is the relevant context.
  Document the limitation in a code comment; fix in a follow-up if
  needed.
- **C5 fires for trust boundaries that are pure containers.** A boundary
  whose only children are other trust boundaries (no blocks or lines)
  would emit a C5 warning if we only check `children.length === 0`.
  Since `children` includes nested group nodes too, a boundary with only
  sub-boundaries will correctly have `children.length > 0` and NOT fire
  C5. Only a completely empty boundary fires. Verify with the smoke test.

### Step 3 — TB-9: `DfdPublisher` parent + crossings export

**Changes.**

1. `DfdPublisher.ts` — add two fields to the existing loops:

   Node loop:
   ```ts
   nodes.push({
       id: instance,
       type: node.id,
       parent: node.parent?.instance ?? null,   // ADD
       properties: node.props.toJson()
   });
   ```

   Edge loop:
   ```ts
   edges.push({
       id,
       source: edge.source?.instance ?? null,
       target: edge.target?.instance ?? null,
       crosses: edge.crossings.map(n => n.instance),  // ADD
   });
   ```

   Both fields are always present (never omitted), even when `null`/`[]`,
   for a stable schema that consumers can rely on.

**Files affected.**

- `src/assets/configuration/DfdPublisher/DfdPublisher.ts`

**Acceptance criteria.**

- Publisher smoke tests pass by hand (see checklist above).
- `npm run test:unit` still green.
- `npm run lint` and `npm run type-check` — no new errors.

**Risks.**

- **Trust boundary nodes appear in `nodes`.** Trust boundaries are
  `Group`s, so they ARE emitted as nodes in the publisher output. Their
  own `parent` field will be the instance of the outer boundary that
  contains them (or `null` for top-level boundaries). This is correct
  — nested boundaries need a `parent` reference too. Verify the smoke
  test for the nested boundary case.
- **`node.instance`** is set correctly on `SemanticGraphNode` from
  `object.instance` in the constructor — confirm this is the same
  instance ID the publisher already emits as the node's `id`. The
  `parent` field should reference that same ID space.

---

## Definition of Done

- All three step-level acceptance criteria met.
- `npm run test:unit` green; no existing tests modified or skipped.
- Manual smoke-test checklist completed and passing.
- A data flow crossing a trust boundary triggers C1 and C2 warnings
  when `authenticated` / `encrypted_in_transit` are `false`. An
  internal data flow (both endpoints in the same boundary) does **not**
  trigger those warnings.
- The published JSON for a cross-boundary diagram includes
  `"parent": "<instance-id>"` for contained nodes and
  `"crosses": ["<instance-id>"]` for crossing edges.
- Only `SemanticGraphNode.ts`, `SemanticGraphEdge.ts`,
  `SemanticAnalyzer.ts`, `DfdValidator.ts`, and `DfdPublisher.ts` are
  modified. No view-layer, mover-layer, or UI changes.
- Lint passes; type-check passes with only the four pre-existing errors
  Phase A/B documented (`DarkTheme`, `LightTheme`, `LatchMover:170`,
  node22 vendor).

---

## What comes after Phase C

- **Phase D: Editor-layer test scaffolding + TB-14.** Build the
  plugin/executor/`SubjectTrack` stubs that Phases A, B, and C all
  deferred, then land the `smartHover` integration test and catch up on
  mover-level unit tests (TB-13's block/group/latch-mover bullets). This
  unblocks automated coverage of everything the smoke checklist currently
  validates by hand.
- **Phase E: UX polish.** TB-10 (depth coloring), TB-11 (clamp cursor),
  TB-12 (context menu reparent). Worth doing once the structural and
  semantic layers are stable.
- **Phase F (opportunistic cleanup).** TB-4b (block-move-triggered line
  LCA recomputation), OTM publisher, TB-6 re-evaluation, the pre-existing
  `BlockMover.ts` lint debt, and the `CanvasView.groups` typing cleanup.
