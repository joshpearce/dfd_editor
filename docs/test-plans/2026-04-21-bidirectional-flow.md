# Human Test Plan — Bidirectional Flow

Companion to `docs/implementation-plans/2026-04-21-bidirectional-flow/` and `test-requirements.md`. 36/36 ACs have automated tests; this plan covers the manual gates the automated suite cannot reach (TALA integration, end-to-end property-editor interaction, fixture importability via the live server).

## Prerequisites

- Node 22, Python 3 with `server/.venv` installed (`cd /Users/josh/code/dfd_editor/server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`).
- `d2` with the TALA plugin on `PATH` (required for Phase B). Verify: `d2 --version` then confirm TALA appears under `d2 layout`.
- Baseline gates (must be green before any manual step):
  - `cd /Users/josh/code/dfd_editor/server && .venv/bin/python -m pytest tests/ -x -q` — 98 tests pass.
  - `npm run test:unit` — 356 tests pass.
  - `npm run build` — clean.
- Launch stack before Phase A / B: `npm run dev:all` (Vite on :5173, Flask on :5050).
- Fixtures:
  - `/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp.json`
  - `/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp-with-data-items.json`
  - `/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp-with-reverse-flows.json`

## Phase A: Property-editor interactive flow (Phase 7 Task 6 step 2)

Purpose: validate the full chain DataItemRefListField → ApplicationStore.execute → ref-array mutation → DynamicLine face re-layout → canvas repaint. Covers AC4.3, AC4.4, AC4.6, and the visual side of AC3.5.

| Step | Action | Expected |
|------|--------|----------|
| A1.1 | `curl -X POST http://localhost:5050/api/diagrams/import -H 'Content-Type: application/json' -d @/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp-with-data-items.json`. Note returned `id`. | HTTP 201, `{"id": "<uuid>"}`. |
| A1.2 | In the browser (http://localhost:5173) open the file list and load the new diagram. | Diagram renders with blocks, groups, and flows visible. |
| A1.3 | Click a flow edge to select it. | Property pane shows flow fields. |
| A1.4 | Inspect the "Data items" section. | Two labelled subsections render, e.g. "Data from Browser to ALB" and "Data from ALB to Browser" — each shows a chip list (possibly empty) and a dropdown. |
| A2.1 | In one direction section (call it "A→B") pick any unselected data item from the dropdown. | A chip with that data-item name appears; the dropdown no longer lists it (AC4.5). The arrowhead at node B (the `node2` end when node1 < node2) appears or persists within one render frame. |
| A2.2 | Repeat once more with a second data item in the same direction. | Second chip appears; dropdown shrinks by one more. Arrowhead at node B remains. |
| A3.1 | Click the × delete button on one chip. | Chip disappears. That data item returns to the dropdown's options. Arrowhead state: if array now empty AND opposite direction is also empty, arrowhead at that end disappears; otherwise remains. |
| A3.2 | Delete the remaining chip in that direction so the array is empty. | Array empty. If the opposite direction's array is also empty, the line becomes a plain line with no arrowheads. If opposite has refs, only the arrowhead at that side remains. |
| A4.1 | Open DevTools → Performance. Start recording. | — |
| A4.2 | Add one ref via dropdown in one direction, then delete one ref in the other direction. | Both mutations complete. |
| A4.3 | Stop recording. Inspect the flame chart. | Each mutation triggers a scoped re-layout of the selected flow only — no frame showing a full DiagramView rebuild. Non-selected blocks/groups do not visually reflow. (AC3.5 visual invariant.) |
| A5.1 | With the flow still selected, note both direction labels (e.g. "Data from Browser to ALB"). | Labels present. |
| A5.2 | In the canvas, double-click the Browser block's name (or edit via property pane) and rename it to "BrowserXYZ". Commit the edit. | Block label updates. |
| A5.3 | Return attention to the still-selected flow's property pane without re-selecting. | Both direction labels update to "Data from BrowserXYZ to ALB" / "Data from ALB to BrowserXYZ" reactively (AC4.6 via RootProperty.subscribe). |
| A6.1 | Trigger save via the Save to server control, then reload the page and re-open the same diagram id. | Diagram reloads with identical chips in each direction; arrowheads match. Round-trip preserves the ref-array edits. |

## Phase B: TALA auto-layout integration (Phase 6 Task 2 — AC5.5)

Purpose: confirm bidirectional flows still produce valid TALA SVG and D2 output contains only `->` operators.

| Step | Action | Expected |
|------|--------|----------|
| B1.1 | `curl -X POST http://localhost:5050/api/diagrams/import -H 'Content-Type: application/json' -d @/Users/josh/code/dfd_editor/server/temp/aws-ecs-webapp-with-reverse-flows.json`. Capture returned id. | HTTP 201 with id. |
| B1.2 | Open DevTools → Network tab. In the browser, load the newly imported diagram. | `POST /api/layout` fires (because stored file has no `layout`). |
| B1.3 | In the Network panel, open the `/api/layout` request. Inspect the JSON body's `source` field. | Response is 200 (not 502), with a `svg` field. Request body contains only `->` edge operators; no occurrences of `<-`, `<->`, or `--`. |
| B1.4 | Return to the canvas view and inspect the rendered diagram. | NewAutoLayoutEngine parses SVG without console errors. Every bidirectional flow in this fixture has arrowheads at both ends (our renderer — not TALA's). Anchor placement is visually comparable in quality to unidirectional fixtures. |
| B1.5 | Reload the page and re-open the same diagram. | Second open skips auto-layout (no `/api/layout` request) because the result was PUT back. Positions are stable across reloads. |

## Phase C: Fixture importability (AC7.1)

Purpose: prove every `server/temp/*.json` fixture conforms to the new shape.

| Step | Action | Expected |
|------|--------|----------|
| C1.1 | `cd /Users/josh/code/dfd_editor/server && .venv/bin/python -m pytest tests/ -x -q` | 98 tests pass (synthetic coverage gate). |
| C1.2 | Ensure Flask is running: `npm run dev:flask` (or `dev:all`). | Server listens on :5050. |
| C1.3 | For each file in `/Users/josh/code/dfd_editor/server/temp/*.json`, run `curl -X POST http://localhost:5050/api/diagrams/import -H 'Content-Type: application/json' -d @<path>`. | Every request returns HTTP 201 with `{"id": "<uuid>"}`. No 400 validation errors. |
| C1.4 | After all imports, open each newly imported diagram in the browser. | Each diagram renders without console errors; flows show the expected arrow shapes based on their ref-array populations. |

## End-to-End: Create-edit-save-reload (cross-cutting smoke)

Purpose: validate AC1/AC2/AC3/AC4/AC5 jointly through the normal user path.

| Step | Action | Expected |
|------|--------|----------|
| E1 | From the file browser, create a new diagram. Add two blocks and a flow between them. | Flow renders as a plain line (both ref arrays empty — AC3.4). |
| E2 | Add one data item to the canvas. Select the flow. In one direction section, add the data item via the dropdown. | Chip appears; arrowhead appears only at the `node2` end (canonical order) — AC3.1. |
| E3 | In the opposite direction, add the same data item again. | Second chip; arrowheads appear at both ends — AC3.3. |
| E4 | Save to server. Reload the diagram. | Both chips reappear in the correct directions; arrowheads at both ends. Ref-array contents preserved (AC2.2). |
| E5 | Rename one endpoint block. | Both direction labels in the flow's property pane update reactively (AC4.6). |
| E6 | Open DevTools console while performing steps E2–E5. | No errors or warnings related to DataFlow / Flow / DataItemRefListField. |

## Regression: Old-shape rejection (AC7.3 smoke beyond unit)

| Step | Action | Expected |
|------|--------|----------|
| R1 | `curl -X POST http://localhost:5050/api/diagrams/import -H 'Content-Type: application/json' -d '{"nodes":[{"type":"process","guid":"11111111-1111-1111-1111-111111111111","properties":{"name":"P"}},{"type":"external_entity","guid":"22222222-2222-2222-2222-222222222222","properties":{"name":"E"}}],"data_flows":[{"guid":"33333333-3333-3333-3333-333333333333","source":"11111111-1111-1111-1111-111111111111","target":"22222222-2222-2222-2222-222222222222","properties":{"name":"old","data_item_refs":[]}}]}'` | HTTP 400 with a structured `details` list mentioning the extra keys `source`/`target`/`data_item_refs`. No diagram is persisted. |

## Traceability (manual gates only)

| Acceptance Criterion | Manual Step |
|----------------------|-------------|
| AC2.2 end-to-end | E4 |
| AC3.1–AC3.4 smoke | E2/E3 |
| AC3.5 perf/visual | A4 |
| AC4.1 | A1.4 |
| AC4.2 | A1.4 |
| AC4.3 | A2 |
| AC4.4 | A3 |
| AC4.5 | A2.1 |
| AC4.6 | A5 |
| AC5.5 TALA integration | B1 |
| AC7.1 live import | C1 |
| AC7.3 HTTP smoke | R1 |
