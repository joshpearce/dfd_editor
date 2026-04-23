#!/usr/bin/env python3
"""compare_layout.py

Import a DFD minimal-format file into the running editor, wait for TALA
auto-layout to complete, then compare the SVG node positions against the
positions stored in the diagram's layout key.

The comparison validates that the browser's SVG-parsing pipeline
(parseTalaSvg → placeBlock → moveTo(center)) correctly translates each
TALA rect's (x, y, width, height) into the center-based (cx, cy) stored
in the diagram's `layout` key.

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


# ---------------------------------------------------------------------------
# Report output
# ---------------------------------------------------------------------------

def print_report(result: dict[str, Any], diagram_id: str, reference_id: str) -> None:
    summ = result["summary"]
    tol  = result["tolerance"]

    print()
    if diagram_id != reference_id:
        print(f"  Fresh diagram    : {diagram_id}")
        print(f"  Reference layout : {reference_id}")
    else:
        print(f"  Diagram : {diagram_id}")
    print(f"  Tolerance        : {tol} px")
    print()

    # Column widths
    w_guid  = 38
    w_coord = 18
    header  = (
        f"  {'GUID':<{w_guid}}  {'SVG center':<{w_coord}}  "
        f"{'Saved center':<{w_coord}}  Max Δ"
    )
    rule = "  " + "─" * (len(header) - 2)

    def fmt_pair(pair: list | tuple) -> str:
        return f"({pair[0]:.1f}, {pair[1]:.1f})"

    if result["mismatch"] or result["match"]:
        print(header)
        print(rule)

    for entry in sorted(result["match"] + result["mismatch"],
                        key=lambda e: e["guid"]):
        ok_mark = "✓" if entry["max_delta"] <= tol else "✗"
        print(
            f"  {ok_mark} {entry['guid']:<{w_guid - 2}}  "
            f"{fmt_pair(entry['svg']):<{w_coord}}  "
            f"{fmt_pair(entry['saved']):<{w_coord}}  "
            f"{entry['max_delta']:.1f}"
        )

    if result["svg_only"]:
        print()
        print("  In SVG only (not in saved layout):")
        for e in result["svg_only"]:
            print(f"    {e['guid']}  {fmt_pair([e['cx'], e['cy']])}")

    if result["layout_only"]:
        print()
        print("  In saved layout only (not in SVG):")
        for e in result["layout_only"]:
            print(f"    {e['guid']}  {fmt_pair(e['saved'])}")

    print()
    print(f"  Summary: {summ['total']} nodes total — "
          f"{summ['match']} match, "
          f"{summ['mismatch']} mismatch, "
          f"{summ['svg_only']} SVG-only (containers / groups), "
          f"{summ['layout_only']} layout-only (handles / auto-generated)")
    print()
    if result["pass"]:
        print("  ✓  PASS  — all shared nodes match (SVG positions == saved layout)")
    else:
        print("  ✗  FAIL  — position mismatches found (see table above)")
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
    p.add_argument("--json", action="store_true", dest="emit_json",
                   help="Emit machine-readable JSON result to stdout")
    return p


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
        layout   = load_diagram_layout(data_dir, diagram_id)
        if layout is None:
            print(f"ERROR: diagram {diagram_id!r} not found or has no layout key", file=sys.stderr)
            return 1
        svg_positions = parse_svg_positions(svg_text)
        result = compare_layouts(svg_positions, layout, args.tolerance)
        if args.emit_json:
            print(json.dumps(result, indent=2))
        else:
            print_report(result, diagram_id, diagram_id)
        return 0 if result["pass"] else 2

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

    if args.reference:
        # Use the named reference diagram — no need to wait for auto-layout on
        # the fresh import.  Still useful to generate a fresh SVG then compare
        # it to a known-good reference.
        reference_id = args.reference
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

        layout = load_diagram_layout(data_dir, reference_id)
        if layout is None:
            print(f"ERROR: reference diagram {reference_id!r} not found or has no layout key",
                  file=sys.stderr)
            return 1

    else:
        # No reference — wait for the browser to auto-layout the fresh import.
        reference_id = diagram_id
        try:
            svg_text, layout = wait_for_layout(
                data_dir, diagram_id, svg_mtime_before, args.timeout
            )
        except TimeoutError as exc:
            print(f"\nERROR: {exc}", file=sys.stderr)
            return 1

    # -----------------------------------------------------------------------
    # Parse SVG positions and compare
    # -----------------------------------------------------------------------
    print(f"  Parsing SVG positions …")
    try:
        svg_positions = parse_svg_positions(svg_text)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"  → Found {len(svg_positions)} positioned nodes in SVG")
    print(f"  → Saved layout has {len(layout)} entries")

    result = compare_layouts(svg_positions, layout, args.tolerance)

    if args.emit_json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result, diagram_id, reference_id)

    return 0 if result["pass"] else 2


if __name__ == "__main__":
    sys.exit(main())
