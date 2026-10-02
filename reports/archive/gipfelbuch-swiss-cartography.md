# Swiss cartography, Swiss mapping and swisstopo, translated for a hand-drawn Gipfelbuch

> Archived 2026-10-02 (was `reports/gipfelbuch-hand-sketch-research/swiss-cartography.md`): LK symbology, swisstopo colours, Kroki conventions and the S1–S32 sketch primitives that `notebook/carto.tsx` and `swiss/Marks.tsx` cite. Current rules: `reports/gipfelbuch.md`.

*Research for the Gipfelbuch sketchbook restyle, 2026-10-01. No repo files changed.*

**Marks.** **[V]** means checked this session against a fetched primary source: the swisstopo PDF, the vector style JSON, or the ASTRA handbook. **[V-prior]** means verified in an earlier repo report and not re-checked. **[U]** means established practice or inference that was not confirmed. Hex values marked "style.json" come from swisstopo's live MapLibre styles (`vectortiles.geo.admin.ch/styles/<id>/style.json`, basemap v1.26.0, light base map v1.19.0, winter v1.19.0), which were downloaded and parsed. The LK *print* inks are CMYK spot separations and are not published as hex. The values below are either the screen analogues swisstopo itself ships or samples of its 2008 legend PDF rendered with poppler.

---

## 0. Covered, gaps, errors in the existing work

**Already covered well (do not redo):**
- The Brezine ink roles: LK ink, NB contour, GL water, GG forest, SR route, PB peak names, YY/SY sign.
- The rock-drawing numbers from Jenny 2014 (0.12 mm mean, 7 strokes per 2 mm, ratio of lit to shaded faces) and the scree polygons from Jenny 2010 (`gipfelbuch-design-book.md` §2.2).
- Imhof's relief principles and his name-placement rules (§2.1, §2.4).
- Contour intervals per scale; contour colour following the surface (brown on earth, black on scree, blue on ice and lake).
- The Wegweiser handbook: RAL colours, time format, Standortfeld, destination order.
- The SAC certainty line styles (solid, dashed, dotted).
- The Siegfried imprint roles (Aufnahme, Revision, Stich) and the stroke tiers for charts.
- The kitsch boundary.
- Components that already exist: `SpotHeight`, `TrigPoint`, `HutBullet`, `Grade`, `StationStamp`, `Waymark`, `Signpost`, `ScaleBar`/`SheetScaleBar`, `Legend` (with `RockSymbol` and `GlacierSymbol`), `HachureRule`, `Cartouche`, `ContourField`, `SheetFrame` (LV95 corners, Blatt number, Stand/Ausgabe), and in viz `Hachure`, `Stipple`, `PenArrow`, `PenCircle`, `PenDimension`, `TallyMarks`, `SkylineSketch` and others.

**Gaps that this report fills:**
1. **The trig point and spot-height glyphs were [U] in the design book.** They are now verified from the 2008 *Conventional signs* legend (§1): an open triangle for trig points of the 1st to 3rd order and LV95, with a height given to one decimal, and **two spot-height marks, a small × and a dot**, with integer heights. All the height figures in that legend are **sloped (italic) bold numerals**, not upright mono.
2. **Index contour labels** are italic, set in the contour's own ink (brown "800"), and break the line [V]. Lake level is blue italic; a lake-bottom spot height is a × plus a dark italic figure [V].
3. **Intermediate contours** (half the interval) are drawn dashed or dotted [V], and no component has them yet. **Escarpments** (*Böschung*) are drawn as a comb of ticks, brown on earth and black on stone [V]. Neither is in the kit.
4. **Kroki conventions** (Swiss Army and scouting field sketches) give the clearest hand-sketch grammar available, and it was missing. Forest is hatched **diagonally**, buildings **vertically** and water **horizontally**. Every Kroki carries a title, an approximate scale, a north arrow with a label, the draughtsman's name, and the date and time. In the view kind (*Ansichtskroki*), things get fainter with distance [V, youngstarswiki Kroki].
5. **Screen inks swisstopo actually ships** (style.json) were only partly cited before:
   - The relief shade is a **cool blue-grey** ramp from `#adbcc7` to `#fbfcfc`, not a neutral grey.
   - Rock hachure renders at **27 % black**.
   - Paths through rock get a paper knockout halo.
   - Contour and peak lettering is set in Frutiger Neue **Italic**.
6. **Swiss hiking signage specs** were missing their exact numbers. Signs use the **ASTRA-Frutiger Standard** typeface at 30 mm, scaled to 75 % [V]. The time base is 4.2 km/h on the flat [V]. Route fields are Pantone 368 C green, numbered in Frutiger 76 Black Italic [V].
7. **Margin furniture.** A graphic scale bar sits in the bottom margin, and the declination note sits in the **bottom-right margin** [V]. The km grid is printed on LK25 and LK50, and a 10 km grid on LK100 [V]. Coordinates are written "larger value first" with spaces: `666 270 / 212 290` [V].
8. **The 2016 modernisation** [V]: Frutiger lettering, red railways, broad coloured boundary bands, an end to shaded or broken double lines, and relief and rock drawing kept.
9. **Heritage facts** [V]:
   - Siegfried 1:25k was a three-colour copper engraving (black, brown, blue); 1:50k sheets were lithographs.
   - The Siegfried contour interval was **30 m in the Alps** and 10 m in the Plateau and Jura.
   - From 1953, swisstopo engraved its originals into coloured lacquer on **glass plates**, for about half a century.
   - Imhof: "Making maps does not begin with a computer, but with sharpening the end of a pencil." He drew rock "as if by magic using chalk or pencil".

**Errors or tensions found:**
- **E1. Figures are upright mono.** `SpotHeight` and the README's "spot height in tabular figures" are upright Plex Mono, but on the LK every height figure is sloped. Keep mono for data tables. Map heights (on sheets, Tafel and sketches) should be **italic**, tabular, with the ink following the class: black for terrain, brown for contours, blue for water.
- **E2. Peak names upright or italic.** The 2008 legend sets mountains **upright, medium weight** ("Jungfrau") and regions **light and letter-spaced** ("G i b e l e g g w a l d"). The 2016+ vector basemap sets peaks in **Frutiger Neue Italic, navy `#1b243e`**, with the elevation on a second line at 0.75 scale. Both are "swisstopo". The README's "peaks upright navy" is the print convention. Pick one per figure; for a sketchbook, the print LK reading (upright) is the better fit.
- **E3. `SpotHeight` draws only the dot.** Add the × variant (see S5).
- **E4. PB `#002f55` for Alpinwanderweg blue.** RAL 5015 is a mid sky blue, roughly `#2271b3`–`#2874b2` (RAL has no official sRGB [U]). Navy reads wrong next to a real white-blue-white blaze. GL `#30626b` is also off. This is the one place where a non-Brezine spot ink is justified, or the blaze could be drawn as an *outline-only* coloured-pencil stroke so the gap matters less.
- **E5. `--gb-sign` SY `#e59e1f`.** This is a good match for RAL 1007 *Narzissengelb* (≈ `#e79c00` [U]). It is correct and should be documented as such.
- **E6. Stale token table.** `gipfelbuch-swiss-aesthetic.md` still lists paper as "W 90% + YY 10% (warm cream)" in its token table. The revision note at the top overrides it, but the table should be corrected.
- **E7. Conflicting user direction.** "Much more aggressive informal sketchbook" collides with the 2026-10-01 user feedback (memory: *Gipfelbuch softer*: no grain, texture, tape, tilt or margin rule; keep the soft grid). The way through: get the aggression from **line, hatch, hand lettering and Kroki grammar**, not from paper simulation. Every move in §6 keeps to that rule; any move that needs tilt or texture is flagged.
- **E8. LV95 separators.** `formatLv95` uses thin spaces. That is correct LK practice (the legend writes `666 270 / 212 290` with spaces [V]). The apostrophe form `2'600'000` belongs to Swiss *running text and software*: map.geo.admin's coordinate readout, and the swissNAMES3D population classes such as `10'000` [V, repo `scripts/terroir/lib/names.ts`]. Use spaces in map furniture and apostrophes in handwritten field notes (see S22).

---

## 1. LK symbology table

Columns: the element; the LK ink (print role) and screen analogues; the line and type; the sketch translation (see §5 for the specs).

| Element | Ink (print role) / screen analogue | Line / type on LK | Sketch translation |
|---|---|---|---|
| Contour, earth | Brown. Basemap `rgba(180,110,13,.35)` = `#b46e0d` at 35 %; light base `#bf8a40`; winter `#bb6c44`; legend PDF sample ≈ `#e85020` (a warm, orange-leaning brown) [V] | Normal contours at 10 m (Jura/Plateau) or 20 m (Alps) on LK25, 20 m on LK50, 50 m on LK100. Index contours at 100 / 200 / 200 m. Intermediate contours at 5/10, 10 and 25 m, **dashed or dotted** [V] | Brown coloured-pencil line, NB. Normal line 0.9 px; index line 1.6 px; intermediate line 0.7 px, dashed 3/3. Slight tremor; the line fades out where the slope flattens |
| Contour, scree | Black. Basemap `rgba(0,0,0,.25)` [V] | Same intervals [V] | Graphite pencil GR at 0.8 px |
| Contour, ice or lake | Blue. Light base `#0088d0`; basemap `#4da4da` [V] | Same; in rock, only the 100 m contours are kept [V] | Blue pencil, GL, 0.8 px |
| Index contour label | In the contour ink, **italic**; the line breaks ("—800—") [V]. Basemap label colours: land `#ab7e40`, water/ice `#2f86bc`, scree `#464646`, Frutiger Neue Italic 10–10.5 px [V] | Reads uphill [V-prior] | Hand-lettered italic figures, 11 px, a 2 px gap in the line, rotated to the line's tangent |
| Rock (*Felszeichnung*) | Black. The basemap renders the hachure polygons at **27 % opacity** (`rgb(12,12,12)`); glacier hachure in `rgb(25,133,200)` [V] | Mean stroke 0.12 mm; shaded faces 0.22–0.26 mm, lit faces 0.06–0.10 mm and broken; about 7 strokes per 2 mm; triangular elements ≈ 2.5 mm; light from the NW [V-prior] | Fall-line pen hatching: shaded face at 1.4 px, spacing 2.5 px; lit face at 0.6 px, spacing 5 px and broken. Ink at 70–85 % |
| Scree (*Geröll*) | Black stipple. The basemap uses a scree fill pattern at 25–35 % [V] | Polygon dots 0.01–0.22 mm, larger in shade and toward the foot of the slope [V-prior] | Stipple of irregular 4–6-gons, radius 0.5–1.6 px, denser downslope and on the shaded side |
| Glacier | Blue contours plus a pale fill. Basemap fill `#cde8f4` [V]; legend shows blue crevasse strokes and moraine as black stipple [V] | No outline; crevasses are short blue strokes across the flow [V] | Pale blue pencil wash (hatch at 0.35) plus 2–4 px blue crevasse ticks across the flow lines; moraine as scree stipple |
| Escarpment (*Böschung*) | Brown on earth, black on stone [V] | A line of comb teeth hanging downslope [V] | A tick comb: 1 px baseline, 3 px teeth at 2 px pitch on the downhill side |
| Forest | Legend PDF fill ≈ `#b0e080` with a dark-green edge; an undefined edge is dotted [V]. Basemap fill `#3e990a` at ≈ 15 % with a `#8ac66c` casing; light base `#bad2ac`; winter `#507e62` [V] | Defined edge solid; undefined edge dotted. Scattered forest as small circles, scrub as dots, orchard as a grid of dots [V] | **Kroki rule: diagonal hatch** in green pencil (GG or a PG mix), 45°, spacing 4 px, 0.7 px. Treelets ("o" loops) along an undefined edge |
| Water: river, lake | Blue. Line `#4da4da`; lake fill `#d2eeff`; river fill `#b5e1fd`; label `#2f86bc`, a step deeper than the line [V] | Names italic; large rivers in spaced capitals ("LE RHÔNE") [V] | **Kroki rule: horizontal hatch** for lakes (spacing 3 px, 0.6 px, GL); single-pass blue lines for streams, thinning upstream |
| Lake level and depth | Lake level is blue italic "419"; a lake-bottom spot height is "× 387" [V] | Sloped figures [V] | Blue italic hand figure; × plus dark figure |
| Trig point (1st–3rd order, LV95) | Black. A small open triangle with a centre dot, height to one decimal, label top right ("2127.6") [V] | Bold sloped figures [V] | A 7 px triangle drawn in three strokes with overshoot at the apex, a centre dot, and the label up and right |
| Spot height | Black. **×** or **·** with an integer height ("1587", "713") [V]. The basemap uses a `dot_black` icon plus Frutiger Neue Regular `#202020` [V] | Sloped bold [V] | A × of two 3 px strokes, or a 1.6 px dot; figure italic 11 px |
| Shrine or summit cross | Black, a small cross ✝ [V] | | A 2-stroke cross, 6 px; with a Gipfelbuch tin as a 2×3 px box at its foot (a doodle, [U]) |
| Lookout tower, monument, erratic block, cave | Black micro-glyphs [V] | | Minimal pen glyphs at 5–7 px, copied from the legend |
| Building | Black filled squares (LK) [V] | | **Kroki rule: vertical hatch** inside a hand-drawn outline |
| Paths | LK25 uses black dashed lines by class [U on the 2016 details]. The basemap path is `#3c3c3c`, dash 16/2 to 40/4 [V] | | Pen dashes, see S17 |
| Hiking trails (Wanderkarte overprint) | Red overprint on swisstopo hiking maps [V that it is red, swisshiking]. The split into solid, dashed and dotted per category is [U] | | SR route line: solid for Wanderweg, dashed for Bergwanderweg, dotted for Alpinwanderweg (matches the SAC certainty grammar [V-prior]) |
| Railway | Red since 2016 [V]; the basemap rail label is `#b73939` [V] | | Thin red double tick line, used rarely |
| Boundaries | Broad transparent coloured bands since 2016 [V]; basemap `#c35591` line with a pink band [V] | | Do not use; too modern-digital |
| Relief shading | Basemap hillshade: a **cool blue-grey ramp from `#adbcc7` to `#fbfcfc`** over 16 luminosity steps [V] | NW light; Imhof's aerial perspective [V-prior] | Cross-contour pencil shading on SE-facing slopes only, GR or BL, 0.5–0.8 px at 0.3–0.5 opacity |
| Sun tone | Basemap `#ffeb05` at 4 %; light base `#ffd905`; winter `#f0f505` [V] | Yellow on lit slopes [V-prior] | YY yellow pencil hatch on NW-facing slopes, 0.25 opacity |
| Lettering classes | Municipalities upright; hamlets and suburbs italic; valleys and mountains medium; regions light and letter-spaced; glaciers blue italic ("Aletschgletscher"); passes upright [V legend]. Basemap faces: Frutiger Neue Condensed Regular/Medium, Italic, Regular, Medium [V] | Abbreviations: P. (Pass/Piz), Gl., H. (Hütte), J. (Joch), L. (Lücke), Sp. (Spitz), St. (Stock), A. (Alp), W. (Wald), S. (See), B. (Bach) [V] | Hand lettering in **two** hand styles: upright technical capitals for places and peaks, and a sloped hand for water, ice and field names. See S20 |
| Grid | A km grid on LK25/50, a 10 km grid on LK100; larger value first [V] | | Hand-ruled tick marks at the frame only, with labels like `2 627` and `1 172` |
| Scale | A graphic scale bar in the bottom margin [V]. 1:25 000 means 4 cm per km; 1:50 000, 2 cm per km; 1:100 000, 1 cm per km [V] | | A hand-ruled alternating bar, see S12 |
| Declination | "Convergence of meridians plus magnetic declination", the value for the sheet centre and the given year, in the **bottom-right margin** [V]. Convergence up to 2° in Switzerland [V]. Current declination ≈ +3° E [U] | | A three-arrow declination doodle: grid N, true N, magnetic N |
| Revision | A 6-year cycle; the title date is the edition and the content date is inside ("Stand") [V]. 247 LK25 sheets [V] | | "Nachgeführt 2026 · Stand 10.2026" hand-written in the corner |

---

## 2. Heritage and hand craft

**Lineage, with the hand traces each step left** [V unless marked]:

| Era | Technique | What the hand shows | Take for the sketchbook |
|---|---|---|---|
| Dufour map 1:100k, 1845–65 | Copper engraving (intaglio), one colour, later 2–3; relief by *Schraffen* (hachures) [V] | Strokes along the fall line, heavier where steeper (Lehmann 1799 [V]); oblique NW light [V-prior] | Fall-line hachure fields for "steepness" figures; one ink only |
| Siegfried map, 1870–1926 (updated to 1949) | 1:25k as a **three-colour copper engraving (black, brown, blue)**; 1:50k as lithographs [V]. Contours at 10 m on the Plateau and **30 m in the Alps** [V]. *Genetic* cliff drawing by Becker and Imfeld [V]. Plane-table survey with *Kippregel* from fixed points 3–5 km apart [V]. Accuracy limits 0.5 mm (25k) and 0.7 mm (50k) [V] | Three-ink restraint; rock drawn by a geologist's eye | The **three-pen rule**: black, brown and blue are the only drawing pens. Red and green are coloured-pencil overlays |
| Plane-table original (*Originalaufnahme*, *Messtischblatt*) | Pencil on the plane table in the field, rays from the station with the alidade, contours sketched on site [V, Rickenbacher 2018; spektrum] | Construction lines left in, rays, station triangles, provisional contours | Leave the construction pencil visible under the inked line (Cajal's rule, already H3) |
| Landeskarte 1935 onward; glass engraving 1953 to about 2000 | Engraving into coloured lacquer on glass plates, one plate per colour separation [V]. Rock drawing by hand at about 1 h per cm² [V-prior]. The *Felsiers* still update rock and glaciers today (Dähler, Gilgen, Heger) [V] | Scribed lines are crisp and even, with tapered ends; colours are separations, so they overprint | The **separation** idea: each ink sits on its own layer, multiplied (already I6). Scribed lines are precise, which contrasts with the fieldbook pencil |
| Imhof (1895–1986) | Pencil, chalk, watercolour; sketchbook always with him on climbs; a 14-route sketch map of the Schesaplana; panoramas; reliefs; *Gelände und Karte* (1950, for the army, on field observation) [V] | "Too topographical for the artist, too artistic for the topographer" [V] | This is the brief: a **topographer who draws**. Pencil first, then ink, then a watercolour wash, never decoration |
| Imfeld (1853–1909), Heim | 40+ panoramas; a **parallel-oblique** view that shows mountains partly in aspect; labels "merge into the map without becoming dominant" [V]. The Rigi-Kulm panorama: Imfeld engraved the contours, J. J. Hofer did the foreground [V] | Ridge outline, hatching on shaded faces only, hairline label leaders | Panorama strips with leaders, name plus height. Rigi-Kulm is a natural precedent for the app's name |
| 2016 LK modernisation | Database-driven; Frutiger; red rail; colour boundaries; relief and rock kept [V] | | Use the old LK, not the 2016 one: the sketchbook evokes the pre-2016 engraved sheet with its serif-free Römisch/Kursiv mix (Landestopografie-Römisch and -Kursiv from 1952 [V-prior]) |
| Neural relief (Jenny 2020), automatic rock hachures (Geisthövel and Hurni) [V-prior] | | | Not for hand-drawing; noted only to avoid "fake-hand" algorithms |
| Tom Patterson | Swiss-style colour relief: lit high slopes brightest, valleys a medium tone, shading weakening downslope [V, via search] | | A slope-lit pencil tone, not a grey raster |

**What a cartographer's field sketch looks like** (Kroki types per [youngstarswiki Kroki](https://youngstarswiki.org/de/wiki/art/kroki), an army and scouting source [V]):

- **Ansichtskroki.** A perspective view drawn in the terrain. Main terrain lines first, then forests, houses and roads from the legend. **The further away, the fainter.**
- **Plankroki.** A plan view based on the map, adding only information the map lacks.
- **Wegkroki.** A route from A to B; only marks immediately left or right of the path, in simple lines.
- **Kompasskroki.** Cross-country: each leg carries only a *Marschzahl* (bearing) and a distance, starting at a known point.
- **Mandatory furniture:** a title, an approximate scale, a north arrow (labelled), the draughtsman's name, and the date and **time**.
- **Hatching code:** forest diagonal, buildings vertical, water horizontal.
- **Swiss hiking time** [V, ASTRA handbook]: 4.2 km/h on the flat, with a Schweizer Wanderwege formula for height. *Leistungskilometer* rule: 1 Lkm = 1 km on the flat = 100 m of ascent; 10–15 min per Lkm [V, chemie.de summary]. The Swiss Army bearing unit (*Artilleriepromille*, 6400 per circle) was **[U]**, since no source was fetched.

---

## 3. Route, hiking and summit conventions

**Wegweiser and markings** (ASTRA and Schweizer Wanderwege, *Handbuch Signalisation Wanderwege*, SN 640 829a [V]):

| | Wanderweg | Bergwanderweg | Alpinwanderweg |
|---|---|---|---|
| Sign colour | yellow RAL 1007 | yellow RAL 1007 | blue RAL 5015 |
| Sign tip | yellow | white RAL 9016 / red RAL 3020 / white | white / blue RAL 5015 / white |
| Confirmation and marking | yellow rhombus (diamond) | white-red-white bar | white-blue-white bar |
| SAC hiking grade (indicative) | T1 | T2–T3 | T4–T6 [U for the exact boundaries] |

- **Lettering:** ASTRA-Frutiger Standard, 30 mm cap height, scaled 75 %. Special notes are 20 mm [V].
- **Destinations** run top to bottom: Nahziel, Zwischenziel, Routenziel. Times are written `45 min`, `1h 30 min`, `3h`, `4h 30 min` [V].
- **Standortfeld:** the place name over its height (`628 m`), taken from the LK25 spot height [V].
- **Confirmations** go within sight of signposts, at forks and about every 10 min of walking [V].
- **Route fields:** national and regional routes are green Pantone 368 C, numbered in Frutiger 76 Black Italic, white, 26 mm. Local route fields are 75 × 75 mm [V].
- **"Wanderland Schweiz"** (SchweizMobil) is the national route network on these green fields [V].
- **RAL approximations [U]:** 1007 ≈ `#e79c00`, 3020 ≈ `#c1121c`, 9016 ≈ `#f6f6f6`, 5015 ≈ `#2271b3`. SY `#e59e1f` and SR `#bf2233` are close to 1007 and 3020. PB is not close to 5015 (E4).

**SAC grades:**
- Hiking scale T1–T6 [V that it exists]: T1 Wandern, T2 Bergwandern, T3 anspruchsvolles Bergwandern, T4 Alpinwandern, T5 anspruchsvolles Alpinwandern, T6 schwieriges Alpinwandern [U for the names; the PDF was not fetched].
- Mountaineering scale L, WS, ZS, S, SS, AS, EX with ± modifiers [V that these grades exist, sac-cas.ch].
- In a sketch, write the grade **hand-boxed** next to the route line, e.g. `T4` in a rough rectangle, or `WS+`.

**Summit objects:**
- **The Gipfelbuch and register:** covered in [V-prior].
- **The summit cross:** the LK has a "Shrine, cross" glyph [V].
- **Orientation tables (*Panoramatafel*):** each feature is given with its bearing and distance [V-prior, opendata.swiss Panoramatafeln].
- **Hut stamps (*Hüttenstempel*):** a widespread practice, but **no source was found** [U]. Keep `StationStamp` as "certifies an act" only.
- **SAC hut map label:** "Trifthütte SAC" in the hamlet italic class [V legend], abbreviated "H." or "Cab." [V].

---

## 4. swisstopo digital and coordinate formats

**Coordinates:**
- **LV95 (CH1903+):** E before N, 7 digits each; E begins with 2 and N with 1. The origin is at Bern, E 2 600 000 / N 1 200 000 [V]. Axes are called **E/N** (formerly y/x) [V, Kanton Aargau].
- **LV03:** 6 digits, "larger value first", e.g. `666 270 / 212 290` [V legend]. The height origin is the Repère Pierre du Niton at 373.600 m [V]. LV03 differs from WGS84 by −50 to −110 m in y, −130 to −160 m in x and 45–53 m in height [V].
- **Notation by context:** use spaces in map furniture and print (`2 627 000`), and the Swiss apostrophe in running text and software readouts (`2'627'000`), as in swissNAMES3D attributes such as `10'000` [V repo data]. The apostrophe in map.geo.admin's readout is [U].
- **Sketch use:** in a field note, write `E 2'627'350 N 1'172'480` by hand. Write sheet ticks as `2 627` (km), with the leading `2` optionally smaller [U, the old LK convention].

**Data products** [V]:
- **swissALTI3D:** 0.5 m and 2 m grids; ±0.5 m (1σ) for lidar and ±1–3 m for stereo.
- **DHM25:** 25 m grid; mean accuracy 1.5 m on the Plateau and Jura, 2 m in the pre-Alps and Ticino, 3 m in the Alps.
- **swissSURFACE3D:** a classified point cloud, with a raster version.
- **swissNAMES3D:** 437 000+ names. OBJEKTART values used by the repo include `Hauptgipfel`, `Gipfel`, `Alpiner Gipfel`, `Haupthuegel`, `Felskopf`, `Pass`, `Strassenpass`, `Wasserfall`, `Aussichtspunkt`, `Ort`, `Ortsteil`, `Gebaeude`, `Flurname swisstopo` and `Lokalname swisstopo` [V repo].
- **Sketch use:** the class drives the lettering class. Hauptgipfel is upright caps plus a trig triangle; Gipfel is upright plus a spot height; Felskopf is small italic; Flurname is the letter-spaced light italic.

**Web map styles** (`vectortiles.geo.admin.ch`) [V]:
- The `basemap.vt` style background is `#fdfdfe`. Light base is `#fcfcfc`, with contours `#bf8a40`, forest `#bad2ac` and sand `#f0dabc`. The winter style has spruce-green forest `#507e62` and a greenish sun tone `#f0f505`.
- Fonts: Frutiger Neue Condensed Regular/Medium, Frutiger Neue Italic, Regular, Medium.
- Peak label: `name\nele` with the elevation at 0.75 scale, navy `#1b243e`, a paper halo `rgba(242,242,242,.9)`.
- Paths through rock or scree get a 2–7 px blurred paper knockout (`mask_terrain`).

**Federal identity:**
- Swiss red `#ff0000` (CMYK 0/100/100/0, Pantone 485). The federal logo is set in Frutiger Light [V edi.admin.ch].
- **Do not use it.** Gipfelbuch must not look federal (rule kept from the design book); SR stays the route red.

**Licence** [V]:
- All swisstopo federal geodata have been OGD since **1 March 2021**: free use including commercial, with source attribution the only condition.
- Accepted attributions: "©swisstopo" or "Federal Office of Topography swisstopo" (or the DE, FR or IT forms). Central attribution is OK for multi-source products (clarified September 2021).
- **Sketch use:** a hand-written colophon line "Grundlage: © swisstopo (OGD)", lower right, in pencil.
- **Caution:** do not trace or reproduce LK sheet artwork as an image. The data (DEM, names, vectors) is OGD and the symbols are conventions, but scanned LK raster sheets are also OGD; prefer drawing from data.

---

## 5. Sketch translation catalogue (30 primitives)

**Shared conventions:**
- Sizes are CSS px at an 800 px figure width; scale by `w/800`, with a 0.5 px floor.
- **Pen** means a tapered variable-width outline (perfect-freehand style, as in the planned `PenLine`): about 0.6 × width at the ends, an ink blob at the start, wobble 0.4–0.8 px, seeded by id.
- **Pencil** means GR or a colour at 0.55–0.8 opacity, constant width, two passes offset by 0.3 px, no taper.
- **Coloured pencil fill** means directional hatch strokes at 0.25–0.45 opacity, *never* a texture (honouring "no grain").
- Inks: `K` = LK ink `#131313`; `B` = NB brown `#95500c`; `W` = GL water `#30626b`; `Gr` = GG forest; `P` = GR pencil `#49423d`; `R` = SR `#bf2233`; `Y` = SY/YY; `N` = PB navy.
- **Optional LK-true sketch inks** for pencil fills only, never text (each would need a contrast check and a Brezine decision):
  - contour brown pencil `#b46e0d` (swisstopo basemap);
  - water pencil `#4da4da`;
  - glacier wash `#cde8f4`;
  - forest pencil `#3e990a` at 0.3;
  - relief blue-grey `#adbcc7`.

| # | Primitive (props) | Draws | Spec |
|---|---|---|---|
| S1 | `SketchContour {d, kind: normal\|index\|inter, surface: earth\|scree\|ice}` | One contour | Ink by surface: B for earth, P for scree, W for ice. Width 0.9 normal, 1.6 index, 0.7 intermediate (dash 3/3). Pencil, wobble 0.5. Fade the last 15 % of open ends with a stroke gradient |
| S2 | `ContourLabel {path, value}` | An index label in the line | Italic hand figures, 11 px, ink as the line; the line is cut 2 px either side; rotated to the tangent and flipped to read uphill |
| S3 | `ContourScribble {dem\|rings}` | A quick 3–6-ring summit or ridge form | Nested pen loops, each not closed: the gap is 8–15° and the end overshoots 2 px. Spacing tightens on the steep side. Only every 5th ring heavier |
| S4 | `TrigTriangle {h, label}` | A trig point | A 7 px equilateral in 3 strokes (the apex overshoots 0.8 px), 1 px K, a 1.2 px centre dot. Label up and right: `2127.6` italic bold 11 px |
| S5 | `SpotX {h, mark: x\|dot}` | A spot height | × = two 3 px strokes at 1 px, or a 1.6 px dot; figure italic 11 px, K (W for lake level) |
| S6 | `SummitCross {register?}` | Summit cross and tin | A 2-stroke cross, 6 × 8 px, 1.1 px K; optional 3 × 2 px box (the Gipfelbuch tin) at its foot |
| S7 | `RockHachure {poly, light=315}` | A rock face | Fall-line strokes. Shaded face 1.4 px at 2.5 px spacing, touching the ridge; lit face 0.6 px at 5 px, broken, stopping 2 px short. Strokes never cross. Opacity 0.75. Triangle facets ≈ 9 px |
| S8 | `ScreeStipple {poly, light}` | Scree | Seeded 4–6-gon "pebbles", r 0.5–1.6 px, growing downslope by 1.5×; density ×2 in shade; a few boulders (r 3) with a heavier lower-right edge. Fill K at 0.8 |
| S9 | `GlacierWash {poly, flow}` | A glacier | A wash of W hatch at 0.25 along the flow (6 px spacing, 0.5 px) plus crevasse ticks of 2–4 px at 1 px across the flow, clustered at the bends; blue contours (S1, ice); no outline |
| S10 | `EscarpmentComb {d, side, surface}` | An edge or step (*Böschung*) | A 1 px base line plus teeth of 3–4 px at 2 px pitch on the downhill side, tapered; B on earth, K on stone |
| S11 | `KrokiHatch {poly, kind: forest\|building\|water}` | Kroki area fill | Forest diagonal 45° in Gr (spacing 4, 0.7 px); building vertical in K (spacing 2.5, 0.6 px); water horizontal in W (spacing 3, 0.6 px). Clipped by a hand outline; opacity 0.6 |
| S12 | `HandScaleBar {mpp}` | Scale bar | A hand-ruled double rail, 4 px tall, alternating segments **filled with pencil hatch** (not solid). End ticks overshoot 1.5 px. Labels `0 · 500 · 1 km` in italic hand. A true length is required (F1) |
| S13 | `NorthArrow {declination?}` | Kroki north | A single 1.2 px pen shaft of 28 px, an open 2-line head, and a hand "N" above. Optional declination fan: grid N (pencil), true N (pen), magnetic N (half arrow, R), angle written `3° E` |
| S14 | `GridTicks {e0,n0,step}` | Coordinate ticks at the frame | 5 px pen ticks, hand-ruled with 0.3 px wobble; labels `2 627` / `1 172` in 10 px italic hand, the leading `2`/`1` at 75 % size; corners in full: `2 627 000 / 1 172 000` |
| S15 | `KrokiTitleBlock {title, scale, author, date, time}` | The mandatory Kroki box | No box. A hand title, underlined once, then `ca. 1:25 000 · R. C. · 01.10.2026 · 14:20` in small hand. Lower left |
| S16 | `HandWegweiser {dests:[{name,time}], here:{name,h}, kind}` | A signpost | A pen-drawn arrow sign with a pointed tip, filled with Y pencil hatch (0.45 opacity, 30° diagonal), tip striped per category (white-red-white = three hatch bands). Times right-aligned `1h 30 min`; Standortfeld `Standort / 628 m` (height from the LK25 spot height) as a white plate under it. Upright print hand (ASTRA-Frutiger-like caps) |
| S17 | `TrailLine {d, cat: hike\|mountain\|alpine}` | A route in the Wanderkarte red | R: hike solid 1.8 px; mountain dashed 6/3; alpine dotted (1.4 px dots at 4 px). Round caps, pen taper |
| S18 | `Blaze {kind}` | A painted marking | Rhombus 8 px in Y (hike), or 12 × 7 px white-red-white bands with a 1 px K outline only on the left and top edges (mountain, alpine). Slightly rough paint edge (wobble 0.6). Inline, upright |
| S19 | `GradeBox {grade}` | `T4`, `WS+` | A rough hand rectangle (4 strokes, overshoot 1.5 px), the grade in bold technical caps 11 px, R if it is the route's crux, otherwise K |
| S20 | `HandName {text, cls: peak\|place\|hamlet\|water\|glacier\|region\|pass}` | Lettering by class | peak: upright caps, N, letter-space 0.04 em, 13–15 px. place: upright mixed case, K. hamlet: sloped (skew −12°), K. water and glacier: sloped, W. region and field: letter-spaced 0.3 em, light, sloped. pass: upright small caps. Abbreviations P., Gl., H., J., L. Paper halo 2 px |
| S21 | `PeakLeader {x,y,label,h,dist}` | Imfeld- or Tafel-style labels above a skyline | A 0.6 px vertical hairline, 10–40 px, a 1.5 px dot at the peak; label `Niesen 2362` and below it `14.2 km · 205°` in small italic. Leaders never cross; stagger them in 2–3 rows |
| S22 | `FieldCoord {e,n}` | A hand-written coordinate | `E 2'627'350 · N 1'172'480`, apostrophes, digits in print (rule H1: digits stay print), labels in hand |
| S23 | `StationRays {station, targets}` | A plane-table or Feldbuch station | Station as S4; rays in pencil at 0.6 px, extended past the target by 6 px; the bearing written along the ray (`205.3°`); one red ray for the solved one |
| S24 | `ReliefPencil {dem, light=315}` | Imhof-style pencil shading | Short cross-contour pencil strokes on aspects 90–270° from the light, length ∝ slope (3–8 px), 0.5–0.8 px, P at 0.3–0.5; stronger at high elevation (aerial perspective); lowlands left blank paper |
| S25 | `SunTone {dem}` | Sun tone | Y hatch at 0.2 on NW-facing slopes above a cutoff, 45°, 5 px spacing |
| S26 | `ProfileSketch {samples}` | An elevation profile (Querprofil) | Ground line pen 1.4 px B; vertical exaggeration written by hand `2× überhöht`; spot heights S5 at the vertices; pencil hatch under the line (fall-line vertical strokes, 3 px spacing) |
| S27 | `PanoramaStrip {horizon}` | A Heim/Imfeld ridge drawing | Ridge pen 1.2 px K; hatch only on faces turning away from the light; far ridges 2 steps lighter and thinner (Ansichtskroki rule: further is fainter): near 1.4 px, mid 1.0, far 0.6 at 0.5 opacity |
| S28 | `MarschTable {legs:[{from,to,km,up,down}]}` | A route time table (Marschzeitberechnung) | A ruled pencil table: leg, km, ↑ m, ↓ m, Lkm, time. Times computed (4.2 km/h on the flat [V]) and written in print figures; a hand sum line drawn twice |
| S29 | `SheetIndexSketch {sheets}` | A Blattübersicht by hand | Hand-ruled rectangles (no closure, corners overshoot), sheet numbers `1208` in technical caps, the current sheet hatched in pencil |
| S30 | `StandNote {aufnahme, nachgefuehrt, stand}` | Corner imprint by hand | Pencil, 11 px hand: `Aufnahme 2024 · nachgeführt 2026 · Stand 10.2026 · © swisstopo (OGD)` |
| S31 | `SpotHeightTable` (optional) | A Höhenkoten list in the margin | Ruled hairlines, italic figures, × marks in the gutter |
| S32 | `CompassLeg {bearing, dist}` | A Kompasskroki leg | Pen line with a mid-arrow; the label along the line, `205° · 640 m`, nothing else (Kompasskroki rule) |

**Width tiers on screen** (pen widths from fineliners, ≈ 3.78 px per mm, scaled down by ~0.6 for screen weight):
- hairline 0.6 (0.1 mm fineliner equivalent);
- fine 0.9 (0.2 mm);
- medium 1.2–1.4 (0.3 mm);
- bold 1.8–2.2 (0.5 mm, route only);
- pencil 0.6–0.9.

At most four tiers per figure (L2 already).

---

## 6. Ranked restyle moves (most impact per effort first)

1. **Hand lettering in the LK class hierarchy (S20).** Two hand styles, an upright technical caps hand and a sloped hand, assigned by swissNAMES3D class. This is the biggest jump in "sketchbook" with no texture. Digits stay print (H1); use a face from the H5 specimen test.
2. **Italic height figures everywhere on maps and sketches (E1, S4, S5, S2).** Convert `SpotHeight`, `TrigPoint` labels and the SheetMap/Tafel heights to sloped tabular figures, inked by class. Add the × spot-height variant. Cheap and authentic.
3. **Kroki hatch fills (S11) replace flat tints** in figure areas: forest diagonal, buildings vertical, water horizontal. This immediately reads as "drawn by an army topographer" and is pure SVG pattern.
4. **The Kroki furniture block on every sketch figure (S15 + S13 + S12):** title, ca. scale, labelled N arrow, initials, date **and time**. It replaces the printed imprint on the sketch-layer figures and keeps F1 (a true scale).
5. **ContourScribble and SketchContour (S1–S3)** on the ContourField header and the DEM figures: open-ended pencil contours, a heavier index line, dashed intermediate lines, labels cut into the line. Contour ink follows the surface.
6. **Hand-drawn Wegweiser (S16) replaces `Signpost`'s print look** for prev/next. Yellow-pencil hatch fill, striped tip per category, Standortfeld `Name / 628 m`, times in the `1h 30 min` format. Keep the link semantics.
7. **TrailLine plus Blaze plus GradeBox (S17–S19)** as the route vocabulary for pipeline stages: red solid, dashed or dotted by certainty, with hand-boxed T and SAC grades.
8. **Panorama leaders (S21, S27)** on the hero and Tafel: Imfeld-style hairline leaders with name, height, distance and bearing, and far ridges fainter.
9. **Rock and scree doodles (S7, S8)** as section ornaments *only where a rock concept is discussed* (horizon and silhouette pages), never as wallpaper. Ornament budget F6.
10. **Relief by pencil (S24, S25)** in `DemSketch` and `SectionSketch`: cross-contour pencil strokes on the shaded side plus a yellow sun-tone hatch, instead of grey rasters on sketch figures. Raw DEM figures stay raw (R11).
11. **Grid ticks and the corner LV95 written by hand (S14)** in `SheetFrame`: pencil ticks with the small leading digit. Field-note coordinates use apostrophes (S22).
12. **Declination fan (S13)** once per sheet, on the pages about pose and yaw. It is literally the yaw-offset concept, so it carries a fact.
13. **Station rays (S23)** for the pose and solve pages: the plane-table metaphor, with pencil construction left visible and the solved ray in red.
14. **Marschzeit table (S28)** as the "runtime / cost" table form: Lkm-style columns, a hand sum, print figures.
15. **Glacier wash and crevasse ticks (S9)** as the "uncertain / moving" fill: crevasses as doubt marks. Use sparingly.
16. **Escarpment comb (S10)** as the "threshold / step" mark in plots, e.g. an accept-rule cutoff or a cliff in a loss curve. A Swiss replacement for a dashed threshold line.
17. **Hand Blattübersicht (S29)** for the index page: hand-ruled sheet rectangles with LK-style 4-digit sheet numbers (Niederhorn sits on **1208 Beatenberg** [V-prior]).
18. **Pencil colophon (S30)** "© swisstopo (OGD)" plus Aufnahme, nachgeführt and Stand, replacing the print imprint on sketch figures.
19. **Two-layer drawing:** pencil construction under the ink on every bespoke sketch (the Messtisch original), using the existing `SketchPath` with a pencil underlay offset of 0.3 px. Turn it off for measured data.
20. **(Needs user re-confirmation, E7.)** The scrappier moves the earlier feedback banned: slight hand rotation of margin notes to 2°, pasted Kroki cards at 1–2° tilt, a ruled margin. Ask before doing any of them.

**Do not:**
- use federal red or the Swiss cross as decoration;
- trace LK raster artwork;
- put coloured-pencil hatch over photos or DEM rasters;
- set measured numbers in a hand face;
- use dashes decoratively, since dashes mean certainty (L3).

---

## 7. Sources

**swisstopo and official** [all fetched this session unless noted]:
- swisstopo, *Conventional signs 2008*, EN: https://www.swisstopo.admin.ch/dam/en/sd-web/WxsMJ4yE7xeV/Zeichenerklaerung_2008_e.pdf. Text extracted; pages 3–4 rendered and colours sampled. DE edition: https://www.swisstopo.admin.ch/dam/de/sd-web/WxsMJ4yE7xeV/Zeichenerklaerung_2008_d.pdf
- swisstopo vector styles: https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json, …/ch.swisstopo.lightbasemap.vt/style.json and …/ch.swisstopo.basemap-winter.vt/style.json
- Siegfried map: https://www.swisstopo.admin.ch/en/siegfried-map
- Modernisation of the national maps 2001–2021: https://www.swisstopo.admin.ch/en/modernisation-of-the-national-maps-2001-2021
- Depicting Switzerland's terrain: https://www.swisstopo.admin.ch/en/depicting-switzerlands-terrain
- Rickenbacher, *Messtisch oder Phototheodolit?* (swisstopo colloquium 2018): https://www.swisstopo.admin.ch/dam/de/sd-web/s61y3oqPmfKs/181116-swisstopo-Kolloquium-MesstischPhototheodolit-web-DE.pdf
- Glass plates exhibition (Vitromusée): https://vitromusee.ch/wp-content/uploads/2024/02/DossierDePresse_Expo_swisstopo-1.pdf (search summary)
- OGD conditions and attribution: https://www.swisstopo.admin.ch/en/conditions-geodata, https://www.swisstopo.admin.ch/en/source-reference-ogd-swisstopo (search summary)
- swissNAMES3D: https://www.swisstopo.admin.ch/en/landscape-model-swissnames3d, https://wiki.openstreetmap.org/wiki/Switzerland/swissNAMES3D
- DHM25 product info: https://www.swisstopo.admin.ch/dam/en/sd-web/RoQOihiRmBVW/DHM25-ProdInfo-EN.pdf (search summary); swissALTI3D: https://wp.unil.ch/geocomputing/?p=2180 (search summary)
- LV95: https://en.wikipedia.org/wiki/Swiss_coordinate_system, https://www.ag.ch/de/themen/planen-bauen/grundbuch-vermessung/amtliche-vermessung/neue-koordinaten
- Federal logo / CD red: https://www.edi.admin.ch/dam/edi/de/dokumente/anleitung_zur_verwendungdesbundeslogos.pdf.download.pdf/anleitung_zur_verwendungdesbundeslogos.pdf (search summary)

**Hiking and SAC:**
- ASTRA / Schweizer Wanderwege, *Signalisation Wanderwege* (SN 640 829a): https://swisshiking.ch/de/media/download/d2b3e6921c5476fccc67b4c0f66771f169539373 (downloaded; tables 6–9, §2.1.7, §3.1.2)
- SAC difficulty scales: https://www.sac-cas.ch/de/ausbildung-und-sicherheit/tourenplanung/schwierigkeitsskalen/
- Bergwelten trail types: https://www.bergwelten.com/a/wegtypen-welcher-weg-fuehrt-wohin (search summary)
- Leistungskilometer: https://www.chemie.de/lexikon/Leistungskilometer.html (search summary)

**Heritage and craft:**
- Imhof, ICA tribute: https://icaci.org/?p=2926; ETH Imhof exhibition: https://www.kartensammlung.ch/Imhof/imhof6engl.html
- Imfeld: https://mapdesign.icaci.org/?p=1705, https://hls-dhs-dss.ch/articles/031187, https://www.geographicus.com/P/RareMaps/imfeldxaver
- Felsiers (NYT via Map Room): https://www.maproomblog.com/2022/03/the-people-who-draw-rocks/
- Kroki conventions: https://youngstarswiki.org/de/wiki/art/kroki (PDF print, text extracted)
- Hachures (Lehmann, rules): https://en.wikipedia.org/wiki/Hachure_map
- Sketchy relief technique: https://andywoodruff.com/blog/hachures-and-sketchy-relief-maps
- Swiss-style colour relief: https://www.research-collection.ethz.ch/handle/20.500.11850/1574; Jenny, *Farbige Reliefkarten*: https://mail.colororacle.org/berniejenny/pdf/2008_Jenny_FarbigeReliefkarten.pdf
- New national maps, 2016: https://www.maproomblog.com/2016/03/new-national-maps-of-switzerland/
- Prior verified sources (Jenny 2010/2014 rock and scree, Imhof name placement, Wüst 2016 lettering) are listed in `reports/gipfelbuch-design-book.md` §23 and `reports/gipfelbuch-field-notebook-design.md`.

**Not verified [U]:**
- RAL→sRGB hexes;
- current declination (~3° E);
- the T-grade names;
- the Wanderkarte solid/dashed/dotted split;
- the hut-stamp custom;
- the small leading digit on grid labels;
- the apostrophe in map.geo.admin's readout;
- the Artilleriepromille bearing unit;
- LK print line weights in mm for contours.
