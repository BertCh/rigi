# Terroir cartography: what the map says about the place

*Plan written 2026-09-30, status updated 2026-10-02. Owner doc for the terroir pack and the `style.terroir` layers (`src/lib/terroir`). The Swiss look as a whole (canon, Landeskarte default, open defects) lives in the hub [swiss-cartography-review.md](swiss-cartography-review.md); lettering roles are in [swiss-map-typography.md](swiss-map-typography.md). The plan of record is [roadmap.md](roadmap.md).*

## Summary

Rigi gets the geometry of a place right. Before this work it showed almost nothing of its character: one feature class (OSM peaks), contours on a per-photo relative hue ramp, and land cover invented from elevation belts in a shader. Lake Thun, the subject of most demo photos, was never named.

Terroir is the set of physical and human facts that make one slope unlike another. The work added them as **data, not decoration**: a pre-baked per-region **terroir pack** (land cover, names, glaciers, geology) and display layers that read it. Everything is additive: a `terroir` section of `ViewStyle` (`style/types.ts TerroirStyle`), the **Terroir** preset, and a Terroir sidebar section (`terroir/ui/TerroirPanel.tsx`) that switches each layer on top of any preset. Classic and the other presets keep it off; terroir-off shader text is proven identical by `scripts/terroir/shader-identity-snap.ts` (GLSL) and `wgsl-identity-snap.ts` (WGSL). The Terroir and Field-sketch presets switch Blend and In map to Relief (`PRESET_INFO.mapLayers` in `style/presets.ts`), because land cover shows on the relief rendering, not on satellite imagery.

## 1. Baseline it replaced (2026-09-30 audit)

The audit (two code audits, 19 screenshots in `out/carto-eval/`, gitignored) graded content D, land cover D (synthetic treeline 1900 / rock 2450 / snow 2900 m), toponymy D, elevation encoding D (relative `cool` ramp, no key), contours C (50 m, index 250 m, "venetian blind" stripes at 20–50 km), colour grammar D (brand orange meant five things), furniture D. Kept as strengths: the Berann absolute ramp, slope classes 30/35/40/45°, Swiss trail colours, TopoBoard, the panorama strip, RigiPanorama's disclosed exaggeration.

## 2. The six layers

| Layer | What the reader learns | Convention | Data (CH / fallback) |
|---|---|---|---|
| **Ground** | Limestone Prealps vs gneiss and granite High Alps | Black rock drawing; lithology tint | GeoCover V2 1:25k, GK500 / OneGeology |
| **Cover** | Ice, firn, scree, rock, forest, pasture, meadow, vineyard | Glacier white + blue contours; scree dots; forest green | swissTLM3D Bodenbedeckung, NFI, Rebbaukataster / ESA WorldCover, CLC+ Backbone |
| **Water** | Lakes, rivers, falls | Blue italic hydronyms; blue contours on ice and water | swissTLM3D, swissNAMES3D / OSM |
| **Human marks** | Alps, huts, graded paths, lifts, villages | SAC/swisstopo symbols, trail blazes, place hierarchy | swissTLM3D, swissNAMES3D / OSM |
| **Names** | Official local name, its class, language and status | Swiss name typography (see [swiss-map-typography.md](swiss-map-typography.md)) | **swissNAMES3D** / OSM `name:*` + Wikidata |
| **Light and time** | Sun, season, snow, glacier then vs now | Imhof warm light / cool shade | EXIF + `look/sun.ts`; Copernicus HR Snow; GLAMOS SGI |

Where each may appear: the **overlay** on the matched photo gets names, outlines and light marks only (the photo already shows the colours); **Blend and In map** get full fills; the **roll map** is the overview; the **place card** explains in words.

## 3. Principles

1. **Data, not decoration.** Every colour on the terrain is a class or value from a dataset; without data, render neutrally and say so.
2. **The photo is the base map.** On the matched photo add only what the pixels cannot show: names, classes, hidden structure, then and now.
3. **Absolute and keyed.** Quantities use a fixed scale with a visible key that brackets the current photo.
4. **Local names in local form.** Official name first, usual form or exonym second and lighter; typography follows class.
5. **One colour grammar.** Blue water and ice, green vegetation, brown and black ground and rock, signage colours for trails, brand glow for interaction only, one neutral colour-blind-checked hue for "DEM truth".
6. **Uncertainty is drawn.** Marks soften as confidence drops, far field first.
7. **Distortion is disclosed.** Exaggeration, Berann bend and seasonal grades only outside the matched view, captioned.
8. **Display only.** Nothing here feeds the matcher, pose, confidence, benchmarks or exports (the snow tint hurt matching; [negative-results.md](negative-results.md)).

## 4. Plan items and status

### Phase 0: honest and legible encodings

| # | Item | Status (2026-10-02) | Where |
|---|---|---|---|
| T0.1 | Absolute elevation with a key bracketing the photo's range | Built: elevation key, contour/index key, inks, cover classes in view, credits | `terroir/ui/Legend.tsx` |
| T0.2 | Swiss index contours on round 100 m | Built (also the Landeskarte default via `swissMajorEvery`) | `terroir/glsl/values.ts` |
| T0.3 | Contour interval thins with range | Built: nested 50 → 100 → 200 → 1000 m | `terroir/glsl/terrain.ts`, `terroir/wgsl/terrain.ts` |
| T0.4 | Peak hierarchy by prominence class, legible sub-line | Built (`style.terroir.peakTiers`): prominence class backfilled from swissNAMES3D; sub-line pill | `terroir/labels/peakTiers.ts` |
| T0.5–T0.6 | Name the water; names in In map and on the roll map | Built on the photo views (lakes and glaciers on their visible surface; settlements, passes, huts, ridges, massifs by class; dedupe against peaks) and on the /roll 3D map. **Not in In map**: the world camera is not exposed through `Renderer` | `terroir/labels/placeNames.ts`, `ui/NamesSvg.tsx`, `terroir/roll/` |
| T0.7–T0.8 | One colour grammar; drawn uncertainty | Partly built: pose-source glyphs, dashed ±10° prior fans, softened labels while unverified. **Open:** re-picked viewpoint palette (vp0/vp5 and fitted/solved collapse under deuteranopia), unified UI tokens | `terroir/roll/`, `PhotoWorkspace.tsx` |
| T0.9 | Furniture | Built: compass ribbon, sun/time chip, range ticks; scale bar and north arrow on minimap and TopoBoard; attribution, north arrow, camera halos on the roll 3D map | `ui/Furniture.tsx`, `terroir/roll/MapFurniture.tsx` |
| T0.10–T0.11 | Identity tokens; preset chips show the preset | Superseded by the khipu brand tokens and the style panel rework; not tracked here | `src/brand/khipu.ts` |
| T0.12 | Swiss trail blazes (white-red-white, white-blue-white) | **Not built** (the trail `dash` landed separately) | — |

### Phase 1: the terroir pack

Built for **Thunersee / Bernese Oberland** (bbox 7.35–8.25°E, 46.45–46.95°N) by `scripts/terroir/build-pack.ts` into `public/terroir/`; contract `src/lib/terroir/types.ts`, loader `pack.ts`. How to rebuild: [scripts/terroir/README.md](../scripts/terroir/README.md).

| Component | Content | Source (CH → fallback) | Licence |
|---|---|---|---|
| `cover` | 25 m class raster in the DEM frame | VECTOR25 + OSM + DEM rules (swissTLM3D → WorldCover) | swisstopo OGD (attribution); WorldCover CC BY 4.0 |
| `names` | 2,949 swissNAMES3D names with class, language, official/usual status, pairs | swissNAMES3D → OSM `name:*` + Wikidata | OGD. **OSM names stay a separate source** (ODbL, §6) |
| `glacier` | GLAMOS SGI outlines 1850/1931/1973/2016/2023 with per-vertex heights | GLAMOS → RGI 7.0 | CC BY 4.0 |
| `geology` | GK500 lithology, 6–10 display classes | GeoCover V2 → GK500 | check per sheet |

Engine side: three-colour contours (`TERROIR_CONTOUR_INK`: brown soil, black rock and scree, blue ice, no lines on water); cover albedo with canopy/scree texture (`TERROIR_COVER`); date snowline ±125 m by aspect (`TERROIR_SNOW`). Both engines: the WGSL port is `terroir/wgsl/terrain.ts` hooked from `deck-webgpu/layers/terrain-styles.ts` (366ab83). Names typography: `style.terroir.names.typography` selects `terroir` or `swisstopo` (Landeskarte) tables.

### Phase 2–3: rendering and stories

| # | Item | Status |
|---|---|---|
| T2.1 | Jenny–Hurni colour relief LUT modulated by cover | Open (the Imhof relief in `look/imhof.ts` covers part of it; LUT is a hub follow-up) |
| T2.2–T2.3 | Scree stipple; rock strokes | Built as hatch v1/v2 (`terroir/hatch.ts`, `hatch-lk.ts`); Swiss rock skeleton open (hub) |
| T2.4 | Forest texture, larch gold by date | Open |
| T2.5–T2.6 | Snow on the photo's date; warm light / cool shade | Built (`TERROIR_SNOW`; Imhof relief) |
| T2.7 | Ortho → class crossfade on grazing slopes | Built as the cliff crossfade on satellite; near-slope ortho streaks remain in Satellite mode |
| T2.8 | Roll map as a map | Partly: names, attribution, compass, halos. Basemap default unchanged |
| T3.1, T3.3 | Place card; line-of-sight profile coloured by cover | Built (`ui/PlaceCard.tsx`, `viz/profile.ts`) |
| T3.2 | Glacier then and now on the photo | Built (`ui/GlacierGhost.tsx`) |
| T3.4–T3.5 | Light of the day on the roll scrubber; sun path | Built (`terroir/roll/LightBand.tsx`, `ui/SunPath.tsx`) |
| T3.6–T3.7 | Geology section; seasonal presets | Open |

**Checks** (fast tier): `terroir-labels`, `terroir-viz`, `terroir-roll`, `terroir-pattern`, `terroir-hatch`, `terroir-pack` (`scripts/ci/checks.mjs`). Browser: the terroir and Landeskarte rows in [batch-ledger.md](batch-ledger.md).

**Known limits:** lake labels can land on near buildings that hide the lake (no buildings in the DEM); pack coverage is Thunersee only; vineyard and orchard are nearly absent (thin OSM); GK500 is coarse; the snowline curve is an engineering default.

## 5. How to evaluate

1. A frozen still set of about 20 wild-benchmark **dev** photos in overlay, Blend and In map for `classic`, Landeskarte and `terroir`.
2. Timed legibility tasks ("highest peak?", "name the lake", "slope above 35°?", "glacier larger than in 1973?"), five people or more, plus blind pairwise preference.
3. Automated: colour-blind ΔE over every categorical palette, monotonic lightness on ordinal ramps, WCAG label contrast over local photo luminance (none built yet).
4. Parity: `classic` stays pixel-identical; `terroir` gets its own baseline.

## 6. Risks and traps

- **ODbL share-alike.** Mixing OSM polygons into a swissTLM3D-derived database Rigi serves makes a derivative database. Composite separate sources at render time; extract them separately.
- **Licences to settle before shipping:** swisstopo base vector tiles say "commercial use requires permission" on opendata.swiss, contradicting the OGD statement (ask swisstopo); per-canton Rebbaukataster; NFI leaf type; Arealstatistik. EOX Sentinel-2 cloudless after 2016 is **CC BY-NC-SA**: do not use.
- **Constants:** the 250 m north/south snowline offset comes from one Italian MODIS study.
- **Over-drawing the photo:** every phase 1–3 element stays off the matched overlay unless §2 allows it.
- **Data age:** GeoCover completes in 2030; glacier outlines always carry a year label.
- **Coverage outside CH:** show a "data: CH national / EU 10 m / none" provenance chip rather than pretending to be uniform.

## 7. Open decisions for the owner

1. swisstopo vector base tiles (after the licence question) or bake everything from swissTLM3D?
2. Name language default: local official (the Swiss rule) or the user's language with the official name second?
3. Glacier ghost on the matched overlay (opt-in, year-labelled) or only in Blend and In map?
4. Coverage target outside Switzerland: CH only, CH + Alpine EU (WorldCover/RGI), or global?

## Sources

**Canon:** Imhof, *Cartographic Relief Presentation* (1965/1982); Jenny & Hurni, [Swiss-style colour relief shading](https://mail.colororacle.org/berniejenny/pdf/2006_JennyHurni_SwissStyleShading.pdf) (2006); Jenny et al., [Swiss-style rock drawing](https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf) (2014); Jenny et al., [Scree](https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf) (2010); Patterson, [Berann](https://cartographicperspectives.org/index.php/journal/article/view/cp36-patterson); Patterson & Jenny, [cross-blended hypsometry](https://cartographicperspectives.org/index.php/journal/article/view/cp69-patterson-jenny); Brown & Samavati, [real-time panorama maps](https://diglib.eg.org:443/handle/10.2312/npar2017a06) (2017); Kyncl & Lysák, [ladder hachures](https://ica-abs.copernicus.org/articles/7/81/2024/ica-abs-7-81-2024.pdf) (2024); Woodruff, [seasonal relief](https://andywoodruff.com/blog/seasonal-relief/); Jenny et al., [Eduard](https://arxiv.org/pdf/2010.01256) (2020).

**Data:** [swissTLM3D](https://opendata.swiss/en/dataset/swisstlm3d); swissNAMES3D ([ProdInfo 2026](https://www.swisstopo.admin.ch/dam/de/sd-web/lXacsGJI7k9t/2026%20swissNAMES3D%20ProdInfo-DE.pdf)); [GeoCover](https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.geologie-geocover); [GLAMOS](https://doi.glamos.ch/); [NFI vegetation height](https://envidat.ch/dataset/vegetation-height-model-nfi); [Rebbaukataster](https://www.geodienste.ch/services/lwb_rebbaukataster/info); [ESA WorldCover](https://registry.opendata.aws/esa-worldcover-vito/index.html); [CLC+ Backbone](https://land.copernicus.eu/api/en/products/clc-backbone/clc-backbone-2021); [Copernicus HR Snow](https://www.wekeo.eu/use-cases/new-copernicus-near-real-time-products-for-snow-and-ice-monitoring); [RGI 7](https://nsidc.org/data/nsidc-0770/versions/7).

**Licences and naming:** [swisstopo OGD conditions](https://www.swisstopo.admin.ch/en/conditions-geodata); [OSMF licence FAQ](https://osmfoundation.org/wiki/Licence_and_Legal_FAQ); [EOX cloudless licensing](https://eox.at/2025/03/sentinel-2-cloudless-2024/); [Weisungen geografische Namen](https://www.cadastre-manual.admin.ch/dam/it/sd-web/4SE6MyxeDpLv/Weisungen-geografische-Namen-de.pdf) (2011).

**Uncertainty:** MacEachren et al., [TVCG 2012](https://geography.wisc.edu/cartography/projects/publications/MacEachrenEtAl_2012_TVCG.pdf); Padilla, Kay & Hullman (2020).
