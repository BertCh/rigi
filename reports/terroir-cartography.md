# Terroir cartography: from overlay to atlas of place

*2026-09-30. Advisory: [roadmap.md](roadmap.md) remains the plan of record. This doc evaluates Rigi from a cartographic and data-viz point of view and proposes an "organic, terroir-first" direction. It builds on [Geospatial rendering aesthetics frontier.md](<Geospatial rendering aesthetics frontier.md>) (2026-09-30) and does not repeat it. That report covers rendering polish: the signature default preset, haze, ink, relief, label halos, leader occlusion, drape PCF and art modes. This one covers **what the map says**: content, encoding, names, colour grammar, legends, uncertainty, and how a view expresses the particular place it shows.*

*Evidence: two read-only code audits (geographic content; visual language, with Oklab and colour-blindness numbers from a throwaway script), 19 screenshots of the live app on the demo roll (`out/carto-eval/*.png`, gitignored, captured 2026-09-30 under the render lock), and a sourced web review of the Swiss/Alpine cartographic canon and open data. File:line references were checked by the auditors; screenshot readings are mine.*

## Summary

Rigi gets the geometry of a place right and shows almost nothing of its character. A registered photo carries a solved pose and metric depth on every pixel, which is the hardest part of a "panorama map". What gets drawn on top of it is one feature class (OSM peaks), contours tinted by a hue ramp that is rescaled per photo, and land cover that does not come from any data. Forest, meadow, rock and snow are elevation bands with hard-coded thresholds in a shader (`src/lib/look/glsl/ramps.ts:41-77`). Lake Thun is the visual subject of most demo photos, and it is never named. Neither are Thun, Interlaken, the Niederhorn ridge, the Aare, the huts, the cable car or the glaciers on the skyline. The In map and /roll 3D views have no names at all.

Terroir is the opposite of generic GIS symbology. It means the ground (rock and geology), the cover (ice, scree, forest, pasture, vine), the water, the human marks (alps, huts, paths, lifts), the local names in the local language, and the light and season of the moment. Switzerland has unusually good open data for every one of these, and almost all of it is free for commercial use with attribution: swissTLM3D land cover, swissNAMES3D names with classes and official/usual status, GLAMOS glacier outlines since 1850, GeoCover geology, cantonal vineyard cadastres. ESA WorldCover and Copernicus layers are pan-European fallbacks.

The proposal has four phases:

0. **Make the existing encodings honest and legible.** Absolute elevation, keyed. Swiss contour conventions. A label hierarchy. One colour grammar. Visible uncertainty. Days of work, mostly composite and UI.
1. **Replace invented land cover with real data.** A per-region "terroir pack" of land cover, names and glaciers, pre-baked like the OSM peak extract.
2. **Render that data organically.** The Imhof/Jenny–Hurni elevation × exposure colour LUT, scree stipple, forest texture, snow from the photo's date, and warm light/cool shade from the EXIF sun.
3. **Turn it into stories.** A "read this view" place card, glacier then-and-now, a line-of-sight profile through the vegetation belts, and a light-of-day track for camera rolls.

The rule that carries over from the aesthetics report still holds. The photo is evidence. On the matched photo, terroir is **selective and drawn**: names, outlines, stipple, ghosts. Full land-cover fills belong to Blend, In map, the roll map and the landing page.

## 1. Current state

### 1.1 Scorecard

| Dimension | State | Grade | Key evidence |
|---|---|---|---|
| Geometric truth (pose, depth, ridges) | Excellent; the product's core | A | status.md; ridges/skyline track the photo closely in every capture |
| Feature content | Peaks only. Trails optional and mostly ungraded. Water fetched and discarded | D | `upload/region.ts:48-50, 352-358`; region-0 has 2789/3844 trails with no `sac_scale` |
| Land cover | Synthetic elevation belts (treeline 1900, rock 2450, snow 2900 m), not regional, not seasonal, not by aspect | D | `look/glsl/ramps.ts:41-77`; WebGPU twin `deck-webgpu/layers/terrain-styles.ts:246-272` |
| Toponymy | Peak `name` only. No `name:fr/it/rm`, no bilingual forms, no hydronyms, settlements or regions, one face and case for everything | D | `geo/peaks.ts:63`, `region.ts:77-91` |
| Label hierarchy | Classic: one style for all peaks. Panorama layout: rank tiers at 1.14 : 1 : 0.88. Prominence filled on ~0.8 % of peaks, so ranking falls back to elevation | C− | `style/defaults.ts:135`, `look/labels/layout.ts:86-89, 397-399` |
| Elevation encoding | Default ramp `cool` (teal→magenta) on a **local** min/max. Lightness not monotonic. Same colour means 900 m in one photo and 3000 m in the next. No legend | D | `style/defaults.ts:14, 25, 42`; `style/ramps.ts:22-30` |
| Contours | 50 m with index every 5 (250 m). Swiss maps index every 100 m. No labels. At 20–50 km they stack into horizontal stripes | C | `settings.ts:39`, `defaults.ts:27`; screenshots |
| Colour grammar | Brand orange `#dca27a` also means viewpoint 0, selection, DEM match cue, hovered peak and cardinal letters. Plus four other oranges | D | `roll/mosaic/style.ts:8`, `PanoramaStrip.tsx:730,771`, `terrainLayer.ts:164,228` |
| Colour-blind safety | Slope classes and trails pass. Viewpoint vp0/vp5 (ΔE 0.018) and pose "fitted"/"solved" (ΔE 0.017) collapse under deuteranopia | C | `mosaic/style.ts:7-16, 43-53` |
| Map furniture | No scale bar, no north arrow in perspective views, no legend anywhere except Step Inside provenance. No attribution found on the /roll 3D map | D | grep; `roll-demo-map.png` |
| Uncertainty | Categorical pill or banner only. Unverified labels and contours draw at full certainty. Prior-pose wedges and frustums look the same as solved ones | C− | `PhotoWorkspace.tsx:858-861, 1268-1312`; `RollMiniMap.tsx:270-279` |
| Light and time | Sun computed from EXIF and used for shading in four presets. Never shown | C | `look/sun.ts:18-150` |
| Visual identity | Warm ink/paper/glow on site and roll pages vs cool slate/cyan in the workspace. Dead lagoon/shadcn tokens. 11 hard-coded near-blacks. Monospace as the house voice | C− | `styles.css:9-117`, `SiteNav.tsx:7` copied ×3 |
| Place-specific moments | RigiPanorama (discloses vertical exaggeration), TopoBoard on swisstopo Pixelkarte, Swiss trail and slope colours, Berann absolute ramp | B+ | `index.tsx:170-177`, `TopoBoard.tsx:159` |

### 1.2 What already works, and should be kept

- **The Berann absolute ramp** (`style/ramps.ts:83-92`, 400–3500 m) is the only nearly monotonic, ordinal elevation ramp in the codebase. Make it the template.
- **Slope classes** 30/35/40/45° (`defaults.ts:66-71`) are ordered, safe for red-green colour blindness, and match the swisstopo slope map. Avalanche-literate Swiss users will read them instantly.
- **Trail colours** follow Swiss signage: yellow hiking, red mountain, blue alpine (`defaults.ts:126-129`).
- **TopoBoard** (landing §03, `landing-02-scroll2400.png`). Polaroids on the swisstopo national map is the most "place" moment in the product. Its weakness is over-zoom: Pixelkarte is upscaled until "Niederhorn" and "1964" are 40 px tall and the linework turns blobby. Pick the tile zoom for the board's real scale, or use the vector base map.
- **The panorama strip's** true azimuth and elevation axes, with real DEM ridgelines (`PanoramaStrip.tsx:653-776`), make it the most honest chart in the app.
- **RigiPanorama** states its vertical exaggeration in the caption. That is good cartographic manners; keep it as a rule for every distorted view.
- **The look modules** already compute the inputs terroir needs: sun from EXIF, cast shadow, sky-view factor, curvature, generalised normals (`look/relief/field.ts`), nDSM (`concord/occl/ndsm.ts`), and lake polygons and levels (`geocam/lakes`).

### 1.3 Findings by surface (from the screenshots)

**Photo overlay** (`photo-demo09-default.png`, `photo-demo03-default.png`):

- **The default contours read as a technical overlay, not a map.** The cyan→magenta lines wrap the whole middle distance in horizontal stripes. At 20–50 km a 50 m interval is denser than the photo's own texture, so the far slopes look shuttered ("venetian blind"). The colour change from cyan to magenta looks meaningful but has no key and no fixed scale.
- **Contours are drawn the same way everywhere they appear:** over forest, pasture and cliff, and right up to the lake shore. A Swiss map would draw them brown on soil, black on rock, blue on ice, and leave the lake surface to its own symbology.
- **The labels are clean, but nothing ranks them.** Jungfrau (4158 m, a UNESCO landmark) is set in the same 12 px 600-weight white as Höhi Egg (1628 m). The grey `ele · dist` sub-line (10 px, 75 % white, `defaults.ts:136`) disappears against bright cloud ("4,078 m · 29.6 km" under Schreckhorn is barely legible).
- **What the photo shows goes unnamed.** In demo-03 Lake Thun fills a third of the frame and is the most saturated thing in it, and it has no label. The same is true of the Niederhorn ridge you stand on, the cable car, and the Bernese Oberland as a massif.
- **The presets change the overlay little, and the Swiss one makes it worse.**
  - `berann` overlay is visually the same as `classic`: same rainbow contours.
  - `swiss` turns the contours into dashed black-and-white "barcode" strokes that fight the photo.
  - `topo-ink` (dark contours) is the most map-like of the three, but still stacks into hatching at range.
  - So the presets' distinct character lives almost entirely in Blend and In map, while the preset chips all show the same cyan→magenta swatch (`StylePanel.tsx:143-181`).

**Blend** (`photo-demo09-blend-classic.png`): the lens reveals satellite imagery with **vertical texture streaks on the near slope**, where a top-down orthophoto is stretched over a face seen almost edge-on. A drawn land-cover class would read better there than an orthophoto. *(The `blend-swiss` and `blend-berann` captures caught the terrain still loading, 0/357 tiles, so they show nothing.)*

**In map** (`photo-demo09-inmap-classic.png`):

- The photo projected onto terrain becomes a large grey-blue sheet. Haze and distant slopes are smeared across the far terrain and dominate the scene.
- The satellite drape on the north cliffs of the Niederhorn shows vertical streaking.
- **No names at all.** Labels are cleared in world mode (`PhotoWorkspace.tsx:390-393`), and this is the view where a map reader most expects them.
- *(The `inmap-swiss` and `inmap-berann` captures stayed in overlay mode, so the capture script's mode switch didn't stick after `?style=`. I couldn't evaluate those two.)*

**/roll map** (`roll-demo-map.png`):

- Long photo-drape streaks run across Lake Thun ("Reach 8 km").
- No labels, no scale, no north arrow, and no attribution on the 3D map.
- The cameras are a small orange cluster that is hard to find at this zoom.

**/roll mosaic** (`roll-demo-mosaic.png`):

- The panorama strip is the best piece of data viz in the app. Its labels, though, are set in a heavy outlined canvas sans with monospace elevations, a different typeface from every other surface.
- The minimap uses OSM raster tiles, where the landing page uses swisstopo. "Niederhorn" appears twice, once from the tile and once from the overlay.
- The orange view wedges are large and opaque. They look like a measurement of visibility, which they aren't.

**Landing and library** (`landing-00-top.png`, `library.png`):

- Calm, dark, competent. The voice is a dev tool's: monospace eyebrows, a lucide icon grid, a single orange accent.
- The place-specific parts are the hero comparison, TopoBoard and RigiPanorama. The rest could belong to any SaaS product.

## 2. What "terroir" means for Rigi

Terroir is the set of physical and human facts that make one slope unlike another. For a registered mountain photo it has six layers. Each one maps onto data that exists and onto a cartographic convention that Swiss readers already know.

| Layer | What the reader learns | Convention to borrow | Data (CH / fallback) |
|---|---|---|---|
| **Ground** | What the mountain is made of: limestone Prealps vs gneiss and granite High Alps | Rock drawing and hachures in black (swisstopo); lithology tint (Atlas der Schweiz) | GeoCover V2 1:25k, GK500 / OneGeology |
| **Cover** | Ice, firn, scree, bare rock, forest (conifer, broadleaf, larch), alpine pasture, meadow, vineyard, orchard | Glacier blue contours and white fill; scree dots; forest green; vineyard hatching | swissTLM3D Bodenbedeckung, NFI vegetation height and leaf type, Rebbaukataster / WorldCover 10 m, CLC+ Backbone, HRL tree cover |
| **Water** | Lakes, rivers, falls, springs | Blue italic hydronyms; blue contour on ice and water | swissTLM3D, swissNAMES3D / OSM `natural=water`, `waterway` |
| **Human marks** | Alps (Alp, Staffel), huts, paths by grade, lifts, chapels, villages | SAC/swisstopo symbols; Swiss trail blazes; place hierarchy | swissTLM3D, swissNAMES3D / OSM `tourism=alpine_hut`, `aerialway`, `place` |
| **Names** | The local, official name in the local language, with its class (Gipfel, Grat, Pass, Gletscher, Alp, Flurname) | Swiss name typography: upright for settlements and peaks, italic for water, spaced caps for regions and massifs | **swissNAMES3D** (classes, `SPRACHCODE`, `STATUS` offiziell/üblich/informell, `NAMEN_TYP`) / OSM `name:*` + Wikidata |
| **Light and time** | When this was: sun angle, season, snow cover, glacier extent then vs now | Imhof warm light / cool shade; Woodruff seasonal relief | EXIF time + `look/sun.ts`; Copernicus HR Snow (FSC, 20 m, daily); GLAMOS SGI 1850/1931/1973/2010/2016/2023 |

Each layer has a different place to appear:

- **Overlay:** names, outlines, light marks only. The photo already shows the colours.
- **Blend and In map:** full fills, because the render *is* the map.
- **Roll map:** the cartographic overview.
- **Place card:** explanation in words.

## 3. Principles

1. **Data, not decoration.** Every colour on the terrain means a class or a value that came from a dataset. If no data is available, render neutrally and say so. Don't invent a treeline.
2. **The photo is the base map.** On the matched photo, add what the eye can't get from the pixels: names, classes, hidden structure, then and now. Never repaint what the pixels already show.
3. **Absolute and keyed.** Any colour that encodes a quantity uses a fixed scale with a visible key, and marks where the current photo sits on that key.
4. **Local names, in local form.** Official name in the local language first. The usual form or exonym second, in a lighter weight. Typography follows feature class.
5. **One colour grammar.** Hues are reserved for meaning:
   - blue: water and ice
   - green: vegetation
   - brown and black: ground and rock
   - signage colours: trails
   - brand glow: interaction only
   - one neutral, colour-blind-checked hue: "DEM truth" (match cues)
6. **Uncertainty is drawn, not just stated.** Marks soften as confidence drops, the far field first, since angular error grows with distance.
7. **Distortion is disclosed.** Vertical exaggeration, Berann bend and seasonal grading appear only outside the matched view, each with a caption.
8. **Display only.** Nothing in this doc feeds the matcher, pose, confidence, benchmarks or measurement exports (roadmap rule 3; `negative-results.md:55`: the snow tint hurt matching).

## 4. Proposals

Effort figures are estimates, not measurements. "Composite" means work in `src/lib/look/glsl/composite.ts` and the deck composite, which is the cheapest place to work in this codebase. A per-material change has to be written four times: three GLSL, deck GLSL, WGSL and CPU parity. Every new look ships as a **new preset** (working name `terroir`) or as a non-classic default. `classic` stays pixel-identical (roadmap rule 4).

### Phase 0: honest and legible (about 1–1.5 weeks, no new data)

| # | Change | Where | Why |
|---|---|---|---|
| T0.1 | **Absolute elevation by default in non-classic presets.** Use the Berann-style absolute range, add a slim vertical **elevation key** in metres, and bracket the photo's own visible range on it | `style/ramps.ts:123-133`, `defaults.ts:14`; new `Legend` component in the workspace | The relative `cool` ramp is unreadable and inconsistent between photos |
| T0.2 | **Contours to Swiss convention.** Index every 100 m (`majorEvery` derived from the interval: 10→10, 20→5, 50→2, 100→5). One ink colour varied only by width and opacity (warm brown on soil). Label index contours in Blend and In map | `defaults.ts:23-40`, `settings.ts:39`, contour shader | Cartographic convention, and a fixed meaning |
| T0.3 | **Interval adapts to range.** Thin contours by screen-space density: 50 m near, 100 m at 5–15 km, 250 m or off beyond about 20 km. Or fade to zero rather than to the current 0.3 floor | contour fade in composite | Removes the venetian-blind stripes, the most visible defect in every overlay capture |
| T0.4 | **Label hierarchy by prominence class, not rank.** Three classes with about a 1.6–1.8× size range. Backfill prominence from Wikidata or swissNAMES3D class (Hauptgipfel/Alpiner Gipfel/Gipfel/Felskopf) where OSM lacks it. Raise sub-line contrast with a halo or frosted pill | `look/labels/rank.ts`, `layout.ts:81-90`, `defaults.ts:135-136` | Jungfrau ≠ Höhi Egg. The sub-line is illegible on cloud |
| T0.5 | **Name the water.** Draw lake names (blue italic, placed along the water body's long axis) from the geometry `region.ts` already fetches and then throws away | `upload/region.ts:352-358`; label layout gets a `water` class | The biggest unnamed thing in most Alpine photos |
| T0.6 | **Labels in In map and on the roll map** (peaks and water), with depth-tested declutter | `PhotoWorkspace.tsx:390-393`, `roll-map.ts` | These views have no toponymy at all |
| T0.7 | **One colour grammar.** Brand glow only for interaction. A separate neutral "DEM truth" hue for match cues and ridges. Re-pick viewpoint colours for ΔE ≥ 0.05 under deuteranopia, with no brand hue. Add a glyph or pattern to pose-source states | `mosaic/style.ts`, `PanoramaStrip.tsx`, `terrainLayer.ts`, `TopoBoard.tsx` | Fixes the orange overload and the colour-blind collisions |
| T0.8 | **Draw uncertainty.** Prior-pose wedges and frustums dashed and widened by ±10°. While a pose is unverified, soften label and contour opacity, dash leaders, and fade the far field first | `RollMiniMap.tsx:270-279`, `roll-map.ts:820-838`, composite | MacEachren et al. 2012: blur, transparency and dashing are the most intuitive encodings of positional uncertainty |
| T0.9 | **Furniture.** Scale bar and north arrow on TopoBoard, the minimap and the roll map. Attribution on the roll 3D map. A small **sun/time chip** in the workspace ("15:39 · sun 228° / 38°") | site and roll components; `look/sun.ts` | Basic map honesty; makes the light visible |
| T0.10 | **Identity hygiene.** Move ink/paper/glow into `styles.css` tokens and drop the dead lagoon/shadcn sets. Bring the workspace onto the same palette. Use one label face on every surface (canvas included). Decide what Fraunces is for: geographic display names (massifs, viewpoints) or nothing | `styles.css:1, 9-117`, `SiteNav.tsx:7`, `terrainLayer.ts:149-182` | Two apps should feel like one |
| T0.11 | **Preset chips show the preset,** not the contour colour (for example, a thumbnail of the terrain ramp or relief) | `StylePanel.tsx:143-181` | Five presets currently show the same swatch |
| T0.12 | **Trail blazes.** White-red-white and white-blue-white as a cased tri-stripe. "Other" as thin grey dashed rather than white | `deck/trail-layer.ts`, `three-apply.ts:340-357` | The real Swiss mark. Frees white for ridges and leaders |

### Phase 1: real ground truth, the "terroir pack" (about 2–3 weeks)

Build a per-region, pre-baked bundle the way the OSM peak extract is built (`src/lib/osm/extract.ts`, `?osmextract=on`). Ship it as PMTiles or JSON next to the region, never as live queries.

| Component | Content | Source (CH → fallback) | Licence note |
|---|---|---|---|
| `cover` raster | Class texture (~10 m, 8-bit class id) in the DEM tile frame: glacier, firn/snow, rock, scree, forest-conifer, forest-broadleaf, shrub, pasture, meadow, vineyard, orchard, water, built | swissTLM3D Bodenbedeckung + NFI leaf type → ESA WorldCover / CLC+ Backbone + HRL leaf type | swisstopo OGD (attribution). WorldCover CC BY 4.0. Copernicus: name the source and say it was modified |
| `names` | Points, lines and polygons with class, language, status, name group | swissNAMES3D → OSM `name`, `name:*` + Wikidata | OGD. **Keep OSM names as a separate source and never merge them into the Swiss set** (ODbL derivative-database trap) |
| `glacier` | Outlines for 1850, 1973, 2016 and 2023, plus debris cover | GLAMOS SGI → RGI 7.0 | CC BY 4.0 / cite NSIDC |
| `geology` | Lithology polygons, simplified to 6–10 display classes | GeoCover V2 → GK500 | open-ref; check the per-sheet licence |
| `features` | Huts, passes and saddles, alps, lifts, chapels, viewpoints | swissTLM3D / swissNAMES3D → OSM | as above |
| `vine` | Legal vineyard perimeters | Cantonal Rebbaukataster (geodienste) | open, but check canton by canton |

Engine changes:

- **Replace `alpineAlbedo`'s constants with a class lookup,** keeping the procedural belts only as a fallback where no data is available. Do it in the deck path and the WGSL twin, then three, as parity requires.
- **Three-colour contours.** Brown on soil, black on rock and scree, blue on glacier and water, using the class texture in the contour shader. This is the cheapest "instantly Swiss" change in the doc.
- **Name classes drive typography:**

  | Class | Treatment |
  |---|---|
  | Hauptgipfel | bold |
  | Gipfel | regular |
  | Felskopf | small |
  | Grat, Massiv | spaced caps along the ridge |
  | Gletscher | blue spaced italic |
  | See, Fluss | blue italic |
  | Pass | regular + saddle glyph |
  | Alp, Flurname | small italic grey-brown, near field only |
  | Settlements | sized by place rank |

- **Multilingual policy** (Swiss naming instructions, 2011): show the `offiziell` local-language form. Show the `üblich` pair as the official slash form (Biel/Bienne). Show `informell` exonyms (Wetterhorn vs official Wätterhoren) on hover, or as a user-language option.
- **Ontology:** add `LandCoverClass`, `Toponym` (with language, status and class), `Glacier extent`, `Lithology` and `Landform` concepts (`ontology/catalogue/concepts.ts:146-230`), so the pack slots into the vocabulary rather than around it.

### Phase 2: organic rendering of the real data (about 2–3 weeks; Blend, In map, roll map, landing)

| # | Technique | Source | Notes |
|---|---|---|---|
| T2.1 | **Swiss colour relief LUT:** one 2D lookup `LUT[shade][elevation]`, with sunlit slopes running blue-green → olive → yellow → white and shade slopes running green-purple → blue-purple, flats masked so lowlands don't yellow | Jenny & Hurni 2006, from Imhof | One texture fetch. **Modulated by cover class** (cross-blended, Patterson & Jenny), so forest stays forest |
| T2.2 | **Scree stipple:** a blue-noise threshold against shading inside scree polygons, dots larger at the foot of the slope | Jenny et al. 2010 (Scree Painter) | Screen-space in composite; cheap |
| T2.3 | **Rock texture:** curvature- and gradient-aligned ink strokes on rock class only, darker on shade faces. A first step toward Swiss rock drawing, not an imitation of it | Jenny et al. 2014; Kyncl & Lysák 2024 (ladder hachures) | Experimental. Full Swiss rock drawing is still unsolved |
| T2.4 | **Forest texture:** tree-stroke or canopy noise keyed to NFI vegetation height; larch gold in October (leaf type × date) | Brown & Samavati 2017; Jenny 2013 | In map, landing, art renders |
| T2.5 | **Snow on the photo's date:** Copernicus HR Snow FSC for the capture day (cached COG). Fallback: procedural snowline by date, about 125 m × cos(aspect) offset, shedding above ~55° slope | Copernicus; Da Ronco & De Michele (single study, needs a Swiss validation) | Display only. Never the matcher (E2 killed) |
| T2.6 | **Warm light, cool shade** from the EXIF sun: shadow colour toward sky blue, lit faces toward the sun's colour at that altitude | Imhof; Woodruff seasonal relief | Already half there via `look/sun.ts` + the relief field |
| T2.7 | **Ortho→class crossfade on grazing slopes:** where the view ray is within ~15° of the slope plane, swap the stretched orthophoto for the class rendering | own synthesis | Fixes the vertical streaks in Blend and In map |
| T2.8 | **Roll map as a map:** default the basemap to swisstopo (CH) or cover-rendered terrain, add names, mute the photo drapes beyond the near field, show cameras as visible symbols | `roll/map/basemap.ts`, `roll-map.ts` | The current satellite view is a weak overview |

### Phase 3: storytelling (about 2–4 weeks, after Phase 1)

| # | Feature | What it shows | Built from |
|---|---|---|---|
| T3.1 | **"Read this view" place card** | Tap any pixel to get its name (with language and official form), class, elevation, distance, aspect, slope, cover, rock type, and glacier status then and now. The Burgundy *climat* pattern: name + geology + exposure + etymology | Range buffer → ENU → pack lookups |
| T3.2 | **Glacier then and now** | A ghost outline or translucent fill of the 1850 / 1973 extent, registered on the actual photo, with a year slider. The SRF Aletsch story on any user photo | GLAMOS, projected through the solved pose |
| T3.3 | **Line-of-sight profile** | An elevation profile from the camera to a tapped point, coloured by the cover belts it crosses (vine → forest → timberline → pasture → scree → ice) | DEM + cover |
| T3.4 | **Light of the day on the roll scrubber** | A thin sun-elevation band behind the time track with golden and blue hour marked. Compressed gaps labelled ("2 h") | `look/sun.ts`, `TimeScrubber.tsx:9, 149-157` |
| T3.5 | **Sun path on the photo** | Today's (or the capture date's) sun arc and the sunrise and sunset azimuths drawn above the skyline | `look/sun.ts`. PeakFinder already does this, so users expect it |
| T3.6 | **Geology section** (In map / landing) | A cross-section under the profile from GeoCover lithology | GeoCover |
| T3.7 | **Seasonal and time-of-day presets** for In map and landing (golden hour, blue hour, winter, larch autumn) | A palette texture plus the light setting, as in the frontier report's palette material | T2.1 + T2.6 |

### Where each layer may appear

| Element | Overlay (matched photo) | Blend | In map / roll map | Landing / share |
|---|---|---|---|---|
| Names (all classes) | yes, near-field classes by distance | yes | yes | yes |
| Cover fills | **no** (outlines and stipple only, opt-in) | yes | yes | yes |
| Three-colour contours | yes | yes | yes | yes |
| Glacier ghost | yes (opt-in, labelled with the year) | yes | yes | yes |
| Snow on the date | no | yes | yes | yes |
| Seasonal and time-of-day grades | no | no | yes, captioned | yes, captioned |
| Vertical exaggeration / Berann bend | never | never | world only, captioned | captioned |
| Uncertainty softening | yes | yes | camera symbols | n/a |

## 5. How to evaluate it

1. **A frozen still set.** About 20 dev-split photos (wild benchmark dev, never test), rendered in overlay, Blend and In map for `classic`, the current best preset, and `terroir`. Re-render after each phase. The capture script used for this doc needs its mode switch fixed first (the Blend and In map captures with `?style=` failed).
2. **Legibility tasks, timed.** "Which peak is the highest?", "Name the lake", "Is this slope above 35°?", "Is that glacier larger or smaller than in 1973?" Measure time and accuracy, five people or more. Grouped-label studies show this design moves task time measurably (Park et al. 2025, cited in the frontier report).
3. **Blind pairwise preference,** as the frontier report proposes, run in the same session.
4. **Automated checks:**
   - a colour-blind ΔE check in CI over every categorical palette (port the auditor's Oklab and Machado script into `scripts/style-check.ts`)
   - a monotonic-lightness check on every ramp marked ordinal
   - a WCAG contrast check for label text over the photo's local luminance
5. **Parity.** Style baseline: `classic` stays pixel-identical; `terroir` gets its own pinned baseline. EVAL is unchanged by construction.

## 6. Risks and traps

- **The ODbL share-alike trap.** Mixing OSM polygons into a swissTLM3D-derived database that Rigi serves makes the combination a derivative database. Composite separate sources at render time, and pre-extract them separately.
- **Licence ambiguities to settle before shipping:**
  - The swisstopo base vector tiles are labelled "commercial use requires permission" on opendata.swiss, which contradicts the OGD statement; ask swisstopo.
  - Per-canton Rebbaukataster terms.
  - The NFI leaf-type licence.
  - Arealstatistik terms per resource.
  - EOX Sentinel-2 cloudless after 2016 is **CC BY-NC-SA**; don't use it.
- **Snowline and treeline constants** need checking against Swiss data. The 250 m north/south snowline offset comes from one Italian MODIS study.
- **Over-drawing the photo.** Every Phase 1–3 element is off on the matched overlay unless listed in the table in §4. Test the overlay with the user's own photos before widening it.
- **Data age.** GeoCover is still being updated (complete by 2030). The Klimaeignungskarte dates from the 1970s, so don't present it as current terroir. Glacier outlines carry a year label, always.
- **Coverage outside CH.** WorldCover and RGI give an honest but coarser look. Show a small "data: CH national / EU 10 m / none" provenance chip rather than pretending to be uniform.
- **Cost of four implementations.** Prefer the composite and screen space (contours, stipple, labels, ghosts). Put per-material changes (cover lookup, LUT) in the deck and WGSL paths first, and the three path at parity only.

## 7. Suggested order

1. **Phase 0** first (T0.3 contour thinning, T0.1 absolute key, T0.4–T0.6 names, T0.7 colour grammar). It needs no new data and fixes what every screenshot shows.
2. **Terroir pack spike** for one region (Niederhorn / Thunersee, which the demo roll covers): swissNAMES3D + TLM cover + GLAMOS, baked by a script under `scripts/terroir/`. Prove three-colour contours and name classes on the demo roll.
3. **T3.2 glacier ghost and T3.1 place card** on the demo roll. They are the most distinctive stories, and nobody else can register them onto a user's own photo.
4. **Phase 2 rendering** for In map, the roll map and the landing page, together with the frontier report's palette material and projective tween.

## 8. Decisions for the owner

1. Ship a `terroir` preset first, or fold Phase 0 into the frontier report's "signature" default?
2. Use swisstopo vector base tiles (after asking about the licence ambiguity), or bake everything from swissTLM3D ourselves?
3. Name language default: local official (the Swiss rule), or the user's language with the official name second?
4. Is the glacier ghost allowed on the matched overlay (opt-in, year-labelled), or only in Blend and In map?
5. Coverage target outside Switzerland for v1: CH only, CH + Alpine EU (WorldCover/RGI), or global?

## 9. Implementation status (2026-10-01)

Everything is **additive**. It lives in a new `terroir` section of `ViewStyle` (`src/lib/style/types.ts` `TerroirStyle`) and a new **Terroir** preset. Classic and every other preset switch it all off, so classic stays pixel-identical. The shader sources are proven byte-identical with terroir off by `scripts/terroir/shader-identity-snap.ts`. A **Terroir** sidebar section (`src/lib/terroir/ui/TerroirPanel.tsx`) turns each layer on or off on top of any preset. Choosing the Terroir preset also switches Blend and In map to Relief (`PRESET_MAP_LAYERS`), because land cover shows on the relief rendering, not on satellite imagery.

| Plan item | State | Where |
|---|---|---|
| Terroir pack (phase 1) | **Built for Thunersee / Bernese Oberland.** Bbox 7.35–8.25°E, 46.45–46.95°N. Contents: 2,949 swissNAMES3D names (classes, language, official/usual status, pairs), a 25 m land-cover PNG (VECTOR25 + OSM + DEM rules), GLAMOS SGI glacier outlines 1850/1931/1973/2016/2023 with per-vertex heights, and GK500 lithology | `scripts/terroir/build-pack.ts`, `public/terroir/`, contract `src/lib/terroir/types.ts`, loader `pack.ts` |
| T0.1 legend | Built: elevation key with the in-view range bracket, contour/index key, soil/rock/ice inks, cover classes in view, credits | `terroir/ui/Legend.tsx` |
| T0.2 Swiss index | Built: index contours on round 100 m (uniform override) | `terroir/glsl/values.ts` |
| T0.3 contours thin with range | Built (deck WebGL): nested levels 50 → 100 → 200 → 1000 m by range | `terroir/glsl/terrain.ts` |
| T0.4 peak tiers, legible sub-line | Built: prominence class (backfilled from swissNAMES3D) drives size and weight; sub-line pill | `terroir/labels/peakTiers.ts`, hooks in `look/labels/*` |
| T0.5–T0.6 names | Built on the photo views: lakes and glaciers on their visible surface; settlements, passes, huts, ridges, massifs typed by class; reach limits; dedupe against peaks. On the /roll 3D map as a TextLayer. **Not in In map** (the world camera is not exposed through `Renderer`) | `terroir/labels/placeNames.ts`, `ui/NamesSvg.tsx`, `terroir/roll/` |
| T0.7–T0.8 colour grammar, uncertainty | Partly built. Built: pose-source glyphs; prior poses dashed with ±10° fans (minimap, 3D map); softened labels while unverified. Not done: re-picked viewpoint palette and unified UI tokens (they would replace existing colours) | `terroir/roll/`, `PhotoWorkspace.tsx` label hooks |
| T0.9 furniture | Built: compass ribbon, sun/time chip, range ticks; scale bar and north arrow on the minimap and TopoBoard; attribution, north arrow and camera halos on the roll 3D map | `ui/Furniture.tsx`, `terroir/roll/MapFurniture.tsx` |
| T0.12 trail blazes | Not built. df's trail `dash` (U2) landed separately | — |
| Phase 1 three-colour contours | Built (deck WebGL): ink from the cover class; no lines on water | `TERROIR_CONTOUR_INK` |
| T2 cover albedo, snow for the date, warm/cool light | Built (deck WebGL): class colours with canopy/scree texture and organic edges; date snowline ±125 m by aspect; cliff cross-fade on satellite imagery | `TERROIR_COVER`, `TERROIR_SNOW` |
| T2.8 roll map as a map | Partly built: names, attribution, compass, halos. Basemap default unchanged | `terroir/roll/RollMapTerroir.tsx` |
| T3.1 / T3.3 place card + line-of-sight profile | Built: tap anywhere for elevation, range, slope, aspect, cover, rock, glacier history, nearest names, sun incidence, and a DEM profile coloured by cover | `ui/PlaceCard.tsx`, `viz/profile.ts` |
| T3.2 glacier then and now | Built: closest extent to the chosen year, plus the latest; near outlines, far soft fills; one tag | `ui/GlacierGhost.tsx` |
| T3.4 light of the day | Built: sun-elevation band, sunrise/noon/sunset ticks, labelled gaps on the roll scrubber | `terroir/roll/LightBand.tsx` |
| T3.5 sun path | Built: arc for the capture date with hour ticks and sunrise/sunset azimuths | `ui/SunPath.tsx` |
| T3.6–T3.7 geology section, seasonal presets | Not built | — |
| WebGPU renderer | **Shading pending.** While a terroir shading switch is on, `auto` resolves to WebGL deck (2f9ffd5); a WGSL port is in progress. The SVG overlays work on every engine | `src/lib/renderer-select.ts` |
| three.js | Hooks were written but are being dropped with the three engine (nothree) | — |

**Checks.** The CI fast tier gains `terroir-labels`, `terroir-viz`, `terroir-roll` and `terroir-pack`.

**Screenshots.** `out/carto-eval/terroir-*.png` (gitignored).

**Known limits:**
- A lake label can land on a near building that hides the lake (the DEM has no buildings; C4's nDSM would fix it).
- Pack coverage is Thunersee only; rebuild for other regions with `build-pack.ts`.
- Vineyard and orchard are nearly absent (OSM is thin here).
- GK500 geology is coarse.
- The snowline curve is an engineering default.
- In Satellite mode the near-slope ortho streaks remain.

## Sources

**Canon**
- Imhof, *Cartographic Relief Presentation* (1965/1982).
- Jenny & Hurni, [Swiss-style colour relief shading](https://mail.colororacle.org/berniejenny/pdf/2006_JennyHurni_SwissStyleShading.pdf) (2006).
- Jenny et al., [Design principles for Swiss-style rock drawing](https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf) (2014).
- Jenny et al., [Scree](https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf) (2010).
- Patterson, [Berann](https://cartographicperspectives.org/index.php/journal/article/view/cp36-patterson).
- Patterson & Jenny, [cross-blended hypsometry](https://cartographicperspectives.org/index.php/journal/article/view/cp69-patterson-jenny).
- Brown & Samavati, [Real-time panorama maps](https://diglib.eg.org:443/handle/10.2312/npar2017a06) (2017).
- Kyncl & Lysák, [ladder hachures](https://ica-abs.copernicus.org/articles/7/81/2024/ica-abs-7-81-2024.pdf) (2024).
- Woodruff, [seasonal relief](https://andywoodruff.com/blog/seasonal-relief/).
- Jenny et al., [Eduard](https://arxiv.org/pdf/2010.01256) (2020).

**Data**
- [swissTLM3D](https://opendata.swiss/en/dataset/swisstlm3d)
- swissNAMES3D ([ProdInfo 2026](https://www.swisstopo.admin.ch/dam/de/sd-web/lXacsGJI7k9t/2026%20swissNAMES3D%20ProdInfo-DE.pdf))
- [GeoCover](https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.geologie-geocover)
- [GLAMOS](https://doi.glamos.ch/)
- [NFI vegetation height](https://envidat.ch/dataset/vegetation-height-model-nfi)
- [Rebbaukataster](https://www.geodienste.ch/services/lwb_rebbaukataster/info)
- [ESA WorldCover](https://registry.opendata.aws/esa-worldcover-vito/index.html)
- [CLC+ Backbone](https://land.copernicus.eu/api/en/products/clc-backbone/clc-backbone-2021)
- [Copernicus HR Snow](https://www.wekeo.eu/use-cases/new-copernicus-near-real-time-products-for-snow-and-ice-monitoring)
- [RGI 7](https://nsidc.org/data/nsidc-0770/versions/7)

**Licences**
- [swisstopo OGD conditions](https://www.swisstopo.admin.ch/en/conditions-geodata)
- [OSMF licence FAQ](https://osmfoundation.org/wiki/Licence_and_Legal_FAQ)
- [EOX cloudless licensing](https://eox.at/2025/03/sentinel-2-cloudless-2024/)

**Naming**
- [Weisungen geografische Namen](https://www.cadastre-manual.admin.ch/dam/it/sd-web/4SE6MyxeDpLv/Weisungen-geografische-Namen-de.pdf) (2011).

**Uncertainty**
- MacEachren et al., [TVCG 2012](https://geography.wisc.edu/cartography/projects/publications/MacEachrenEtAl_2012_TVCG.pdf).
- Padilla, Kay & Hullman (2020).

**Verification gaps** (carried over from the research brief): no swissTLM3D 2.2 object catalogue opened, no Lavaux or Valais wine-map style guide found, and no primary style specification for Alpenvereinskarten or IGN TOP25.
