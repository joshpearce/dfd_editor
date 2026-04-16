# TALA Layout Integration Notes

Last verified: 2026-04-16

Research notes for integrating the TALA layout engine as a position source
for the DFD editor. TALA is Terrastruct's closed-source autolayout binary
designed for software architecture diagrams. These notes were reverse-
engineered against `d2plugin-tala v0.4.3` (installed at
`/opt/homebrew/opt/tala/bin/d2plugin-tala`) by reading the open-source D2
CLI, which speaks the plugin protocol to the TALA binary.

Authoritative source for the protocol: `d2plugin/exec.go` and
`d2plugin/plugin.go` in [terrastruct/d2](https://github.com/terrastruct/d2).

## CLI plugin protocol

The D2 CLI invokes any `d2plugin-*` binary as a subprocess using these
subcommands (argv[1]). TALA implements all of them.

| Subcommand               | stdin                                      | stdout                       | Timeout |
| ------------------------ | ------------------------------------------ | ---------------------------- | ------- |
| `info`                   | —                                          | JSON `PluginInfo`            | 10s     |
| `flags`                  | —                                          | JSON `[]PluginSpecificFlag`  | 10s     |
| `layout [--flag val ...]`| `d2graph.Graph` JSON                       | `d2graph.Graph` JSON         | 2m      |
| `routeedges [--flag val ...]` | `{ "g": <Graph>, "gEdges": <Graph> }` JSON | `d2graph.Graph` JSON  | 2m      |
| `postprocess`            | SVG bytes                                  | SVG bytes                    | 1m      |

On error, the binary exits non-zero and writes to stderr. Flag args discovered
via `flags` are passed to `layout`/`routeedges` as `--<Tag> <value>`; slice
values are comma-joined.

### TALA specifics (v0.4.3)

- **Flags:** only `--tala-seeds` (`[]int64`, default `[1,2,3]`). Layouts run
  in parallel for each seed and the best-performing result is returned.
- **Features advertised** (from `d2plugin/plugin_features.go`):
  `descendant_edges`, `container_dimensions`, `near_object`, `top_left`,
  `routes_edges`. The `container_dimensions` feature is the one that makes
  size-aware layout possible (see below).
- **License:** `TSTRUCT_TOKEN` env var or `~/.config/tstruct/auth.json`
  (`{"api_token": "..."}`). Unlicensed use works but watermarks output and
  prints to stderr.
- **No `--version` flag.** The binary prints its version when run
  unauthenticated.

### `d2graph.Graph` JSON is not a public schema

The `layout` subcommand takes/returns whatever `d2graph.SerializeGraph`
emits from `oss.terrastruct.com/d2/d2graph`. This is an internal struct,
not a documented API, and can drift between D2 versions. Driving TALA
standalone by hand-crafting this JSON is possible but fragile.

## Recommended integration path

**Shell out to the `d2` binary with `--layout=tala`** rather than calling
`d2plugin-tala` directly. This treats D2 source text and the rendered
SVG as the stable boundary, which is what D2 actually ships as a public
surface.

Flow:

1. Serialize DFD editor diagram → D2 source (one declaration per node,
   one connection per edge).
2. Run `d2 --layout=tala in.d2 out.svg`.
3. Parse `out.svg` and extract positions from each node's `<g class="shape">`
   transform/`x`/`y` attributes.
4. Apply coordinates back to the editor's diagram model.

Tradeoff vs. the direct `d2plugin-tala layout` path: one extra serialize/
parse hop in each direction, but the D2 text and SVG are stable whereas
`d2graph.Graph` JSON is not.

## The size-matching caveat

This is the main integration hazard. TALA places nodes using whatever
`width`/`height` the graph reports. The DFD editor's shapes have sizes
derived from the Dfd theme/template (content-driven, often 200+ pixels
wide). D2's default auto-sizing measures the node's label text in Source
Sans Pro with its own padding — typically much smaller. If you emit D2
source without explicit sizes:

- TALA will pack nodes based on D2's small auto-sizes.
- When those coordinates are applied to the editor's larger shapes,
  nodes overlap and edges clip through them.

### Fix

For each node, emit explicit `width:` and `height:` in the D2 source
matching the editor's actual shape bounds (including any stroke/padding
the editor treats as part of the hit box). TALA advertises the
`container_dimensions` feature, so it honors these.

Do the same for edge labels if the editor's labels are larger than D2's
default text measurement.

### Verify on a sample before trusting output

D2 may still add shape-specific padding on top of explicit `width`/`height`:

- `cylinder` shape has vertical caps.
- `class` / `sql_table` shapes have header rows.
- Container padding for nested nodes is separate from the container's
  own width/height.

Round-trip one representative diagram from `server/data/` and compare
the TALA-computed bounds against the editor's expected bounds before
wiring this into the main flow.

## Font considerations

D2 measures text with Source Sans Pro. The editor uses its own font
stack. Even with explicit node `width`/`height`, edge labels and any
shape that sizes itself from inner text may differ. Explicit sizing on
every measurable element sidesteps this; relying on auto-sizing will not
match the editor.

## References

- Binary: `/opt/homebrew/opt/tala/bin/d2plugin-tala`
- Plugin protocol (authoritative): [d2plugin/exec.go](https://github.com/terrastruct/d2/blob/master/d2plugin/exec.go),
  [d2plugin/plugin.go](https://github.com/terrastruct/d2/blob/master/d2plugin/plugin.go),
  [d2plugin/plugin_features.go](https://github.com/terrastruct/d2/blob/master/d2plugin/plugin_features.go)
- TALA README: https://github.com/terrastruct/TALA/blob/master/README.md
- D2 TALA docs: https://d2lang.com/tour/layouts/tala
