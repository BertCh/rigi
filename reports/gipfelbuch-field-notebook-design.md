# Gipfelbuch: the field-notebook design system

**Revision, 2026-10-01 (later, user request):** softer sheet. No paper grain, tape, tilted prints, red margin rule or sheet-frame ticks. The grid stays, at about half its former strength (6 %, index ruling 8 %), and the paper is warm white (W 96% + YY 4%). The rules are in the Gipfelbuch README ("Soft sheet").

Status: research consolidated and plan written on 2026-10-01. No code has changed yet; the five work packages (WP1–WP5) in the last section carry the implementation. This report builds on [`gipfelbuch-swiss-aesthetic.md`](gipfelbuch-swiss-aesthetic.md), [`gipfelbuch-swiss-sketch-research.md`](gipfelbuch-swiss-sketch-research.md), [`gipfelbuch-sketch-rendering.md`](gipfelbuch-sketch-rendering.md), [`gipfelbuch-notebook-research.md`](gipfelbuch-notebook-research.md) and `src/components/gipfelbuch/README.md`, and does not repeat them. It adds four research passes:

1. the paper objects of Swiss mountaineering and fieldwork;
2. hand-drawn data practice and the NPR line-weight literature;
3. Swiss typographic fundamentals (grid, type scale, tables);
4. Landeskarte symbology with real numbers.

It then states one design system, audits the current code against it, and plans the work.

Verification marks: **[V]** means checked against a fetched source, a repo file or a font binary. **[U]** means established practice or inference that was not confirmed.

## 1. Research synthesis

### 1.1 Alpine notebooks and field books: the paper objects

**The summit register.** A Gipfelbuch lives in a weatherproof tin on the summit cross. Club sections, hut keepers and guides supply them, and full books go to archives ([Bergwelten](https://www.bergwelten.com/a/vom-sinn-und-unsinn-des-gipfelbuchs); [Wikipedia: Summit register](https://en.wikipedia.org/wiki/Summit_register); Staatsarchiv Thurgau holds a book covering 1916–1957, [query-staatsarchiv.tg.ch](https://query-staatsarchiv.tg.ch/detail.aspx?ID=98318)) [V]. Sarah Jane Schmitt's study of 125 years of entries (DAV *Panorama* 1/2014, [PDF](https://bibliothek.alpenverein.de/webOPAC/04_FAQ_oft_gestellte_Fragen/Gipfel_und_Huettenbuecher/SpurendesDagewesenseinsArtikelimPanorama-1-2014-Kultur-MedienS.74.pdf)) [V] found that:

- The register started (1786) as a *Gipfelflasche*: a bottle holding visiting cards.
- Around 1900, entries were "nüchtern und sachlich": date, name, and sometimes route, times, weather and view. Rhymes and sayings came only after WWII.

Bergwelten still asks for *platzsparend* entries in the form date, time, name, route, and says the book is "kein Malbuch" ([Bergwelten](https://www.bergwelten.com/a/was-schreibe-ich-ins-gipfelbuch)) [V]. **For us:** a run record has the same shape as a register line: who/what, when, where, by which route, under what conditions, with what result. A stack of uniform cards in a tin is a legitimate index form, and it is not a graph.

**The Führerbuch.** The Bern guide regulation of 1856 required every patented guide to carry a paginated book in which clients wrote testimonials. More than three bad entries in a year cost the guide his patent ([Jungfrau.ch](https://www.jungfrau.ch/de-ch/die-geburtsstaette-der-bergfuehrerschaft/); [AAC transcriptions](https://publications.americanalpineclub.org/articles/12193822300/Alps-Mr-Sydney-Spencer-Has-Kindly-Transcribed-the-Following-American-Entries-from-Fhrerbcher-in-the-A-C-library)) [V]. Each entry follows a fixed order: year, date, place, guide, climb, signature, home town. **For us:** this is the analogue of verification. A check id signs the entry, and the frozen accept rule is the patent rule.

**Wegweiser.** The *Handbuch Signalisation Wanderwege* (ASTRA / Schweizer Wanderwege, SN 640 829a; [PDF](https://swisshiking.ch/de/media/download/d2b3e6921c5476fccc67b4c0f66771f169539373)) [V] specifies the trail categories:

| Category | Sign | Tip |
| --- | --- | --- |
| Wanderweg | yellow RAL 1007 | yellow |
| Bergwanderweg | yellow | white-red-white |
| Alpinwanderweg | blue RAL 5015 | white-blue-white |

It also fixes:

- **Destinations** run top to bottom: nearest (Nahziel), then intermediate, then the end of the route (Routenziel).
- **Times** are written `45 min`, `1h 30 min`, rounded to 5 min. From 3 h upward, times near the full hour round to it. On one post, either every sign gives a time or none does.
- **The Standortfeld** gives the place name over its altitude (`628 m`), with spelling from swissNAMES and height from LK / DHM25.

**For us:** the Standortfeld becomes the entry header, the time format becomes our duration style, and the destination order becomes the signpost order. RAL 5015 has no Brezine swatch. PB (#002f55) stands in for it, and the code says so.

**SAC route topos.** The SAC legend ([sac-cas.ch/en/legende](https://sac-cas.ch/en/legende)) [V] encodes certainty in line style:

- **solid:** a marked trail, up to T3;
- **dashed:** higher demands, or an approximate itinerary;
- **dotted:** pathless terrain that cannot be charted.

The ORTOVOX/Panico topo legend ([PDF](https://www.ortovox.com/safety-academy-lab-rock/fileadmin/user_upload/Downloads/TopoErklaerungDownload_EN.pdf)) [V] confirms the topo layout:

- a pitch column to the right of the route, `length / grade` plus a pitch number, counted from the bottom;
- belay, bolt, rappel and summit-register symbols.

The glyph shapes are **[U]**, so we draw our own. **For us:** a pipeline drawn as a climb. Stages are pitches, checkpoints are belays, and certainty is coded solid / dashed / dotted.

**Surveyor and naturalist field books.**

- A US surveyor's book puts tabular readings on the left page and the header, remarks and sketch on the right page, which carries a red centre line. Errors are struck with one line so they stay legible, and the correction is initialled. Nothing is erased and no page is removed ([open-exam-prep](https://open-exam-prep.com/study-guides/nsps-cst-1/field-operations-notes-communication/field-note-bookkeeping)) [V]. Whether Swiss Feldbücher used the same split is [U].
- The Grinnell system has four linked tiers, field notebook → journal → species account → catalogue, cross-referenced by date and locality ([MVZ Berkeley](https://mvz.berkeley.edu/the-grinnell-method)) [V].

**For us:** a split spread with the print table on the left and the sketch on the right; a strike-through that carries a signature; and a page taxonomy (Field page / Journal / Account / Catalog) that replaces any graph.

**Panoramas and orientation tables.**

- Heim's Säntis panorama was surveyed in 1870–71 ([HLS](https://hls-dhs-dss.ch/articles/028851)) [V].
- Imfeld drew 40+ panoramas whose labels "merge into the map without becoming dominant" ([ICA](https://mapdesign.icaci.org/?p=1705)) [V].
- Imhof's Urirotstock panorama is a pencil fair drawing ([kartensammlung.ch](https://www.kartensammlung.ch/Imhof/imhof8engl.html)) [V].
- Summit orientation tables give each named feature with its bearing and distance ([opendata.swiss](https://ckan.opendata.swiss/dataset/panoramatafeln)) [V].

**For us:** peak labels follow the orientation-table grammar: name, altitude and distance in km.

**The kitsch boundary.** A material element is allowed only if it does the same job as in the original:

- a stamp certifies;
- tape attaches evidence;
- a clipping is a source.

Coffee rings, torn edges, fold shadows, leather textures, sticky notes, rotation above 4° and decorative pins are mood, not function. They are banned.

### 1.2 Sketch, handwriting and hand-made data drawing

**Precedents.**

- **Dear Data** (Lupi and Posavec, [Pentagram](https://www.pentagram.com/work/dear-data/story)) [V]. Every card has a key on its back, because the drawing never explains itself. **Take:** every figure carries a print "how to read" key.
- **Mona Chalabi** ([SSENSE](https://www.ssense.com/en-pk/editorial/culture/data-journalist-mona-chalabi-isnt-sure-about-certainty)) [V] uses a shaky line "to remind someone that a human has made a decision". **Take:** this is honest only for the authorial layer, never for measured series, and that is already the Gipfelbuch rule.
- **Du Bois's Paris plates** ([AAIHS](https://www.aaihs.org/digital-du-bois/)) [V]. **Take:** flat fills from a few swatches, exact numbers lettered in print beside the marks, and blank paper as the separator.
- **Nightingale**. **Take:** fill carries the category and a print legend keys it. Do not copy the rose form: its area encoding misleads.

**NPR research.**

- **Winkenbach and Salesin (SIGGRAPH 94, [PDF](https://www.cin.ufpe.br/~sbm/p91-winkenbach.pdf)).** Stroke textures depend on output resolution, so use fewer strokes when small. *Indication* means hatching only near edges.
- **Praun et al. (SIGGRAPH 2001).** Tonal art maps are nested stroke sets, so a value change adds lines and never reshuffles them.
- **Hertzmann and Zorin (2000).** Hatch along principal directions; on terrain that means the fall line, the Schraffen convention.
- **Goodwin, Vollick and Hertzmann ([NPAR 2007](https://www.dgp.toronto.edu/~todd/isophote)).** Hand line thickness varies with depth and curvature and tapers at the ends. Constant-width strokes "look lifeless". This is the largest computer tell left in the repo.
- **Secord (2002).** Weighted Voronoi stippling places tone by dot density.

**Libraries.**

- perfect-freehand (MIT) is the reference for tapered outline strokes. We write our own, as `sketchify.ts` does for rough.js.
- tldraw drops wobble below 50 % zoom, a pattern worth copying. Its SDK licence rules it out as a dependency.
- roughViz and chart.xkcd do not bound jitter to data tolerance. Ours already does.

**Font audit.** fontTools was run on the google/fonts TTFs [V]:

| Face | GSUB | Alternates | Digits | x-height | Licence |
| --- | --- | --- | --- | --- | --- |
| Architects Daughter (current) | none | 0 | proportional | 0.43 | OFL-1.1 |
| **Caveat** [wght 400–700] | calt, salt, ss01, ss02 | 275 | tabular | 0.40 | OFL-1.1 |
| **Shantell Sans** [wght, INFM, BNCE, SPAC] | calt, rlig, tnum, zero | 875 | tnum | 0.485 | OFL-1.1 |
| Kalam (fallback) | Latin liga only | 0 | proportional | 0.53 | OFL-1.1 |

Architects Daughter repeats every glyph identically. Caveat cycles alternates, and Shantell Sans has the best small-size x-height.

**Perception.**

- **Wood et al. 2012** ([City Research Online](https://openaccess.city.ac.uk/id/eprint/1274/)) [V]. Sketchiness hurts area judgement but increases engagement and critique. **Take:** no area encodings in sketch style.
- **Boukhelifa et al. 2012** ([AVIZ](https://www.aviz.fr/Research/UncertaintySketchy)) [V]. People prefer dashing for uncertainty. **Take:** keep wobble constant and use dashes for doubt.
- **Song et al., VIS 2025** ([program](https://aa.ieeevis.org/year/2025/program/paper_de570d65-b80f-4e25-9d54-88f11281e2c5.html)) [V]. Hand-drawn fonts significantly lowered perceived credibility. **Take:** numbers and headline claims are never in the hand font.
- **Fox et al., "Visualization Vibes", VIS 2025** ([MIT News](https://news.mit.edu/index%2Ephp/2025/charts-can-be-social-artifacts-communicate-more-than-data-1022)) [V]. Style signals social origin. **Take:** the print survey furniture is what makes the hand read as an observer's note on a survey sheet and not as a doodle.

### 1.3 Swiss design fundamentals

**Emil Ruder, "The Typography of Order" ([neugraphic](https://neugraphic.com/ruder/ruder-text2.html)) [V].**

- Lines over 60 letters are hard to read.
- Unprinted space has "incomparable optical value": white space is the divider.
- The free line of an illustration is the strongest contrast to ordered type. This is the theory behind "print is the form, hand is the observer". A hand line only reads well against a rigorous grid.

**Josef Müller-Brockmann, *Grid Systems*.** Grids of 8 to 32 fields; field heights in whole text lines and gaps of one empty line [U]. **Take:** every vertical dimension is a multiple of the baseline.

**Neue Grafik (1958–65, [Wikipedia](https://en.wikipedia.org/wiki/Neue_Grafik)) [V].** A four-column grid from the cover to the interior, and a cover set in type only. It is the closest precedent for a research journal.

**Karl Gerstner, *Designing Programmes* ([digest](https://artequalswork.com/posts/designing-programmes/)) [V].** "To describe the problem is part of the solution." His 58-unit grid serves one to six columns. **Take:** the type system is a programme of tokens, not a set of page layouts.

**Armin Hofmann.** Reduction, and opposition to the "trivialization of colour". **Take:** rank by weight, size and position, never by colour.

**Lettering on the Landeskarte** ([Wüst 2016, ETH IKA](http://www.ika.ethz.ch/studium/bachelorarbeit/2016_wuest_bericht.pdf); [Biniek et al., ICA](https://ica-proc.copernicus.org/articles/1/9/2018/ica-proc-1-9-2018.pdf)) [V]:

- The engraved *Landestopografie-Römisch* and *-Kursiv* faces were in use from 1952.
- Neue Frutiger has been used since the 2014 vector LK, chosen because it is narrower than Univers and its open forms read better at small sizes.
- Italic marks a category (field names, parts of settlements), not emphasis.

**Consequences:**

- Fira Sans and Fira Sans Condensed are a defensible open stand-in for Frutiger: humanist, with a condensed sibling. Fira has `tnum lnum smcp case` [V].
- A roman serif title has the Römisch precedent. Fraunces stays for H1 and the cartouche only.

**The Confederation's open design system** ([github.com/swiss/designsystem](https://github.com/swiss/designsystem), MIT) [V] uses Noto Sans in only regular and bold, with sizes 12–80. This is evidence that current Swiss public practice uses few weights. Gipfelbuch must not look federal.

**SBB clock** ([Wikipedia](https://en.wikipedia.org/wiki/Swiss_railway_clock)) [V]. The second hand sweeps, then pauses at 12 for the minute impulse. **Take:** a "minute-stop" rhythm for staged animation.

**Contrast, computed on `--gb-paper` #f5f2ea** [V]:

| Swatch | Ratio | Use |
| --- | --- | --- |
| LK | 16.6 | text |
| PB | 12.2 | text |
| BG | 6.9 | text |
| GL | 6.1 | text |
| NB | 5.5 | text |
| SR | 5.4 | text |
| MG | 4.2 | fails at small sizes |
| BL | 2.8 | not text |
| SY | 2.0 | not text |

BL is currently used for `.gb-coord` and Plot tick labels. Both fail.

### 1.4 Swiss cartography: hard numbers

**Lineage** [V]:

- **Dufour (1:100k, 1845–64):** shadow hachures lit from the north-west. Lehmann's rules: strokes follow the steepest gradient, and steeper ground gets thicker strokes.
- **Siegfried (1:25k / 1:50k, 1870–1926):** three-colour contours.
- **Imhof:** aerial perspective, so peaks get the most contrast. Yellow "sun tone" on lit slopes.
- **Modern LK (2001–2021):** swissTLM base, Frutiger lettering, the Swiss-style terrain kept ([swisstopo](https://www.swisstopo.admin.ch/en/modernisation-of-the-national-maps-2001-2021)).

**Rock drawing** ([Jenny et al. 2014](https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf); [Gilgen and Jenny 2010](https://mail.technicalgeography.org/pdf/sp_i_2010/05_digital_rock_and_scree_drawing_in_vector_an.pdf)) [V]:

- Black only, round caps.
- **Widths:** mean 0.12 mm. Shaded slopes 0.22 mm at the foot to 0.26 mm at the top. Lit slopes 0.06–0.10 mm, often broken.
- **Density:** about 7 strokes per 2 mm. Lit faces 4–5, shaded peaks up to 9.
- **Light** from the north-west. Contrast is strongest at the peaks.
- **Elements:** triangles about 2.5 mm wide, with their bases on contours.
- **Rules:** lit-face hachures stop short of the ridge, shaded ones touch it. Strokes never cross, except along faults.
- **Orientation:** hachures perpendicular to the contours mean steep ground; parallel means passable.
- **Contours in rock:** LK keeps only the 100 m index contours, and contours are thinner on lit faces.

**Scree** ([Jenny, Hutzler and Hurni 2010](https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf)) [V]:

- Stones are convex 4–8-gons, not circles.
- Size runs from about 0.01 mm in sun to 0.22 mm in shade, and stones grow toward the foot of the slope.
- Placement uses Floyd–Steinberg dithering of the relief, with an obstacle mask kept tight enough that it leaves no halo.
- Boulders have a thicker lower-right shadow edge.

**Glaciers and contours** ([Zeichenerklärung 2008](https://www.swisstopo.admin.ch/dam/de/sd-web/WxsMJ4yE7xeV/Zeichenerklaerung_2008_d.pdf); [basemap style.json](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json)) [V]:

- A glacier is a pale tint with blue contours and blue crevasse strokes. It has no outline.
- Contour inks: soil brown, scree black, glacier and lake blue.
- LK25 uses a 20 m interval in the Alps with 100 m index contours. Only index contours carry labels.
- Basemap screen colours: contour `#b46e0d` at 35 %, peak labels `#1b243e`, glacier fill `#cde8f4`.

**Lettering, spot heights and frame** [V]:

- Municipalities are upright; hamlets and places inside a municipality are italic. Areas and forests are light and letter-spaced.
- Abbreviations: P., Gl., H., L., J.
- There are separate symbols for trig points and spot heights. The triangle-with-centre-dot glyph for a trig point is [U].
- The km grid is labelled larger number first.
- Every sheet has a scale bar in the margin, an edition year, and a content date (*Stand*). Sheets are revised on a 6-year cycle.
- Niederhorn lies on LK25 sheet **1208 Beatenberg** [V, hiking listings].

**Nearest Brezine swatches** (CIE76 ΔE against `src/brand/khipu.ts`):

| Map role | Swatch (ΔE) | Note |
| --- | --- | --- |
| rock / spot-height black | LK (3) | |
| soil contour | NB (16) | the line ink, 5.5:1 |
| peak lettering | PB (11) | |
| water | GL (30–40) | a deliberate muting: Brezine has no saturated blue |
| glacier fill | paper + 12–18 % GL | |
| forest | paper + 25–35 % PG | |
| relief | BL (6) | |
| sun tone | YY | |
| route | SR | the only red |

## 2. Design principles: the Gipfelbuch design system

The book is a **surveyor's field book bound into a map sheet**. Print is the form: the grid, type, tables, numbers and map furniture. The hand is the observer: margin notes, circled marks, leaders, struck guesses. Only furniture wobbles; data lines stay within their tolerance. Photos and DEM rasters are never filtered, tinted or hatched. Network graphs are not used.

### 2.1 Grid and rhythm

- Base unit `--gb-unit: 6px`. Body line `--gb-line: 24px`. Every line-height, `margin-block`, `gap` and figure height is a multiple of 6.
- Sections are separated by 48 px of paper and chapters by 72 px. Paper, not strokes, does the separating.
- Grid by width:

  | Width | Columns | Outer margin | Gutter |
  | --- | --- | --- | --- |
  | 375 | 4 | 16 px | 12 px |
  | 768 | 8 | 32 px | 24 px |
  | 1280 | 12 | 48 px | 24 px |

  Content is at most 1184 px wide.
- Asymmetric desktop layout (≥ 1024 px):
  - columns 1–2: hanging kicker, entry number and date, flush right;
  - columns 3–8: body, at most 66 ch;
  - columns 9–12: margin notes and the rail.

  Figures span 3–12 or 1–12. Text blocks are never centred.

### 2.2 Type scale (the only sizes allowed)

| Role | Face | Size / line ≥ 768 | Size / line at 375 |
| --- | --- | --- | --- |
| micro: coordinates, ticks, imprint | Plex Mono or Fira tnum, BG ink | 11/12 | 11/12 |
| caps kicker | Fira Sans Condensed **500**, 0.12 em, `case` | 11/12 | 11/12 |
| caption, table | Fira Sans 400 | 13/18 | 13/18 |
| body | Fira Sans 400, ragged right, `text-wrap: pretty` | 16/24 | 16/24 |
| lead | Fira Sans 400 | 20/30 | 18/24 |
| H3 | Fira Sans 600 | 16/24 | 16/24 |
| H2 | Fira Sans 600 | 24/30 | 20/24 |
| H1 | Fraunces 600, opsz high, `text-wrap: balance` | 40/48 | 30/36 |
| Stat | Fira Sans 300, `tabular-nums lining-nums` | 56/60 | 40/48 |
| hand note | Caveat 400–500, at most 12 words | 18/24 | 18/24 |
| hand label in a figure | Shantell Sans 450, INFM 35 | ≥ 13 | ≥ 13 |

Rules:

- Fraunces is for H1 and the cartouche only.
- Italic marks a category: water, derived or estimated values, places inside a larger unit. It is not ornament.
- Numbers in tables and stats use Fira `tabular-nums lining-nums`. Plex Mono is for code, paths and LV95 coordinates. Thousands use a thin space (`formatLv95`).

### 2.3 Inks (Brezine swatches only)

| Token | Swatch | Role |
| --- | --- | --- |
| `--gb-ink` | LK #131313 | text, rock, axes |
| `--gb-secondary` | **BG #4a545c** (new) | secondary text, coordinates, ticks, captions |
| `--gb-contour` | NB #95500c | DEM, terrain, contours |
| `--gb-water` | GL #30626b | image-measured quantities, links |
| `--gb-forest` | GG #575e4e | results |
| `--gb-red` | SR #bf2233 | route; at most once per figure, twice per screen |
| `--gb-navy` | PB #002f55 | peak lettering; RAL 5015 stand-in |
| `--gb-sign`, `--gb-sign-light` | SY, YY | Wegweiser, sun tone |
| `--gb-relief` | BL #919192 | hairlines and hachure **only**, never text |
| `--nb-pencil` | **GR #49423d** (was off-chart #55524c) | the prior, uncertainty |
| `--nb-tape` | **LG #baaf96** mix (was off-chart #e9dfc4) | |
| paper | W + YY | |
| paper-deep | paper + LG | |

### 2.4 Paper and ruling

- One ruling per region, never two stacked:
  - a 5 mm (about 20 px) square grid for figure wells and the notebook;
  - 24 px lines for prose notes;
  - fine vertical transit rules only behind numeric tables.
- The surveyor's red centre line (SR at 38 %) is the only divider in a split spread.
- ~~Paper grain stays at about 5 %.~~ Superseded 2026-10-01: no grain (see the revision note at the top).

### 2.5 Stroke tiers

In an 800 px SVG:

| Stroke | Width |
| --- | --- |
| grid | 0.5 |
| index grid | 0.9 |
| axis | 1.2 |
| series | 1.4–1.6, constant |
| route | 2.2 |
| hachure | 0.5–0.9 (lit 0.5, shaded 1.6–1.9) |

Furniture strokes (arrows, circles, leaders, underlines) are **tapered outlines** with a mean width of 1.3, entry and exit tapers, and an ink blob where the pen lands. A line that carries meaning never has a mean width below 1.2.

### 2.6 Line style codes certainty (the SAC legend)

| Style | Meaning |
| --- | --- |
| solid | measured or verified |
| dashed (4/2) | approximate or model-derived |
| dotted (0.8 px dots, 5 px pitch) | uncharted or open |

Contour inks follow the same idea: brown = measured from the DEM, black at 25–40 % = derived or certain, GL = modelled or image-side. Dashes are never decorative.

### 2.7 Hand versus print

- The hand states decisions and doubts ("threshold chosen by eye"). It never carries a measurement or a headline.
- A digit inside a hand note is set in print.
- At most three hand notes per entry, each 12 words or fewer.

### 2.8 Furniture vocabulary

| Element | Form | Source |
| --- | --- | --- |
| Standortfeld entry header | place name over altitude | Wegweiser |
| Register line | `date · time \| viewpoint \| route \| conditions \| result` | Gipfelbuch c. 1900 |
| Testimony line | `date · check · verdict · signer` | Führerbuch |
| Struck | legible single-line strike plus a `by` signature | field book |
| SpotHeight | 1.6 px dot plus a mono value; `P.` prefix for unnamed points | LK |
| TrigPoint | open triangle with a centre dot, for cameras and stations | LK |
| HutBullet | list bullet | |
| Grade tokens | T1–T6, L…EX | SAC |
| RouteTopo | the pipeline as a climb | topo |
| Waymarks | status | SAC |
| Signpost | prev/next, nearest destination first | Wegweiser |
| Sheet-margin cross-references | "→ 08 · Pose" | LK sheet edges |
| Stand imprint | edition and content date | LK |
| Cartouche | a type-only cover | Neue Grafik |
| Legend, scale bar | | |
| HachureRule | a patchwork of rock triangles | |
| Station stamp | only for a frozen result, at most one per page | |

### 2.9 Motion

- Draw-on happens only on the client outside automation, and reduced motion shows the final state.
- Staged figures follow the minute-stop rhythm: advance, then hold until the data is ready, with a minimum 1.5 s hold.
- Nothing animates a photo or raster.

### 2.10 The kitsch test (a review rule)

Every material element must carry a fact. Banned:

- coffee rings, torn edges, fold or curl shadows, leather or kraft textures;
- rotation above 4°;
- sticky notes and decorative pins;
- drop shadows on prints;
- tape on figures that attach no photo.

## 3. Gap audit (current code against the principles)

### Tokens and type

| # | Location | Gap | Principle |
| --- | --- | --- | --- |
| G1 | `src/components/gipfelbuch/swiss/theme.css:94` | `.gb-coord` is BL (2.8:1), a contrast failure on every coordinate, breadcrumb and rel line | 2.3 |
| G2 | `swiss/theme.css:78` | `.gb-caps` is weight 600 with 0.14 em and no `case` feature | 2.2 |
| G3 | `swiss/theme.css` | No baseline or grid tokens (`--gb-unit`, `--gb-line`), no `.gb-grid`, no Swiss table class, no `text-wrap` rules, no forced-colors handling | 2.1 |
| G4 | `notebook/notebook.css:16`, `:28`, `:31` | `--nb-pencil #55524c` and the `--nb-tape #e9dfc4` base are off-chart. `--nb-hand` is Architects Daughter, which has no `calt`, no alternates and proportional digits | 2.3, 1.2 |
| G5 | `notebook/notebook.css:152` | `.nb-print` has a decorative `box-shadow` | 2.10 |
| G6 | `notebook/notebook.css:178`, `:186` | The range-track SVG hard-codes `%2355524c` (off-chart pencil) | 2.3 |
| G7 | `src/routes/__root.tsx:19` | Fira Sans has no weight 300 for `Stat` | 2.2 |
| G7 | `notebook/notes.tsx:20` | The hand font URL loads Architects Daughter and Kalam only | 2.2 |
| G8 | `notebook/notes.tsx:68` | `Struck` has no `by` signature, and its `decoration-2` in red at 13 px is heavier than a single legible line | 2.8 |

### Ink kit

| # | Location | Gap | Principle |
| --- | --- | --- | --- |
| G9 | `notebook/Ink.tsx:52` | `HAND_SCALE = 0.87` is tuned to Architects Daughter's width | 1.2 |
| G10 | `notebook/Ink.tsx:182–219` | `HandText` letters digits in the hand font. Pages put measurements there, e.g. `pages/dem-source.tsx:228–233` ("Mapterhorn peaks at {fmt(...)} m") and `pages/accept-rule.tsx:443–450` ("accept ≥ 0.5") | 2.7 |
| G11 | `notebook/Ink.tsx:66–89` | Every furniture stroke is a constant-width `<path>` (`Stroke`), with no taper, pressure or ink blob | 2.5 |
| G12 | `notebook/Ink.tsx:403–433` | `Stipple` draws round dots of uniform size, not scree stones | 1.4 |

`sketchRect` already overshoots its corners (`sketchify.ts:168–195`), so the brief's "no corner crossing" gap is already closed.

### Page shell

| # | Location | Gap | Principle |
| --- | --- | --- | --- |
| G13 | `ConceptPage.tsx:312` | H1 is Fraunces `font-bold` (700) at 3.6rem | 2.2 |
| G13 | `ConceptPage.tsx:315` | The tagline is Fraunces *italic* used as ornament | 2.2 |
| G13 | `ConceptPage.tsx:349` | The lede is 17px/1.7, off-scale | 2.2 |
| G13 | `ConceptPage.tsx:124` | NodeCard titles use Fraunces at 17 px | 2.2 |
| G13 | `ConceptPage.tsx:169` | The rel line is italic Fraunces | 2.2 |
| G13 | `ConceptPage.tsx:441` | The Connections heading is Fraunces | 2.2 |
| G14 | `ConceptPage.tsx:344` | The layout is `lg:grid-cols-[1fr_250px]` with no hanging column and no 6 px rhythm | 2.1 |
| G14 | `ConceptPage.tsx:346` | "Eintrag · id" is a plain mono line, not a Standortfeld or register header | 2.8 |
| G15 | `ConceptPage.tsx:281` | The imprint has no *Stand* or *Ausgabe* | 2.8 |
| G15 | `ConceptPage.tsx:461–487` | The signposts show no distance (page count) | 2.8 |
| G16 | `viz/Section.tsx:45` | Section H2 is Fraunces 1.65rem | 2.2 |
| G16 | `viz/Section.tsx:54` | `PROSE` is 15.5px/1.75 with no 66 ch measure | 2.2 |
| G16 | `viz/Section.tsx:68–74` | `Stat` is mono 2rem with a **red ▲ on every stat**, which breaks the one-red rule | 2.3 |
| G17 | `viz/Figure.tsx:21` | `tape = true` by default puts tape on every figure, including pure diagrams (kitsch) | 2.10 |
| G17 | `viz/Figure.tsx:71` | The caption is 11 px and has no source or run id, no print title block and no reading key | 1.2 |
| G18 | `viz/Steps.tsx:79–86` | `Flow` draws every arrow in SR, so N−1 reds per figure | 2.3 |
| G18 | `viz/Steps.tsx:104–135` | `Steps` is a dotted pencil spine with hand-lettered numerals (`Ink.tsx:221–253`), not a RouteTopo | 2.8 |
| G19 | `viz/Plot.tsx:158`, `:178` | Tick labels fill `--gb-relief` (BL, 2.8:1) | 2.3 |
| G19 | `viz/Plot.tsx:204–216` | Axis titles are italic `fill-white/70` | 2.2 |
| G20 | `viz/CodeRef.tsx:23` | The chip is `bg-white/[0.07] text-white/75` with the icon in the group accent | 2.3 |
| G20 | `viz/Callout.tsx:58` | Callout body is 14.5 px | 2.2 |

### Cartographic furniture

| # | Location | Gap | Principle |
| --- | --- | --- | --- |
| G21 | `swiss/Legend.tsx:102–128` | `PeakSymbol` is a filled triangle, which on the LK means a trig point | 1.4 |
| G21 | `swiss/Legend.tsx:145–158` | `RockSymbol` strokes are uniformly 0.9 wide, with no lit or shaded side | 1.4 |
| G21 | `swiss/Legend.tsx:161–181` | `GlacierSymbol` is hatched **and** outlined | 1.4 |
| G22 | `swiss/HachureRule.tsx:31–75` | Random filled wedges hang from a ridge. There are no lit/shade widths, no triangle patchwork, and lit strokes do not stop short | 1.4 |
| G23 | `swiss/Signpost.tsx:72–74` | Weight 700 is not loaded for Condensed | 2.2 |
| G23 | `swiss/Signpost.tsx:87–103` | The sign is a filled sign plus a sketched outline (fill **and** outline), measured through a ResizeObserver | 2.4 |
| G24 | `swiss/Cartouche.tsx:26` | The cover is centred | 2.1 |
| G24 | `swiss/SheetFrame.tsx:191–195` | The imprint is centred and has no Stand | 2.8 |
| G24 | `swiss/` | No `SpotHeight`, `TrigPoint`, `HutBullet`, `Grade`, `RegisterLine`, `Standortfeld`, `RouteTopo` or station stamp | 2.8 |
| G25 | `src/routes/gipfelbuch.index.tsx:145` | The DEEP cards use `border-t-[1.5px]` as a decorative section stroke | minimal strokes |
| G25 | `gipfelbuch.index.tsx:184` | Group H2s are Fraunces | 2.2 |
| G25 | `gipfelbuch.index.tsx:106` | The cartouche says "Niederhorn ob Thunersee" with no real sheet number (1208 Beatenberg) | 1.4 |

### Pages (sampled: `accept-rule.tsx`, `dem-source.tsx`, `skyline.tsx`; counted across all 19)

| # | Gap | Principle |
| --- | --- | --- |
| G26 | 222 text uses of `text-white/35`…`/60` (ink at 35–60 % on paper, below 4.5:1 below about 60 %); e.g. `accept-rule.tsx:106`, `:648`, `:1020` | 2.3 |
| G27 | 66 half-pixel sizes (`text-[10.5px]` ×24, `[11.5px]` ×15, `[12.5px]` ×16, `[13.5px]` ×5, `[9.5px]` ×6) | 2.2 |
| G28 | 14 `rounded`, `rounded-full` or `rounded-lg` pills or chips, e.g. `photo.tsx:388`, `:596`; `rigi.tsx:233`, `:295`; `skyline.tsx:630`, `:822`; `dem-source.tsx:991` | minimal strokes, no rounded cards |
| G29 | `HandText` at size 11–12 in figures (`dem-source.tsx:228`, `:510`, `:542`) is below the hand floor | 2.2. Fixed centrally by G10's print digits and the Shantell small-hand style, not per page |

## 4. Implementation plan

The work is split into **five packages with disjoint file ownership**. Shared kit, theme and furniture changes come first and propagate to all 19 pages. Only WP5 touches page files, and only with mechanical class substitutions. Packages WP1–WP4 can run in parallel. WP5 depends only on the class names fixed here, and can run in parallel too because it touches only page files and `gipfelbuch.check.ts`.

**Cross-package contracts** (fixed here so the packages need not see each other's work):

- **CSS custom properties from WP1:** `--gb-unit`, `--gb-line`, `--gb-secondary` (BG #4a545c). Every TSX consumer writes them with a literal fallback, e.g. `var(--gb-secondary, #4a545c)`, so no package breaks if WP1 lands later.
- **CSS classes from WP1:**
  - `.gb-num`: Fira tabular lining figures.
  - `.gb-table`: Swiss table.
  - `.gb-hand-small`: Shantell Sans label.
  - `.nb-fade`: the draw-on substitute for filled strokes.
- **`.nb-fade` behaviour** (WP1 CSS): `.nb-armed .nb-fade { opacity: 0 }` and `.nb-armed.nb-on .nb-fade { animation: nb-fade 600ms ease-out forwards; animation-delay: var(--nb-delay, 0ms) }`, with a reduced-motion override to opacity 1.
- **WP2 primitive API:** `PenLine`, `PenArrow`, `PenCircle` and `PenCross` keep their props.

### Verification for every package

```
npx tsc --noEmit -p .
npx biome check --write <changed files>
npx tsx src/lib/gipfelbuch/gipfelbuch.check.ts
npx tsx src/components/gipfelbuch/notebook/notebook.check.ts
node scripts/ci/spdx.mjs
```

Visual checks happen at `/dev/gipfelbuch-sheet`, `/gipfelbuch` and `/gipfelbuch/accept-rule`, on the dev server at :3100. Browser gates are batched afterwards under `scripts/gpu/with-render-lock.mjs`, and `node scripts/ci/run.mjs fast` runs before merge.

| WP | Title | Owns |
| --- | --- | --- |
| WP1 | Type programme, inks and fonts | `swiss/theme.css`, `swiss/palette.ts`, new `swiss/type.ts`, `notebook/notebook.css`, `notebook/notes.tsx`, `src/routes/__root.tsx`, `NOTICE.md`, `reports/licences.md` |
| WP2 | Ink kit: tapered pen, print digits in hand text, scree stones | `notebook/Ink.tsx`, `notebook/sketch.ts`, `notebook/sketchify.ts`, `notebook/notebook.check.ts` |
| WP3 | Page shell and viz primitives | `ConceptPage.tsx`, `viz/Section.tsx`, `viz/Figure.tsx`, `viz/Callout.tsx`, `viz/Steps.tsx`, `viz/CodeRef.tsx`, `viz/Plot.tsx`, `viz/index.ts` |
| WP4 | Cartographic furniture and the index cover | `swiss/Legend.tsx`, `swiss/HachureRule.tsx`, `swiss/SheetFrame.tsx`, `swiss/Signpost.tsx`, `swiss/Cartouche.tsx`, `swiss/Waymark.tsx`, `swiss/FurnitureSheet.tsx`, `swiss/index.ts`, new `swiss/Marks.tsx`, new `swiss/Register.tsx`, `src/routes/gipfelbuch.index.tsx` |
| WP5 | Mechanical page sweep and page lint | `src/lib/gipfelbuch/pages/*.tsx` (19), `src/lib/gipfelbuch/gipfelbuch.check.ts` |

Detailed instructions and acceptance criteria for each package are in the workflow output that accompanies this report; they are summarised here.

- **WP1** adds `--gb-secondary` and the grid tokens, and fixes `.gb-coord`, `.gb-caps`, the table, grid and `text-wrap` rules and forced-colors handling. It re-inks pencil and tape to Brezine, removes the print shadow, and swaps the hand to Caveat with Shantell Sans for small labels. It adds Fira Sans 300 and the Fraunces H1 constraints, gives `Struck` a `by` signature, and adds `swiss/type.ts` as a typed scale.
- **WP2** adds an in-house tapered-outline stroke (after perfect-freehand) with an ink blob, and moves the furniture primitives onto it. Dashed strokes stay stroked. `HandText` sets digit runs in print, and `HAND_SCALE` is retuned for Caveat. `Stipple` draws polygon stones that grow toward the bottom. New checks cover all of this.
- **WP3** reworks the concept page: an asymmetric grid, a Standortfeld and register header, Fira H2 and H3, the 16/24 body at 66 ch, and a lead at 20/30. `Stat` uses Fira 300 with an open trig triangle. `Figure` gets tape off by default, a print title block and an optional reading key. `Flow` arrows are drawn in ink, and `Steps` becomes a route topo. Plot ticks move to BG, and the Stand imprint and signpost distances are added.
- **WP4** rebuilds the legend symbols to LK grammar and turns `HachureRule` into a lit/shade triangle patchwork. It adds `SpotHeight`, `TrigPoint`, `HutBullet`, `Grade`, `StationStamp`, `Standortfeld`, `RegisterLine` and `TestimonyLine` (the RouteTopo is `Steps` itself, in WP3), and gives `SheetFrame` Stand and cross-reference props. The signpost loses its outline, and the cartouche becomes a left-aligned cover. The index page loses its decorative border and gets the real Blatt 1208.
- **WP5** applies the mechanical class substitutions across the 19 pages (contrast floor, scale sizes, no rounded pills). A ratcheting lint in `gipfelbuch.check.ts` keeps them from coming back.

### Deferred (not in this round)

These need either data the pages do not yet expose or new figure work:

- the circular orientation table;
- panorama-table peak labels with distance;
- weighted Voronoi stipple hillshades;
- fall-line terrain hatching;
- the split-page spread as a page-level layout;
- the Card-tin photo index;
- self-hosted woff2 fonts (the GDPR item already in `reports/licences.md`).

Each should get its own entry in `reports/roadmap.md` when it is picked up.

## 5. Licence notes

**Fonts:**

- Caveat (© 2014 The Caveat Project Authors), Shantell Sans (© 2022 The Shantell Sans Project Authors), Fira Sans and Fira Sans Condensed (© 2012–2015 Mozilla Foundation and Telefonica S.A.), Fraunces (© 2018 The Fraunces Project Authors) and Architects Daughter are all OFL-1.1.
- IBM Plex Mono is OFL-1.1 with Reserved Font Name "Plex", so any self-hosted subset must be renamed.
- Loading from the Google Fonts CSS2 API redistributes nothing. Self-hosting later must ship `OFL.txt`.

**Proprietary references (cited as models only, never bundled or imitated):** Frutiger, Neue Frutiger, ASTRA-Frutiger, Univers, Helvetica, Akzidenz and Söhne; the SBB clock; CD Bund branding; the Swiss coat of arms (WSchG); the "Wanderland" mark; and the ORTOVOX/Panico topo glyphs.

**swisstopo data** is OGD with attribution "© swisstopo". "Blatt 1208" is a reference, not a product mark.

**Papers** by Jenny et al., Imhof, Winkenbach and Salesin, Goodwin et al., Wood et al., Song et al. and Fox et al. are cited for facts, and no figures are reproduced. **Heim, Imfeld and Studer** works are public domain, but each digitisation has its own reuse terms. **Imhof** is in copyright.
