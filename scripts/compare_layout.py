#!/usr/bin/env python3
"""compare_layout.py

Import a DFD minimal-format file into the running editor, wait for TALA
auto-layout to complete, then compare the browser's stored geometry
against the TALA SVG on four independent dimensions:

  1. Block centers   — SVG rect center vs. saved `layout[guid]` (cx, cy).
  2. Container bounds — SVG container rect vs. saved `groupBounds[guid]`
                         (xMin, yMin, xMax, yMax).
  3. Edge endpoints  — each flow latch's saved (cx, cy) vs. the TALA
                         polyline's start/end vertex.
  4. Bend points     — each flow's handle positions vs. the TALA
                         polyline's interior vertices.

Sections 1–3 should pass at default tolerance today. Section 4 is
expected to fail on any flow TALA routed with three or more bends; the
`pickPolylineElbow`/`significantInteriorVertices` reduction keeps only
one handle, so multi-bend routes lose their interior vertices. The
failing rows are the motivating signal for the `PolyLine`-face design
work captured in
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

    results: dict[str, Any] = {}
    results["block_centers"]    = compare_layouts(svg_positions, layout, tolerance)
    results["container_bounds"] = compare_container_bounds(svg_bounds, group_bounds, tolerance)
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
