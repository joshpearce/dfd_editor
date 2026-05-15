# NativeLayoutEngine → TALA parity: open-ended improvement loop

**Date:** 2026-05-15 · **Type:** open-ended optimization loop (no fixed end
state) · **Driver fixtures:** `server/examples/java-app-parity-input-no-layout.json`
(harness input) + `server/examples/java-app-parity-reference-tala.json` (TALA oracle)

## Goal

Drive `NativeLayoutEngine` toward **layout parity with the TALA engine** by
repeatedly: (1) laying the fixture out with TALA via the parity harness to get
a reference position map, (2) laying the *same* fixture out with the native
engine via the harness, (3) scoring how far native is from TALA, (4) making
one small, principled change to the native layout algorithm, (5) re-measuring,
(6) keeping or reverting the change. Loop until the score plateaus or hits the
parity threshold.

This is a follow-on to
`docs/implementation-plans/2026-05-15-native-layout-engine/plan.md` (the
switchable-engine scaffold + harness). Read that first — it defines the
harness, the resolver, and the confinement invariants this loop must preserve.

## The single most important fact: where the code changes go

`NativeLayoutEngine` is intentionally thin and HTTP-free. Its `run()`
serializes the canvas, calls the injected `nativeLayout` callback, and applies
the returned `PositionMap` via `ManualLayoutEngine`. The callback POSTs to the
**server route `POST /api/native-layout`** (`server/editor_api.py`), which
today ignores the body and returns `{"layout": {}}` (⇒ empty map ⇒ provable
no-op).

**Therefore the layout algorithm is written server-side, in Python.** The
iteration surface is the `native_layout()` route — or, preferably, a new
`server/native_layout.py` module it delegates to. Do **not** move layout math
into `NativeLayoutEngine.ts`; that would violate the OpenChart HTTP-free
boundary and the confinement guard tests. The TS engine and resolver should
not need to change at all during this loop.

Request body the route receives (sent by the harness's `nativeLayout`
callback, shape `NativeLayoutDocument`):

```jsonc
{ "objects": [ /* DiagramObjectExport[] — the serialized canvas:
                   blocks, groups, lines, anchors, latches, handles,
                   each with an `instance` id + structural fields */ ],
  "layout":  { /* PositionMap — current positions, may be empty/default */ } }
```

Response contract (unchanged): `{ "layout": { "<instance>": [x, y], ... } }`.
`ManualLayoutEngine` moves every object whose `instance` appears in the map
(blocks via `moveTo(center)`; it does **not** call `setBounds`, so group
*sizing* the way TALA does it is out of reach via this path — see "Known
structural gaps").

## Phase 0 — Fixtures (already prepared)

Two committed fixtures in `server/examples/` collapse what was originally a
format-conversion + TALA-capture prerequisite. Both were produced from the
most recent TALA-laid-out diagram persisted under `server/data/` (a native
`dfd_v1` `DiagramViewExport` — exactly the shape the harness's `diagram`
field consumes, since `loadExistingFile` treats a stored doc as a
`DiagramViewExport` through a pass-through preprocessor):

- **`server/examples/java-app-parity-reference-tala.json`** — the TALA
  reference / parity oracle. The full export *with* TALA's `layout` (14
  positioned instances), `groupBounds` (6), and `camera`. This is "what TALA
  can do"; its `layout`/`groupBounds` are the fixed comparison target. It is
  byte-for-byte the diagram TALA produced.
- **`server/examples/java-app-parity-input-no-layout.json`** — the harness
  input. The *same* diagram with `layout` **and** `groupBounds` removed
  (both are TALA-derived layout outputs); `objects` are byte-identical to the
  reference. Keys: `schema, theme, objects, camera, name`. The strip is
  essential: if the input retained either key, `new DiagramViewFile(factory,
  doc)` would seed the canvas at TALA's positions/bounds and the
  currently-no-op native engine would echo TALA's layout back — a false
  parity signal. With them removed, native's output is a true measurement.

Consequences: no `{nodes,edges,data_items}`→minimal conversion is needed, and
**`d2`/TALA is not required to have a target** — the reference is already
captured. (`d2`+TALA is only needed if you later want to *regenerate* or
re-validate the reference by running the harness with `engine:"tala"` on the
input; optional.)

**Acceptance for Phase 0:** `curl -XPOST localhost:5050/api/layout-harness -d
'{"diagram": <contents of java-app-parity-input-no-layout.json>,
"engine":"native"}'` returns 200 with a `document` (native is still a no-op,
so `document.layout` ≈ the canvas's default/seeded positions). A 502 means a
bad request or a broken server, not a layout signal — read the Flask logs.

## Phase 1 — Recon the `objects` serialization shape

The TALA reference is already captured (Phase 0), so the only remaining
prerequisite is understanding the serialization the algorithm must consume.

1. Read `objects` directly from
   `server/examples/java-app-parity-input-no-layout.json` (no harness run or
   debug logging needed — `objects` there is byte-identical to the
   reference's). Learn the real `DiagramObjectExport` schema: block size
   fields, group child lists, line/anchor/latch/handle linkage, parent ids,
   and which `instance` ids appear as keys in the reference's `layout`
   (those are the objects the position map must place).
2. Design the algorithm against that *actual* schema, not assumptions. The
   reference's `layout` map (14 entries) keyed by `instance` is precisely the
   output contract `/api/native-layout` must learn to reproduce.

## Phase 2 — The scoring script

Write `tools/parity-loop/score.py` (a tool, not shipped code):

- Input: a native `document.layout` (from a harness run on
  `server/examples/java-app-parity-input-no-layout.json`) and the reference
  `layout` read from `server/examples/java-app-parity-reference-tala.json`.
- **Align before comparing.** TALA and native pick different origins/scales;
  parity is about *relative structure*, not absolute coordinates. Subtract
  each set's centroid; optionally solve a best-fit uniform scale (and, later,
  rotation/reflection — Procrustes). Compare only object `instance`s present
  in both maps.
- Output a single scalar to minimize (primary metric: **mean per-node
  Euclidean error after alignment**) plus diagnostics: median error, max
  error, worst-N offending `instance`s, and the count of nodes within ε. The
  worst-N list is what guides the next code change.
- v1 scores **node positions** only. Add group-bounds and edge-bend-point
  terms as later milestones (see Known structural gaps).
- Print the metric in a stable `METRIC mean_node_err=<float> ...` line so the
  loop (or the `autoresearch` skill) can parse it.

## Phase 3 — The improvement loop

Open-ended. Each iteration:

1. **Hypothesize** one small, *principled* change toward how TALA lays out
   hierarchical graphs (rough TALA shape: layered/hierarchical ranking →
   per-rank ordering to reduce crossings → x/y coordinate assignment →
   orthogonal edge routing, with containers/trust-boundaries as nested
   sub-layouts). Pick the change from the scoring diagnostics (the worst-N
   nodes tell you what's wrong: whole-graph rotation, rank spacing, sibling
   ordering, container nesting, etc.).
2. **Implement** the minimal change in `server/native_layout.py` (or the
   route). Keep it a general algorithm — **never hard-code this fixture's
   node ids or coordinates** (that is memorization, not parity).
3. **Make the change take effect** (see "Server restart procedure").
4. **Re-run** the harness with `engine:"native"` on the fixture; pass the
   returned `document.layout` to `score.py` against the cached TALA reference.
5. **Keep or revert:** if the primary metric improved, keep (commit);
   otherwise revert. Log `{iteration, change summary, metric, kept?}` to
   `tools/parity-loop/log.jsonl`.
6. **Guardrails every iteration (all must stay green):**
   - `cd server && .venv/bin/python -m pytest -q` and `npm run test:unit`
     show no *new* failures beyond the documented pre-existing ones
     (`test_mcp_tools.py` `_loopback_http`; `DfdSocketDispatcher.spec.ts`
     remote-control).
   - **Evolve the contract tests as native stops being a no-op.** Once
     `/api/native-layout` returns a non-empty map, the assertions that encode
     "native is a no-op / geometry unchanged" are *intentionally obsolete* and
     must be updated in the same commit as the behavior change:
     `server/tests/test_native_layout.py` (`{"layout":{}}` assertion), and the
     default-skipped harness integration test in
     `server/tests/test_layout_harness.py` (`engine=native ⇒ geometry
     unchanged` → `engine=native ⇒ within threshold of TALA`). The TS
     `NativeLayoutEngine.spec.ts` "empty map ⇒ unchanged" stays valid (it
     injects an empty source) — do not weaken it.
   - The confinement guard specs and the OpenChart HTTP-free boundary must
     keep passing — math stays in Python; `NativeLayoutEngine.ts`/the resolver
     are not touched.
   - **Overfitting check:** every few iterations, also score a *holdout*
     example (e.g. `aws-ecs-webapp.json`, run through the same Phase-0
     adaptation). Report both metrics. If the driver metric improves while the
     holdout regresses, the change is memorization — revert and rethink.

This loop is a natural fit for the `autoresearch` skill (a parsable `METRIC`
line, keep/revert on improvement, JSONL logging). The agent may run it under
autoresearch or as a manual loop; either way the methodology above is the
contract.

## Server restart procedure (how changes take effect)

`npm run dev:all` runs Flask as `flask --app app run --debug` → the Werkzeug
**reloader auto-restarts on any Python file save**, usually within ~1 s. So:

- **Python changes** (`server/native_layout.py`, `editor_api.py`): save, then
  **confirm the reload actually happened** before re-running the harness —
  watch the Flask pane for the reloader's restart line, or poll
  `curl -s localhost:5050/api/health` until it responds post-save. Do not
  trust "I saved it" alone.
- **Import-time errors** (syntax error, bad import in the route): the reloader
  prints the traceback and the app stays broken until the next good save. The
  agent must read the Flask log every iteration and fix forward — a harness
  call against a broken server returns 502, which is *not* a layout signal.
- **Hard-restart fallback** (use when the reloader is wedged, or to be
  certain): kill the Flask process and restart it
  (`npm run dev:flask`), or restart the whole `npm run dev:all`. Then gate on
  `curl -s localhost:5050/api/health` returning `{"status":"ok"}` before the
  next harness call.
- **TS changes need no restart.** The harness shells `npx vitest run` fresh
  each call and vitest transpiles on the fly — but per "the single most
  important fact", you should not be changing TS in this loop anyway.
- **Cadence note:** each harness call cold-starts `npx vitest` (seconds), so
  an iteration is several seconds end-to-end. Acceptable for a loop; do not
  parallelize harness calls against one server.

## Known structural gaps (set expectations / milestone the work)

- **Group sizing.** TALA emits container rectangles and the `tala` path
  applies them via `GroupFace.setBounds`. The native path applies positions
  via `ManualLayoutEngine`, which only `moveTo`s — it does not resize groups.
  Full group-bounds parity therefore cannot be reached through the position
  map alone. Milestone accordingly: **M1 = node-position parity** (achievable
  now); **M2 = group/container parity** may require extending the native
  apply path (e.g. a bounds map alongside the position map, applied by a
  small `ManualLayoutEngine` extension or a sibling engine) — treat as a
  scoped sub-plan if/when M1 plateaus, not an ad-hoc hack mid-loop.
- **Edge routing.** TALA produces multi-bend orthogonal routes (handles
  upgraded to `PolyLine`). Node parity does not imply edge parity; add an
  edge-bend term to the metric only after M1 is solid.
- **Determinism.** The algorithm must be deterministic (same input ⇒ same
  output) or the metric is noise. No unseeded randomness.

## Definition of "done enough" (stopping criteria)

There is no fixed end state; stop when any of:

- the primary metric (mean aligned node error) is below an agreed parity
  threshold on **both** the driver fixture and the holdout, **or**
- the metric plateaus for N consecutive iterations (diminishing returns),
  **or**
- a wall-clock / iteration budget is exhausted.

On stop: leave the loop artifacts under `tools/parity-loop/`, ensure all
suites are green with the contract tests updated to the new native behavior,
and write a short outcome summary (final metric, what the algorithm does,
remaining gaps — esp. M2 group bounds) into this directory as
`outcome.md`. Do not delete the harness or the `tala` key — TALA remains the
parity oracle for any future iteration.

## Guardrails summary (non-negotiable)

- Math is **server-side Python**; OpenChart stays HTTP-free; confinement guard
  specs stay green; the harness is unchanged.
- No hard-coding the driver fixture's ids/coords; validate on a holdout.
- Every kept change: full `pytest` + `test:unit` green (pre-existing failures
  excepted), with no-op-era contract tests updated in the same commit.
- Never commit anything under `server/data/`; loop artifacts live in
  `tools/parity-loop/`.
- Confirm the server actually reloaded before trusting a harness result.
