# Extend `compare_layout.py` with Full-Geometry Checks

Date: 2026-04-23
Target: `scripts/compare_layout.py`

## Goal

Extend the existing TALA-vs-saved-layout validator from block centers
only to full diagram geometry. Three new checks, each answering a
specific correctness question the current script silently skips:

1. **Container bounds** — does the browser-stored `groupBounds` rect
   match TALA's container rect in the SVG?
2. **Edge endpoints** — does each flow's latch position match the
   start/end vertex of the TALA edge polyline?
3. **Bend points** — do the flow's stored handle positions match the
   TALA polyline's interior vertices, in order?

Run the enhanced script against `server/examples/java_web_app.json`.
The *expected* outcome — given the multi-bend flow-routing problem
documented in
`docs/design-plans/2026-04-23-multi-bend-flow-routing.md` — is that
block and container checks pass, and bend-point checks fail on flows
TALA routed with three or more bends. That output is itself the
evidence base for whether to invest in the `PolyLine` face.

## Non-Goals

- No change to how `compare_layout.py` is invoked (`--svg-only`,
  reference-layout, and import-and-wait modes stay as-is).
- No change to the block-center path. The current 0.0-px match is
  correct; preserve it.
- No face classification (N/S/E/W). The latch-vs-SVG-endpoint check
  is a pure coordinate comparison; the saved latch position already
  encodes the face the browser picked.
- No bend-count reconciliation strategy. If TALA's polyline has N
  interior vertices and the flow has M handles with M ≠ N, report it
  as a structural mismatch (expected under the current
  `pickPolylineElbow` reduction) and move on. Don't try to match
  one-to-many.
- No fix for the underlying multi-bend compression. That is the
  separate design doc's concern.

## Approach

One script, three new check functions, one aggregated report.
Existing block-center code stays put; new checks run after it on the
same parsed SVG + layout inputs. Summary counts per check; detailed
per-element table when `--verbose`; structured per-check blocks in
`--json` output.

`scripts/compare_layout.py` stays stdlib-only; all parsing is string-
and-XML based, same as today.

---

## Step 1 — Container-bounds check

**What it validates**

For every container GUID in the saved `groupBounds`, the TALA SVG's
outer rect for that container should equal the stored bounds.

The diagram JSON stores `groupBounds[guid] = [xMin, yMin, xMax, yMax]`.
The SVG stores the rect inside the container's `<g class=b64(guid)>`
as `<rect x y width height>`. Convert SVG rect to
`[x, y, x+w, y+h]` and compare against `groupBounds[guid]`.

Verified on `java_web_app.json`: all six containers match at Δ = 0
pixels today. The check is a regression guard.

**Changes**

- Add `parse_svg_container_bounds(svg_text)` that returns
  `dict[guid, (xMin, yMin, xMax, yMax)]` by locating every
  `<g class=b64(GUID-path)>` whose leaf GUID ALSO appears as a
  non-leaf segment in some other path (i.e. is a container), and
  reading the rect in its direct `<g class="shape">` child.
- Add `load_group_bounds(data_dir, diagram_id)` that returns the
  `groupBounds` dict from the saved diagram JSON.
- Add `compare_container_bounds(svg_bounds, saved_bounds, tolerance)`
  returning a per-GUID diff record with
  `{match, mismatch, svg_only, saved_only}` categories, mirroring the
  shape of `compare_layouts`.
- Wire into the main flow after block-center comparison; report under
  a `Container bounds` heading.

**Acceptance**

- Against `java_web_app.json`: the six containers report as matches
  at the default 2.0-px tolerance.
- A deliberate 10-px perturbation to one `groupBounds` entry produces
  a mismatch entry with the expected delta.
- `--json` output has a `container_bounds` top-level key with the
  same `match / mismatch / svg_only / saved_only / summary` shape as
  the existing block result.

---

## Step 2 — Edge-endpoint check

**What it validates**

For every data flow in the diagram JSON, the saved layout position of
each latch (`flow.node1`, `flow.node2`) should equal the start/end
vertex of the corresponding TALA edge polyline.

A latch GUID is stored on the flow's `node1` / `node2` fields. The
layout dict contains `layout[latch_guid] = [cx, cy]`. The SVG edge is
found by decoding `<g class="b64">` with `-&gt;` in the decoded path
— match on the unordered endpoint-block-GUID pair plus the trailing
`[N]` index.

Direction normalization: the schema canonicalises `str(node1) <
str(node2)`, but TALA's edge writes the direction as declared. Take
both endpoints as an unordered set and assign source/target after the
match by proximity (SVG start closer to which latch).

**Changes**

- Add `parse_svg_edges(svg_text)` returning a list of records:
  `{src_guid, tgt_guid, index, start_xy, end_xy, points}`
  — `src_guid` / `tgt_guid` are the leaf GUIDs of each path side;
  `index` is the `[N]` suffix. The full `points` array is carried for
  Step 3.
- Add `collect_flow_edges(diagram_json)` returning a list of
  `{flow_guid, node1_latch_guid, node2_latch_guid,
    node1_block_guid, node2_block_guid, handles}`. Walk `objects` to
  resolve each flow's latch instances back to their parent blocks via
  the latch's linked anchor — this requires reading each latch's
  `anchor` reference out of the native objects list.
- Add `match_flow_to_edge(flow, svg_edges)` that matches on the
  unordered GUID pair. When multiple edges match (parallel flows),
  disambiguate using the `[N]` index.
- Add `compare_edge_endpoints(matched_pairs, saved_layout, tolerance)`
  that compares each latch's saved `(cx, cy)` to the nearer of the
  SVG edge's start/end point. Report Δ per latch.
- Wire into main; report under an `Edge endpoints` heading.

**Acceptance**

- Against `java_web_app.json`: report one row per flow endpoint
  (2 rows per flow), numeric Δ per axis.
- Unmatched flows (no SVG edge) and orphaned SVG edges (no flow)
  are surfaced in `edge_only` / `flow_only` lists — they indicate
  either parse bugs or in-progress state.
- `--json` output has an `edge_endpoints` top-level key.

---

## Step 3 — Bend-point check

**What it validates**

For every data flow, the TALA polyline's interior vertices — the
bends between start and end — should correspond 1:1 to the flow's
`handles[]` array, in order, with matching `(cx, cy)` positions.

Under today's code this check is *expected to fail* on any flow TALA
routed with three or more bends, because `pickPolylineElbow` collapses
N interior vertices to `handles[0]` and drops the rest. The failures
are the desired signal.

**SVG polyline extraction**

TALA emits bends as `L … S Sx Sy Px Py` triplets — a 5-px corner
fillet between two straight segments. The logical bend point is the
`(Px, Py)` coordinate following each `S` command; the `(Sx, Sy)`
control point is part of the Bézier curve and should be discarded.

Strategy: tokenise the path `d` attribute with command letters
preserved (not just numbers like today), walk the token stream, and
emit `(Px, Py)` for every `S` (or `C`, if present) endpoint, plus the
leading `M` and trailing `L`. Flatten near-colinear vertices using the
same `collinearEpsilon = 0.5` tolerance that `pickPolylineElbow` uses
(`NewAutoLayoutEngine.ts:690`) so the check agrees with what the
engine considers a "real" bend.

**Changes**

- Add `extract_polyline_bends(d_attr)` returning the list of
  `(cx, cy)` vertices after S-curve flattening and near-colinear
  elision. Drop the first and last vertex (those are the endpoints,
  covered by Step 2).
- Add `compare_bend_points(flow, svg_bends, saved_layout, tolerance)`:
  - `svg_bends` is the list from `extract_polyline_bends`.
  - `flow_bends` is `[saved_layout[h] for h in flow.handles]`.
  - Compare positionally by index. When lengths differ, report a
    `bend_count_mismatch` with both counts; still compare the prefix
    that does exist.
- Wire into main; report under a `Bend points` heading with per-flow
  rows and a summary of how many flows failed because of position
  delta vs. count mismatch.

**Acceptance**

- Against `java_web_app.json`: report per-flow bend counts
  `svg: N, saved: M` and position deltas for the overlapping prefix.
  Flows where `N > M` (typically `M = 1` from `pickPolylineElbow`
  and `N = 2+` from TALA) are flagged as `bend_count_mismatch` —
  this is the signal documented in
  `2026-04-23-multi-bend-flow-routing.md`.
- A deliberate 10-px perturbation to one handle's `layout` entry
  produces a position-delta mismatch.
- `--json` output has a `bend_points` top-level key with per-flow
  records: `{flow_guid, svg_count, saved_count, deltas, verdict}`.

---

## Reporting

Extend `print_report` to emit four sections in order: existing
**Block centers**, then **Container bounds**, **Edge endpoints**,
**Bend points**. Each section prints its own pass/fail line. The
script's exit code becomes `0` only when every section passes at the
given tolerance; any mismatch in any section returns `2`.

Add a `--verbose` flag that prints the per-row tables. Without it,
each section prints only summary counts plus its pass/fail verdict —
keeps routine runs terse.

Update the top-of-file docstring to describe the four-check model and
list the new `--verbose` flag.

---

## Test Plan

Manual + scripted:

1. **Baseline.** Run `python3 scripts/compare_layout.py --svg-only
   1fd76e36-5c03-4abd-93df-df14267a0e4b` and confirm:
   - Block centers: PASS (14 matches, Δ = 0).
   - Container bounds: PASS (6 matches).
   - Edge endpoints: PASS (all flow latches align within tolerance).
   - Bend points: FAIL on multi-bend flows — expected signal.

2. **Perturbation.** Edit a copy of the diagram JSON, shift one
   `groupBounds` entry by 10 px, one latch in `layout` by 10 px, and
   one handle in `layout` by 10 px. Re-run and confirm each
   perturbation surfaces in the matching section.

3. **JSON mode.** Run with `--json` and confirm the four top-level
   keys are present with the documented shapes.

4. **Empty-handle flow.** Construct a minimal diagram with a single
   flow whose `handles` array is empty. Run the script; bend-point
   check reports `svg_count: 0, saved_count: 0` as a match for that
   flow (no bends to compare).

5. **Parallel flows.** Add a second flow between the same node pair
   to the example and re-run. Confirm the `[N]` index disambiguation
   matches them correctly.

No new unit tests for the script itself (single-file, stdlib-only,
manual-run tooling). If we later move it into a package, add
pytest-style tests then.

---

## Sequencing

Step 1 and Step 2 are independent; either can ship first. Step 3
depends on Step 2's edge-matching infrastructure. Recommended order:

1. Step 1 (container bounds) — smallest, pure regression guard.
2. Step 2 (edge endpoints) — builds the flow-to-SVG-edge match
   machinery.
3. Step 3 (bend points) — reuses Step 2's match, adds polyline
   parsing.

Each step is an independent commit. Each commit updates the script
and the top-of-file docstring; no other files change.

## Related

- `docs/design-plans/2026-04-23-multi-bend-flow-routing.md` — the
  problem this script measures.
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/D2Bridge.ts` —
  reference implementation of SVG parsing (`parseTalaSvg`,
  `TalaEdge`). The script should stay aligned with its tokenisation
  rules.
- `src/assets/scripts/OpenChart/DiagramView/DiagramLayoutEngine/NewAutoLayoutEngine/NewAutoLayoutEngine.ts:672-699` —
  `pickPolylineElbow` and the `collinearEpsilon` constant the bend
  extractor should match.
