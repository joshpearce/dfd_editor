#!/usr/bin/env python3
"""compare_layout.py

Import a DFD minimal-format file into the running editor, wait for TALA
auto-layout to complete, then compare the browser's stored geometry
against the TALA SVG on four independent dimensions:

  1. Block centers   — SVG rect center vs. saved `layout[guid]` (cx, cy).
  2. Container bounds — SVG container rect vs. saved `groupBounds[guid]`
                         (xMin, yMin, xMax, yMax).
  3. Edge endpoints  — each flow's SVG polyline start/end vertex vs.
                         the parent block's rect perimeter (using the
                         same `pointToBoxDistance` check the engine's
                         rebind pass uses).  Expect a 2–6 px consistent
                         offset from TALA's arrow-tip clearance; use
                         `--tolerance 6` for a clean PASS.
  4. Bend points     — each flow's interior handle positions vs. the
                         TALA polyline's interior vertices (S-endpoint
                         per fillet, with near-colinear vertices
                         dropped).  Counts are compared first;
                         mismatches are reported as
                         `bend_count_mismatch` — the multi-bend signal.

Sections 1–3 should pass at a generous tolerance today. Section 4 is
expected to fail on any flow TALA routed with two or more bends that
the engine collapsed to a single handle: `significantInteriorVertices`
keeps only one `handles[i]` per line, so multi-bend routes lose their
interior vertices. The failing rows are the motivating signal for the
`PolyLine`-face design work captured in
`docs/design-plans/2026-04-23-multi-bend-flow-routing.md`.

Usage:
    # Import, display in browser, wait for auto-layout, compare:
    python3 scripts/compare_layout.py server/examples/java_web_app.json

    # Compare against a specific reference diagram's layout instead of
    # waiting for the browser to save the freshly imported one:
    python3 scripts/compare_layout.py server/examples/java_web_app.json \\
        --reference 1fd76e36-5c03-4abd-93df-df14267a0e4b

    # Just compare latest-layout.svg against an existing diagram layout
    # (no import, no browser required):
    python3 scripts/compare_layout.py \\
        --svg-only 1fd76e36-5c03-4abd-93df-df14267a0e4b

Options:
    --flask-url URL     Flask server base URL (default: http://127.0.0.1:5050)
    --data-dir DIR      Path to server/data directory
                        (default: <repo-root>/server/data)
    --reference ID      Diagram ID whose saved layout is the reference.
                        If omitted, uses the freshly imported diagram after
                        the browser saves its auto-layout.
    --svg-only ID       Skip import. Compare latest-layout.svg against the
                        named diagram's layout key. Implies --no-display.
    --no-display        Import the diagram but do not broadcast a display
                        event (useful when the browser is already showing it).
    --timeout SECS      Seconds to wait for the browser to complete layout
                        and save (default: 60).
    --tolerance PX      Maximum pixel delta per axis considered a "match"
                        (default: 2.0).
    --verbose           Print per-row tables for every section. Without
                        this flag each section prints only summary counts
                        plus its pass/fail verdict.
    --json              Emit machine-readable JSON instead of human output.
"""

import argparse
import base64
import json
import math
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Repository root and defaults
# ---------------------------------------------------------------------------

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT  = _SCRIPT_DIR.parent
_DATA_DIR   = _REPO_ROOT / "server" / "data"
_FLASK_URL  = "http://127.0.0.1:5050"


# ---------------------------------------------------------------------------
# HTTP helpers (stdlib only — no requests dependency)
# ---------------------------------------------------------------------------

def _http_post(url: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _http_get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read())


def check_flask(flask_url: str) -> None:
    try:
        _http_get(f"{flask_url}/api/health")
    except urllib.error.URLError as exc:
        print(f"ERROR: Flask not reachable at {flask_url}  ({exc})", file=sys.stderr)
        print("Run `npm run dev:flask` (or `npm run dev:all`) first.", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Diagram operations
# ---------------------------------------------------------------------------

def import_diagram(flask_url: str, minimal_doc: dict) -> str:
    """POST a minimal-format doc to Flask and return the new diagram ID."""
    result = _http_post(f"{flask_url}/api/diagrams/import", minimal_doc)
    return result["id"]


def broadcast_display(flask_url: str, diagram_id: str) -> bool:
    """Broadcast a display event so the browser loads the diagram."""
    try:
        result = _http_post(
            f"{flask_url}/api/internal/broadcast",
            {"type": "display", "payload": {"id": diagram_id}},
        )
        return result.get("ok", False)
    except Exception as exc:
        print(f"  WARNING: broadcast failed: {exc}", file=sys.stderr)
        return False


def load_diagram_layout(data_dir: Path, diagram_id: str) -> dict[str, list[float]] | None:
    """Return the `layout` key from a saved diagram file, or None if absent."""
    path = data_dir / f"{diagram_id}.json"
    try:
        data = json.loads(path.read_text())
        layout = data.get("layout")
        if layout:
            return layout
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return None


def load_group_bounds(
    data_dir: Path, diagram_id: str
) -> dict[str, list[float]] | None:
    """Return the `groupBounds` key from a saved diagram file, or None if absent.

    `groupBounds[guid]` is `[xMin, yMin, xMax, yMax]`.  Containers with no
    user-set bounds are absent from the map; auto-sized groups land in it
    after the first save.
    """
    path = data_dir / f"{diagram_id}.json"
    try:
        data = json.loads(path.read_text())
        bounds = data.get("groupBounds")
        if bounds:
            return bounds
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return None


# ---------------------------------------------------------------------------
# SVG position parsing (mirrors D2Bridge.parseTalaSvg logic)
# ---------------------------------------------------------------------------

_GUID_SEG = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_GUID_PATH_RE = __import__("re").compile(rf"^{_GUID_SEG}(\.{_GUID_SEG})*$")
_B64_RE       = __import__("re").compile(r"^[A-Za-z0-9+/]+=*$")
_CDATA_RE     = __import__("re").compile(r"<!\[CDATA\[.*?\]\]>", __import__("re").DOTALL)


def _local_tag(elem: ET.Element) -> str:
    t = elem.tag
    return t.split("}", 1)[1] if "}" in t else t


def _rect_in_shape(g_elem: ET.Element) -> tuple[float, float, float, float] | None:
    """Return (x, y, w, h) from the first <rect> in a direct <g class='shape'> child."""
    for child in g_elem:
        if _local_tag(child) == "g" and child.get("class") == "shape":
            for gc in child:
                if _local_tag(gc) == "rect":
                    try:
                        x = float(gc.get("x", "nan"))
                        y = float(gc.get("y", "nan"))
                        w = float(gc.get("width",  "nan"))
                        h = float(gc.get("height", "nan"))
                    except (TypeError, ValueError):
                        continue
                    if any(math.isnan(v) for v in (x, y, w, h)):
                        continue
                    return x, y, w, h
    return None


def parse_svg_positions(svg_text: str) -> dict[str, dict[str, Any]]:
    """Parse a TALA D2 SVG and extract leaf-GUID → position info.

    Returns a dict keyed by leaf GUID (the last segment of the D2 path).
    Each value has:
        d2_path  — full D2 path (e.g. "parent-guid.child-guid")
        cx, cy   — center coordinates (matches the engine's placeBlock formula)
        x, y     — top-left from the SVG rect
        w, h     — dimensions from the SVG rect
    """
    import re

    # ElementTree cannot handle CDATA sections; replace them with a comment.
    svg_clean = _CDATA_RE.sub("<!-- cdata removed -->", svg_text)

    try:
        root = ET.fromstring(svg_clean)
    except ET.ParseError as exc:
        raise ValueError(f"Failed to parse SVG: {exc}") from exc

    seen_d2_paths: set[str] = set()
    positions: dict[str, dict[str, Any]] = {}

    for elem in root.iter():
        if _local_tag(elem) != "g":
            continue
        cls = elem.get("class", "")
        if not cls or not _B64_RE.match(cls):
            continue
        try:
            d2_path = base64.b64decode(cls).decode("utf-8")
        except Exception:
            continue
        if not _GUID_PATH_RE.match(d2_path):
            continue
        if d2_path in seen_d2_paths:
            continue
        seen_d2_paths.add(d2_path)

        dims = _rect_in_shape(elem)
        if dims is None:
            continue
        x, y, w, h = dims
        leaf_guid = d2_path.rsplit(".", 1)[-1]
        positions[leaf_guid] = {
            "d2_path": d2_path,
            "cx": x + w / 2,
            "cy": y + h / 2,
            "x": x, "y": y, "w": w, "h": h,
        }

    return positions


def parse_svg_container_bounds(
    svg_text: str,
) -> dict[str, tuple[float, float, float, float]]:
    """Extract `(xMin, yMin, xMax, yMax)` for every container in the TALA SVG.

    A container is any node whose leaf GUID also appears as a non-leaf
    segment of some other node's decoded D2 path.  Top-level blocks that
    have no nested children are *not* containers and are excluded.  The
    returned rect is the container's outer bounding box, ready to compare
    against the saved `groupBounds` entry.
    """
    positions = parse_svg_positions(svg_text)

    container_leaves: set[str] = set()
    for info in positions.values():
        parts = info["d2_path"].split(".")
        if len(parts) > 1:
            for segment in parts[:-1]:  # every non-leaf segment is a container
                container_leaves.add(segment)

    bounds: dict[str, tuple[float, float, float, float]] = {}
    for leaf, info in positions.items():
        if leaf not in container_leaves:
            continue
        x, y, w, h = info["x"], info["y"], info["w"], info["h"]
        bounds[leaf] = (x, y, x + w, y + h)
    return bounds


# ---------------------------------------------------------------------------
# SVG edge parsing (mirrors D2Bridge.parseTalaSvg edge logic)
# ---------------------------------------------------------------------------

# UUID with optional "[N]" index suffix, used to read `(src -> tgt)[N]`.
_INDEX_RE = __import__("re").compile(r"\[(\d+)\]\s*$")
_GUID_ONLY_RE = __import__("re").compile(_GUID_SEG)
# Path command letter + coordinate pair tokenizer (see extract_polyline_bends).
_PATH_TOKEN_RE = __import__("re").compile(
    r"([MmLlHhVvCcSsQqTtAaZz])|([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)"
)


def _parse_edge_spec(decoded: str) -> dict[str, Any] | None:
    """Extract src/tgt leaf GUIDs and trailing `[N]` index from a decoded
    D2 edge class.

    D2 edge classes take several shapes depending on the edge's enclosing
    scope: `(SRC -> TGT)[N]`, `scope.(SRC -> TGT)[N]`, or a bare
    `SRC -> TGT[N]`.  In every form `SRC` and `TGT` are one or more
    dot-separated UUID segments.  The *leaf* GUID (last segment) is what
    the flow's latch parent block resolves to, so those are what we
    return.
    """
    s = decoded.replace("&gt;", ">").replace("&lt;", "<")
    arrow = s.rfind("->")
    if arrow == -1:
        return None
    left  = s[:arrow]
    right = s[arrow + 2:]

    m = _INDEX_RE.search(right)
    index = int(m.group(1)) if m else 0
    if m:
        right = right[:m.start()]

    left_guids  = _GUID_ONLY_RE.findall(left)
    right_guids = _GUID_ONLY_RE.findall(right)
    if not left_guids or not right_guids:
        return None
    return {
        "src_leaf": left_guids[-1],
        "tgt_leaf": right_guids[-1],
        "index":    index,
    }


def _tokenize_path_points(d_attr: str) -> list[tuple[float, float]]:
    """Tokenize every numeric coordinate pair in an SVG `d` string and
    return them as `(x, y)` points in source order.

    Matches the engine's D2Bridge.parseTalaSvg behaviour (see
    `parseTalaSvg` — it extracts every numeric pair and treats them as
    polyline vertices, including Bézier control points).  Used here only
    to locate the edge's start/end.
    """
    d_stripped = __import__("re").sub(r"[Zz]\s*$", "", d_attr)
    nums = __import__("re").findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", d_stripped)
    pts: list[tuple[float, float]] = []
    for i in range(0, len(nums) - 1, 2):
        try:
            pts.append((float(nums[i]), float(nums[i + 1])))
        except ValueError:
            continue
    return pts


def parse_svg_edges(svg_text: str) -> list[dict[str, Any]]:
    """Parse every TALA edge out of the SVG.

    Each returned record carries:

      - `src_guid` / `tgt_guid`: leaf GUIDs of the edge endpoints (as
        written in the D2 source — *not* canonicalised by `<`-ordering,
        see plan Step 2).
      - `index`: the `[N]` suffix so parallel edges between the same
        pair can be disambiguated.
      - `start_xy` / `end_xy`: first and last `(x, y)` in the path's `d`.
      - `points`: the full numeric-pair list from `d`, carried forward
        for Step 3's bend comparison.
      - `d`: raw `d` attribute so downstream code can re-parse with
        command letters preserved.
    """
    svg_clean = _CDATA_RE.sub("<!-- cdata removed -->", svg_text)
    try:
        root = ET.fromstring(svg_clean)
    except ET.ParseError as exc:
        raise ValueError(f"Failed to parse SVG: {exc}") from exc

    # Build parent map so we can find the <path class="connection"> inside
    # each base64-classed <g>.  ElementTree doesn't expose parents
    # natively; scanning every <g> whose decoded class contains "->" is
    # cheaper than walking up from each connection path.
    edges: list[dict[str, Any]] = []

    for g in root.iter():
        if _local_tag(g) != "g":
            continue
        cls = g.get("class", "")
        if not cls or not _B64_RE.match(cls):
            continue
        try:
            decoded = base64.b64decode(cls).decode("utf-8")
        except Exception:
            continue
        normalised = decoded.replace("&gt;", ">")
        if "->" not in normalised:
            continue
        spec = _parse_edge_spec(decoded)
        if spec is None:
            continue

        # Find the first descendant <path> whose class list carries
        # `connection` but not `fill-…` (arrowhead markers).
        path_elem: ET.Element | None = None
        for desc in g.iter():
            if _local_tag(desc) != "path":
                continue
            path_cls = desc.get("class", "")
            tokens = path_cls.split()
            if "connection" not in tokens:
                continue
            if any(t.startswith("fill-") for t in tokens):
                continue
            path_elem = desc
            break
        if path_elem is None:
            continue
        d = path_elem.get("d", "")
        pts = _tokenize_path_points(d)
        if len(pts) < 2:
            continue

        edges.append({
            "src_guid": spec["src_leaf"],
            "tgt_guid": spec["tgt_leaf"],
            "index":    spec["index"],
            "start_xy": pts[0],
            "end_xy":   pts[-1],
            "points":   pts,
            "d":        d,
        })
    return edges


# ---------------------------------------------------------------------------
# Diagram-side flow resolution
# ---------------------------------------------------------------------------

def load_diagram_native(data_dir: Path, diagram_id: str) -> dict | None:
    """Return the parsed native diagram JSON, or None if absent."""
    path = data_dir / f"{diagram_id}.json"
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def collect_flow_edges(diagram: dict) -> list[dict[str, Any]]:
    """Walk the native `objects` array and return one record per data flow.

    The native schema stores a flow's endpoints as latch GUIDs (node1 /
    node2).  Matching a flow to a TALA SVG edge needs the *block* GUIDs,
    since D2 connections are written between block paths.  Each latch
    belongs to an anchor (via the anchor's `latches` list), and each
    anchor is owned by a block (via the block's `anchors` map, keyed by
    the anchor's angle in degrees — `"0"` = east, `"90"` = south, ...).
    The angle is captured alongside the block GUID so the edge-endpoint
    check can derive the latch's expected perimeter position.
    """
    anchor_to_block: dict[str, tuple[str, int]] = {}  # anchor → (block, angle_deg)
    latch_to_anchor: dict[str, str] = {}
    flows: list[dict[str, Any]] = []

    for o in diagram.get("objects", []):
        obj_id = o.get("id", "")
        # Block-side: maps anchor instance → (block instance, angle).
        anchors = o.get("anchors")
        if isinstance(anchors, dict):
            block_instance = o.get("instance")
            if isinstance(block_instance, str):
                for angle_str, anchor_inst in anchors.items():
                    if isinstance(anchor_inst, str):
                        try:
                            angle = int(angle_str)
                        except (TypeError, ValueError):
                            continue
                        anchor_to_block[anchor_inst] = (block_instance, angle)
        # Anchor-side: maps every latch instance → its parent anchor.
        if "anchor" in obj_id:
            anchor_instance = o.get("instance")
            if isinstance(anchor_instance, str):
                for latch_inst in o.get("latches", []) or []:
                    if isinstance(latch_inst, str):
                        latch_to_anchor[latch_inst] = anchor_instance
        # Collect flow records; resolve to block GUIDs after the walk.
        if obj_id == "data_flow":
            flows.append({
                "flow_guid":        o.get("instance"),
                "node1_latch_guid": o.get("node1"),
                "node2_latch_guid": o.get("node2"),
                "handles":          list(o.get("handles", []) or []),
            })

    for f in flows:
        for side in ("node1", "node2"):
            latch = f[f"{side}_latch_guid"]
            a = latch_to_anchor.get(latch) if latch else None
            block, angle = anchor_to_block.get(a, (None, None)) if a else (None, None)
            f[f"{side}_block_guid"]    = block
            f[f"{side}_anchor_angle"]  = angle
    return flows


# Tolerance (px) for discarding near-colinear interior vertices — mirrors
# `COLLINEAR_EPSILON` in `NewAutoLayoutEngine.ts` so the script agrees
# with what the engine considers a "real" bend.
_COLLINEAR_EPSILON = 0.5


def extract_polyline_bends(d_attr: str) -> list[tuple[float, float]]:
    """Return the interior bend vertices of a TALA SVG `d` attribute.

    TALA draws each corner as an `L <pre-fillet> S <ctrl> <post-fillet>`
    sequence (5 px fillet between two straight segments).  The "logical"
    bend is the S command's endpoint; the pre-fillet `L` endpoint is the
    same corner approached from the other side, and the `S` control
    point is Bézier scaffolding.  The walk therefore keeps every
    command's endpoint, then drops any `L` endpoint immediately
    followed by an `S` (the pre-fillet twin), and finally trims the
    polyline's own start and end.  Remaining vertices are filtered
    against the straight line through the overall endpoints using the
    same `_COLLINEAR_EPSILON` the engine uses.

    Returns `[]` for straight edges, zero-length segments, and malformed
    input.
    """
    tokens: list[tuple[str, str | float]] = []
    for m in _PATH_TOKEN_RE.finditer(d_attr):
        if m.group(1):
            tokens.append(("cmd", m.group(1)))
        else:
            tokens.append(("num", float(m.group(2))))

    endpoints: list[tuple[str, float, float]] = []  # (cmd_upper, x, y)
    cur_cmd: str | None = None
    cx = cy = 0.0
    i = 0

    def read_nums(count: int) -> list[float] | None:
        if i + count > len(tokens):
            return None
        nums: list[float] = []
        for k in range(count):
            kind, val = tokens[i + k]
            if kind != "num":
                return None
            nums.append(val)  # type: ignore[arg-type]
        return nums

    # Fixed parameter counts per command; M/L/H/V absorb extra pairs as
    # implicit follow-ons like the SVG spec requires.
    while i < len(tokens):
        kind, val = tokens[i]
        if kind == "cmd":
            cur_cmd = val  # type: ignore[assignment]
            i += 1
            continue
        if cur_cmd is None:
            i += 1
            continue
        rel = cur_cmd.islower()
        c = cur_cmd.upper()

        if c == "Z":
            i += 1
            continue
        if c == "M":
            nums = read_nums(2)
            if nums is None: i += 1; continue
            x, y = nums
            if rel: x += cx; y += cy
            cx, cy = x, y
            endpoints.append(("M", x, y))
            i += 2
            # Subsequent pairs are implicit L (per SVG spec).
            cur_cmd = "L" if not rel else "l"
            continue
        if c == "L":
            nums = read_nums(2)
            if nums is None: i += 1; continue
            x, y = nums
            if rel: x += cx; y += cy
            cx, cy = x, y
            endpoints.append(("L", x, y))
            i += 2
            continue
        if c == "H":
            nums = read_nums(1)
            if nums is None: i += 1; continue
            x = nums[0]
            if rel: x += cx
            cx = x
            endpoints.append(("L", cx, cy))
            i += 1
            continue
        if c == "V":
            nums = read_nums(1)
            if nums is None: i += 1; continue
            y = nums[0]
            if rel: y += cy
            cy = y
            endpoints.append(("L", cx, cy))
            i += 1
            continue
        if c == "C":
            nums = read_nums(6)
            if nums is None: i += 1; continue
            ex, ey = nums[4], nums[5]
            if rel: ex += cx; ey += cy
            cx, cy = ex, ey
            endpoints.append(("S", ex, ey))  # treat as a fillet endpoint
            i += 6
            continue
        if c == "S":
            nums = read_nums(4)
            if nums is None: i += 1; continue
            ex, ey = nums[2], nums[3]
            if rel: ex += cx; ey += cy
            cx, cy = ex, ey
            endpoints.append(("S", ex, ey))
            i += 4
            continue
        if c == "Q":
            nums = read_nums(4)
            if nums is None: i += 1; continue
            ex, ey = nums[2], nums[3]
            if rel: ex += cx; ey += cy
            cx, cy = ex, ey
            endpoints.append(("S", ex, ey))
            i += 4
            continue
        if c == "T":
            nums = read_nums(2)
            if nums is None: i += 1; continue
            ex, ey = nums
            if rel: ex += cx; ey += cy
            cx, cy = ex, ey
            endpoints.append(("S", ex, ey))
            i += 2
            continue
        # Unknown command — skip.
        i += 1

    # Drop each L endpoint that is immediately followed by an S endpoint
    # (pre-fillet corner approach; the S endpoint is the post-fillet
    # twin at the same logical corner).
    filtered: list[tuple[str, float, float]] = []
    for k, ep in enumerate(endpoints):
        if ep[0] == "L" and k + 1 < len(endpoints) and endpoints[k + 1][0] == "S":
            continue
        filtered.append(ep)

    if len(filtered) < 2:
        return []

    start = (filtered[0][1],  filtered[0][2])
    end   = (filtered[-1][1], filtered[-1][2])
    interior = [(p[1], p[2]) for p in filtered[1:-1]]

    dx = end[0] - start[0]
    dy = end[1] - start[1]
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq == 0:
        return []
    epsilon_sq = _COLLINEAR_EPSILON * _COLLINEAR_EPSILON
    result: list[tuple[float, float]] = []
    for p in interior:
        cross = dx * (p[1] - start[1]) - dy * (p[0] - start[0])
        dist_sq = (cross * cross) / seg_len_sq
        if dist_sq >= epsilon_sq:
            result.append(p)
    return result


def _point_to_box(
    p:    tuple[float, float],
    rect: tuple[float, float, float, float],  # (xMin, yMin, xMax, yMax)
) -> tuple[float, float, tuple[float, float]]:
    """Return `(dx_out, dy_out, nearest_point)` for a point vs. a rect.

    `dx_out` / `dy_out` are 0 on the axis that is already inside the
    rectangle's extent, and the outward gap otherwise — a decomposition
    that surfaces per-axis drift in the report.  `nearest_point` is the
    closest point on the rectangle (equal to `p` when it lies inside).

    Mirrors `NewAutoLayoutEngine.pointToBoxDistance` (the engine's own
    edge-to-block scoring helper) so the check agrees with the
    rebind pass's definition of "on the block".
    """
    x_min, y_min, x_max, y_max = rect
    nx = min(max(p[0], x_min), x_max)
    ny = min(max(p[1], y_min), y_max)
    return (abs(p[0] - nx), abs(p[1] - ny), (nx, ny))


def match_flow_to_edge(
    flow:  dict[str, Any],
    edges: list[dict[str, Any]],
    used:  set[int],
) -> int | None:
    """Pick the SVG-edge index that best matches this flow.

    Matches on the unordered `{src_guid, tgt_guid}` pair so TALA's
    declared-direction ordering doesn't matter.  When multiple candidates
    match (parallel flows between the same node pair), prefers the
    lowest `[N]` index that hasn't been claimed yet.
    """
    b1 = flow.get("node1_block_guid")
    b2 = flow.get("node2_block_guid")
    if not b1 or not b2:
        return None
    pair = frozenset({b1, b2})
    candidates: list[tuple[int, int]] = []  # (svg_index, edges-list-position)
    for i, e in enumerate(edges):
        if i in used:
            continue
        if frozenset({e["src_guid"], e["tgt_guid"]}) == pair:
            candidates.append((e["index"], i))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][1]


# ---------------------------------------------------------------------------
# Wait for layout completion
# ---------------------------------------------------------------------------

def wait_for_layout(
    data_dir: Path,
    diagram_id: str,
    svg_mtime_before: float,
    timeout: float,
) -> tuple[str, dict[str, list[float]]]:
    """Poll until latest-layout.svg is newer AND the diagram has a layout key.

    Returns (svg_text, layout_dict).
    """
    svg_path     = data_dir / "latest-layout.svg"
    diagram_path = data_dir / f"{diagram_id}.json"
    deadline     = time.monotonic() + timeout
    dots         = 0

    print(f"  Waiting up to {timeout:.0f}s for auto-layout … ", end="", flush=True)

    while time.monotonic() < deadline:
        time.sleep(0.5)

        # Has the SVG been updated since we started?
        try:
            svg_mtime = svg_path.stat().st_mtime
        except FileNotFoundError:
            continue
        if svg_mtime <= svg_mtime_before:
            if dots % 4 == 0:
                print(".", end="", flush=True)
            dots += 1
            continue

        # Has the diagram been saved with a layout key?
        try:
            data   = json.loads(diagram_path.read_text())
            layout = data.get("layout")
            if layout:
                print(" done", flush=True)
                return svg_path.read_text(), layout
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        if dots % 4 == 0:
            print(".", end="", flush=True)
        dots += 1

    print(" TIMEOUT", flush=True)
    raise TimeoutError(
        f"Layout did not complete within {timeout}s for diagram {diagram_id!r}.\n"
        "Make sure the editor is open in the browser and TALA/D2 is installed."
    )


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def compare_layouts(
    svg_positions: dict[str, dict[str, Any]],
    saved_layout:  dict[str, list[float]],
    tolerance:     float = 2.0,
) -> dict[str, Any]:
    """Compare SVG-derived center positions to the saved layout key.

    SVG   center  = (x + w/2, y + h/2)  — mirrors placeBlock in the engine.
    Saved layout  = {guid: [cx, cy]}     — stored by the browser after layout.
    """
    all_guids = sorted(set(svg_positions) | set(saved_layout))

    match:        list[dict] = []
    mismatch:     list[dict] = []
    svg_only:     list[dict] = []
    layout_only:  list[dict] = []

    for guid in all_guids:
        in_svg    = guid in svg_positions
        in_layout = guid in saved_layout

        if in_svg and not in_layout:
            svg_only.append({"guid": guid, **svg_positions[guid]})
            continue
        if in_layout and not in_svg:
            layout_only.append({"guid": guid, "saved": saved_layout[guid]})
            continue

        svg_cx, svg_cy   = svg_positions[guid]["cx"], svg_positions[guid]["cy"]
        saved_cx, saved_cy = saved_layout[guid]

        dx  = abs(svg_cx - saved_cx)
        dy  = abs(svg_cy - saved_cy)
        max_delta = max(dx, dy)

        entry: dict = {
            "guid":      guid,
            "d2_path":   svg_positions[guid]["d2_path"],
            "svg":       [round(svg_cx, 1), round(svg_cy, 1)],
            "saved":     [saved_cx, saved_cy],
            "delta":     [round(dx, 1), round(dy, 1)],
            "max_delta": round(max_delta, 1),
        }
        (match if max_delta <= tolerance else mismatch).append(entry)

    # Pass = no mismatches on nodes present in both sets.
    # SVG-only  = containers (groups) — positioned via groupBounds, not layout key; expected.
    # Layout-only = auto-generated handles / non-block instances; expected.
    passed = len(mismatch) == 0
    return {
        "pass":        passed,
        "tolerance":   tolerance,
        "match":       match,
        "mismatch":    mismatch,
        "svg_only":    svg_only,
        "layout_only": layout_only,
        "summary": {
            "total":        len(all_guids),
            "match":        len(match),
            "mismatch":     len(mismatch),
            "svg_only":     len(svg_only),
            "layout_only":  len(layout_only),
        },
    }


def compare_container_bounds(
    svg_bounds:   dict[str, tuple[float, float, float, float]],
    saved_bounds: dict[str, list[float]],
    tolerance:    float = 2.0,
) -> dict[str, Any]:
    """Compare SVG-derived container rects to the saved `groupBounds` map.

    Mirrors the shape of :func:`compare_layouts` so the caller can reuse
    the reporting code: `{match, mismatch, svg_only, saved_only, summary}`.

    The per-axis delta is the maximum absolute difference across the four
    rect coordinates (xMin/yMin/xMax/yMax); a row passes when that delta
    is within `tolerance`.
    """
    all_guids = sorted(set(svg_bounds) | set(saved_bounds))

    match:      list[dict] = []
    mismatch:   list[dict] = []
    svg_only:   list[dict] = []
    saved_only: list[dict] = []

    for guid in all_guids:
        in_svg   = guid in svg_bounds
        in_saved = guid in saved_bounds

        if in_svg and not in_saved:
            x0, y0, x1, y1 = svg_bounds[guid]
            svg_only.append({
                "guid": guid,
                "svg":  [x0, y0, x1, y1],
            })
            continue
        if in_saved and not in_svg:
            saved_only.append({
                "guid":  guid,
                "saved": list(saved_bounds[guid]),
            })
            continue

        svg_rect   = svg_bounds[guid]
        saved_rect = saved_bounds[guid]
        deltas     = [abs(svg_rect[k] - saved_rect[k]) for k in range(4)]
        max_delta  = max(deltas)

        entry: dict = {
            "guid":      guid,
            "svg":       [round(v, 1) for v in svg_rect],
            "saved":     list(saved_rect),
            "delta":     [round(d, 1) for d in deltas],
            "max_delta": round(max_delta, 1),
        }
        (match if max_delta <= tolerance else mismatch).append(entry)

    # Pass only when no mismatches AND no orphan entries on either side.
    # Orphans indicate a structural disagreement (a container the browser
    # thinks exists but TALA didn't draw, or vice versa) — both are real
    # failures, even though they don't carry a numeric delta.
    passed = not mismatch and not svg_only and not saved_only
    return {
        "pass":       passed,
        "tolerance":  tolerance,
        "match":      match,
        "mismatch":   mismatch,
        "svg_only":   svg_only,
        "saved_only": saved_only,
        "summary": {
            "total":      len(all_guids),
            "match":      len(match),
            "mismatch":   len(mismatch),
            "svg_only":   len(svg_only),
            "saved_only": len(saved_only),
        },
    }


def compare_edge_endpoints(
    flows:         list[dict[str, Any]],
    svg_edges:     list[dict[str, Any]],
    svg_positions: dict[str, dict[str, Any]],
    tolerance:     float = 2.0,
) -> dict[str, Any]:
    """Compare each flow's SVG edge endpoint against the parent block's
    rectangular perimeter (see `_point_to_box` — mirrors the engine's
    `pointToBoxDistance` rebind-scoring helper).

    Latches aren't stored in the saved `layout` dict unless the user
    explicitly dragged them (see `LatchView.userSetPosition` +
    `ManualLayoutEngine.generatePositionMap`).  The native anchor angle
    can also drift relative to a freshly regenerated SVG — TALA is free
    to route edges through a different face, and the browser's rebind
    doesn't persist until the next save.  So rather than compare to a
    stored or angle-derived latch point, the check asks the structural
    question: does each SVG edge endpoint land on (or within tolerance
    of) the parent block's perimeter?  That's exactly what
    `pickNearestAnchor` uses to score the edge's alignment.

    TALA terminates edges a few pixels short of the target block so the
    arrowhead marker has clearance, so expect a consistent 2–6 px delta
    on every row; `--tolerance 6` gives a clean PASS.  The per-axis Δ
    is emitted unmodified so both the arrow-clearance offset and any
    real drift are visible in the report.

    Returned shape:
      - `match` / `mismatch`: per-latch rows with Δ.
      - `flow_only`: flows that had no matching SVG edge.
      - `edge_only`: SVG edges with no corresponding flow.
      - `summary`: row counts, plus flow-level counts in
                   `flow_only` / `edge_only`.
    """
    match:     list[dict] = []
    mismatch:  list[dict] = []
    flow_only: list[dict] = []

    used: set[int] = set()
    for flow in flows:
        edge_idx = match_flow_to_edge(flow, svg_edges, used)
        if edge_idx is None:
            flow_only.append({
                "flow_guid":  flow["flow_guid"],
                "node1_latch": flow["node1_latch_guid"],
                "node2_latch": flow["node2_latch_guid"],
                "node1_block": flow["node1_block_guid"],
                "node2_block": flow["node2_block_guid"],
            })
            continue
        used.add(edge_idx)
        edge = svg_edges[edge_idx]
        start = edge["start_xy"]
        end   = edge["end_xy"]

        for side in ("node1", "node2"):
            block_guid = flow[f"{side}_block_guid"]
            angle      = flow[f"{side}_anchor_angle"]
            block_pos  = svg_positions.get(block_guid) if block_guid else None
            if block_pos is None:
                mismatch.append({
                    "flow_guid": flow["flow_guid"],
                    "side":      side,
                    "latch":     flow[f"{side}_latch_guid"],
                    "reason":    "parent block not in SVG",
                })
                continue

            block_rect = (
                block_pos["x"], block_pos["y"],
                block_pos["x"] + block_pos["w"], block_pos["y"] + block_pos["h"],
            )
            # Pick whichever SVG endpoint is nearer to this block's rect.
            dx_s, dy_s, near_start = _point_to_box(start, block_rect)
            dx_e, dy_e, near_end   = _point_to_box(end,   block_rect)
            use_start = math.hypot(dx_s, dy_s) <= math.hypot(dx_e, dy_e)
            if use_start:
                endpoint, nearest, dx, dy = start, near_start, dx_s, dy_s
                endpoint_label = "start"
            else:
                endpoint, nearest, dx, dy = end, near_end, dx_e, dy_e
                endpoint_label = "end"
            max_delta = max(dx, dy)
            entry = {
                "flow_guid":    flow["flow_guid"],
                "side":         side,
                "latch":        flow[f"{side}_latch_guid"],
                "block":        block_guid,
                "anchor_angle": angle,
                "svg":          [round(endpoint[0], 1), round(endpoint[1], 1)],
                "nearest":      [round(nearest[0], 1), round(nearest[1], 1)],
                "delta":        [round(dx, 1), round(dy, 1)],
                "max_delta":    round(max_delta, 1),
                "svg_endpoint": endpoint_label,
            }
            (match if max_delta <= tolerance else mismatch).append(entry)

    # Edges the SVG has but no flow claimed — typically either a parse
    # bug or a flow added to the canvas after the last layout.  Report
    # with their src/tgt leaf GUIDs so the caller can investigate.
    edge_only: list[dict] = []
    for i, edge in enumerate(svg_edges):
        if i in used:
            continue
        edge_only.append({
            "src_guid": edge["src_guid"],
            "tgt_guid": edge["tgt_guid"],
            "index":    edge["index"],
            "start":    [round(edge["start_xy"][0], 1), round(edge["start_xy"][1], 1)],
            "end":      [round(edge["end_xy"][0],   1), round(edge["end_xy"][1],   1)],
        })

    passed = not mismatch and not flow_only and not edge_only
    return {
        "pass":       passed,
        "tolerance":  tolerance,
        "match":      match,
        "mismatch":   mismatch,
        "flow_only":  flow_only,
        "edge_only":  edge_only,
        "summary": {
            "flows":     len(flows),
            "edges":     len(svg_edges),
            "match":     len(match),
            "mismatch":  len(mismatch),
            "flow_only": len(flow_only),
            "edge_only": len(edge_only),
        },
    }


def compare_bend_points(
    flows:        list[dict[str, Any]],
    svg_edges:    list[dict[str, Any]],
    saved_layout: dict[str, list[float]],
    tolerance:    float = 2.0,
) -> dict[str, Any]:
    """Compare TALA polyline interior vertices to each flow's handle list.

    For every flow, resolve the matching SVG edge (same unordered-pair
    logic as `compare_edge_endpoints`), extract its interior vertices via
    `extract_polyline_bends`, and pair each with the saved layout entry
    for the corresponding `flow.handles[i]`.  Handles absent from
    `layout` (i.e. `userSetPosition = False`, left for DynamicLine's
    strategy to re-derive) are paired with a `null` saved position — the
    row still counts toward `saved_count` but is skipped in the position
    check.

    A flow is classified as:
      - `match`                — `svg_count == saved_count` AND every
                                  pair compared is within tolerance.
      - `position_mismatch`    — counts agree but at least one pair
                                  exceeds tolerance.
      - `bend_count_mismatch`  — counts disagree (the multi-bend signal
                                  documented in the plan; expected when
                                  TALA routes more bends than
                                  `pickPolylineElbow` preserves).

    Position deltas are computed per axis (dx, dy) for the overlapping
    prefix in all verdict classes, so the multi-bend diagnostic still
    carries numeric evidence.
    """
    matches:        list[dict] = []
    pos_mismatch:   list[dict] = []
    count_mismatch: list[dict] = []
    flow_only:      list[dict] = []

    used: set[int] = set()
    for flow in flows:
        edge_idx = match_flow_to_edge(flow, svg_edges, used)
        if edge_idx is None:
            flow_only.append({
                "flow_guid":  flow["flow_guid"],
                "handles":    list(flow.get("handles") or []),
            })
            continue
        used.add(edge_idx)
        edge       = svg_edges[edge_idx]
        svg_bends  = extract_polyline_bends(edge["d"])
        handles    = flow.get("handles") or []
        svg_count  = len(svg_bends)
        saved_count = len(handles)

        deltas: list[dict[str, Any]] = []
        position_fail = False
        for i in range(min(svg_count, saved_count)):
            bend = svg_bends[i]
            handle_guid = handles[i]
            saved_pos = saved_layout.get(handle_guid)
            row: dict[str, Any] = {
                "index":  i,
                "handle": handle_guid,
                "svg":    [round(bend[0], 1), round(bend[1], 1)],
            }
            if saved_pos is None:
                row["saved"]     = None
                row["delta"]     = None
                row["max_delta"] = None
            else:
                sx, sy = saved_pos
                dx = abs(sx - bend[0])
                dy = abs(sy - bend[1])
                max_delta = max(dx, dy)
                row["saved"]     = [sx, sy]
                row["delta"]     = [round(dx, 1), round(dy, 1)]
                row["max_delta"] = round(max_delta, 1)
                if max_delta > tolerance:
                    position_fail = True
            deltas.append(row)

        entry: dict[str, Any] = {
            "flow_guid":   flow["flow_guid"],
            "svg_count":   svg_count,
            "saved_count": saved_count,
            "deltas":      deltas,
        }
        if svg_count != saved_count:
            entry["verdict"] = "bend_count_mismatch"
            count_mismatch.append(entry)
        elif position_fail:
            entry["verdict"] = "position_mismatch"
            pos_mismatch.append(entry)
        else:
            entry["verdict"] = "match"
            matches.append(entry)

    edge_only: list[dict] = []
    for i, edge in enumerate(svg_edges):
        if i in used:
            continue
        edge_only.append({
            "src_guid": edge["src_guid"],
            "tgt_guid": edge["tgt_guid"],
            "index":    edge["index"],
        })

    passed = not pos_mismatch and not count_mismatch and not flow_only and not edge_only
    return {
        "pass":             passed,
        "tolerance":        tolerance,
        "match":            matches,
        "position_mismatch": pos_mismatch,
        "bend_count_mismatch": count_mismatch,
        "flow_only":        flow_only,
        "edge_only":        edge_only,
        "summary": {
            "flows":                len(flows),
            "match":                len(matches),
            "position_mismatch":    len(pos_mismatch),
            "bend_count_mismatch":  len(count_mismatch),
            "flow_only":            len(flow_only),
            "edge_only":            len(edge_only),
        },
    }


# ---------------------------------------------------------------------------
# Report output
# ---------------------------------------------------------------------------

def _fmt_pair(pair: list | tuple) -> str:
    return f"({pair[0]:.1f}, {pair[1]:.1f})"


def _fmt_rect(rect: list | tuple) -> str:
    return f"({rect[0]:.0f}, {rect[1]:.0f}, {rect[2]:.0f}, {rect[3]:.0f})"


def _print_block_centers(result: dict[str, Any], verbose: bool) -> None:
    summ = result["summary"]
    tol  = result["tolerance"]
    print("  Block centers")
    print("  " + "─" * 40)

    if verbose and (result["mismatch"] or result["match"]):
        w_guid  = 38
        w_coord = 18
        print(
            f"    {'GUID':<{w_guid}}  {'SVG center':<{w_coord}}  "
            f"{'Saved center':<{w_coord}}  Max Δ"
        )
        for entry in sorted(result["match"] + result["mismatch"],
                            key=lambda e: e["guid"]):
            ok_mark = "✓" if entry["max_delta"] <= tol else "✗"
            print(
                f"    {ok_mark} {entry['guid']:<{w_guid - 2}}  "
                f"{_fmt_pair(entry['svg']):<{w_coord}}  "
                f"{_fmt_pair(entry['saved']):<{w_coord}}  "
                f"{entry['max_delta']:.1f}"
            )
        if result["svg_only"]:
            print("    In SVG only (not in saved layout):")
            for e in result["svg_only"]:
                print(f"      {e['guid']}  {_fmt_pair([e['cx'], e['cy']])}")
        if result["layout_only"]:
            print("    In saved layout only (not in SVG):")
            for e in result["layout_only"]:
                print(f"      {e['guid']}  {_fmt_pair(e['saved'])}")

    print(
        f"    Summary: {summ['total']} nodes — "
        f"{summ['match']} match, {summ['mismatch']} mismatch, "
        f"{summ['svg_only']} SVG-only (containers), "
        f"{summ['layout_only']} layout-only (handles / auto)"
    )
    verdict = "✓  PASS" if result["pass"] else "✗  FAIL"
    print(f"    Verdict: {verdict}  (tolerance {tol} px)")
    print()


def _print_container_bounds(result: dict[str, Any], verbose: bool) -> None:
    summ = result["summary"]
    tol  = result["tolerance"]
    print("  Container bounds")
    print("  " + "─" * 40)

    if verbose and (result["mismatch"] or result["match"]):
        w_guid = 38
        w_rect = 26
        print(
            f"    {'GUID':<{w_guid}}  {'SVG rect':<{w_rect}}  "
            f"{'Saved rect':<{w_rect}}  Max Δ"
        )
        for entry in sorted(result["match"] + result["mismatch"],
                            key=lambda e: e["guid"]):
            ok_mark = "✓" if entry["max_delta"] <= tol else "✗"
            print(
                f"    {ok_mark} {entry['guid']:<{w_guid - 2}}  "
                f"{_fmt_rect(entry['svg']):<{w_rect}}  "
                f"{_fmt_rect(entry['saved']):<{w_rect}}  "
                f"{entry['max_delta']:.1f}"
            )
        if result["svg_only"]:
            print("    In SVG only (not in saved groupBounds):")
            for e in result["svg_only"]:
                print(f"      {e['guid']}  {_fmt_rect(e['svg'])}")
        if result["saved_only"]:
            print("    In saved groupBounds only (not in SVG):")
            for e in result["saved_only"]:
                print(f"      {e['guid']}  {_fmt_rect(e['saved'])}")

    print(
        f"    Summary: {summ['total']} containers — "
        f"{summ['match']} match, {summ['mismatch']} mismatch, "
        f"{summ['svg_only']} SVG-only, {summ['saved_only']} saved-only"
    )
    verdict = "✓  PASS" if result["pass"] else "✗  FAIL"
    print(f"    Verdict: {verdict}  (tolerance {tol} px)")
    print()


def _print_edge_endpoints(result: dict[str, Any], verbose: bool) -> None:
    summ = result["summary"]
    tol  = result["tolerance"]
    print("  Edge endpoints")
    print("  " + "─" * 40)

    rows = result["match"] + result["mismatch"]
    if verbose and rows:
        w_flow = 38
        w_side = 5
        w_coord = 18
        print(
            f"    {'Flow GUID':<{w_flow}}  {'Side':<{w_side}}  "
            f"{'SVG endpoint':<{w_coord}}  {'Nearest on block':<{w_coord}}  Max Δ"
        )
        for entry in sorted(rows, key=lambda e: (e["flow_guid"], e["side"])):
            if "max_delta" not in entry:
                # Rows with a textual reason (e.g. missing latch) fall here.
                print(
                    f"    ✗ {entry['flow_guid']:<{w_flow - 2}}  "
                    f"{entry['side']:<{w_side}}  "
                    f"{entry.get('reason', '?')}"
                )
                continue
            ok_mark = "✓" if entry["max_delta"] <= tol else "✗"
            print(
                f"    {ok_mark} {entry['flow_guid']:<{w_flow - 2}}  "
                f"{entry['side']:<{w_side}}  "
                f"{_fmt_pair(entry['svg']):<{w_coord}}  "
                f"{_fmt_pair(entry['nearest']):<{w_coord}}  "
                f"{entry['max_delta']:.1f}"
            )
        if result["flow_only"]:
            print("    Flows with no SVG edge:")
            for e in result["flow_only"]:
                print(f"      {e['flow_guid']}  "
                      f"({e['node1_block']} ↔ {e['node2_block']})")
        if result["edge_only"]:
            print("    SVG edges with no matching flow:")
            for e in result["edge_only"]:
                print(
                    f"      [{e['index']}] {e['src_guid']} → {e['tgt_guid']}  "
                    f"start={_fmt_pair(e['start'])} end={_fmt_pair(e['end'])}"
                )

    print(
        f"    Summary: {summ['flows']} flows, {summ['edges']} svg-edges — "
        f"{summ['match']} match, {summ['mismatch']} mismatch, "
        f"{summ['flow_only']} flow-only, {summ['edge_only']} edge-only"
    )
    verdict = "✓  PASS" if result["pass"] else "✗  FAIL"
    print(f"    Verdict: {verdict}  (tolerance {tol} px)")
    print()


def _print_bend_points(result: dict[str, Any], verbose: bool) -> None:
    summ = result["summary"]
    tol  = result["tolerance"]
    print("  Bend points")
    print("  " + "─" * 40)

    all_rows = (
        result["match"] + result["position_mismatch"] + result["bend_count_mismatch"]
    )
    if verbose and all_rows:
        w_flow = 38
        print(
            f"    {'Flow GUID':<{w_flow}}  svg  saved  Verdict              Max Δ (overlap)"
        )
        for entry in sorted(all_rows, key=lambda e: e["flow_guid"]):
            verdict = entry["verdict"]
            ok_mark = "✓" if verdict == "match" else "✗"
            deltas  = entry["deltas"]
            max_seen = max(
                (d["max_delta"] for d in deltas if d["max_delta"] is not None),
                default=None,
            )
            d_str = f"{max_seen:.1f}" if max_seen is not None else "—"
            print(
                f"    {ok_mark} {entry['flow_guid']:<{w_flow - 2}}  "
                f"{entry['svg_count']:>3}  {entry['saved_count']:>5}  "
                f"{verdict:<20} {d_str}"
            )
            for d in deltas:
                if d["saved"] is None:
                    print(
                        f"        [{d['index']}] svg={_fmt_pair(d['svg'])}  "
                        f"saved=<not user-set>"
                    )
                else:
                    print(
                        f"        [{d['index']}] svg={_fmt_pair(d['svg'])}  "
                        f"saved={_fmt_pair(d['saved'])}  Δ={_fmt_pair(d['delta'])}"
                    )
        if result["flow_only"]:
            print("    Flows with no SVG edge:")
            for e in result["flow_only"]:
                print(f"      {e['flow_guid']}  handles={len(e['handles'])}")
        if result["edge_only"]:
            print("    SVG edges with no matching flow:")
            for e in result["edge_only"]:
                print(f"      [{e['index']}] {e['src_guid']} → {e['tgt_guid']}")

    print(
        f"    Summary: {summ['flows']} flows — "
        f"{summ['match']} match, "
        f"{summ['position_mismatch']} position-mismatch, "
        f"{summ['bend_count_mismatch']} bend-count-mismatch, "
        f"{summ['flow_only']} flow-only, {summ['edge_only']} edge-only"
    )
    verdict = "✓  PASS" if result["pass"] else "✗  FAIL"
    print(f"    Verdict: {verdict}  (tolerance {tol} px)")
    print()


def print_report(
    results:      dict[str, Any],
    diagram_id:   str,
    reference_id: str,
    verbose:      bool = False,
) -> None:
    """Print every section's result table (verbose) or summary (default).

    `results` is a dict keyed by section name (`block_centers`,
    `container_bounds`, …); missing sections are silently skipped so the
    caller can extend the script incrementally.
    """
    print()
    if diagram_id != reference_id:
        print(f"  Fresh diagram    : {diagram_id}")
        print(f"  Reference layout : {reference_id}")
    else:
        print(f"  Diagram : {diagram_id}")
    print()

    if "block_centers" in results:
        _print_block_centers(results["block_centers"], verbose)
    if "container_bounds" in results:
        _print_container_bounds(results["container_bounds"], verbose)
    if "edge_endpoints" in results:
        _print_edge_endpoints(results["edge_endpoints"], verbose)
    if "bend_points" in results:
        _print_bend_points(results["bend_points"], verbose)

    any_fail = any(not r["pass"] for r in results.values())
    if any_fail:
        print("  ✗  OVERALL FAIL — one or more sections reported mismatches")
    else:
        print("  ✓  OVERALL PASS — every section matched within tolerance")
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="compare_layout.py",
        description=(
            "Import a DFD minimal-format file, trigger browser auto-layout, "
            "and compare the SVG positions against the saved diagram layout."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Options:")[1] if "Options:" in __doc__ else "",
    )
    p.add_argument("import_file", nargs="?",
                   help="Minimal-format JSON file to import (e.g. server/examples/java_web_app.json)")
    p.add_argument("--flask-url", default=_FLASK_URL,
                   help=f"Flask base URL (default: {_FLASK_URL})")
    p.add_argument("--data-dir", type=Path, default=_DATA_DIR,
                   help=f"Path to server/data (default: {_DATA_DIR})")
    p.add_argument("--reference", metavar="ID",
                   help="Use this diagram's layout as the reference instead of the fresh import")
    p.add_argument("--svg-only", metavar="ID", dest="svg_only_id",
                   help="Skip import; compare latest-layout.svg against this diagram's layout")
    p.add_argument("--no-display", action="store_true",
                   help="Do not broadcast a display event after import")
    p.add_argument("--timeout", type=float, default=60.0,
                   help="Seconds to wait for auto-layout (default: 60)")
    p.add_argument("--tolerance", type=float, default=2.0,
                   help="Max pixel delta per axis considered a match (default: 2.0)")
    p.add_argument("--verbose", action="store_true",
                   help="Print per-row tables for every section")
    p.add_argument("--json", action="store_true", dest="emit_json",
                   help="Emit machine-readable JSON result to stdout")
    return p


def run_all_checks(
    svg_text:     str,
    data_dir:     Path,
    diagram_id:   str,
    tolerance:    float,
) -> dict[str, Any]:
    """Parse the SVG and saved diagram once, run every check, return a dict
    keyed by section name (`block_centers`, `container_bounds`, …).

    Unavailable sections (e.g. the saved diagram has no `groupBounds`) are
    included with `pass=True` and an empty summary so the caller's
    aggregate verdict logic stays uniform.
    """
    svg_positions = parse_svg_positions(svg_text)
    layout        = load_diagram_layout(data_dir, diagram_id) or {}
    group_bounds  = load_group_bounds(data_dir, diagram_id) or {}
    svg_bounds    = parse_svg_container_bounds(svg_text)
    svg_edges     = parse_svg_edges(svg_text)
    native        = load_diagram_native(data_dir, diagram_id) or {}
    flows         = collect_flow_edges(native)

    results: dict[str, Any] = {}
    results["block_centers"]    = compare_layouts(svg_positions, layout, tolerance)
    results["container_bounds"] = compare_container_bounds(svg_bounds, group_bounds, tolerance)
    results["edge_endpoints"]   = compare_edge_endpoints(
        flows, svg_edges, svg_positions, tolerance,
    )
    results["bend_points"]      = compare_bend_points(
        flows, svg_edges, layout, tolerance,
    )
    return results


def emit_results(
    results:      dict[str, Any],
    diagram_id:   str,
    reference_id: str,
    emit_json:    bool,
    verbose:      bool,
) -> None:
    if emit_json:
        print(json.dumps(results, indent=2))
    else:
        print_report(results, diagram_id, reference_id, verbose=verbose)


def main() -> int:
    args = build_parser().parse_args()

    data_dir: Path = args.data_dir
    flask_url: str = args.flask_url
    svg_path       = data_dir / "latest-layout.svg"

    # -----------------------------------------------------------------------
    # Mode: --svg-only  (no import, just compare existing SVG vs named diagram)
    # -----------------------------------------------------------------------
    if args.svg_only_id:
        diagram_id = args.svg_only_id
        print(f"\nComparing latest-layout.svg against diagram {diagram_id!r}")
        if not svg_path.exists():
            print(f"ERROR: {svg_path} does not exist", file=sys.stderr)
            return 1
        svg_text = svg_path.read_text()
        if load_diagram_layout(data_dir, diagram_id) is None:
            print(f"ERROR: diagram {diagram_id!r} not found or has no layout key", file=sys.stderr)
            return 1
        results = run_all_checks(svg_text, data_dir, diagram_id, args.tolerance)
        emit_results(results, diagram_id, diagram_id, args.emit_json, args.verbose)
        return 0 if all(r["pass"] for r in results.values()) else 2

    # -----------------------------------------------------------------------
    # Normal mode: import → [display] → wait → compare
    # -----------------------------------------------------------------------
    if not args.import_file:
        print("ERROR: provide an import_file or use --svg-only", file=sys.stderr)
        build_parser().print_usage(sys.stderr)
        return 1

    import_path = Path(args.import_file)
    if not import_path.exists():
        print(f"ERROR: import file not found: {import_path}", file=sys.stderr)
        return 1

    print(f"\nImporting {import_path} …")
    check_flask(flask_url)

    minimal_doc = json.loads(import_path.read_text())

    # Record SVG mtime before import so we can detect the update.
    try:
        svg_mtime_before = svg_path.stat().st_mtime
    except FileNotFoundError:
        svg_mtime_before = 0.0

    if args.no_display:
        diagram_id = import_diagram(flask_url, minimal_doc)
        print(f"  → Created diagram: {diagram_id} (display skipped)")
    else:
        # Use the combined endpoint so import + broadcast is a single round-trip.
        result_body = _http_post(f"{flask_url}/api/diagrams/import-and-display", minimal_doc)
        diagram_id  = result_body["id"]
        ok          = result_body.get("broadcast_delivered", False)
        status      = "ok" if ok else "failed (browser may not be connected)"
        print(f"  → Created diagram: {diagram_id}")
        print(f"  → Broadcast display: {status}")
        if not ok:
            print("  Hint: open http://localhost:5173 in a browser with the editor running.")

    # -----------------------------------------------------------------------
    # Determine comparison targets
    # -----------------------------------------------------------------------
    reference_id: str
    compare_source_id: str  # whose saved JSON holds the reference geometry

    if args.reference:
        # Use the named reference diagram — no need to wait for auto-layout on
        # the fresh import.  Still useful to generate a fresh SVG then compare
        # it to a known-good reference.
        reference_id = args.reference
        compare_source_id = args.reference
        print(f"  → Using reference layout: {reference_id}")

        # If display was broadcast, wait for the SVG to be updated.
        if not args.no_display:
            try:
                svg_text, _ignored_layout = wait_for_layout(
                    data_dir, diagram_id, svg_mtime_before, args.timeout
                )
            except TimeoutError as exc:
                print(f"\nERROR: {exc}", file=sys.stderr)
                return 1
        elif not svg_path.exists():
            print(f"ERROR: {svg_path} does not exist; run without --no-display first", file=sys.stderr)
            return 1
        else:
            svg_text = svg_path.read_text()

        if load_diagram_layout(data_dir, reference_id) is None:
            print(f"ERROR: reference diagram {reference_id!r} not found or has no layout key",
                  file=sys.stderr)
            return 1

    else:
        # No reference — wait for the browser to auto-layout the fresh import.
        reference_id = diagram_id
        compare_source_id = diagram_id
        try:
            svg_text, _layout = wait_for_layout(
                data_dir, diagram_id, svg_mtime_before, args.timeout
            )
        except TimeoutError as exc:
            print(f"\nERROR: {exc}", file=sys.stderr)
            return 1

    # -----------------------------------------------------------------------
    # Run every check against the SVG and the selected reference.
    # -----------------------------------------------------------------------
    print("  Parsing SVG and saved diagram …")
    try:
        results = run_all_checks(svg_text, data_dir, compare_source_id, args.tolerance)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    emit_results(results, diagram_id, reference_id, args.emit_json, args.verbose)
    return 0 if all(r["pass"] for r in results.values()) else 2


if __name__ == "__main__":
    sys.exit(main())
