<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Swiss cartography: canon, Landeskarte status and open defects

*Hub for the Swiss look. Review written 2026-10-01 (master bab0f28); status updated 2026-10-02 after the cartography consolidation (2f9c4da). Everything Swiss from 10-01/10-02 is **browser-unverified** (rows A1–A5 and "0a" in [batch-ledger.md](batch-ledger.md)).*

Related docs:
- [terroir-cartography.md](terroir-cartography.md): the terroir pack (land cover, names, glaciers) and its layers;
- [swiss-map-typography.md](swiss-map-typography.md): lettering roles, placement rules, font licences;
- [gipfelbuch.md](gipfelbuch.md): the Gipfelbuch canon; archived research behind it: [archive/gipfelbuch-design-book.md](archive/gipfelbuch-design-book.md), [archive/gipfelbuch-swiss-cartography.md](archive/gipfelbuch-swiss-cartography.md) (LK symbol table, Kroki conventions);
- [archive/geospatial-rendering-aesthetics-2026-09-30.md](archive/geospatial-rendering-aesthetics-2026-09-30.md): the 09-30 rendering-frontier review (its "ship a signature default" recommendation is done; open ideas are in §5.3).

Evidence: a web research pass (74 sources; **[V]** read, **[S]** search summary only, **[U]** unverified; unmarked = [V]); a code audit of `src/lib/{style,look,terroir}`, both shader dialects, `src/brand`, `src/components/gipfelbuch/swiss` and `examples/deck/landeskarte`; 18 reference plates in [swiss-cartography/img/](swiss-cartography/img/) (sources and licences in [SOURCES.md](swiss-cartography/img/SOURCES.md)). No Rigi renders yet: §6 says how to make the side-by-side in the next batch pass.

## Summary

**The canon.** The Swiss manner is a white sheet. Form is carried by **grey relief shading** lit from the north-west (adjusted locally, contrast rising with altitude, no cast shadows), a faint **yellow sun tone** on lit slopes masked off rock, ice and scree, **black rock drawing** (edge skeleton plus hachures, denser on shaded faces), and **contours whose ink follows the surface** (brown soil, black scree, blue ice and lake). Colour is spent on water, forest, and since 2014 red rail and road fills. Lettering is a strict hierarchy (Frutiger since 2014, LK Roemisch/Kursiv before); hydrography and height figures are italic.

**Rigi today.** Landeskarte (`presetStyle("swiss")`, alias `landeskarte`) is the **default look** (9b2a6e8; `style/store.ts`). Its look key is `LOOK_ALPINE, LOOK_HARMONIZE, LOOK_INK, LOOK_RELIEF`: Imhof relief (`look/imhof.ts`, one TS source for both dialects), Landeskarte hachure/scree/glacier lines (`terroir/hatch-lk.ts`), brown contours with 100 m index, ink ridges, swisstopo label typography. Shared map colours live in `src/lib/style/palette.ts` (§3.4).

**Why the default still does not read as a Swiss map** (open):
1. **The relief, hachure and tint render only in the hillshade map style**, and the default map/world style is satellite (`settings.ts:48,58`); `PRESET_INFO.swiss` has no `mapLayers` (D3).
2. **50 m base contours** instead of 20 m in the Alps; surface-coloured contour ink needs a pack.
3. **The ground is the green-to-ochre alpine tint** (Patterson/Berann), not white paper with relief.
4. **The hachure follows the photo sun**, not the fixed map light (D4).
5. **The GLSL twins (WebGL2 fallback) of Imhof relief and hatch v2 have never been compiled** (D5); nothing has been seen in a browser.

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

"Default" means the Landeskarte look (`style/presets.ts` `swiss`), the default preset since 9b2a6e8.

### 3.1 Scorecard (re-checked 2026-10-02)

| Element | What Rigi does (default) | Canon | Grade |
|---|---|---|---|
| Light direction | Fixed 315°/45° cartographic light, z-factor 1.6; the photo sun weighs 0.15 (`look/glsl/relief.ts`, `look/imhof.ts`) | C1 | A |
| Multidirectional, local adjustment | MDOW 225/270/315/360°; Imhof aspect swing up to 65°; one TS source for both engines | C1, C2 | A− |
| Generalisation | 4 scale levels by range, 500 m to 25 km | C9 | B+ (cost unmeasured) |
| Warm light / cool shade, elevation contrast | Imhof lit/shade colours; elevation tint 700–2800 m | C5, C6 | A− |
| Sun-tone mask (off rock, ice, scree) | Not modelled as a separate yellow plate | C7 | C |
| Ground | Green → ochre alpine albedo, now generated from `ALPINE_TINT` (`palette.ts`), not paper | §2.4 | D (Patterson, not LK) |
| Visible in the default view | **No**: needs the hillshade map style; default is satellite | — | **F (biggest gap, D3)** |
| Rock hachure | Fall-line strokes, 16 sectors, 3.5 px shade / 6 px lit, ground-anchored octave ladder, slope 36–44°, above 1500–1900 m (`terroir/hatch-lk.ts`) | C11–C14 | B− (no skeleton) |
| Hachure light | Shadow side from `dot(n, TER_SUN)`, the photo sun (`terroir/glsl/terrain.ts`, `terroir/wgsl/terrain.ts`) | C1, C12 | D (D4) |
| Scree | Jittered dots, 5 px pitch, 26–44° slope | C16 | C (no downslope size, no light coupling) |
| Glacier | Without a pack: blue strokes above 2800–3000 m under 32–42°; contours stay brown on ice | C17, C19 | C− (D9) |
| Contour interval | 50 m base; index at 100 m (`swissMajorEvery`); distance ladder 100/200/1000 m | 20 m Alps / 100 m index | C+ |
| Contour colour | Minor `#b98a5e` α0.55, index `#8a5a32` α0.9 (`SWISS_CONTOURS`) on Terroir's thin dark-brown casing (1.2 px, α0.35) | C19, C21 | B (D1 fixed 2f9c4da) |
| Contour ink by surface | `TERROIR_CONTOUR_INK` needs a pack; the example derives it from slope/elevation bands | C18, C19 | C |
| Contour labels | None in the app; Gipfelbuch `SheetMap` italic in the line's ink (correct) | C20 | D (app) / A (Gipfelbuch) |
| Water | Flat `#548099` lakes found by zero gradient below 2600 m; no shoreline or rivers | §2.4 | D (D12) |
| Forest, settlement, roads | None by default (pack-dependent, see terroir) | §2.4 | F |
| Peak lettering | swisstopo table: names 12 px/600; spot heights 10 px/**300, brown** (`terroir/labels/swisstopo.ts`) | C23: figures black, sloped | C |
| Name hierarchy | `style.terroir.names.typography = "swisstopo"` on Landeskarte (blue italic water, spaced ranges); renders when a pack is loaded and names are on | C23, C24 | B (D7 fixed 2f9c4da) |
| Panorama ridges | Ink ridges, strength 0.5, `WARM_INK` | §2.7 | A− |
| Furniture | App: `furniture: false`, `legend: false`. Gipfelbuch and the example: LV95 ticks, scale bar, legend | §2.6 | C (app) / A− (others) |
| Engine parity | Imhof relief, hatch-lk and the alpine tint generated for both dialects; MDOW still hand-copied into WGSL; **GLSL never compiled** (only `wgsl-compile` exists) | — | C |
| Browser evidence | None | — | **unverified** |

### 3.2 What is right and must be kept

- **The cartographic light is fixed and separate from the photographic sun** (weight 0.15): exactly the Swiss distinction, which most terrain renderers get wrong.
- **One TS source per shading formula for both dialects** (`look/imhof.ts`, `palette.ts alpineBaseBody`). It is the model for the remaining hand copies.
- **Hachures anchored in ground metres with an octave ladder** give temporal stability a screen-space hatch never has.
- **Index-contour logic:** 100 m indexes, nested ladder (coarse lines are always also fine lines).
- **The Gipfelbuch sheet** (`components/gipfelbuch/swiss/*`) and **`examples/deck/landeskarte`** are the most faithful Swiss renderings in the repository (20 m contours, ink by surface, pale lakes `#b0d1e3`, LV95 furniture). Several fixes are "port from the example".

### 3.3 Defects

| ID | Defect | Status (2026-10-02) |
|---|---|---|
| D1 | Swiss preset inherited Classic's navy contour casing | **Fixed** 2f9c4da (`SWISS_CONTOURS`: thin dark-brown casing, also Field sketch) |
| D2 | `bands.ramp` under Landeskarte resolved to `cool` | **Fixed** 2f9c4da (`bands.ramp: "swiss"`) |
| D3 | Default view shows no relief, tint or hatch (satellite map/world style; no `PRESET_INFO.swiss.mapLayers`). Parity gap: WGSL hatches only on `hillshade`, GLSL also on imagery before tiles load | **Open**, owner decision (one line, changes what every new user sees) |
| D4 | Hachure shadow side follows the photo sun (`TER_SUN`) while the relief uses fixed 315°; at dusk every face draws at shadow density | Open |
| D5 | GLSL twins of Imhof relief and hatch v2 never compiled (the Dawn gate covers WGSL only) | Open (ledger A1, A2, A5) |
| D6 | Stale text | Partly fixed 2f9c4da (swisstopo.ts comments, Manrope dropped). **Open:** `look/imhof.ts` header cites a missing `scripts/gpu/imhof-dawn.ts` |
| D7 | `SWISSTOPO_NAME_TYPO` dead in the app | **Fixed** 2f9c4da (`names.typography`) |
| D8 | Hatch inks called Brezine colours | **Fixed** 2f9c4da |
| D9 | Without a pack, glacier lines fire on any gentle ground above about 2800 m | Open |
| D10 | Distance veil applied three times (Imhof aerial ≤0.35, relief mid-tone fade 12.5 %, classic haze); far ridges may wash out | Open, unmeasured |
| D11 | 1500 m rock threshold drops low cliffs (Rigi conglomerate, Jura, parts of the Niederhorn flue at 1700–1950 m) | Open |
| D12 | Lake detector catches any flat area below 2600 m (`look/glsl/ramps.ts`) | Open |
| D13 | Up to 16 extra DEM reads plus about 6 stroke evaluations per pixel on the default; frame time not measured | Open, unmeasured |
| D14 | `style-baseline`, `eval-app`, `deck-smoke` were captured under the Classic default | Open (batch pass: recapture or pin `?style=classic`) |

**Not a defect:** italic contour figures in the Gipfelbuch `SheetMap` are correct (C20, C23). The photo-label spot heights should be sloped too (§5.1 item 9).

### 3.4 One palette (landed 2f9c4da)

`src/lib/style/palette.ts` holds the map colours used in more than one place, with provenance (`classic` / `rigi`; none claims to be "official"): `CONTOUR_BROWN`, `COVER_INK`, `WARM_INK`, `BERANN_INK`, `DARK_INK`, `CONTOUR_CASING_BROWN`, `TOPO_PAPER`, `WORLD_SKY`, `WORLD_CLEAR`, `CLASSIC_HAZE`, `ALPINE_TINT`, plus emitters (`alpineBaseBody(glsl|wgsl)`, `shaderFloat`, `hexToBytes`). The GLSL `alpineBase`, WGSL `ts_alpine_base` and the `patterson` ramp are generated from `ALPINE_TINT`; `CONTOUR_INK` and `HATCH_LK_INK` both derive from `COVER_INK`. `PRESET_INFO` in `style/presets.ts` is the one preset registry (`PRESET_IDS`, `PRESET_LABELS`, `PRESET_OVERLAY_LAYER`, `PRESET_MAP_LAYERS` derive from it; `presetIdFrom()` resolves aliases; the stored id stays `swiss`). Verified pixel-neutral: all 12 resolved presets JSON-identical apart from the deliberate changes, 36 `deckTerrainStyle` hashes identical, identity snaps numeric-equal, 252 WGSL variants compile on Dawn.

Still scattered: seven water blues (app lake `#548099`, `--gb-water` `#30626b`, example `#b0d1e3`, …); two contour browns (app `#b98a5e`/`#8a5a32` vs Gipfelbuch and example Brezine NB `#95500c`); three warm/cool relief tunings (MDOW, Imhof, terroir fallback); five hachure implementations (`hatch.ts` v1, `hatch-lk.ts`, the example, `gipfelbuch/sheet-rock.ts`, `notebook/carto.tsx`; `hatch-lk` already diverges from the example: stroke length 3.2 vs 10 periods, spacing 3.5/6 vs 3/5); Fira Sans shipped twice ("Fira Sans" and "GB Sans"). The example keeps its own copy by rule (public API only).

---

## 4. Brand tension (owner decision)

The Brezine chart (`src/brand/khipu.ts`) has **no saturated blue**; the Swiss canon spends its colour on blue (water fill, ice contours, crevasses, hydrographic names). `--gb-water` `#30626b` and the app lake `#548099` read as "dark lake", not LK pale blue (`#b0d1e3`) with a `rgb(0,136,208)` line. Options: **(a)** a map-ink exception (swisstopo screen blues for map content only, chrome stays Brezine; one `WATER` token group in `palette.ts`); **(b)** add a pale and a line blue to the brand chart; **(c)** keep Brezine and accept the departure. The review recommends **(a)**: the map is content, and blue water is the strongest Swiss-map signal after rock drawing.

---

## 5. Open work

### 5.1 Ranked fixes (value per effort)

| # | Change | Fixes | Effort | Status |
|---|---|---|---|---|
| 1 | Make the look visible: `PRESET_INFO.swiss.mapLayers = { mapStyle: "hillshade", worldStyle: "hillshade" }` | D3 | one line | Open (owner) |
| 2 | Warm contour casing; `bands.ramp: "swiss"` | D1, D2 | preset data | **Done** 2f9c4da |
| 3 | Key the hachure shadow side to the map light (315°/45° plus the C12 west-north-west secondary on rock); lower the rock threshold or tie it to a pack's rock class | D4, D11 | small, both dialects | Open |
| 4 | 20 m base contours in the Alps (index stays 100 m); recheck density on the demo roll | C19, §2.3 | setting + check | Open |
| 5 | Ink contours by surface without a pack: port the example's slope/elevation bands (black on rock with minor lines dropped, blue on ice) | C18, C19 | medium | Open |
| 6 | Compile the GLSL in CI (glslang over all presets and look permutations), then the batch browser pass for A1/A2/A5 on both renderers | D5, D14 | medium | Open |
| 7 | One ink source | §3.4 | medium | **Partly done** (`palette.ts`); open: water blues (after §4), relief tone tokens, MDOW generation |
| 8 | "Paper" albedo for Landeskarte: white ground, blue-grey relief on shaded slopes only (C8), 4 % yellow sun tone masked off rock/ice/scree (C7), pale-blue lakes with a blue shore; keep the alpine tint for Terroir and Berann | C3, C6–C8 | medium | Open |
| 9 | Spot heights in ink, sloped, weight 400 (not brown 300) | C22–C24 | small | Open (names/Manrope part done) |
| 10 | Stale-text sweep | D6, D8 | trivial | Partly done; `imhof.ts` header and CHANGELOG lines remain |

### 5.2 Code-health follow-ups (from the 2f9c4da consolidation)

1. **WGSL atmosphere duplicate:** `deck-webgpu/layers/terrain-styles.ts ATMOSPHERE_WGSL` re-implements `atm-sky.ts` without Nebelmeer, so with valley fog on WebGPU terrain does not fog where WebGL does. Use the `atm-sky` part.
2. Generate the WGSL uniform structs from `defineBlock` (with vec3→vec4 padding) plus a parity spec.
3. One `oklabWgsl()` / harmonise generator for the three WGSL copies (composite, drape, terrain-styles) and the color-stats kernel.
4. Relief tone tokens in `palette.ts`; then decide whether they become one Jenny–Hurni LUT.
5. Make `schema.ts` and `types.ts` one source (today drift is caught only by the "CLASSIC is a fixed point" spec and `style-check`).
6. One `niceScaleLength` and one north-arrow glyph for `terroir/roll`, `gipfelbuch/swiss` and `step-inside`; alias the "GB Sans/Serif/Mono" fonts to the site faces.
7. Engines start from `CLASSIC` (`deck/engine.ts`, `deck-webgpu/engine.ts`, `roll/map/basemap.ts`): only `PhotoWorkspace` follows the user's preset, so the roll basemap is always Classic. Decide which views follow it.
8. Unused fields: `labels.export.textGap` is never read; `hazeDensity`/`hazeMax`/`casing.minorMul` have no UI.
9. Owner: one contour brown (app `#b98a5e`/`#8a5a32` vs Brezine NB `#95500c`)?

### 5.3 Research-grade and rendering ideas

- **Rock skeleton:** crest and gully strokes from DEM curvature (ridge/valley extraction exists in `look/sketch-ridges.ts`) drawn before the fill hachures (C11); optionally a luma-graph compute pre-pass after Geisthövel & Hurni 2018 emitting an SDF. No published real-time GPU Swiss rock renderer is known (C15).
- **Scree:** dot size growing downslope and coupled to the light (C16); fix the octave crossfade shimmer.
- **Jenny–Hurni (grey × elevation) colour LUT** replacing the scattered tone constants, authored from 5–10 swatches.
- **Glacier mask from GLAMOS or swissTLM3D** via the terroir pack instead of elevation alone (D9).
- **Measure** frame time and far-ridge contrast on the default (D10, D13).
- From the 09-30 aesthetics review, still open: terrain shadow and haze applied to overlays; leader-line occlusion; grouped sub-summit labels; range-ordered reveals; port the WebGPU drape's 2×2 occlusion vote to the WebGL deck drape (`deck/terrain-layer.ts`); a Berann palette material and a projective photo→3D tween for the world view and landing. Art modes that alter photo pixels need hard guardrails (the photo is evidence). Do not ship: Apple SHARP weights (non-commercial), Careaga/Aksoy intrinsics (academic), FLUX.1-dev ControlNets (non-commercial).

---

## 6. How to judge it (next batch pass)

The reference plates double as a visual test; bboxes are in [SOURCES.md](swiss-cartography/img/SOURCES.md).

1. Render Landeskarte in the **map** view, hillshade, top-down, at both z15 extents (Niederhorn `46.7022,7.7454 → 46.7248,7.7893`; Jungfraujoch `46.5362,7.9541 → 46.5589,7.998`), once per renderer (`--renderer webgpu`, `--renderer deck`), under the render lock.
2. Place each render beside `lk-colour-*-z15.jpg` and `light-basemap-relief-jungfrau-z15.jpg` and score: rock reads as rock (C11–C13)? same shaded faces as the LK (C1, D4)? ice white with blue (C17, C19)? contours quiet? lowland soft and summits hard (C5)?
3. Repeat on two demo photos in the overlay view, where the rule is restraint.
4. Commit the renders as `reports/swiss-cartography/img/rigi-*.jpg` so this document shows the comparison.

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
