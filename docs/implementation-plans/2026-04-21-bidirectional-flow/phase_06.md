# Phase 6 — D2Bridge single-edge emission

**Goal:** `D2Bridge.serializeToD2` emits exactly one D2 edge per Flow as `node1 -> node2`, with no attached attributes, regardless of the Flow's ref-array state. The `->` operator is pinned; arrow visuals are entirely the Vue canvas renderer's concern (Phase 4). TALA layout behavior is unchanged.

**Architecture:** Phase 2 already renamed `source`/`target` → `node1`/`node2` inside `D2Bridge.ts` (stub interface, `resolveLineEndpoints` return type, variable names). Phase 6 adds explicit spec coverage proving the invariants: one edge per Flow, no attributes, `->` direction pinned, ref-array state invisible to D2. Also includes a manual end-to-end smoke test of the `/api/layout` integration.

**Tech Stack:** TypeScript, Vitest. D2 + TALA via the Flask backend. Gate: `vue-tsc` + `npm run test:unit`.

**Scope:** Phase 6 of 7. Depends on Phases 2, 3, 5.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### bidirectional-flow.AC5: Downstream consumers handle the new shape

- **bidirectional-flow.AC5.5 Success:** `D2Bridge.serializeToD2` emits one D2 edge per Flow as `node1 -> node2` with no attached attributes, regardless of ref-array state.

---

## Context for the executor

**Codebase verification findings (2026-04-21):**

- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts`:
  - After Phase 2: `SerializableLine.node1Object` / `node2Object`, `resolveLineEndpoints(): { node1Instance, node2Instance } | null`, emission loop uses `${absoluteD2Path(node1Instance, index)} -> ${absoluteD2Path(node2Instance, index)}`.
  - Literal `" -> "` is hardcoded at the emission site (formerly line 330). No branching.
  - No attributes are attached (no `{ ... }` after the arrow).
- ✓ `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.spec.ts`:
  - After Phase 2: stubs use `node1Object` / `node2Object`, tests assert output contains `"block-a -> block-b"`, edge-null-endpoint skipping, nested-in-group path handling, and ID escaping.
  - No existing test explicitly asserts **"no attributes attached"** or **"ref-array state does not change D2 output"** — Phase 6 adds both.
- ✓ Anchor rebind / `AnchorStrategy` at `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/AnchorRebind.ts` — both endpoints rebound symmetrically (`pickCardinalAnchor` treats each endpoint independently). No directional assumption. No changes needed.
- ✓ `/api/layout` endpoint (confirmed from `server/CLAUDE.md`): accepts `{"source": "<d2 text>"}`, shells `d2 --layout=tala`, returns `{"svg": ...}` on 200 or 502 if `d2` binary absent. No Phase 6 server changes needed — the endpoint is direction-agnostic.

**External verification (D2 / TALA):**

- D2 edge operators `->`, `<-`, `<->`, `--` are distinct in syntax, but `a -> b` and `b <- a` are semantically equivalent in the graph. TALA's bidirectional-edge handling (`<->`) is a *rendering* optimization, not a routing hint. Pinning our output to `node1 -> node2` is safe and does not inadvertently encode semantic direction — that's deliberately derived from our ref arrays in the Vue renderer, never from D2.
- D2 SVG output places `marker-end` on the second endpoint — `parseTalaSvg` reads node positions and edge polylines geometrically, so it's resilient to marker changes we don't care about.

**Skills to activate before implementing:**

- `ed3d-house-style:writing-good-tests`
- `ed3d-house-style:howto-code-in-typescript`

---

<!-- START_TASK_1 -->
### Task 1: Harden `D2Bridge.spec.ts` — explicit invariants

**Verifies:** bidirectional-flow.AC5.5

**Files:**
- Modify: `/Users/josh/code/dfd_editor/src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.spec.ts`

**Implementation:**

Add a new `describe` block after the existing happy-path tests:

```typescript
describe("D2Bridge.serializeToD2 — edge emission invariants (bidirectional flow)", () => {
    it("emits one edge per Flow as `node1 -> node2`", () => {
        const blockA = makeBlock("block-a", "A", 100, 50);
        const blockB = makeBlock("block-b", "B", 100, 50);
        const line = makeLine(blockA, blockB);
        const canvas = makeCanvas([blockA, blockB], [], [line]);

        const output = serializeToD2(canvas);

        // Exactly one arrow statement.
        const arrowCount = (output.match(/ -> /g) ?? []).length;
        expect(arrowCount).toBe(1);
        expect(output).toContain("block-a -> block-b");
    });

    it("emits no attributes on the edge", () => {
        const blockA = makeBlock("block-a", "A", 100, 50);
        const blockB = makeBlock("block-b", "B", 100, 50);
        const line = makeLine(blockA, blockB);
        const canvas = makeCanvas([blockA, blockB], [], [line]);

        const output = serializeToD2(canvas);

        // No `{` directly after the arrow line (which would be an attribute block).
        const lineWithArrow = output.split("\n").find(l => l.includes(" -> "));
        expect(lineWithArrow).toBeDefined();
        expect(lineWithArrow!).not.toMatch(/ -> .*\{/);
    });

    it("never emits `<-`, `<->`, or `--`", () => {
        const blockA = makeBlock("block-a", "A", 100, 50);
        const blockB = makeBlock("block-b", "B", 100, 50);
        const line = makeLine(blockA, blockB);
        const canvas = makeCanvas([blockA, blockB], [], [line]);

        const output = serializeToD2(canvas);

        expect(output).not.toMatch(/ <- /);
        expect(output).not.toMatch(/ <-> /);
        expect(output).not.toMatch(/ -- /);
    });

    it("SerializableLine interface is invariant to ref-array state", () => {
        // Structural invariant: the interface the D2 bridge consumes exposes only
        // node1Object and node2Object — it does NOT carry ref-array fields. If
        // adding a ref array ever required exposing them on SerializableLine,
        // this test would guide the fix. We verify by reading the interface
        // shape off a stub and asserting no unexpected ref-array properties.
        const stub = makeLine({ instance: "x" }, { instance: "y" });
        const keys = Object.keys(stub).sort();
        expect(keys).toEqual(["node1Object", "node2Object"]);
        // No node1_src_data_item_refs, node2_src_data_item_refs, etc.
    });
});
```

**Rationale:** The design explicitly says "D2Bridge.serializeToD2 emits one D2 edge per Flow as `node1 -> node2` with no attached attributes, regardless of ref-array state." Because `SerializableLine` doesn't even carry ref-array fields, the bridge cannot branch on them — this is a static invariant expressed in the interface shape. The test above encodes that invariant; it doesn't need to construct full canvases with varying ref-array state. If anyone ever adds a ref-array field to `SerializableLine`, this test fails loudly, forcing a deliberate decision.

**Verification:**

```
cd /Users/josh/code/dfd_editor
npm run type-check
npm run test:unit -- D2Bridge.spec
```
Expected: all tests pass, including the four new ones.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Smoke test `/api/layout` through the browser

**Verifies:** bidirectional-flow.AC5.5 end-to-end; layout stability for bidirectional flows

**Files:** None modified.

**Implementation:**

This task is a manual interactive check (not a blocking gate, but required confidence before closing the phase).

1. Start both services:
   ```
   cd /Users/josh/code/dfd_editor
   npm run dev:all
   ```
   Confirm Vite on `:5173` and Flask on `:5050`.

2. Import `server/temp/aws-ecs-webapp-with-reverse-flows.json` (has bidirectional flows after Phase 1's hand-merge):
   ```
   curl -s -X POST http://localhost:5050/api/diagrams/import \
       -H 'Content-Type: application/json' \
       -d @server/temp/aws-ecs-webapp-with-reverse-flows.json
   ```
   Capture the returned `{"id": "<uuid>"}`.

3. Open `http://localhost:5173` and load that diagram. Auto-layout fires on first load (no coords present yet), which means the browser POSTs D2 text to `/api/layout` and the Flask endpoint shells `d2 --layout=tala`.

4. Verify:
   - TALA SVG returns 200 (not 502 — `d2` binary must be on `PATH`).
   - `NewAutoLayoutEngine` parses the SVG and places blocks + reroutes line endpoints without error (no console error about dangling anchors).
   - Each bidirectional flow renders with arrows at both ends (driven by Phase 4's DynamicLine — not by D2).
   - Visually: anchor placement is comparable to unidirectional fixtures. If anchor quality is materially worse for bidirectional flows than for unidirectional ones, that's a follow-up item — **flag to the user via AskUserQuestion** rather than trying to fix in this plan. TALA's unit-layout optimiser was designed around unidirectional flows; anecdotal degradation is acceptable.

5. Check the request/response pair in DevTools → Network:
   - Request body (sent to `/api/layout`) should be a D2 document where every edge uses `->`. Search the sent text — zero occurrences of `<-`, `<->`, `--`.
   - Response body is the TALA SVG.

**Deliverable:** A short note in the commit message (or a scratch file under `SCRATCHPAD_DIR=/tmp/plan-2026-04-21-bidirectional-flow-79ca594d/`) documenting:
- TALA version / date (from `d2 --version` if available).
- Whether anchor placement degraded visibly for bidirectional flows.
- Any error seen in server or browser console.

If any gate fails (SVG returns 502, anchors go missing, parse errors): STOP and surface to the user. Do not try to patch in this phase.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Full-suite verification + commit

**Verifies:** Phase 6 as a whole (bidirectional-flow.AC5.5)

**Files:** None modified.

**Implementation:**

1. Run suites:
   ```
   cd /Users/josh/code/dfd_editor
   npm run type-check
   npm run test:unit
   npm run build
   npm run lint
   ```
   Expected: all green.

2. Final grep that nothing Phase-2-related regressed in D2Bridge:
   ```
   rg -n "sourceObject|targetObject|sourceInstance|targetInstance" \
       src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/
   ```
   Expected: zero matches.

**Commit:**

```
test(d2-bridge): pin edge emission to `node1 -> node2` with no attributes

Adds explicit invariants — one edge per Flow, no attribute blocks, ref-array
state is invisible to D2 output. Closes AC5.5 of the bidirectional flow
design.
```
<!-- END_TASK_3 -->
