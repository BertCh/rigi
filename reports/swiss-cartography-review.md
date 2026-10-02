<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Swiss cartography: canon, reference plates and Rigi against them

*2026-10-01. Review, no code changed. Master was at bab0f28, plus the uncommitted tree.*

This is the hub document for the Swiss look. It covers three things:
- the canon (history, relief, rock, contours, colour, type, furniture, panoramas), illustrated with published Swiss maps;
- what Rigi's Landeskarte default and its siblings actually render;
- a ranked list of fixes.

Topic-specific detail stays in the older reports:
- [gipfelbuch-design-book.md](gipfelbuch-design-book.md): typography, notebook and the 60-rule programme;
- [gipfelbuch-hand-sketch-research/swiss-cartography.md](gipfelbuch-hand-sketch-research/swiss-cartography.md): the LK symbol table and Kroki conventions;
- [terroir-cartography.md](terroir-cartography.md): content and data, land cover and names;
- [Geospatial rendering aesthetics frontier.md](<Geospatial rendering aesthetics frontier.md>): photo-overlay polish;
- [wave5-plan-2026-10-02.md](wave5-plan-2026-10-02.md): what wave 5 built.

**Evidence.**
1. A web research pass (74 sources). Claims carry **[V]** when the source document was read, **[S]** when only a search summary was seen, and **[U]** when unverified. Unmarked claims are [V].
2. A read-only code audit of `src/lib/{style,look,terroir}`, both shader dialects, `src/brand`, `src/components/gipfelbuch/swiss` and `examples/deck/landeskarte`. The headline file:line claims were re-checked by hand.
3. 18 reference plates in [swiss-cartography/img/](swiss-cartography/img/), with their sources and licences in [SOURCES.md](swiss-cartography/img/SOURCES.md).

No Rigi screenshots are included: cook mode (`reports/batch-ledger.md`) forbids browser runs. §6 sets out how to make the missing side-by-side comparison in the next batch pass.

## Summary

**The canon in one paragraph.** The Swiss manner is a white sheet. Form is carried by four things:
- **grey relief shading**, lit from the north-west, adjusted locally, with contrast rising with altitude and no cast shadows;
- a faint **yellow sun tone** on lit slopes, masked off rock, ice and scree;
- **black rock drawing**: a skeleton of edge strokes, filled with hachures that are denser on shaded faces;
- **contours whose ink follows the surface**: brown on soil, black on scree, blue on ice and lake.

Colour is spent on a few things only: water (pale blue fill, blue line, blue italic names), forest (light green), and since 2014 red rail and coloured road fills. Lettering is a strict hierarchy, Frutiger since 2014 and swisstopo's own LK Roemisch and LK Kursiv before that. Hydrography and height figures are italic. Imhof's school adds aerial perspective (plains soft and cool, summits hard and bright) and colour relief driven by elevation × illumination.

**Rigi against it.** The pieces are mostly built, and built well:
- an Imhof relief, generated for both engines from one source;
- Landeskarte-style hachure and scree;
- surface-coloured contour ink;
- index contours every 100 m;
- swisstopo label typography;
- a full Gipfelbuch sheet system;
- a faithful flagship example.

The default experience still does not look like a Swiss map, for five reasons:
1. **The relief, hachure and tint only render in the hillshade map style.** The default is satellite, so a new user sees none of them.
2. **The default contours are 50 m brown lines over a navy-black casing** inherited from Classic. The surface-coloured contour ink is off.
3. **The ground is a green-to-ochre elevation tint** (Patterson/Berann), not white paper with relief.
4. **Several inks are scattered copies** of slightly different values across about six modules.
5. **None of it has been checked in a browser.** The GLSL (WebGL2 fallback) versions of the Imhof relief and hachure v2 have never been compiled.

Of the ten recommended fixes in §5, five are small: preset data, one table entry, and a hachure light vector. Together they close most of the visible gap.

---

## 1. Lineage, in plates

### 1.1 Dufour map, 1845–1865 (1:100 000)

<img src="swiss-cartography/img/commons-dufour-xviii-aletsch-1854.jpg" width="49%" alt="Dufour sheet XVIII, Aletsch area, 1854: steel-engraved hachures under oblique light"> <img src="swiss-cartography/img/dufour-jungfrau-z15.jpg" width="49%" alt="Dufour map via swisstopo WMTS, Jungfraujoch">

*Left: Blatt XVIII Brieg–Airolo, 1854. Engraved by H. Müllhaupt, Dufour direxit. Public domain, scan via Wikimedia Commons. Right: the same map from swisstopo's journey-through-time WMTS (`ch.swisstopo.hiks-dufour`), © swisstopo.*

- **Format:** 25 sheets of 70 × 48 cm, monochrome copper intaglio. The mean planimetric error is 153 m, which is 1.5 mm on the map.
- **Light:** the "Dufour system" uses **shadow hachures under oblique north-west light**. Strokes are thinned on lit north-west slopes and full on shaded ones [V].
- **The precedent for Rigi:** shaded faces drawn dense and lit faces drawn sparse is the same light logic the LK rock drawing keeps. It is the precedent for keying our hachure density to a fixed map light, not the real sun (§3, D4).

### 1.2 Siegfried atlas, 1870–1926, revised until 1949 (1:25 000 / 1:50 000)

<img src="swiss-cartography/img/commons-siegfried-jungfrau-1872.jpg" width="49%" alt="Siegfried sheet 489 Jungfrau, 1872"> <img src="swiss-cartography/img/siegfried-jungfrau-z15.jpg" width="49%" alt="Siegfried via WMTS, Jungfraujoch">

*Left: sheet 489 "Jungfrau", 1872, Leuzinger lithograph, public domain. Right: `ch.swisstopo.hiks-siegfried`, © swisstopo.*

- **Sheets and contours:** 462 + 142 sheets. Contours are 10 m at 1:25k and 30 m at 1:50k.
- **Three inks: the rule we still follow:**
  - **brown** contours on vegetated ground;
  - **blue** for water and for contours on glaciers;
  - **black** for everything else, including rock.
- **No relief shading.** That gap is why the SAC kept printing its own shaded maps.

### 1.3 Landeskarte (LK), 1938 to today

<img src="swiss-cartography/img/zeitreihen-1955-niederhorn-z15.jpg" width="49%" alt="Niederhorn in the 1955 time series"> <img src="swiss-cartography/img/lk-colour-niederhorn-z15.jpg" width="49%" alt="Niederhorn, current national map 1:25k">

*The Niederhorn, the demo roll's home ground, then and now. Left: `ch.swisstopo.zeitreihen` at 1955-12-31. Right: `ch.swisstopo.pixelkarte-farbe`, current. Both © swisstopo.*

The 1955 plate still shows a pre-LK25 sheet (Siegfried-style serif lettering). LK25 coverage was only completed in 1979, so that is plausible, but it is unverified which edition the tile shows. Things to compare between the two plates:
- the brown contours with bold index lines;
- the green forest;
- the black cliff drawing on the Niederhorn flue;
- the serif and Fraktur-era names against the 2014+ Frutiger;
- the red cable-car line and the pink-red boundary band.

**Facts:**
- **The law:** 1935, after Imhof's "map war".
- **The series:**
  - LK50 from 1938 (sheet 263 Wildstrubel), 78 sheets;
  - LK25 from 1952 (sheet 1145 Bielersee) to 1979, 247 sheets;
  - LK100 1954–65, 23 sheets.
- **Six-year revision cycle** since 1968.
- **Production chain** [V, Gilgen 2024]:
  - scribing in red lacquer on glass from 1953, one plate per ink: black, blue, brown, green;
  - masks for the lake and forest tones;
  - the relief **airbrushed in black ink**;
  - a **deletion mask that keeps the yellow sun tone out of rock, scree and glacier**;
  - lettering phototypeset in swisstopo's own **LK Roemisch / LK Kursiv**.
- **Rock work today:** only about three "Felsiers" still update rock by hand.
- **The 2014 redesign (TLM-based, 2001–2021):**
  - Frutiger lettering;
  - red rail;
  - coloured road fills;
  - boundaries as broad coloured bands;
  - slightly larger minimum sizes.
- **What 2014 kept:** "rock, scree, relief and sun tone", which is the Swiss style proper.
- **LK10:** rasterises and thins the hand-drawn LK25 rock rather than redrawing it.

### 1.4 The high Alps: what the LK actually does with rock and ice

![Jungfraujoch at z15, three panels: national map, swissALTI3D relief, SWISSIMAGE](swiss-cartography/img/composite-jungfrau-lk-relief-swissimage-z15.jpg)

*Jungfraujoch, one extent and three layers. From left: the 1:25k national map, the swissALTI3D relief shading, the SWISSIMAGE orthophoto. All © swisstopo.*

This is the key plate for Rigi's renderer. The map (left) is **not** a stylised version of the photo (right):
- **Ice becomes white paper with blue contours.** On the map, index contours are labelled in blue italic (2800, 3400). Short blue strokes stand for crevasses.
- **Rock becomes black skeleton strokes plus hachures.** The drawing is denser on faces turned away from the north-west light, whatever the photo's sun did.
- **The relief tone is a soft blue-grey** that stays out of the way of the line work.

<img src="swiss-cartography/img/lk-colour-jungfrau-z13.jpg" width="49%" alt="Jungfrau region overview z13"> <img src="swiss-cartography/img/lk-colour-niederhorn-z13.jpg" width="49%" alt="Thunersee north shore overview z13">

*Overview scale (z13). Left: the Jungfrau, Mönch and Lauterbrunnen. Right: Thunersee, Spiez and the Niederhorn. Note the spaced blue italic "Thuner See" and the sparse contours. © swisstopo.*

### 1.5 Variants swisstopo ships for screens

<img src="swiss-cartography/img/lk-grey-jungfrau-z15.jpg" width="32%" alt="Grey national map"> <img src="swiss-cartography/img/lk-winter-jungfrau-z15.jpg" width="32%" alt="Winter national map"> <img src="swiss-cartography/img/light-basemap-relief-jungfrau-z15.jpg" width="32%" alt="Light base map relief">

*From left: grey national map (`pixelkarte-grau`), winter map (`pixelkarte-farbe-winter`) and the light base map relief (`leichte-basiskarte_reliefschattierung`). © swisstopo.*

The light base map is the closest published precedent for a **quiet base under overlays**: thin grey hachures, blue crevasse ticks and a pale blue-grey relief. That is the role Rigi's Landeskarte look plays under a photo.

### 1.6 Relief data, and the Imfeld school

<img src="swiss-cartography/img/relief-swissalti3d-niederhorn-z14.jpg" width="32%" alt="swissALTI3D relief, Niederhorn"> <img src="swiss-cartography/img/relief-swissalti3d-jungfrau-z14.jpg" width="32%" alt="swissALTI3D relief, Jungfrau"> <img src="swiss-cartography/img/commons-imfeld-montblanc-1896.jpg" width="32%" alt="Imfeld, La Chaîne du Mont-Blanc, 1896">

*swissALTI3D hillshade at the Niederhorn and Jungfrau (© swisstopo; swisstopo publishes a north-west mono-directional and a six-light multidirectional version). Right: Xaver Imfeld, "La Chaîne du Mont-Blanc", 1896, public domain (Imfeld died 1909). It shows the painted, north-west-lit, tinted relief that Imhof systematised.*

Eduard Imhof's own maps and panoramas are in copyright until the end of 2056 and are not reproduced here. See *Cartographic Relief Presentation* (Esri Press reprint, 2007).

---

## 2. The canon, as implementable rules

Each rule has a number (C1, C2, …) so §3 and §5 can refer to it.

### 2.1 Relief shading

| # | Rule | Source |
|---|---|---|
| C1 | Light from the north-west, about 45° elevation. Adjust it locally so that both flanks of a ridge separate: Imhof lit a north-west-trending range from the west | Jenny et al. 2021 [31]; canton of Schwyz relief spec [32] |
| C2 | Brighten or darken whole landforms so the main structure reads | [31] |
| C3 | Flats and lakes take a uniform mid-grey | [31] |
| C4 | No cast shadows in plan view | [31] |
| C5 | Aerial perspective: the lit/shade contrast **rises with elevation**. Plains are soft, the Jura medium, the high Alps hardest | [31], [7] |
| C6 | "Higher is brighter". Lowlands cool and hazy, lit slopes warm, shadows cool violet-blue | Imhof via Jenny & Hurni 2006 [7] |
| C7 | The sun tone is the **negative of the grey relief**. Apply it as yellow on lit slopes, masked off flats, rock, ice and scree. Live swisstopo style: `rgb(255,235,5)` at **4 %**, on lit slopes only | [7], [27], [17] |
| C8 | The relief is a **cool blue-grey** ramp drawn on shaded slopes only, from `#adbcc7` to `#fbfcfc`. Lit slopes stay paper | [27] |
| C9 | Generalise by scale: keep the sharp ridges, drop small detail | [31] |

Digital recipes worth stealing:
- **The Jenny & Hurni 2006 colour LUT.** It is 256 grey levels × 256 elevations → RGB, filled from 5–10 control colours with Gaussian weight exp(−0.0002·d²). It is one 2-D texture lookup per pixel on the GPU.
- **MDOW** (Mark 1992). Four lights at 225, 270, 315 and 360°, weighted by sin²(aspect − azimuth).
- **Sky models** (Kennelly & Stewart 2014). Keep a directional component, or isolated peaks go flat.
- **The Mapzen spheremap** (matcap) hillshade.
- **Patterson's texture-shading rock recipe:** Hard Light at 200/−2, slope-masked.
- **Plan oblique relief** at about 45° (Jenny & Patterson 2007). The earliest example is Imfeld's 1887 *Reliefkarte der Centralschweiz*.
- **Eduard.** U-Nets trained on swisstopo's manual relief, sold as an app. The weights are not open, so it is a reference rather than a dependency.

### 2.2 Rock, scree, glacier

Rock (Jenny, Gilgen, Geisthövel, Marston & Hurni 2014 [48]):

| # | Rule |
|---|---|
| C10 | Draw rock **as a climber sees it**, not orthographically: faces, bands and gullies |
| C11 | Use three stroke types: **contour strokes** (edges), **shape strokes**, and **fill hachures**. The first two form the **skeleton**, which is drawn first |
| C12 | The main light is north-west, with a **secondary west-north-west light on rock**. North-north-west only exceptionally |
| C13 | Strokes **never cross**, with a gap of at least 0.3 mm. **4–5 strokes per 2 mm on lit faces and 9 on shaded ones.** On steep lit faces, hachures turn away from the fall line |
| C14 | Stroke widths: 0.06–0.10 mm on lit faces (may be broken). 0.22 mm at the foot to 0.26 mm at the top on shaded faces. Mean about 0.12 mm |
| C15 | The cost is about 1 hour per cm², or about 2 000 hours per mountain sheet. There is no published real-time GPU Swiss rock renderer **[U, none found]**: an open frontier |

Scree, glacier and moraine:

| # | Rule |
|---|---|
| C16 | **Scree** dots are irregular polygons whose **size and density follow the light**. They grow larger downslope and in gullies (Jenny, Hutzler & Hurni 2010 [52]) |
| C17 | **Glacier:** white paper with blue contours, blue crevasse strokes and blue italic names. The sun tone is masked out. Moraine is drawn as black scree stipple |
| C18 | **In rock, only the 100 m contours are kept** (2008 legend: "Rock with 100 m contour lines") |

Automation precedents:
- Geisthövel & Hurni 2018: DEM + rock mask + light → skeleton → vector hachures.
- Gilgen & Jenny 2010: vector rock and scree.
- swisstopo LK10: rasterise the existing hand-drawn rock.
- Andreas Neumann (ETH IKG), QGIS UC 2026: rock as orientation-following line-pattern fills from Swiss Map Vector 25.

### 2.3 Contours

Intervals, from the 2008 *Conventional Signs* legend [53]:

| Scale | Normal | Index | Intermediate |
|---|---|---|---|
| LK25 | 10 m (Jura, Plateau), **20 m (Alps)** | **100 m** | 5 / 10 m, dashed |
| LK50 | 20 m | 200 m | 10 m |
| LK100 | 50 m | 200 m | 25 m |

| # | Rule |
|---|---|
| C19 | Contour ink follows the surface: **brown on soil, black on scree, blue on ice and lake** (lake contours give depth) |
| C20 | Index labels are **italic, in the line's own ink**. They break the line and sit on a halo. They read uphill **[U for LK specifically; general practice]** |
| C21 | Screen values from the live style: basemap soil `rgba(180,110,13,0.35)`, scree `rgba(0,0,0,0.25)`, ice and lake `rgb(77,164,218)` at 0.30–0.47. Labels: soil `rgb(171,126,64)`, scree `rgb(70,70,70)`, water `rgb(47,134,188)` |

### 2.4 Colour

- **No official CMYK, Pantone or hex values for the LK inks are published [U].** The live swisstopo MapLibre styles are the authoritative digital reference [27]: basemap v1.26.0, light v1.19.0, winter v1.19.0, at `vectortiles.geo.admin.ch/styles/<id>/style.json`. Do not invent "official" ink values. Sample those styles or the `pixelkarte-farbe` tiles instead.
- **Plates:**
  - Siegfried: 3 inks.
  - LK on glass: black, blue, brown and green lines, plus lake tone, forest tone, grey relief and the yellow sun tone.
  - Since 2014: red rail and road fills.
- **Area colour is rare:** forest (light green with a dark-green edge), lakes (pale blue), settlement (black buildings). **There is no elevation tint on the LK.** Hypsometric tints belong to Imhof's school and small-scale atlases (C6), not to the national map.

### 2.5 Typography

| # | Rule |
|---|---|
| C22 | **Typefaces:** LK Roemisch and LK Kursiv in 1952–2013. **Frutiger since 2014**: the live styles use Frutiger Neue Condensed Regular, Medium and Bold, Frutiger Neue Regular and Medium, and Frutiger Neue Italic. Frutiger is commercial, and the fonts are not OGD |
| C23 | **Hierarchy:** municipalities upright, hamlets italic. Mountains and valleys medium weight. Regions light and letter-spaced. Glaciers and water blue italic. Large rivers in spaced capitals. **All height figures sloped** |
| C24 | Imhof, *Positioning Names on Maps* (1962/1975): legible; clearly associated with the feature; never over important content; shows the feature's extent; hierarchy carried by the type; names neither crowded nor evenly scattered. Area names letter-spaced across the area; ribbon areas labelled along their axis |

A further point, which is not a rule: Biniek et al. (ICA 2018) criticised the switch to sans-serif as not reflecting Swiss typographic culture. Rigi's stand-ins are Fira Sans and Fira Sans Condensed, which is defensible.

### 2.6 Map furniture

- **Grid:** a km grid on LK25 and LK50, 10 km on LK100.
- **Coordinates:** written in LV95 (`2 600 000 / 1 200 000` origin), larger value first, with spaces.
- **Margins:** scale bar in the bottom margin; declination (meridian convergence plus magnetic declination) in the bottom-right margin.
- **Dates:** the title date is the year of publication. "Stand" is the date of the content, printed inside the map.
- **Unverified:** frame tick spacing, line weights, and whether a north arrow is printed **[U]**.

### 2.7 Panoramas: Swiss school against Berann

- **Swiss (Heim, Imfeld):**
  - drawn from a real station in **true perspective**, as a survey document;
  - outline plus restrained tone;
  - peaks named above the skyline with leaders.
  - The exact leader rules are **[U]**: no primary text was found.
- **Berann** (Austrian; Patterson 2000):
  - picture plane tilted, then **curved convex from about two-thirds of the way back**;
  - selective vertical exaggeration, mountains rotated, valleys widened (Yosemite +220 %);
  - light perpendicular to the structural trend;
  - warm foreground against a cool background, saturated, painterly.
- **For Rigi:** the photo overlay is necessarily Swiss school (survey-true, because the photo is evidence). Berann belongs in the world view and on the landing page. Plan-oblique bending stays deferred: wave 5 found it breaks culling, picking and geo-query.

---

## 3. Rigi against the canon

"Default" means `presetStyle("swiss")`, the **Landeskarte** look. `src/lib/style/store.ts:26-27` makes it the default. Its look key is `LOOK_ALPINE, LOOK_HARMONIZE, LOOK_INK, LOOK_RELIEF`.

### 3.1 Scorecard

| Element | What Rigi does (default) | Canon | Grade |
|---|---|---|---|
| Light direction | Fixed 315°/45° cartographic light, z-factor 1.6; the photo sun has weight 0.15 only (`look/glsl/relief.ts:45-59, 121`; `look/imhof.ts:25-26`) | C1 | A |
| Multidirectional, local adjustment | MDOW at 225/270/315/360°; Imhof aspect swing up to 65° (`imhof.ts:27-30`); one TS source for both engines (`imhof.ts:166-236`) | C1, C2 | A− |
| Generalisation | 4 scale levels by range, 500 m to 25 km (`imhof.ts:21-24`) | C9 | B+ (cost unmeasured) |
| Warm light / cool shade, elevation contrast | Lit [1.06,1.0,0.85], shade [0.64,0.70,0.84]; elevation tint 700–2800 m (`imhof.ts:31-36`) | C5, C6 | A− |
| Sun-tone mask (off rock, ice, scree) | Not modelled as a separate yellow plate | C7 | C |
| Ground | **Green → ochre elevation albedo** (`look/glsl/ramps.ts:47-81`), not paper | §2.4 | D (Patterson, not LK) |
| Visible in the default view | **No.** Relief, tint and hatch need the hillshade map style; defaults are `mapStyle`/`worldStyle: "satellite"` (`settings.ts:48,58`). `PRESET_MAP_LAYERS` switches only `terroir` (`style/presets.ts:509-512`) | — | **F (the biggest gap)** |
| Rock hachure | Fall-line strokes in 16 sectors, 3.5 px shade / 6 px lit, 0.9 px wide, ground-anchored octave ladder, slope 36–44°, above 1500–1900 m (`terroir/hatch-lk.ts:22-47`) | C11–C14 | B− (no skeleton) |
| Hachure light | Shadow side from **`dot(n, TER_SUN)`**, the photo sun (`terroir/glsl/terrain.ts:301`; WGSL `wgsl/terrain.ts:306`) | C1, C12 | D (disagrees with the relief at dusk) |
| Scree | Jittered dots at a 5 px pitch, 26–44° slope (`hatch-lk.ts:40-47`) | C16 | C (no downslope size, no light coupling) |
| Glacier | Without a pack: blue strokes wherever the ground is above 2800–3000 m and under 32–42° (`hatch-lk.ts:48-56`). Contours stay brown on ice | C17, C19 | C− |
| Contour interval | **50 m** base (`settings.ts:42`); index at 100 m via `swissMajorEvery` (`terroir/glsl/values.ts:167`); distance ladder 100/200/1000 m | 20 m Alps / 100 m index | C+ (index right, base too coarse) |
| Contour colour | Minor `#b98a5e` α0.55, index `#8a5a32` α0.9 (`presets.ts:261-266`), **over an inherited navy casing** `[0.02,0.03,0.06]`, +2 px, α0.55 (`style/defaults.ts:45-48`) | C19, C21 | D |
| Contour ink by surface | `TERROIR_CONTOUR_INK` exists but is off and needs a pack; the example does it from slope and elevation bands (`examples/deck/landeskarte/…/ink.wgsl.ts:41-49`) | C18, C19 | C |
| Contour labels | None in the app. Gipfelbuch: italic, in the line's ink (`SheetMap.tsx:195-216`), which is correct | C20 | D (app) / A (Gipfelbuch) |
| Water | Lakes flat `#548099`, found by zero gradient below 2600 m; no shoreline, no rivers (`ramps.ts:77-80`) | §2.4 | D |
| Forest, settlement, roads | None by default | §2.4 | F (data dependent; see terroir) |
| Peak lettering | swisstopo preset: 12 px/600 names; spot heights 10 px/**300, brown `#bb8b54`** (`terroir/labels/swisstopo.ts:171`) | C23: height figures black and sloped | C |
| Name hierarchy (water italic, regions spaced) | `SWISSTOPO_NAME_TYPO` exists but never renders (`peakTiers` and `names` are off) | C23, C24 | D (dead in the app) |
| Panorama ridges | Ink ridges, strength 0.5, about `#705e4b`/`#594a40`, shared source | §2.7 | A− |
| Furniture | App: `furniture: false`, `legend: false`. Gipfelbuch and the example: LV95 ticks, scale bar, legend | §2.6 | C (app) / A− (others) |
| Engine parity | Imhof relief and hatch-lk generated for both engines; the alpine tint and MDOW are hand-copied into WGSL (`deck-webgpu/layers/terrain-styles.ts:289-320, 384-399`). **The GLSL was never compiled** | — | C |
| Browser evidence | None for anything Swiss from 10-01/10-02 | — | **unverified** |

### 3.2 What is right and must be kept

- **The cartographic light is fixed and separate from the photographic sun** (weight 0.15). This is exactly the Swiss distinction, and most terrain renderers get it wrong.
- **The Imhof maths has one TypeScript source for both shader dialects** (`look/imhof.ts`). It is the model for the hand-copied MDOW and alpine-tint twins.
- **Hachures are anchored in ground metres with an octave ladder.** That gives temporal stability, which a screen-space hatch never has.
- **The index-contour logic is right:** 100 m indexes, and the nested ladder means coarse lines are always also fine lines.
- **The Gipfelbuch sheet** (`components/gipfelbuch/swiss/*`) and **`examples/deck/landeskarte`** are the most faithful Swiss renderings in the repository. The example gets 20 m contours, ink by surface, pale lakes `#b0d1e3` and LV95 furniture right. Several fixes below are "port from the example".

### 3.3 Defects found (file:line re-checked)

| ID | Defect | Where |
|---|---|---|
| D1 | The swiss preset changes the contour colour but inherits Classic's **navy casing** (on, +2 px, α0.55). Brown lines on a blue-black halo have no counterpart on any Swiss map. Terroir overrides it, but swiss does not | `style/presets.ts:259-268`, `style/defaults.ts:45-48` |
| D2 | `bands.ramp` under Landeskarte resolves to `cool` (teal to magenta) | `style/defaults.ts` (inherited) |
| D3 | The default view shows no relief, tint or hatch: satellite map/world style, and no `PRESET_MAP_LAYERS.swiss`. Parity gap: WGSL hatches only on `hillshade` (`terroir/wgsl/terrain.ts:81`), while GLSL also hatches imagery before tiles load (`deck/terrain-layer.ts:524-529`) | `settings.ts:48,58`; `presets.ts:509-512` |
| D4 | The hachure shadow side follows the photo sun (`TER_SUN`) while the relief uses a fixed 315°. At dusk every face draws at shadow density, and the rock drawing can disagree with the relief about which face is dark | `terroir/glsl/terrain.ts:301`; `wgsl/terrain.ts:306` |
| D5 | The GLSL versions of Imhof relief and hatch v2 have never been compiled. The Dawn gate covers WGSL only, so the WebGL2 fallback could fail on the new default | ledger rows A1, A2, A5 |
| D6 | Stale text: `terroir/labels/swisstopo.ts:7-12, 24-27`; `look/imhof.ts:19` cites a missing `scripts/gpu/imhof-dawn.ts`; the label font stack still lists Manrope; the CHANGELOG still says swisstopo labels are "not yet wired" and hatch v2 is "off by default" | |
| D7 | `SWISSTOPO_NAME_TYPO` is dead in the app; only `labels.check.ts` uses it | `terroir/labels/swisstopo.ts` |
| D8 | The comment calls the hatch inks Brezine colours; `#2b2724` and `#3f7fb3` are not chart swatches | `terroir/hatch-lk.ts:67-70` |
| D9 | Without a pack, the glacier lines fire on any gentle ground above about 2800 m | `hatch-lk.ts:48-56` |
| D10 | The distance veil is applied three times: Imhof aerial (max 0.35), the relief mid-tone fade (12.5 %), and the classic haze. Far ridges may wash out. Not measured | `imhof.ts:37-39`, `relief.ts:141` |
| D11 | The 1500 m rock threshold drops low cliffs: the Rigi conglomerate, the Jura, and even parts of the Niederhorn flue (about 1700–1950 m) sit in the fade band | `hatch-lk.ts:37-38` |
| D12 | The lake detector catches any flat area below 2600 m | `look/glsl/ramps.ts:77-80` |
| D13 | Cost: up to 16 extra DEM reads plus about 6 stroke evaluations per pixel on the new default. Frame time not measured | `imhof.ts`, `hatch-lk.ts` |
| D14 | `style-baseline`, `eval-app` and `deck-smoke` were captured under the Classic default and need recapturing or pinning | `scripts/ci/known-failures.json` |

**Not a defect:** the code audit flagged the italic contour figures in the Gipfelbuch `SheetMap` as wrong. The 2008 legend and the live style both set height and contour figures sloped (C20, C23), so they are correct. The spot heights in the photo labels should be sloped too (§5 item 9).

### 3.4 One palette, scattered across modules

The same Swiss inks exist as several hand-copied values:
- **Contour brown:** `presets.ts:262` (repeated at :384 and :457), `terroir/classes.ts:75`, `gipfelbuch/swiss/inks.ts:31`, `theme.css:22`, and the example (`furniture.css`, `ink.wgsl.ts`). There are also the topo-map preset's `#9a6a3a` and `#6b4423`.
- **Rock and ice ink:** identical copies in `classes.ts:76-77`, `hatch-lk.ts:69-70` and the example.
- **Water:** seven values across `ramps.ts`, `terrain-styles.ts`, `classes.ts`, the labels, `--gb-water` and the example.
- **Warm/cool relief tones:** four places.
- **The alpine tint:** three copies.
- **Hachure:** five implementations (`hatch.ts` v1, `hatch-lk.ts`, the example's ink, `gipfelbuch/sheet-rock.ts`, `notebook/carto.tsx`). `hatch-lk` already diverges from the example it was ported from: stroke length 3.2 vs 10 periods, spacing 3.5/6 vs 3/5.
- **Paper:** the Gipfelbuch uses 96/4, the example's `style.css` still uses 90/10.
- **Fira Sans:** shipped twice, as "Fira Sans" and "GB Sans".

A single `src/lib/carto/inks.ts`, with GLSL and WGSL constants generated from it, would stop this drift. The example keeps a copy by rule, because examples import public API only.

---

## 4. Brand tension (owner decision)

The Brezine chart (`src/brand/khipu.ts`) has **no saturated blue**; `gipfelbuch/swiss/inks.ts:47` says so. The Swiss canon spends its colour on blue: water fill, ice contours, crevasses and hydrographic names. The current water ink `--gb-water` is `#30626b`, a teal-slate, and the app lake is `#548099`. Both read as "dark lake", not as LK pale blue (`#b0d1e3` in the example) with a `rgb(0,136,208)` line.

Options:
- **(a) A map-ink exception.** Allow the swisstopo screen blues for map content only. Chrome stays Brezine.
- **(b) Add a pale blue and a line blue to the brand chart.**
- **(c) Keep Brezine and accept the departure.**

The review recommends **(a)**. The map is content, not chrome, and blue water is the single strongest "this is a Swiss map" signal after the rock drawing.

---

## 5. Recommendations, ranked by value per effort

| # | Change | Fixes | Effort | Engine work |
|---|---|---|---|---|
| 1 | **Make the look visible:** add `swiss: { mapStyle: "hillshade", worldStyle: "hillshade" }` to `PRESET_MAP_LAYERS`, or make Relief the Landeskarte default for map and world | D3 | one line | none |
| 2 | **Fix the contour casing and the bands ramp in the swiss preset:** a warm paper casing (about 1.2 px, α0.35, like Terroir) or none; `bands.ramp: "swiss"` | D1, D2 | preset data | none |
| 3 | **Key the hachure shadow side to the map light**, not the photo sun. Use 315°/45° plus the C12 west-north-west secondary on rock, so rock and relief agree. Lower the rock threshold, or tie it to a pack's rock class | D4, D11 | small, both dialects (generated) | yes |
| 4 | **20 m base contours in the Alps** (10 m below about 1200 m optional), index stays 100 m, distance ladder unchanged. Recheck density on the demo roll | C19, §2.3 | setting + check | none |
| 5 | **Ink contours by surface without a pack:** port the example's slope/elevation bands (black on rock with minor lines dropped (C18), blue on ice) | C18, C19 | medium | yes |
| 6 | **Compile the GLSL in CI** (glslang, all presets and look permutations), then run the batch browser pass for A1/A2/A5 on both renderers | D5, D14 | medium | gate |
| 7 | **One `carto/inks.ts`**, sampled from the live swisstopo styles and `pixelkarte-farbe` (not invented). GLSL and WGSL constants generated from it. Merge the hand-copied MDOW and alpine tint into generated code. Owner decision §4 first | §3.4 | medium | yes |
| 8 | **A "paper" albedo for Landeskarte:** white ground, blue-grey relief on shaded slopes only (C8), a 4 % yellow sun tone masked off rock, ice and scree (C7), pale-blue lakes with a blue shore. Forest green only from a pack. Keep the alpine tint for Terroir and Berann | C3, C6–C8, §2.4 | medium | yes |
| 9 | **Labels:** spot heights in ink, sloped, weight 400 (not brown 300). Enable `peakTiers` and `names` where a pack exists so `SWISSTOPO_NAME_TYPO` renders (or delete it). Font family `Fira Sans`; drop Manrope | C22–C24, D6, D7 | small | none |
| 10 | **Stale-text sweep:** CHANGELOG lines, `swisstopo.ts` and `imhof.ts:19` comments, the Brezine claim in `hatch-lk.ts` | D6, D8 | trivial | none |

**After that (research-grade):**
- **Rock skeleton.** Crest and gully strokes from DEM curvature (ridge/valley extraction already exists in `look/sketch-ridges.ts`), drawn before the fill hachures (C11). Optionally a compute pre-pass in the luma graph after Geisthövel & Hurni 2018, emitting an SDF. This would be the first real-time GPU Swiss rock renderer we know of (C15).
- **Scree:** dot size growing downslope and coupled to the light (C16). Fix the octave crossfade shimmer.
- **Colour relief as a Jenny–Hurni (grey × elevation) LUT texture.** One lookup replaces the scattered tone constants, and the LUT can be authored from 5–10 swatches.
- **Glacier mask from GLAMOS or swissTLM3D** in the terroir pack, instead of elevation alone (D9).
- **Measure** frame time and far-ridge contrast on the new default (D10, D13).

---

## 6. How to judge it (for the next batch pass)

The reference plates double as a visual test. The bboxes are in [SOURCES.md](swiss-cartography/img/SOURCES.md).

1. Render the Landeskarte preset in the **map** view, hillshade, top-down, at both z15 extents (Niederhorn `46.7022,7.7454 → 46.7248,7.7893` and Jungfraujoch `46.5362,7.9541 → 46.5589,7.998`). Do it once per renderer (`--renderer webgpu`, `--renderer deck`), under the render lock.
2. Place each render beside `lk-colour-*-z15.jpg` and `light-basemap-relief-jungfrau-z15.jpg` and score it on the C-rules:
   - Does rock read as rock (C11–C13)?
   - Are the shaded faces the same faces as on the LK (C1, D4)?
   - Is ice white with blue (C17, C19)?
   - Do the contours sit quietly (D1)?
   - Is the lowland cool and soft while the summits are hard (C5)?
3. Repeat on two demo photos in the overlay view, where the rule is restraint: the photo is evidence.
4. Commit the renders next to the plates as `reports/swiss-cartography/img/rigi-*.jpg` so this document shows the comparison.

---

## 7. Licences of the plates

- **swisstopo WMTS plates (15):** Swiss open government data since 2021-03-01. Free, including commercial use; the credit "© swisstopo" is required.
- **Wikimedia Commons plates (3):** public domain.
  - Dufour sheet XVIII, 1854;
  - Siegfried sheet 489, 1872;
  - Imfeld, 1896 (Imfeld died 1909).
  - Commons scans tagged "Attribution-Swisstopo" were deliberately not used.
- **Not reproduced, because still in copyright:**
  - Eduard Imhof (d. 1986), protected until the end of 2056;
  - Heinrich Berann (d. 1999), until the end of 2069;
  - figures from the cited papers (except CC BY ICA proceedings).
- **Not covered by the OGD terms:** Frutiger fonts, logos and the federal arms.

Before these plates appear anywhere public, re-read the current swisstopo terms.

## Sources

Numbers match the citations above.

1. Wikipedia, Topographic Map of Switzerland (Dufour). https://en.wikipedia.org/wiki/Topographic_Map_of_Switzerland
2. swisstopo, Dufour map. https://www.swisstopo.admin.ch/en/dufour-map
3. Esri GIS Dictionary, partial hachuring system (Dufour system). https://support.esri.com/en-us/gis-dictionary/partial-hachuring-system
4. Wikipedia, Hachure map. https://en.wikipedia.org/wiki/Hachure_map
5. Wikipedia, Topographic Atlas of Switzerland (Siegfried). https://en.wikipedia.org/wiki/Topographic_Atlas_of_Switzerland
6. swisstopo, Siegfried map. https://www.swisstopo.admin.ch/en/siegfried-map
7. Jenny, B. & Hurni, L. (2006), Swiss-Style Colour Relief Shading Modulated by Elevation and by Exposure to Illumination, *Cartographic Journal* 43(3), 198–207. https://mail.colororacle.org/berniejenny/pdf/2006_JennyHurni_SwissStyleShading.pdf
8. HLS, Xaver Imfeld. https://hls-dhs-dss.ch/de/articles/031187/
9. swisstopo, National map (history, numbering, cycle). https://www.swisstopo.admin.ch/en/national-map
10. Wikipedia, Cartography of Switzerland. https://wikipedia.com/wiki/Dufourkarte
11. Forte, Käuferle & Streit (2016), The new 1:10 000 national map. https://www.swisstopo.admin.ch/dam/en/sd-web/Hb1LYoJBlwt5/Artikel-NeueLandeskarte10-EN.pdf
13. Wikipedia, National Maps of Switzerland. https://en.wikipedia.org/wiki/National_Maps_of_Switzerland
15. swisstopo (2008), Conventional Signs, "Map revision". https://www.swisstopo.admin.ch/dam/en/sd-web/WxsMJ4yE7xeV/Zeichenerklaerung_2008_e.pdf
17. Gilgen, J. (2024), Making of Mount Everest Map at swisstopo, *Proc. ICA* 6, 6 (CC BY 4.0). https://ica-proc.copernicus.org/articles/6/6/2024/ica-proc-6-6-2024.pdf
19. Map Room, "The People Who Draw Rocks" (2022). https://www.maproomblog.com/2022/03/the-people-who-draw-rocks/
21. swisstopo, Modernisation of the national maps 2001–2021. https://www.swisstopo.admin.ch/en/modernisation-of-the-national-maps-2001-2021
23. Käuferle, Streit & Forte (2015), New National Maps for Switzerland, ICA generalisation workshop. https://kartographie.geo.tu-dresden.de/downloads/ica-gen/symposium2015/20151203_ext_abstract_swisstopo.pdf
24. Käuferle et al. (2014), Das neue Landeskartenwerk der Schweiz, DGPF Tagungsband 23. https://dgpf.de/src/tagung/jt2014/proceedings/proceedings/papers/Beitrag163.pdf
25. SRF, "Neue Landkarten sind eine Revolution" (2014). https://www.srf.ch/news/schweiz/schweiz-neue-landkarten-sind-eine-revolution
26. opendata.swiss, Vector map base / Base Map vector tile style. https://opendata.swiss/en/dataset/vektorielle-kartenbasis-vector-tileset
27. swisstopo live MapLibre styles, parsed 2026-10-01: basemap v1.26.0, light base map v1.19.0, winter v1.19.0. https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json (and `.lightbasemap.vt`, `.basemap-winter.vt`)
29. swisstopo, A journey through time – maps. https://www.swisstopo.admin.ch/en/a-journey-through-time-maps
30. Jenny, B. (2008), Review of *Cartographic Relief Presentation* (Esri Press reprint). https://mail.colororacle.org/berniejenny/pdf/2008_Jenny_ImhofBookReview.pdf
31. Jenny, Heitzler, Singh, Farmakis-Serebryakova, Liu & Hurni (2021), Cartographic Relief Shading with Neural Networks, IEEE TVCG. https://arxiv.org/abs/2010.01256
32. Canton of Schwyz AGI, "Relief – Variante Schattierung" (NW, 45°). https://ckan.opendata.swiss/dataset/relief-variante-schattierung
33. opendata.swiss, swissALTI3D hillshade mono- and multidirectional. https://opendata.swiss/en/dataset/swissalti3d-reliefschattierung-multidirektional
35. Farmakis-Serebryakova & Hurni (2025), Neural Network Models for Adaptive Multi-scale Relief Shading, ICA Abstracts 10, 73. https://ica-abs.copernicus.org/articles/10/73/2025/ica-abs-10-73-2025.pdf
37. Hurni, L. (2025), Engineers of Map Art – 170 Years of Cartography at ETH Zurich, ICA Abstracts 10, 116. https://ica-abs.copernicus.org/articles/10/116/2025/ica-abs-10-116-2025.pdf
38. Mark, R. K. (1992), Multidirectional, oblique-weighted shaded relief, USGS OFR 92-422. https://pubs.usgs.gov/publication/ofr92422
39. Esri, Introducing Esri's next generation hillshade. https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/imagery/introducing-esris-next-generation-hillshade
40. Esri, Updated hillshade toolbox (Swiss Hillshade). https://www.esri.com/arcgis-blog/products/product/mapping/updated-hillshade-toolbox
41. Kennelly, P. & Stewart, A. J. (2014), General sky models for illuminating terrains, IJGIS 28(2). https://research.cs.queensu.ca/home/jstewart/papers/sky.pdf
42. Richardson, P. (2016), Mapping Mountains, Mapzen blog. https://mapzen.com/blog/mapping-mountains
43. Patterson, T., Terrain Texture Shader. https://www.shadedrelief.com/texture_shading/
44. Patterson, T., Mountain Cartography Workshop maps (Banff). https://shadedrelief.com/banff/
46. Jenny, B. & Patterson, T. (2007), Introducing Plan Oblique Relief, *Cartographic Perspectives* 57. https://cartographicperspectives.org/index.php/journal/article/view/cp57-jenny-patterson
47. ICA MapCarte, Imfeld, *Reliefkarte der Centralschweiz* (1887). https://mapdesign.icaci.org/?p=1705
48. Jenny, Gilgen, Geisthövel, Marston & Hurni (2014), Design Principles for Swiss-style Rock Drawing, *Cartographic Journal* 51(4). https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf
49. Geisthövel, R. & Hurni, L. (2018), Automated Swiss-Style Relief Shading and Rock Hachuring, *Cartographic Journal* 55(4). https://research-collection.ethz.ch/handle/20.500.11850/201368
50. Gilgen & Jenny (2010), Digital rock and scree drawing in vector and raster. https://mail.technicalgeography.org/pdf/sp_i_2010/05_digital_rock_and_scree_drawing_in_vector_an.pdf
52. Jenny, Hutzler & Hurni (2010), Scree representation on topographic maps. https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf
53. swisstopo (2008), Conventional Signs / Zeichenerklärung (English). https://www.swisstopo.admin.ch/dam/en/sd-web/WxsMJ4yE7xeV/Zeichenerklaerung_2008_e.pdf
56. Biniek et al. (2018), Designing typefaces for maps: a protocol of tests, *Proc. ICA* 1, 9. https://ica-proc.copernicus.org/articles/1/9/2018/ica-proc-1-9-2018.pdf
57. Wikipedia, Typography (cartography), on Imhof 1962/1975. https://en.wikipedia.org/wiki/Typography_(cartography)
63. Patterson, T. (2000), A View From On High: Heinrich Berann's Panoramas, *Cartographic Perspectives* 36. https://cartographicperspectives.org/index.php/journal/article/view/cp36-patterson
66. Neumann, A., Styling a Swiss topographic map, QGIS UC 2026. https://talks.osgeo.org/qgis-uc2026/talk/P7EBXR/
70. Swiss Copyright Act, Art. 29. https://lawbrary.ch/law/art/URG-v2022.01-en-art-29
71. Wikipedia, Eduard Imhof. https://en.wikipedia.org/wiki/Eduard_Imhof
74. swisstopo, Conditions for geodata (2024-01-08). https://www.swisstopo.admin.ch/en/conditions-geodata

Gaps in the numbering are sources from the full research brief that this review does not cite. Plate sources are in [SOURCES.md](swiss-cartography/img/SOURCES.md).
