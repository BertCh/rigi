<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Cartography consolidation (2026-10-02)

Session `mt-image-0a`. The user asked for "a deep dive on all of the cartographic representations, configuration, styles", then research, then "a comprehensive update consolidation refactor". This report covers four things:

- the inventory (from three read-only code surveys);
- the research (map-style systems and Swiss references);
- the architecture the code is moving to;
- what landed, how it was verified, and what is still open.

It builds on [swiss-cartography-review.md](swiss-cartography-review.md), the canon (C1–C24), defects (D1–D14) and ranked fixes. It does not repeat that report: where an item here closes one of its defects, the defect is named.

## 1. Inventory: where cartography lives

| Layer | Modules | Role |
|---|---|---|
| Config | `src/lib/style/{types,schema,defaults,presets,store,ramps,color,deck-apply}.ts` | `ViewStyle` (8 sub-objects, about 160 leaves); 12 presets as `DeepPartial` layers over `CLASSIC`; storage `{v:1, preset, overrides}` plus `?style=`; `deck-apply` turns a style into plain numbers for both engines |
| Palette (new) | `src/lib/style/palette.ts` | The named map colours that more than one place uses (§3) |
| Shading | `src/lib/look/**` (`glsl/*`, `imhof.ts`, `relief/`, `atmosphere.ts`, `water/`, `nebelmeer/`, `sketch-ridges.ts`, `trail-stroke.ts`) and the WGSL ports in `src/lib/deck-webgpu/layers/{terrain-styles,atm-sky,composite,drape,ridges,flow}.ts` | Ramps, alpine tint, MDOW/Imhof relief, Tanaka, slope classes, aerial perspective, water, ink ridges, harmonise |
| Terroir | `src/lib/terroir/**` | Pack data (cover, names, glaciers), `TERROIR_*` shader chunks (GLSL and WGSL), hatch v1/v2, patterns, labels (`classes.ts NAME_TYPO`, `labels/swisstopo.ts`), overlays and furniture (`ui/`, `roll/`, `viz/`) |
| Labels | `src/lib/look/labels/**` | Classic, panorama and inline layouts; SVG, DOM CSS and export-canvas sinks |
| Other map surfaces | `src/lib/roll/**`, `src/components/gipfelbuch/swiss/**`, `examples/deck/landeskarte` | Roll mosaic and map, the Gipfelbuch paper sheets, and the standalone example. The example imports public API only, so it keeps its own copy by rule |
| Brand | `src/brand/khipu.ts`, `src/styles.css --rigi-*`, `gipfelbuch/swiss/{inks,palette,theme.css}` | Brezine chart roles, used by the chrome and the Gipfelbuch |

### Main findings

**Config**
- `terroir` and `field-sketch` repeated about 40 identical leaves.
- Four presets re-typed the same brown contour pair and warm ink.
- The preset id, label and layer tables were four separate lists (`PRESET_IDS`, `PRESET_LABELS`, `PRESET_OVERLAY_LAYER`, `PRESET_MAP_LAYERS`).
- `schema.ts` and `types.ts` are both hand-written and can drift. Drift is caught only by the "CLASSIC is a fixed point" spec and `style-check`.
- The user-facing name "Landeskarte" was not accepted anywhere: only the id `swiss` was.

**Shaders**
- The alpine tint existed three times: GLSL `alpineBase`, the WGSL `ts_alpine_base`, and the `patterson` ramp.
- The rock and ice inks existed twice (`CONTOUR_INK`, `HATCH_LK_INK`).
- The world sky `#a9c2da` existed four times; the flow streak colour was hard-coded in the WGSL.
- Not changed here (owned by peers, or not pixel-neutral), recorded in §5:
  - the WGSL atmosphere duplicate without Nebelmeer;
  - three harmonise and OKLab copies;
  - three warm/cool relief tunings;
  - hand-written WGSL uniform structs.

**Labels and colour**
- `SWISSTOPO_NAME_TYPO` was dead (review D7), so Landeskarte names used the terroir table.
- The SVG halo formula was duplicated.
- The label font stack was duplicated.
- Seven water blues and three contour browns exist across surfaces.
- Five scale-bar helpers and three north arrows exist.

## 2. Research: what mature style systems do

The full brief, with sources, is in the session transcript. These are the conclusions that apply here:

- **Three layers.** A primitive palette feeds semantic tokens (a "flavor" in Protomaps basemaps: a flat object of roles such as `water`, `glacier`, `wood_a`/`wood_b`, `city_label_halo`), and layer generators read the tokens. Consumers never hold literals.
- **Composition by `extends` plus override**, not copy. Examples: Protomaps `{...LIGHT, water}`, DTCG `$extends`, Tangram `import:`.
- **A versioned persisted style** with a pure migration chain. MapLibre carries `version: 8`; Rigi carries `v: 1` with a migration hook not yet needed.
- **Shader constants.** Generate both dialects from one TS table. Values go in as uniforms where they change at runtime. `defines` are kept for control-flow variants only, because every define multiplies the WGSL compile matrix. Parity is asserted by a spec, not by comments.
- **Swiss references.** No official RGB or CMYK values for the Landeskarte inks are published. The live swisstopo MapLibre styles (`vectortiles.geo.admin.ch/styles/<id>/style.json`) are the digital reference, and their colours are screen colours (a saturated forest green, for example). Tokens therefore carry provenance (`classic` / `rigi`) and none claims to be "official". This matches the review's §2.4.

## 3. Architecture now in the tree

```
src/lib/style/palette.ts            tokens with provenance: CONTOUR_BROWN, COVER_INK, WARM_INK,
                                    BERANN_INK, DARK_INK, CONTOUR_CASING_BROWN, TOPO_PAPER,
                                    WORLD_SKY, WORLD_CLEAR, CLASSIC_HAZE, ALPINE_TINT
        │                           + emitters: alpineBaseBody(glsl|wgsl), shaderFloat, hexToBytes
        ├── style/defaults.ts       CLASSIC sky, clear, haze
        ├── style/presets.ts        SWISS_CONTOURS, TERROIR_LAYERS, inks; PRESET_INFO registry
        ├── style/ramps.ts          patterson = ALPINE_TINT belts
        ├── look/glsl/ramps.ts      alpineBase + rock/snow/lake generated (GLSL)
        ├── deck-webgpu/layers/terrain-styles.ts   ts_alpine_base + rock/snow/lake generated (WGSL)
        ├── terroir/classes.ts      CONTOUR_INK = COVER_INK
        ├── terroir/hatch-lk.ts     HATCH_LK_INK = bytes of COVER_INK
        └── deck/world-view.ts, deck-webgpu/layers/atm-sky.ts   WORLD_SKY re-exported
```

**Preset registry.** `PRESET_INFO: Record<PresetId, {label, aliases?, overlayLayer?, mapLayers?}>` is the one list. `PRESET_IDS`, `PRESET_LABELS`, `PRESET_OVERLAY_LAYER` and `PRESET_MAP_LAYERS` are derived from it, so existing imports are unchanged. `presetIdFrom()` resolves aliases: `?style=landeskarte` and a stored `"landeskarte"` both read as `swiss`. The persisted id stays `swiss`, so no stored state is invalidated.

**Name typography.** A new field, `style.terroir.names.typography: "terroir" | "swisstopo"`, selects the per-class table. The default is `terroir`, and Landeskarte uses `swisstopo`. The Terroir panel has a switch for it. `nameType(cls, px, typography)` reads `NAME_TYPOGRAPHY[typography]`.

**Labels.** `look/labels/css.ts svgHaloWidth()` is shared by `PeakLabelsSvg` and `NamesSvg`. `terroir/viz/ink.ts FONT` is now `LABEL_FONT_FAMILY`.

## 4. What changed, and how it was verified

### Pixel-neutral (proven)

Before-snapshots were captured first, and after-snapshots were taken after each step:
- `scripts/terroir/wgsl-identity-snap.ts`
- `scripts/terroir/shader-identity-snap.ts`
- a scratch dump of every resolved preset, every `deckTerrainStyle(preset, mode)`, `CONTOUR_INK`, `HATCH_LK_INK`, every `look/glsl/ramps.ts` export and both `WORLD_SKY`s

Results:
- **Resolved presets.** All 12 are JSON-identical apart from the new `typography` field and the deliberate swiss/field-sketch changes below. All 36 `deckTerrainStyle` hashes are identical.
- **Inks and sky.** Both ink tables and both sky constants are identical.
- **Shader text.** The generated GLSL and WGSL are identical once float spelling is normalised, so `0.40` becomes `0.4`, which is the same f32 literal. Hashes of the raw text changed, so the identity-snap outputs are not byte-equal, but no number changed.
- **Dawn.** All 252 WGSL variants compile on Dawn (`DAWN_DIR=… npx tsx scripts/gpu/wgsl-compile-all.ts`, terrain 73/73, including every alpine variant and the flow layer).

### Deliberate, visible, browser-unverified (ledger row)

| Change | Where | Closes |
|---|---|---|
| Landeskarte and Field sketch contours sit on Terroir's thin dark-brown casing (1.2 px, α 0.35) instead of Classic's navy (+2 px, α 0.55) | `presets.ts SWISS_CONTOURS` | review D1 |
| Landeskarte's bands layer uses the `swiss` ramp instead of Classic's `cool` | `presets.ts` swiss | review D2 |
| Landeskarte place names (when a pack is present and names are switched on) use the swisstopo table: blue italic water, spaced capitals for ranges | `terroir.names.typography` | review D7 |
| The swisstopo font stack drops Manrope; the comments are current | `terroir/labels/swisstopo.ts` | review D6 (part) |
| The hatch ink comment no longer claims Brezine swatches | `terroir/hatch-lk.ts` | review D8 |

The default Landeskarte render changes only in the contour casing. Names are off without a pack, and the bands layer is not the default overlay.

### Gates run

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | Clean apart from errors in two peers' untracked specs (`deck-webgpu/__tests__/styles-cull-atlas.spec.ts`, `deck/__tests__/terrain-stream.spec.ts`), not touched here |
| `npx biome check --write` | Run on every changed file |
| `npx vitest run src/lib/style src/lib/terroir src/lib/look` | Passes, including the new `style/__tests__/palette.spec.ts` and `look/__tests__/svg-halo.spec.ts` |
| `node scripts/ci/run.mjs fast` | `style-check`, `labels`, `terroir-*`, `layer-atm-sky`, `layer-terrain-styles`, `imhof`, `spdx` pass. `flow` failed once on a timing budget under machine load (9 ms) and passed alone (1.7 ms) |
| Pre-existing `unit` failures | `terrain-mesh`, `eye-above-ground`, and `checks.spec` (README table): failing before this work, not related |
| Not run | Any browser, screenshot or GLSL compile (cook mode: the batch pass owns them) |

## 5. Open items

### Owner decisions

1. **One contour brown?** The app's Swiss presets use `#b98a5e`/`#8a5a32`. The Gipfelbuch sheets and the example use Brezine NB `#95500c`. Both are now named, so changing either is one line.
2. **Map-ink blues** (review §4). Brezine has no pale water blue, and there are seven water blues across surfaces. The review recommends a map-content exception sampled from the swisstopo styles. That would be one `WATER` token group in `palette.ts`.
3. **Make Landeskarte visible by default** (review fix #1): `PRESET_INFO.swiss.mapLayers = { mapStyle: "hillshade", worldStyle: "hillshade" }`. This is one line, but it changes what every new user sees in the map and world views, so it was left for the user.

### Follow-ups, ranked by value per risk

1. **WGSL atmosphere duplicate.** `terrain-styles.ts ATMOSPHERE_WGSL` re-implements `atm-sky.ts` without Nebelmeer. With valley fog on, the WebGPU terrain does not fog where WebGL does. Delete the copy and use the `atm-sky` part. The WGSL owner is `mt-image-07`.
2. **Generate the WGSL uniform structs from `defineBlock`**, the GLSL side's single field table, including the vec3→vec4 padding. Add a parity spec.
3. **One `oklabWgsl()` / harmonise generator** for the three WGSL copies (composite, drape, terrain-styles) and the color-stats kernel.
4. **Relief tone tokens.** MDOW `(0.62,0.72,0.98)→(1.05,1.0,0.88)`, Imhof `IMHOF_SHADE/LIT` and the terroir fallback are three tunings of one warm/cool idea. Name them in `palette.ts`, then decide whether they should be one (the review's Jenny–Hurni LUT).
5. **Schema from types.** Make `schema.ts` the source and derive `ViewStyle` from it, or the reverse. This also folds the `def:` copies of `CLASSIC` numbers.
6. **Furniture helpers.** One `niceScaleLength` and one north-arrow glyph for `terroir/roll`, `gipfelbuch/swiss` and `step-inside`. Coordinate with the roll and Gipfelbuch owners.
7. **Font registries.** Alias "GB Sans/Serif/Mono" to the site faces so one woff2 set loads.
8. **Engines start from `CLASSIC`** (`deck/engine.ts`, `deck-webgpu/engine.ts`, `roll/map/basemap.ts`, the layer defaults). Only `PhotoWorkspace` follows the user's preset, so the roll basemap is always Classic. Decide which views should follow it.
9. **Unused fields.** `labels.export.textGap` is never read. `hazeDensity`/`hazeMax`/`casing.minorMul` have no UI.
