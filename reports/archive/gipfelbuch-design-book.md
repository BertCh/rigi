# The Gipfelbuch design book: Swiss cartography, Swiss typography and the field notebook

> Archived 2026-10-02: the research and rule ids (T, I, G, L, F, H, A) that code comments cite. Superseded where it conflicts by the hand pass (hand is the form, Architects Daughter, no grain) and by `reports/gipfelbuch.md`, which holds the current canon. Links to the earlier reports point at deleted files (git history).

Status: research document, 2026-10-01. Nothing in `src/` has changed. It prepares an overhaul of the Gipfelbuch (`/gipfelbuch`, 19 concept sheets and an index) toward one goal: **a pinnacle of Swiss design and cartography, drawn as a topographer's field book on map paper.**

The document has three parts. Part I is the research: the five traditions we draw on and what each teaches. Part II is the programme: one design system stated as rules, in the spirit of Gerstner's *Designing Programmes*. Part III is the work: the gap between the current code and the programme, a rendering technique menu, platform support, a phased plan and the decisions the user still has to make.

**Revision, 2026-10-01 (later, user request via mt-image-3b): a softer sheet.** The user asked for no paper texture and no full notebook look, while keeping a soft grid. The following are now out:

- the paper grain (I8: no grain tile at all);
- tape and tilted prints (F6);
- the red margin rule;
- the sheet-frame margin ticks.

The paper and paper-deep tones are lighter. The grid stays soft. Everything else in the programme stands.

**How it relates to earlier reports.** This document builds on five earlier reports and supersedes them where they conflict. Every revision is called out as **Revises:**.

| Report | Contents |
| --- | --- |
| `gipfelbuch-swiss-aesthetic.md` | the map-sheet theme |
| `gipfelbuch-notebook-research.md` | the notebook skin |
| `gipfelbuch-swiss-sketch-research.md` | the chart grammar |
| `gipfelbuch-sketch-rendering.md` | the rough.js and SVG filter spec |
| `gipfelbuch-field-notebook-design.md` | the design system and WP1–WP5 plan, not yet implemented |

**Evidence marks.**

| Mark | Meaning |
| --- | --- |
| **[V]** | Checked this session against a fetched primary or peer-reviewed source, a repo file, or a computation. |
| **[S]** | Secondary summary that could not be cross-checked against the original. |
| **[U]** | Unverified: background knowledge, inference or design judgement. |

Imhof's own books were not readable online. Everything attributed to Imhof comes through Jenny, Hurni, Patterson and the Auto-Carto formalisations, so treat it as paraphrase.

Method: five research passes in parallel (Swiss cartography; Swiss typography and book design; notebooks and editorial web; non-photorealistic rendering; web-platform typography and colour), plus a read-only audit of the current code. About 200 sources were consulted; the source list is at the end.

---

## Contents

- Part I: Lineage
  1. The thesis in one paragraph
  2. Swiss cartography
  3. Swiss typography and book design
  4. The field notebook
  5. The explanatory web
  6. Evidence: sketchiness, trust and legibility
- Part II: The programme
  7. Principles
  8. Grid and page
  9. Type
  10. Inks and paper
  11. Line
  12. Terrain
  13. Lettering and labels
  14. The hand
  15. Furniture
  16. Motion, print, accessibility
- Part III: The work
  17. The current state against the programme
  18. Rendering technique menu
  19. Platform support (October 2026)
  20. Phased plan
  21. Open decisions
  22. The canon: 60 rules on one page
  23. Sources

---

# Part I: Lineage

## 1. The thesis in one paragraph

Three disciplines govern the Gipfelbuch.

- **Swiss typography** supplies the *programme*: a rule set fixed in advance, from which every page follows without new decisions (Gerstner, Müller-Brockmann).
- **Swiss cartography** supplies the *hierarchy*: inks with meanings, light from the north-west, rock built of strokes, labels placed by Imhof's rules, and "less often means more".
- **The field notebook** supplies the *honesty*: raw observation beside the fair copy, pencil construction left visible under ink, and provenance on every entry.

The sketch is the observer's hand on top of an exact record. It is never a filter over the record. Wainwright's hand-lettered Lakeland pages, whose contours still follow the Ordnance Survey, are the proof that the two can coexist. The test for every element is: *does it carry a fact?*

## 2. Swiss cartography

### 2.1 Eduard Imhof and the Swiss manner of relief

The Swiss method of drawing mountains, as documented by Jenny, Hurni and colleagues from swisstopo practice, works like this [V: Jenny et al. 2014, 2020; Jenny & Hurni 2006]:

- **Light from the upper left** (north-west, azimuth about 315°) across the whole map. This avoids relief inversion.
- **Light bent locally.** A ridge running NW–SE is lit from the west, so its two flanks differ in tone. Use one direction per mountain.
- **Structure first.** Delineate ridge and gully lines, shade the main divides, then work from the dark slopes up to the bright peaks.
- **Tone is a design decision, not physics.** Whole landforms are brightened or darkened so the two sides of a range separate. Flat ground is a neutral grey. Cast shadows are never drawn in 2-D relief, because they put the drainage out of register with the shading [V Patterson 2000].
- **Aerial perspective in relief.** Contrast between lit and shaded slopes is strongest at the summits and weakest in the lowlands. Jenny calls this "hypsometric aerial perspective" [V].
- **One illumination system.** Shaded relief, a faint yellow sun tone on fully lit slopes, rock hachures and scree dots together form one continuous surface, whatever the land cover [V].
- **Colour runs "higher is brighter".** Lowlands are cool grey-blue-green and recede. Midlands are olive to yellow-brown, and the highest ground is near white. Lit slopes are warm, from yellow-green to yellow to white. Shaded slopes are cool, from blue-purple to violet-grey. Imhof rejected the "higher is darker" and saturate-to-red schemes [V Jenny & Hurni 2006].
- **Saturation only on small areas.** Large fields stay light and quiet so that small symbols can speak [S].
- **"Less often means more."** Generalise for the scale, and keep only what serves the reader's task [S, ICA tribute].

A frequently cited list of six Imhof "rules of colour harmony" could not be located. Do not quote it. The verified six principles are for lettering (§2.4).

### 2.2 The Landeskarte (LK)

**Contour colour follows the surface** [V swisstopo legend 2008]:

| Surface | Contour colour |
| --- | --- |
| earth | brown |
| rock and scree | black |
| glacier and lake | blue |

**Contour intervals** [V legend, parsed from layout]:

| Scale | Normal interval | Index contour | Intermediate |
| --- | --- | --- | --- |
| 1:25 000 | 10 m in Jura and Mittelland, 20 m in the Alps | 100 m | 5 / 10 m |
| 1:50 000 | 20 m | 200 m | 10 m |
| 1:100 000 | 50 m | 200 m | 25 m |

In rock at 1:25 000 only index contours run through. At smaller scales none do [V Jenny 2014].

**Rock drawing (Felszeichnung)** [V Jenny et al. 2014]. These are print values at 1:25k–1:500k:

- All strokes are black. Brightness comes only from stroke width, length and density.
- The brightness model has three parts: the primary lit face, the primary shaded face, and two intermediate faces.
- The mean density is 7 strokes per 2 mm (about 0.28 mm apart). Lit faces carry 4–5 strokes per 2 mm and shaded faces up to 9.
- The mean width is 0.12 mm. On lit faces strokes are 0.06–0.10 mm and may break. On shaded faces they run 0.22 mm at the lower end to 0.26 mm at the upper end.
- The basic element is a triangle of about 2.5 mm with a lit, a middle and a shaded facet.
- Strokes never cross, except one long line for a fault. Elements may be displaced by up to 0.3 mm.
- Rock is drawn **as seen from the ground**, not orthogonally, so steep faces get a slightly enlarged footprint.
- Hachure direction signals steepness. Strokes run perpendicular to the contours on steep, dangerous ground and parallel to them on walkable ground.
- Manual cost was about 1 hour per cm², or roughly 2 000 hours per mountain sheet.

**Scree** [V Jenny, Hutzler & Hurni 2010]:

- Dots are irregular polygons with 4–8 corners. They range from 0.01 mm on lit slopes to 0.22 mm on shaded ones.
- Dots grow a little downslope.
- Dots in gully flow lines are about 1.5× larger. Boulders reach about 1.5 mm.
- Both size and density follow the light.

**The 2016 generation** [V swisstopo modernisation page; Streit 2017]:

- A Frutiger-family condensed sans replaced the serif lettering. The vector styles name *Frutiger Neue Condensed Regular* and *Frutiger Neue Italic*.
- Rail is red, and borders are broad transparent bands.
- Minimum sizes and spacing are slightly larger.
- The Swiss relief, rock, scree and sun tone are explicitly preserved.

An ICA paper calls this the first sans-serif in Swiss maps, and criticises it as disconnected from Swiss typographic culture [V Biniek et al. 2018]. Water names are italic [V web style].

**Ink values.** The LK print inks are not published as CMYK or hex [U], so do not quote "swisstopo ink" hexes. The public web basemap style gives web analogues [V as web values only]:

| Feature | Web value |
| --- | --- |
| water line | `rgb(77,164,218)` |
| water label | `rgb(47,134,188)` (deeper than the line) |
| peak labels | navy `rgb(27,36,62)` (not black) |
| sun tone | `rgb(255,235,5)` |

Rigi's Brezine inks (§10) stay the source of truth. They follow LK *roles*, not LK hexes.

**Unverified (do not state as fact):**

- LK sheet-frame conventions: tick spacing, grid weights, whether there is a north arrow, the margin legend layout.
- Dufour's light direction.
- Heim and Imfeld panorama technique.
- SAC Clubführer topo conventions.

### 2.3 The lineage before and after

| Who | When | What to take |
| --- | --- | --- |
| **Dufour** map (1:100k) | 1845–64 | Hachured relief, the "Swiss manner" [S]. |
| **Siegfried** map | from 1870 | Contours and rock drawing, no shading [V Jenny & Hurni 2006]. Its imprint credits the separate roles *Aufnahme* (survey), *Revision* and *Stich* (engraving) [V], which is a model for crediting a page's provenance. |
| **Becker**, Glarus map | 1889 | First printed map with deliberate aerial perspective: lit slopes yellow-green, shaded dark green, contrast sharpened at the summits. He also tried southern light on the Rigi sheet [V]. |
| **Imhof**, school atlases and *Atlas der Schweiz* | 1932–76 and later | The method made repeatable: all colour plates derived photomechanically from one grey shading [V]. |
| **Berann** (via Patterson 2000) | | Warm saturated foreground against a cool blue background, light chosen for the graphic rather than the sun, geography bent for legibility. Cast shadows are allowed in panoramas, never in plan relief [V]. |
| **Jenny et al.**, neural relief shading | 2020 / 2021 | A U-Net trained on swisstopo's manual shading. Experts rated it highly. Light and generalisation are steered by rotating or filtering the input DEM [V]. It ships as **Eduard** (macOS, paid, closed) [S]. |
| **Geisthövel & Hurni** (ETH IKG) | 2015–18 | Automatic Swiss-style rock hachuring from a DEM and a rock mask [V abstract]. No open code was found. |
| **Patterson** (shadedrelief.com) | | Warm-to-white lit slopes, cool shadows, texture shading, plan-oblique relief. The Banff prototypes are public domain [S]. |
| **Tanaka** | 1950 | Illuminated contours: light on lit slopes, dark on shaded slopes, width following the cosine of aspect against light [V via PSU course]. |

### 2.4 Imhof on names (*Positioning Names on Maps*, 1975)

The six principles [V via Freeman & Ahn and Doerschler, who cite Imhof directly]:

1. Names are easy to read and to find.
2. A name is clearly tied to its object.
3. Names do not cover, overlap or conceal.
4. Names show situation, extent, connection, importance and difference.
5. Type arrangement mirrors classification and hierarchy.
6. Names are neither evenly spread nor densely clustered.

Derived placement rules:

- **Line and name.** A name never overlaps another name or a point symbol. Where a name crosses a line, the line breaks, not the name.
- **Points.** Labels are horizontal, close to the point and not letter-spaced. The preferred position is up and to the right. A label above the point beats one below.
- **Lines.** The name follows the curve, avoids sharp bends and ends, and repeats rather than stretches.
- **Areas.** The name spans the area with about 1.5 letter-spaces free at each end. If it is not horizontal it curves, with an arc of at most about 60° (the Freeman–Ahn formalisation).
- **Water.** Names are italic and blue. Text above a horizontal line reads left to right.
- **Order.** Place the least free names first: areas, then lines, then points.

## 3. Swiss typography and book design

### 3.1 The masters, reduced to what we can use

**Josef Müller-Brockmann**, *Grid Systems* (1961/81). The book treats modular grids of 8 to 32 fields with constant gutters [V, publisher blurbs]. In his method the body line is the unit, and the module height is a whole number of lines plus a one-line gutter, so picture edges fall on text baselines [S]. The grid exists to remove arbitrary decisions.

**Emil Ruder**, *Typographie* (1967) [V, transcription of "Basel 1965"]:

- "Lines of more than sixty letters are difficult to read."
- "The non-inked spaces have an incomparable optical value."
- Contrast comes from size, weight and white space.
- A finer modular scheme opens more possibilities.

**Karl Gerstner**, *Designing Programmes* (1964): design as a *programme*, "systematically creeping up on a task rather than hoping for inspiration" [V, Madsen's summary]. For us the stylesheet is the programme. A new concept page should need no new typographic decision.

**Hofmann and Weingart.** A strict system with one deliberate departure: Weingart loosened the Basel rules from inside the school [V]. Allow **one** sanctioned exception per page.

**Jan Tschichold.**

- His canon for a 2:3 page sets the margins inner : top : outer : bottom at 2 : 3 : 4 : 6. The text block has the page's proportion, and its height equals the page width [V].
- His intentional page proportions are 2:3, 1:√2, 1:√3, 5:8 and 5:9 [V].
- His *Penguin Composition Rules* (1947) are four pages of manufacturing-grade rules, among them equalising letter-spaces by their visual value [V].

**Jost Hochuli**, *Detail in Typography* and *Designing Books*. Texture comes from letter, word and line spacing. English can run shorter lines than German for the same evenness [V, Eye review]. His numeric rules could not be retrieved [U].

### 3.2 Contemporary Swiss practice

**The Most Beautiful Swiss Books 2025** chose 17 books from 388. They were judged on graphic and typographic design, print and binding quality, and materials. The jury called books "objects of desire and markers of identity" again [V BAK]. The Jan Tschichold Prize went to Coline Sunier & Charles Mazé [V]. The common traits of recent winners (material contrast, exposed structure, grotesk plus mono, plain grids) are our impression, not a jury statement [U].

**NORM** (Bruni and Krebs) are known for a programmatic method and their own typefaces [V]. **Elektrosmog** design for Parkett, Kunsthaus Zürich and Das Magazin [V]. **Lars Müller Publishers** publish Gerstner and much of Swiss design history [V].

### 3.3 Typefaces

The Swiss references are Akzidenz, Neue Haas/Helvetica, Univers (the most Gerstner-like: a numbered system of weights and widths) and Frutiger (open humanist; ASTRA-Frutiger on Swiss road signs since 2003; Frutiger Neue Condensed on the LK since 2016).

Contemporary paid heirs, should the budget ever exist [V foundry pages]:

| Typeface | Foundry | Notes |
| --- | --- | --- |
| Suisse Int'l / Works / Mono | Swiss Typefaces | lifetime licence |
| GT Alpina | Grilli | 70-style serif with small caps and old-style figures |
| ABC Diatype / Diatype Mono | Dinamo | |
| Unica77 / Unica77 Mono | Lineto | |
| Theinhardt | Optimo | |

Open candidates (OFL unless noted; check licences marked [U] on the specimen page before shipping):

| Face | Role it could play | Notes |
| --- | --- | --- |
| **Fira Sans + Fira Sans Condensed** (current) | text, labels | Humanist, Frutiger-like, with real condensed cuts. **The closest free analogue of the LK's own Frutiger Neue Condensed.** |
| Instrument Sans | text, labels | Neo-grotesk. Axes `wdth` 75–100, `wght` 400–700, italic. 12 stylistic sets [V]. |
| Hanken Grotesk | text | The quietest neo-grotesk, Helvetica-adjacent [S]. |
| Inter | UI text | Neutral, screen-first, rich `cv`/`ss` features [V]. |
| Geist / Geist Mono | UI | Inspired by Univers, Suisse and Diatype; reads as "product" [V]. |
| DINish | labels, figures | DIN 1451-inspired, `wdth`/`wght` axes, tabular and old-style figures [V]. An engineer's face. |
| **Source Serif 4** | titles, cartouche, long reading | Optical sizes, small caps, old-style figures [V]. Sturdy transitional serif. |
| Newsreader | long reading, titles | Built for continuous screen reading. `opsz`, small caps, old-style and tabular figures [V]. |
| Fraunces (current) | display only | A "soft serif" after Windsor, Souvenir and Cooper. Its `SOFT`/`WONK` mannerisms are the least Swiss voice on the page [V]. |
| IBM Plex Mono (current), Fira Mono, Martian Mono | coordinates, code | Plex reads editorial. Fira Mono would remove a family. |

Hands for annotation (§14):

| Face | Licence | Notes |
| --- | --- | --- |
| Architects Daughter (current) | OFL | "The graphic, squared look of architectural writing" [V]. |
| Caveat, Shantell Sans (proposed by the WP plan) | OFL | Shantell is a marker hand, too playful for this brief [V]. |
| osifont | GPLv3 with a font exception | An ISO 3098 technical-lettering face. Whether the exception covers web `@font-face` delivery is a legal question [V licence, U web use]. |

## 4. The field notebook

| Precedent | What it teaches | Status |
| --- | --- | --- |
| **Grinnell method** (MVZ Berkeley) | Four linked records: field notebook (raw, in the field), journal (fair copy, soon after), species accounts, catalogue. "You can't tell in advance which observations will prove valuable." | [V] |
| **Darwin, Notebook B** (1837) | A rough tree headed "I think". A sketch is credible when it is labelled as a thought. | [V] |
| **Humboldt, *Naturgemälde*** (1805) | One cross-section carries altitude zones, species and measurements, each label set beside its feature. The direct ancestor of an annotated mountain figure. | [V] |
| **Ramón y Cajal** | Pencil first, then ink over it, **pencil never erased**. Hatching, stipple and wash. His drawings were judged clearer than the photographs of his day. | [V] |
| **Wainwright, *Pictorial Guides*** (1955–66) | Over 2 100 hand-made pages reproduced at drawn size. After about 100 pages he scrapped them to justify every line without hyphenation, working out letter and word spacing by hand. Ascent maps are planimetric in front and tilt into perspective behind. Summits are drawn in profile from the approach. Tone comes from line density, never wash. Prose is wedged around the drawings, "spiked with warnings". Dedicated to "The Men of the Ordnance Survey". | [V] |
| **Real Gipfelbücher** | From about 1850, kept in a tin at the summit cross. Around 1900 entries were *nüchtern und sachlich*: date, name, route, times, weather. Bergwelten still asks for space-saving entries ("kein Malbuch"). | [V] |
| **Führerbuch** (Bern 1856) | A guide's paginated book of client testimonials. Each entry follows a fixed order and is signed. Three bad entries a year cost the guide his patent. | [V via the WP plan] |
| **Tufte, *Beautiful Evidence*** | Six principles: comparison; causality and mechanism; multivariate data; complete integration of words, numbers and images; documented provenance; content above all. Sparklines; small multiples. | [V] |
| **Paper** | Leuchtturm and Rite in the Rain use a 5 mm grid. Field Notes graph paper is 3/16 in. | [V] |

The common lesson: **the furniture is human and economical, and the evidence is exact and dense.** The hand-made look rests on an invisible discipline, as Wainwright's restart shows.

## 5. The explanatory web

| Exemplar | Steal | Status |
| --- | --- | --- |
| Bartosz Ciechanowski | Text then live figure, beat after beat. Constant colour vocabulary. Drag, slider or toggle only, and only when moving it reveals a cause. | [V] |
| Red Blob Games (Amit Patel) | Semantic colour held across diagram, text and code. Negative space instead of borders. Animated transitions between states. Permanent URLs. | [V] |
| Gwern.net | "Visual differences should be semantic differences." Sidenotes on wide screens, inline on narrow ones. Semantic zoom, collapsibles. "Always bet on text." | [V] |
| Tufte CSS | Off-white `#fffff8` and off-black `#111`. Numbered sidenotes, ⊕ margin notes, colour only inside figures. | [V] |
| The Pudding | Data must carry the conclusion. The shape of the story varies. | [V] |
| Distill | Explanation as first-class work. Figures woven into the argument. | [V] |
| Bret Victor | Reactive documents; "the author holds up their end of the conversation". | [V] |
| Maggie Appleton | Growth stages; visible incompleteness. | [V] |
| swisstopo, *Journey through time* | One slider carries a whole historical argument. | [V] |
| NZZ Visuals | Swiss newsroom scrollytelling (Swiss Viz Award 2023). | [V award page only] |
| Josh Comeau | One light source for every shadow; shadows tinted to the surface. | [V] |
| NYT, Reuters, FT, Bloomberg, SRF Data, Observable, Nicky Case, Sam Who | Not researched in this pass. | [U] |

What the best of these share: **one real figure per beat, the caption as a claim, restraint, depth on request, and interaction only where it is the argument.**

## 6. Evidence: sketchiness, trust and legibility

**Wood, Isenberg, Isenberg, Dykes, Boukhelifa & Slingsby (2012), IEEE TVCG 18(12)** [V]:

- Judgement of relative area **degrades** as sketchiness rises, and the effect varies by shape.
- Readers can rank sketchiness, but individuals differ widely.
- Sketchy charts **raise engagement** and willingness to annotate.
- The style draws attention to global features over detail.

**Boukhelifa, Bezerianos, Isenberg & Fekete (2012)** [V]. Sketchiness can encode qualitative uncertainty as intuitively as blur, but readers *preferred dashing*.

**Consequence.** Wobble must not be ambiguous. Two uses are possible: decoration (furniture) or an uncertainty channel. Using it for both would make every wobbly line a question. We already encode certainty with line style (solid, dashed, dotted, from the WP plan §2.6), which is the readers' preferred channel, so **wobble is furniture only**.

The NPR pass suggested letting roughness encode the confidence of the pose fit. **Rejected** for that reason. Whether readers read furniture wobble as data imprecision is untested [U]. A small in-house A/B test with a precision question would settle it (see §21).

**Legibility.**

- Excalidraw replaced its Virgil hand with Excalifont because Virgil was hard to read [V].
- Dyslexia fonts show no reliable benefit; spacing helps more than letter shape [V, secondary summaries].
- WCAG 2.2: 4.5:1 for text, 3:1 for large text and for meaningful graphics [V].
- APCA Lc 75 for body text is a useful design check while WCAG 3 remains a draft (March 2026) [V W3C news; S on APCA equivalence].

---

# Part II: The programme

The rules are numbered **G** (grid), **T** (type), **I** (ink), **L** (line), **R** (relief), **N** (names), **H** (hand), **F** (furniture) and **A** (access, motion, print). They are written as acceptance criteria. §22 collects them on one page.

## 7. Principles

1. **One object.** The Gipfelbuch is *a surveyor's field book bound into a map sheet*. There are not two skins.
2. **Print is the form, the hand is the observer.** This keeps the earlier decision.
3. **Every element carries a fact.** Furniture that states nothing is removed, or made true. For example, the scale bar shows the real scale of its figure.
4. **Data is exact; only furniture wobbles.** Photos and DEM rasters are never filtered, tinted or hatched.
5. **The programme decides.** Tokens and about 20 components decide every page. A new page adds content, not styles.
6. **Less often means more.** When unsure, remove.

## 8. Grid and page

**Revises** the WP plan §2.1 only where marked. It keeps the 6 px unit and 24 px line.

- **G1. One unit.** `--gb-unit: 6px` and `--gb-line: 24px` (= 1 `rlh` at 16/24 body). Every margin, gap, figure height and rule offset is a multiple of 6, and every block-level gap is a multiple of 24. Use `rlh` units in CSS: `margin-block: 2rlh`.
- **G2. The graph paper *is* the baseline grid.** **Revises:** the graph cell goes from 20 px to **24 px**, which is 1 line (6.35 mm at 96 dpi, close to the 5 mm field-book norm). Every fifth line is heavier (index ruling), as on engineering pads [U]. Text baselines and figure edges then land on the ruling, as in Wainwright's discipline and Müller-Brockmann's rule that picture edges fall on baselines.
- **G3. Leading trim.** `text-box: trim-both cap alphabetic` on headings, captions, legend text and sheet furniture. Blocks then start at cap height and end at the baseline, and spacing is pure multiples of the line. It is Baseline since Firefox 154 (Chrome 133, Safari 18.2). Keep the `@supports` padding fallback.
- **G4. The modular field.** The column table from the WP plan stands: 4 columns at 375 px, 8 at 768 px, 12 at 1280 px, with 12/24/24 px gutters and a 1 184 px maximum. Module height is 4 lines plus a 1-line gutter (120 px). Figure heights snap to whole modules.
- **G5. Tschichold proportions in the margins.** At ≥ 1024 px the page is asymmetric:
  - columns 1–2: hanging kicker and entry number;
  - columns 3–8: text, at most 62–66 ch;
  - columns 9–12: marginalia and the rail.

  The inner margin to the outer (margin-column) width follows 2 : 4, Tschichold's inner : outer. Text is never centred.
- **G6. Named lines, not breakpoints.** Build the grid with named lines `[full-start] [feature-start] [content-start] [content-end] [margin-start] [margin-end] [full-end]`, with `minmax(0, …)` breakout tracks that collapse without media queries. Figures use `grid-template-columns: subgrid` so their captions and notes keep the page's columns.
- **G7. Figure proportions are intentional.** Use 2:3, 3:2, 1:√2, 5:8, or the photo's own ratio. Never an arbitrary height.
- **G8. One deliberate exception per page.** A bleed map, a tilted print, or a stamp across the gutter. Name it in review.
- **G9. Space separates, strokes do not.** Sections sit 2 lines apart (48 px), chapters 3 lines (72 px). This keeps the user's minimal-strokes rule.

## 9. Type

**The type system in one sentence:** *a Frutiger-like humanist sans for the map and the text, a sturdy roman for the sheet titles, a quiet mono for coordinates, and one technical hand for the observer.*

**Recommended stack.**

- **Text and labels: Fira Sans + Fira Sans Condensed** (keep). §2.2 makes this the strongest argument in the research: since 2016 the LK itself is lettered in Frutiger Neue Condensed, and Fira is the closest open analogue, with true condensed cuts for labels. A neo-grotesk such as Hanken or Instrument Sans would read as *Swiss poster* rather than *Swiss map*.
- **Titles and cartouche: Source Serif 4**, set with optical sizing. **Revises:** this replaces Fraunces. The pre-2016 LK and the Siegfried and Dufour sheets were lettered in roman. A sturdy transitional serif honours that and the book tradition; Fraunces' Windsor/Cooper softness does not. The alternate is Newsreader.
- **Coordinates and code: Fira Mono** (or keep Plex Mono). Fira Mono shares the family's metrics and removes one family.
- **Hand: one face, chosen by a specimen bake-off** (§14, decision D2).

That is four families, down from six fetched today (Manrope is downloaded and suppressed). They are self-hosted as subset WOFF2 with metric-matched fallbacks (`size-adjust`, `ascent-override`) so the baseline grid does not jump on load. This also clears the Google-CDN privacy item in `reports/licences.md`.

**Type scale.** These are the only sizes allowed. The scale keeps the WP plan's table, with three changes:

- H1 moves to Source Serif 4 at `opsz` auto.
- The caps kicker uses Fira Condensed **500** with `case`.
- Body leading is pinned to the 24 px line.

| Role | Face | ≥ 768 | 375 |
| --- | --- | --- | --- |
| micro (ticks, coordinates, imprint) | Fira Mono / Fira tnum, secondary ink | 11/12 | 11/12 |
| caps kicker | Fira Sans Condensed 500, +0.10 em, `case` | 11/12 | 11/12 |
| caption, table, legend | Fira Sans 400 | 13/18 | 13/18 |
| body | Fira Sans 400 | 16/24 | 16/24 |
| lead | Fira Sans 400 | 20/30 | 18/24 |
| H3 | Fira Sans 600 | 16/24 | 16/24 |
| H2 | Fira Sans 600 | 24/30 | 20/24 |
| H1 / cartouche | Source Serif 4 600, `opsz` auto | 40/48 | 30/36 |
| stat | Fira Sans 300, `tabular-nums lining-nums` | 56/60 | 40/48 |
| hand note | one hand face | 18/24 | 18/24 |

Rules:

- **T1. Seven sizes, two weights per family.** The audit counted 33 arbitrary `text-[…]` sizes. All of them map to the table.
- **T2. Measure 60–66 ch** for body; 45 ch in margin and multi-column text. Ruder and Bringhurst both give this.
- **T3. Flush left, ragged right, never justified.** Use `text-wrap: pretty` on prose and `balance` on headings, captions and legends.
- **T4. Hyphenation only with `lang` set** and `hyphenate-limit-chars: 7 3 3`. Off in captions.
- **T5. Figures.** `tabular-nums lining-nums` in every table, stat, coordinate, elevation and bearing. Old-style figures only in running serif text. `slashed-zero` only in mono.
- **T6. Numbers with units.** Use a thin no-break space for thousands (1 563 m, LV95 `2 615 000`) and a no-break space before the unit.
- **T7. Caps are tracked +5–12%** and used only for labels under one line. Real small caps (`all-small-caps`) come only from the serif.
- **T8. Italic marks a category, never ornament:** water, derived or estimated values, a place inside a larger unit. This removes today's ornamental italic taglines and subtitles.
- **T9. Hierarchy by size and space,** not by rule lines or colour. Two heading levels carry the book.
- **T10. Kerning on, and display caps spaced optically** (Tschichold).
- **T11. Hanging punctuation** where Safari supports it, plus a manual negative indent on quotations elsewhere.

## 10. Inks and paper

The Brezine separations (`swiss/theme.css`) stay. They already follow LK roles: ink LK, contour NB, water GL, forest GG, red SR, navy PB for peak names (the web basemap also sets peaks in navy), and sun tone YY. Contrast on paper `#f5f2ea` [V, computed]:

| Ink | Hex | On paper | On paper-deep `#e9e4d9` | Allowed use |
| --- | --- | --- | --- | --- |
| LK ink | `#131313` | 16.6 | | all |
| PB navy | `#002f55` | 12.2 | 10.8 | peak names, text |
| GR pencil | `#49423d` | 8.8 | 7.8 | pencil marks, text |
| BG secondary (new, WP plan) | `#4a545c` | 6.9 | 6.1 | secondary text, coordinates, captions |
| GL water | `#30626b` | 6.1 | 5.4 | text, lines |
| GG forest | `#575e4e` | 6.0 | | text, lines |
| NB contour | `#95500c` | 5.5 | 4.8 | text, lines |
| SR red | `#bf2233` | 5.4 | 4.7 | text, lines; one red per figure |
| MG | `#817066` | 4.2 | 3.7 | **large text and graphics only** |
| BL relief | `#919192` | 2.8 | 2.5 | **hairlines and hachure only, never text** |

- **I1. Three text inks, no alpha ladder.** Text is ink, secondary (BG) or a semantic ink. The 14 `text-white/NN` alpha steps the audit found are retired: about 180 uses at 35–55% fail 4.5:1 at 10–12 px. Opacity is allowed only on non-text furniture.
- **I2. Roles are fixed** and shared by figure, caption, equation and code reference (Patel's semantic colour):
  - brown is DEM and terrain;
  - water blue is image-measured;
  - forest is the result;
  - red is the route and the one accent;
  - pencil is the prior and the doubt.

  Equation symbols take the ink of the layer they measure. This is already true in `viz/math.tsx`; keep it.
- **I3. Contours take the colour of the surface.** Brown on earth, black on rock and scree, blue on glacier and lake (LK). This needs a rock and glacier mask for the sheet and DEM patches (§12; decision D5).
- **I4. Higher is brighter, warm lit and cool shaded** for every relief raster we bake (§12).
- **I5. Saturation only in small areas.** Large fields stay paper or a pale tint. The sign yellow appears only on Wegweiser and the sun tone.
- **I6. Overprint like separations.** Stacked map inks inside one figure blend with `mix-blend-mode: multiply` inside an `isolation: isolate` sheet, so that contour brown over relief grey darkens as ink does on paper.
- **I7. Define tokens in OKLCH** (Brezine hex as the source comment). Derive tints with `color-mix(in oklab, …)`, and add P3 spot variants of SR and GL under `@media (color-gamut: p3)` after the sRGB value.
- **I8. Paper.** Paper is W + YY, with a grain of about 5%. **Revises:** the grain becomes a baked seamless tile (§18), not a live `feTurbulence`. The paper stays light in both site themes: the sheet is a physical object. Only the surround follows the site theme (decision D3).
- **I9. Off-chart colours are closed.**
  - `--nb-pencil` becomes GR.
  - `--nb-tape` becomes an LG mix.
  - `.nb-print` `#fbfaf6` becomes paper W.
  - The neon photo-overlay colours (`LAYER_STYLE`) stay photo-only. On paper (keys, captions) they map to their paper inks through `PAPER_INK`.

## 11. Line

Swiss rock drawing gives numbers, and the screen keeps their **ratios**, not their millimetres: 0.12 mm is about 0.45 CSS px, too thin to render.

**Stroke tiers** (per 800 px SVG; the WP plan's tiers stand):

| Tier | Width |
| --- | --- |
| grid | 0.5 |
| index grid | 0.9 |
| axis | 1.2 |
| series | 1.4–1.6 |
| route | 2.2 |
| hachure, lit | 0.5 |
| hachure, shaded | 1.6–1.9 |

Rules:

- **L1. Hachure ratios from the LK.** Shaded to lit width is about 1 : 2.5–4. Shaded to lit density is about 9 : 4–5. Strokes never cross (except one fault line). Strokes run perpendicular to the contours on steep ground and parallel on walkable ground.
- **L2. A meaningful line is never thinner than 1.2.** At most four widths per figure.
- **L3. Certainty is line style, never wobble:**
  - solid: measured or verified;
  - dashed 4/2: approximate or modelled;
  - dotted (0.8 px dots at 5 px pitch): open.

  Dashes are never decorative.
- **L4. Pen furniture is tapered, data is not.** Leaders, circles, arrows and underlines become variable-width outlines with tapers at entry and exit and an ink blob at the start (perfect-freehand, MIT; §18). Data series keep a constant width.
- **L5. Pencil is a different line, not a lighter pen.** Pencil is thin, GR, and multiplied by the paper grain in *page space* so the grain does not slide with the stroke (Sousa & Buchanan). It is used for construction: the prior, the DEM silhouette under the inked match. This is Cajal's unerased pencil.
- **L6. The double stroke** (two seeded passes at different jitter) is reserved for furniture. Data lines get one pass.
- **L7. Simplify before jitter.** Run Visvalingam–Whyatt on dense polylines before any furniture jitter.

## 12. Terrain

This section is the strongest differentiator and the one the repo is closest to: `SheetMap` already bakes swisstopo relief and Mapterhorn contours, `DemPatch` draws DEM crops, and Rigi computes horizons on the GPU.

- **R1. North-west light, bent locally.** Bakes use a 315° main azimuth and blend a second azimuth where ridges run parallel to the light (Imhof via Jenny 2020). One direction per mountain.
- **R2. Generalise before shading.** Low-pass the DEM at a scale-appropriate sigma so the shading shows landforms, not noise.
- **R3. Aerial perspective.** Shade contrast rises with elevation. Lowlands get a cool neutral grey and the highest ground lightens toward paper.
- **R4. Sun tone.** A faint YY on fully lit slopes only, masked out of flats (`--gb-sign-light` already exists).
- **R5. Sky illumination and ambient occlusion** (Kennelly & Stewart 2006) darken valleys without a directional bias. The bake can reuse Rigi's horizon machinery: march 8–16 azimuths per texel and take `1 − mean(sin horizon)`. This is a natural `ComputeGraph` kernel [U on reuse].
- **R6. Illuminated (Tanaka) contours.** Contours are lighter on lit aspects and darker on shaded aspects, and their width follows the cosine of aspect against light. It is pure vector, prints well, and survives `forced-colors`. It is the cheapest authentic upgrade to `SheetMap` and `DemPatch`.
- **R7. Rock hachures** where slope exceeds a threshold and the land cover is rock: triangle elements with three facets, the L1 ratios, ground-view enlargement on steep faces, and no crossing (Jenny 2014; Geisthövel & Hurni 2018). This is the single most distinctive Swiss element and the hardest. It is baked offline, never live.
- **R8. Scree** is irregular polygons. Size and density follow the light and grow downslope, and flow lines run in gullies (Jenny 2010). It is baked offline as weighted-Voronoi or blue-noise stipples.
- **R9. No cast shadows in plan relief.** Panoramas may use Berann's warm foreground and cool haze, and his liberty with light, because a panorama is a picture, not a plan.
- **R10. Panorama strips** with a compass ring for directional stories (Wainwright's summit panoramas). They are drawn from Rigi's own horizon profile, so the line is the data.
- **R11. Photos and DEM rasters stay unfiltered.** The relief bake is a *drawing* of the DEM, labelled as such. The measured DEM patch is shown raw.

## 13. Lettering and labels

- **N1. Imhof's order:** areas first, then lines, then points.
- **N2. Point labels** go up and to the right, horizontal, close to the point, not spaced. Peak names are navy (PB), with the spot height in tabular figures below or after the name.
- **N3. Line labels** follow the curve (`<textPath startOffset="50%" text-anchor="middle">`), avoid sharp bends and ends, and repeat rather than stretch.
- **N4. Area labels** are letter-spaced to span the area, with about 1.5 letter-spaces free at each end, and curve at most about 60°.
- **N5. Water** is italic, in water blue, a step deeper than the water line.
- **N6. The line breaks, not the name.** Use a paper halo (`paint-order: stroke; stroke: var(--gb-paper); stroke-linejoin: round`), and on contours a real gap.
- **N7. Class shows in type:** size, weight, case and slant encode class and importance (Imhof principle 5). Names may cluster where the information is (principle 6).
- **N8. Map labels have a minimum size.** Use `container-type: inline-size` on figures and `cqi` font sizes with a 11 px floor. The audit found `SheetMap`'s 17–62 px lettering shrinking to 5–20 px on phones.
- **N9. Round dots on the i at label size.** Square dots read as buildings (ICA 2018). Fira's dots are round.

## 14. The hand

- **H1. The hand states decisions and doubts,** never a measurement or a headline. Any digit inside a hand note is set in print. Pages that put measurements in `HandText` move them to print (`pages/dem-source.tsx`, `pages/accept-rule.tsx`, per the WP plan's gap G10).
- **H2. At most three hand notes per entry,** each of 12 words or fewer, plus circled step numbers and leaders.
- **H3. Two hands at most:** pen for observation and pencil for derivation (Cajal). One *face*; the pencil is a colour and a line, not a second font.
- **H4. Upright, low-contrast, technical.** A Swiss topographer letters like an engineer (ISO 3098 / DIN 16 tradition): upright capitals, even spacing, no bounce. Rotation is at most 2°.
- **H5. The face is chosen by specimen.** **Revises** both earlier choices (Architects Daughter in the code, Caveat plus Shantell in the WP plan). Bake one test card per candidate: a leader note, a circled number, a margin note and a struck guess, on paper, at 16 and 18 px, run through the contrast check. Candidates:
  - Architects Daughter (current);
  - Caveat;
  - one technical-lettering face, osifont if its licence clears.

  Pick the one that reads as *surveyor*, not *sketchbook*. This is decision D2.
- **H6. Notes live in the margin column on wide screens and inline on narrow ones** (Tufte, Gwern). On wide screens they use CSS anchor positioning (Baseline January 2026): `anchor-name` on the mark and `position-anchor` plus `top: anchor(top)` on the note, with a unique name per note. Collision handling is a small layout pass; anchor positioning does not stack notes.

## 15. Furniture

The furniture vocabulary of the WP plan (§2.8) is kept: register line, testimony line, Struck, SpotHeight, TrigPoint, grade tokens, RouteTopo, Waymark, Signpost, sheet-margin cross-references, stand imprint, cartouche, legend, scale bar and station stamp. This research adds rules about **truth**:

- **F1. Furniture must be true.**
  - The **scale bar** shows the actual scale of the figure it sits under, or it is removed. Today it always reads 1 : 25 000 / 2 km.
  - The **legend** on a page lists only the symbols that appear on that page. Today the same six appear on every page.
- **F2. The Siegfried imprint.** Each figure's provenance line credits the roles: *Aufnahme* (source photo or DEM, with its id and date), *Revision* (the pipeline stage that measured it) and *Stich* (the renderer). This is a cheap Swiss and Tufte device: provenance as furniture.
- **F3. The Grinnell pair.** Where a page shows a measurement, the raw field note (the guess, the residual) sits in the margin next to the fair-copy statement in the text.
- **F4. Station table.** Pose numbers (yaw, pitch, FOV, residual) are set as a theodolite book: ruled columns, tabular figures, fine vertical transit rules only behind the numbers.
- **F5. Index as a sheet index (*Blattübersicht*), a proposal.** A series of national maps is indexed by a sheet-division map, not a network. The 19 sheets could be laid out as a sheet index keyed to the three groups, with the notebook entries beside it. This would keep the "no node-link graphs" rule and stay cartographic. Decision D4.
- **F6. The kitsch test** of the WP plan §2.10 stays. Banned: coffee rings, torn edges, curl shadows, leather or kraft, rotation above 4°, sticky notes, pins, drop shadows on prints, and tape on figures with no photo. **Added:** no ornament that imitates a *physical defect* rather than a *practice*. A stamp records an act. A stain records nothing.

## 16. Motion, print, accessibility

- **A1. The static state is the design.** Reveals start visible when `IntersectionObserver` is missing, in print, under reduced motion and under webdriver. Today several reveals start at `opacity-0`.
- **A2. Draw-on** is client-only, outside automation, and never on photos or rasters. Staged figures hold at least 1.5 s per stage.
- **A3. Sheet-to-sheet transitions.** `@view-transition { navigation: auto }` with a persistent `view-transition-name` on the sheet frame, so moving between concept pages turns a sheet while the frame stays. Chrome 126 and Safari 18.2 support this; Firefox status conflicts between sources. Wrap it in `prefers-reduced-motion: no-preference`.
- **A4. Scroll-driven reveals** are enhancement only (`@supports (animation-timeline: view())`). Firefox stable still has them behind a flag.
- **A5. The printed Gipfelbuch.** `@page { size: A4; margin: … }` with Tschichold margins, page counters in margin boxes (Chrome 131+), named pages for map plates, `break-inside: avoid` on figures, grain off, and physical stroke widths. A PDF of the 19 sheets is a natural "design book" edition. Today there are no print styles at all.
- **A6. `prefers-contrast: more`** turns off grain, multiply overlays and wobble, and raises line weights. **`forced-colors: active`**: figures use `currentColor`, and essential strokes are restored to `CanvasText`.
- **A7. Contrast gate.** 4.5:1 for all text and 3:1 for every mark that carries meaning, checked in CI against the paper tokens (I1 table). The grid and margin rules are exempt only because they carry nothing.
- **A8. Decorative SVG** is `aria-hidden`. Figures have `role="img"` with a title and description, and numbers stay as HTML text.

---

# Part III: The work

## 17. The current state against the programme

Summary of the audit (read-only; file references under `src/components/gipfelbuch/` unless they start with another root). The WP plan's gap table G1–G13 stays valid. The items below are the largest gaps or are new.

| # | Gap | Where | Rule |
| --- | --- | --- | --- |
| 1 | 33 arbitrary type sizes, half-pixel steps, four different body sizes (15–17 px), three H2 styles | components and pages | T1 |
| 2 | 14-step ink alpha ladder; about 180 text uses below 4.5:1; `.gb-coord` in BL at 2.8:1 | `swiss/theme.css:94`, pages | I1, A7 |
| 3 | Six families downloaded at runtime from the Google CDN (Manrope fetched but unused); math set in the browser's default serif; `fontFamily="monospace"` in one page | `src/routes/__root.tsx:17-18`, `viz/math.tsx`, `pages/baseline-pipeline.tsx` | §9 |
| 4 | Fraunces set inline in three places instead of through `.display-title` | `swiss/Cartouche.tsx:35`, `src/routes/gipfelbuch.index.tsx:155,185` | T1 |
| 5 | Three paper grounds (plain, grain, grid), `--gb-paper` vs `--nb-paper`, `.gb-caps` duplicating `.nb-label` | `notebook/notebook.css`, `swiss/theme.css` | §7.1, G2 |
| 6 | 20 px graph cell not on the 24 px line | `notebook/notebook.css:35-44` | G2 |
| 7 | No base unit; vertical rhythm ad hoc (`mt-14`, `my-9`, `my-7`) | `ConceptPage.tsx`, `viz/*` | G1 |
| 8 | 20+ stroke widths against 5 tiers; two-pass pen thins meaningful lines toward 1 px | `notebook/Ink.tsx` | L2 |
| 9 | Untapered furniture strokes | `notebook/Ink.tsx:66-89` | L4 |
| 10 | Scale bar always 1 : 25 000; identical legend on every page | `swiss/ScaleBar.tsx`, `ConceptPage.tsx` footer | F1 |
| 11 | No print styles; reveals start at `opacity-0`; no `forced-colors` handling | `src/styles.css`, `viz/Figure.tsx` | A1, A5, A6 |
| 12 | `SheetMap` lettering shrinks to 5 px on phones; `Plot` fixed margins; fixed 188 px `ScaleBar` | `swiss/SheetMap.tsx:146`, `viz/Plot.tsx:76` | N8 |
| 13 | Dark `SiteNav` over the paper page | `ConceptPage.tsx` | I8, D3 |
| 14 | 388 lines depend on the `text-white` to ink remap | across | I1 (migrate to named ink utilities) |
| 15 | Dead network-graph code (`CoreMap.tsx`, `GraphView.tsx`, `GraphCanvas.tsx`, `force.ts`) with no importers found | `src/components/gipfelbuch/` | Principle 6. Delete after a double-check with `rg`. |
| 16 | Live `feTurbulence` grain and `feDisplacementMap` pencil on large regions | `swiss/theme.css:48`, `swiss/PencilFilter.tsx` | I8, §18 |
| 17 | Relief is a plain swisstopo raster: no Imhof colour, no Tanaka contours, no rock or scree | `swiss/SheetMap.tsx`, `scripts/gipfelbuch/data-sheet.ts` | §12 |

## 18. Rendering technique menu

Cost classes:

- **S**: trivial, CPU or one-off.
- **M**: one bake or one cheap pass.
- **L**: a per-frame GPU pass or a large bake.

Media: SVG, Canvas2D (Cv), WGSL. Licences marked [U] must be checked before code is copied.

| Effect | Technique | Medium | Cost | Library, licence | Reference |
| --- | --- | --- | --- | --- | --- |
| Furniture wobble | Seeded double stroke, low-frequency perpendicular jitter, centripetal Catmull–Rom | SVG | S | own `sketch.ts` (rough.js MIT as reference) | rough.js; Wood 2012 |
| Pen weight and taper | Outline polygon from deterministic pseudo-pressure; one filled path per stroke | SVG / Cv | S | perfect-freehand, MIT | perfect-freehand README [V] |
| Pencil | Thin GR stroke multiplied by a page-space grain tile | SVG + CSS | S | own baked tile | Sousa & Buchanan 1999 |
| Paper grain | One seamless baked tile (512–1024 px), used as CSS background, mask and GPU texture | CSS / WGSL | S | own bake | Quilez noise articles |
| Ink bleed | Blur, threshold and multiply by grain, on small static groups only | SVG filter | M | none | [U] |
| Blob fill (lake, forest) | Hachure or cross-hatch | SVG | S | `sketch.ts` | rough.js |
| Tonal hatching | Tonal art map array, nested strokes | WGSL / pre-clipped SVG | M | own | Praun et al. 2001 |
| Stipple, static | Weighted Voronoi with Lloyd relaxation, baked | Cv / SVG | M (bake) | d3-delaunay, ISC [U] | Secord 2002 |
| Stipple, live | Blue-noise threshold texture: `step(blueNoise(uv), tone)` | WGSL | S | own void-and-cluster bake | Ulichney 1993; Bridson 2007 |
| Engraved shading | Form-following parallel lines, width by tone | SVG | M | perfect-freehand | Ostromoukhov 1999 |
| Watercolour wash | Recursive polygon deformation, 30–100 layers at about 4%, baked | Cv | M | own | Hobbs 2017 [V] |
| Swiss relief (premium) | Generalise, multi-azimuth, aerial perspective, sun tone, baked offline | raster | M | own; Eduard as benchmark (paid) | Jenny 2020; Jenny & Hurni 2006 |
| Sky illumination and AO | Horizon-based: N azimuths, `1 − mean(sin h)` | WGSL compute | M | own `ComputeGraph` kernel | Kennelly & Stewart 2006 |
| Illuminated contours | Marching squares; width and tone from the cosine of aspect against light | SVG | S–M | d3-contour [U] | Tanaka 1950 |
| Slope hachures | Evenly spaced gradient streamlines, width by slope | SVG / Cv | M | perfect-freehand | Kennelly & Kimerling; Jobard & Lefer 1997 [U] |
| Rock hachures | Triangle facets, LK ratios, no crossing | Cv / SVG bake | L | none open | Jenny 2014; Geisthövel & Hurni 2018 |
| Scree | Irregular polygons, size and density from light, growing downslope | Cv / SVG bake | M | none open | Jenny 2010 |
| Line generalisation | Visvalingam–Whyatt before jitter | any | S | own or mapshaper [U] | Visvalingam & Whyatt 1993 |
| Ink overprint | `mix-blend-mode: multiply` inside `isolation: isolate` | CSS / SVG | S | none | MDN |
| Duotone print | `feColorMatrix` with `color-interpolation-filters="sRGB"` | SVG | S | none | MDN. Not on measured photos (R11). |
| Torn or deckled edge | Not used (kitsch test F6) | | | | |
| Panorama styling (Step Inside, landing) | Haze, bent projection, warm foreground and cool background | WGSL / deck | M–L | own | Patterson 2000; Brown et al. 2017 |
| Painterly 3-D view (optional, later) | Structure tensor, anisotropic Kuwahara, edge pass, paper multiply | WGSL | L | none in WGSL found | Kyprianidis et al. 2013; Bousseau 2006 |
| Determinism | Per-element sfc32 seeded from an integer hash of the stable id; no `Math.sin` hashes; no `Math.random` in render | any | S | public domain | bryc PRNG notes |

**Rendering rules that follow from the menu:**

- **Bake, don't filter.** Never animate `baseFrequency`. Never apply a filter to text or photos. Keep at most three filtered regions on screen, and test iOS Safari. Its filter tiling bugs (WebKit 266295) are exactly the failure mode for a full-sheet pencil filter.
- **Paths for linework, Canvas or GPU for marks.** SVG handles a few hundred merged paths well; tens of thousands of stipples and hachures belong in a baked raster or an instanced layer.
- **Bakes are scripts.** Relief, rock, scree and grain bakes live in `scripts/gipfelbuch/`, are seeded and versioned, and are checked as golden images. Live `feTurbulence` output differs between engines [U].
- **Under the GPU-first rule,** the relief, AO and stipple bakes are `ComputeGraph` work where they run in the browser. Any live NPR pass on the 3-D view must also ship GLSL for the WebGL2 engine, or be gated to WebGPU only (AGENTS.md).

## 19. Platform support (October 2026)

Status from MDN and web.dev digests. Rows marked [conflict] or [U] were not settled; check caniuse before relying on them.

| Feature | Chrome | Safari | Firefox | Use |
| --- | --- | --- | --- | --- |
| `text-box-trim` / `text-box-edge` | 133 | 18.2 | 154 | G3, with padding fallback |
| `lh`, `rlh` | 109 / 111 | 16.4 | 120 | G1 |
| `text-wrap: balance` / `pretty` | 114 / 117 | yes / yes [U stable version] | yes | T3 |
| `hanging-punctuation` | no | yes | no | T11, enhancement |
| `hyphenate-limit-chars` | 109 | no | 137 [U] | T4 |
| `initial-letter` | 110 | yes | no | not planned |
| Subgrid | 117 | 16 | 71 | G6 |
| Container size queries, `cqi` | 105 | 16 | 110 | N8 |
| Anchor positioning | 125 | 26 | 147 [conflict on versions] | H6 |
| `animation-timeline: view()` | 115 | 26 | flag | A4, enhancement |
| Cross-document view transitions | 126 | 18.2 | 144/147 [conflict] | A3, enhancement |
| `@page` margin boxes | 131 | [U] | [U] | A5 (Paged.js as fallback) |
| `light-dark()`, `color-mix()`, relative colour, OKLCH | yes | yes | yes | I7 |
| `color-gamut: p3` | yes | yes | yes | I7 |
| `mix-blend-mode`, `paint-order` | yes | yes | yes | I6, N6 |
| `mask-image` | yes | yes | yes | not planned (F6) |
| CSS Painting API (Houdini `paint()`) | yes | no | no | do not depend on it |
| `interpolate-size`, `reading-flow` | Chrome only | no | no | skip |

## 20. Phased plan

These phases replace the order of WP1–WP5 in the field-notebook plan but keep its packages. Each phase lands on the fast tier (`node scripts/ci/run.mjs fast`, which includes the `gipfelbuch` and `gipfelbuch-notebook` checks) plus a 390 px and 1280 px screenshot review. Bakes add golden images.

| Phase | Scope | Rules | Size |
| --- | --- | --- | --- |
| **P0. Decisions** | Settle D1–D6 (§21). Hand specimen card. Type specimen sheet of Fira and Source Serif 4 at the scale. | §21 | S |
| **P1. Programme tokens** | Grid tokens (`--gb-unit`, `--gb-line`, `rlh`), 24 px graph paper, the type scale as utilities (`gb-text-body`, `gb-text-caption`…), named ink utilities replacing `text-white/NN`, a single paper, a single caps class, self-hosted subset WOFF2 with metric fallbacks, Source Serif 4 for H1 and cartouche, contrast check in CI | G1–G3, T1–T11, I1, I7–I9, A7 | M |
| **P2. Page shell** | Named-line grid with subgrid figures, margin column, anchor-positioned notes, Siegfried imprint and Grinnell pair, true scale bar and per-page legend, print stylesheet, reveal and forced-colours fixes, view transitions | G4–G9, H6, F1–F4, A1–A6 | M |
| **P3. Pen** | perfect-freehand tapered furniture, pencil versus pen, baked paper and grain tiles replacing live filters, hand face swap, hand-note audit (no digits) | L2–L7, H1–H5 | M |
| **P4. Terrain** | Relief bake v2 (NW light bent locally, aerial perspective, sun tone, sky AO via `ComputeGraph`), Tanaka contours on `SheetMap` and `DemPatch`, surface-coloured contours, Imhof label placement, `cqi` label floors | R1–R6, N1–N9, I3–I4 | M–L |
| **P5. Signature** | Rock hachures and scree for the Niederhorn sheet and the Alpine DEM patches, panorama strip with compass ring, *Blattübersicht* index if D4 is yes | R7–R10, F5 | L |
| **P6. Edition** | The printed Gipfelbuch (A4 PDF, 19 sheets plus index), a design-book colophon page (faces, inks, sources, credits) | A5 | S–M |

Pages are owned by several sessions (see `src/components/gipfelbuch/README.md` and the ownership memory). P1 and P2 touch shared kit files, so they should land in one coordinated pass, not in parallel with page edits.

## 21. Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Title face: keep Fraunces, or move to Source Serif 4 (or Newsreader)? | **Source Serif 4**. It is a roman in the LK and Siegfried lineage; Fraunces' softness is the least Swiss voice on the page. |
| D2 | Hand face: Architects Daughter, Caveat (plus Shantell), or a technical-lettering face? | Choose by the specimen card in P0. The research leans toward an upright technical hand. |
| D3 | Dark site theme: should the paper sheet stay light, with only the surround dark? | **Yes.** A paper sheet is an object; keep the nav and surround dark, or make the nav paper too on Gipfelbuch routes. |
| D4 | Index as a sheet index (*Blattübersicht*) beside the notebook entries? | **Prototype it**. It is cartographic, not a network graph. |
| D5 | Surface-coloured contours and rock hachures need a rock and glacier mask. Use swissTLM3D land cover (licence check), or derive the mask from slope plus elevation? | Slope plus elevation first (no new data); swissTLM3D if it looks wrong. |
| D6 | Run a small A/B test of whether furniture wobble lowers trust in the exact data? | **Yes**, cheaply. Five readers and one precision question per figure, with and without wobble. |

## 22. The canon: 60 rules on one page

**Grid.**
1. One unit: 6 px, 24 px line, `rlh` everywhere.
2. The graph cell is one line; every fifth line is heavier.
3. Trim the leading on every block.
4. Modular fields: module height = 4 lines plus a 1-line gutter; figure heights are whole modules.
5. Asymmetric page: kicker columns, a 62–66 ch text block, a margin column; inner to outer 2:4.
6. Named grid lines and subgrid, not breakpoints.
7. Intentional figure proportions only.
8. One sanctioned exception per page.
9. Space separates; strokes mark state only.

**Type.**
10. Seven sizes, two weights per family.
11. Fira Sans and Condensed for the map and the text; a roman for titles; one mono; one hand.
12. Self-hosted, subset, metric-matched fonts.
13. Flush left, `pretty` prose, `balance` headings.
14. Hyphenate only with `lang` and limits.
15. Tabular lining figures in all data.
16. Thin no-break spaces in numbers and before units.
17. Tracked caps under one line only.
18. Italic is a category, never ornament.
19. Hierarchy from size and space.

**Ink.**
20. Brezine inks in LK roles.
21. Three text inks; no alpha ladder.
22. One role per ink, shared by figure, caption, equation and code.
23. Contours take the colour of the surface.
24. Higher is brighter; lit warm, shade cool.
25. Saturation only in small areas.
26. Separations overprint with multiply.
27. OKLCH tokens; P3 spot variants.
28. Paper stays light; grain is a baked tile.
29. No off-chart colours on paper.

**Line.**
30. Hachure ratios from the LK: shade to lit width about 1 : 2.5–4, density about 9 : 4–5.
31. Meaningful lines are at least 1.2 wide; at most four widths per figure.
32. Certainty is line style, never wobble.
33. Furniture tapers; data does not.
34. Pencil is construction, in page-space grain.
35. Simplify before jitter.

**Terrain.**
36. North-west light, bent locally.
37. Generalise before shading.
38. Aerial perspective by elevation.
39. Sun tone on lit slopes only.
40. Sky illumination for valleys.
41. Tanaka contours.
42. Rock hachures, baked.
43. Scree dots, baked.
44. No cast shadows in plan relief.
45. Photos and DEM rasters stay raw.

**Names.**
46. Areas, then lines, then points.
47. Points up and to the right.
48. Lines along the curve; areas spaced and arced.
49. Water italic and blue.
50. The line breaks, not the name.
51. Label size floors through container queries.

**Hand.**
52. The hand states decisions and doubts, never numbers.
53. At most three notes of 12 words per entry.
54. Upright technical lettering, rotation at most 2°.
55. Notes in the margin wide, inline narrow.

**Furniture and access.**
56. Every element carries a fact: true scale bars, per-page legends, the Siegfried imprint.
57. The kitsch test: practices yes, defects no.
58. The static state is the design; motion is enhancement.
59. A printed edition exists.
60. 4.5:1 for text and 3:1 for meaningful marks, gated in CI.

---

## 23. Sources

### Swiss cartography

- Jenny, B. & Hurni, L. (2006). Swiss-style colour relief shading modulated by elevation and by exposure to illumination. *The Cartographic Journal* 43(3). https://mail.colororacle.org/berniejenny/pdf/2006_JennyHurni_SwissStyleShading.pdf
- Jenny, Gilgen, Geisthövel, Marston & Hurni (2014). Design principles for Swiss-style rock drawing. *The Cartographic Journal* 51(4). https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf
- Jenny, Hutzler & Hurni (2010). Scree representation on topographic maps. https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf
- Jenny et al. (2020/2021). Cartographic relief shading with neural networks. IEEE TVCG 27(2). https://arxiv.org/abs/2010.01256
- Patterson, T. (2000). A view from on high: Heinrich Berann's panoramas. *Cartographic Perspectives* 36. https://cartographicperspectives.org/index.php/journal/article/download/cp36-patterson/pdf
- Youngblood (2010). Review of Imhof, *Cartographic Relief Presentation*. *Cartographic Perspectives* 65. https://cartographicperspectives.org/index.php/journal/article/download/cp65-youngblood/pdf/976
- Freeman & Ahn. A program for automatic name placement (Auto-Carto 6). https://cartogis.org/docs/proceedings/archive/auto-carto-6/pdf/a-program-for-automatic-name-placement.pdf
- Doerschler. An expert system for dense-map name placement (Auto-Carto 9). https://cartogis.org/docs/proceedings/archive/auto-carto-9/pdf/an-expert-system-for-dense-map-name-placement.pdf
- Imhof, E. (1975). Positioning names on maps. *The American Cartographer* 2(2) (not read directly). https://www.researchgate.net/publication/239538755_Positioning_Names_on_Maps
- swisstopo, *Zeichenerklärung* (2008). https://www.swisstopo.admin.ch/dam/de/sd-web/WxsMJ4yE7xeV/Zeichenerklaerung_2008_d.pdf
- swisstopo, Modernisation of the national maps. https://www.swisstopo.admin.ch/en/modernisation-of-the-national-maps-2001-2021
- swisstopo, Depicting Switzerland's terrain. https://www.swisstopo.admin.ch/en/depicting-switzerlands-terrain
- Streit (2017), *Geomatik Schweiz* 5/2017. https://www.swisstopo.admin.ch/dam/de/sd-web/guRiv1Q0Dr2y/Artikel-GS5-2017-SMV-DE.pdf
- swisstopo basemap vector style. https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json
- Biniek et al. (2018). Designing typefaces for maps. *Proc. ICA* 1. https://ica-proc.copernicus.org/articles/1/9/2018/ica-proc-1-9-2018.pdf
- ICA tribute to Imhof. https://icaci.org/?p=2926
- Geisthövel & Hurni, Automatic rock depiction via relief shading (ICC 2015). https://icaci.org/files/documents/ICC_proceedings/ICC2015/papers/26/444.html
- Geisthövel & Hurni (2018). Automated Swiss-style relief shading and rock hachuring. *The Cartographic Journal* 55(4), doi:10.1080/00087041.2018.1551955
- Kennelly & Stewart (2006). A uniform sky illumination model. *CaGIS* 33(1). https://pure.psu.edu/en/publications/a-uniform-sky-illumination-model-to-enhance-shading-of-terrain-an/
- Ambient occlusion for terrain shading. *Cartographic Perspectives* 103. https://cartographicperspectives.org/index.php/journal/article/view/1901
- PSU GEOG 486, hachures and Tanaka contours. https://courses.ems.psu.edu/geog486/book/export/html/867
- Graser, Tanaka contours in QGIS. https://anitagraser.com/2015/05/24/how-to-create-illuminated-contours-tanaka-style/
- Patterson, Texture shading. https://www.shadedrelief.com/texture_shading/
- Eduard. https://eduard.earth/
- Brown et al. (2017). Real-time panorama maps. https://diglib.eg.org:443/handle/10.2312/npar2017a06
- Jenny & Jenny (2012). Terrain texture synthesis for panoramic maps. https://cartogis.org/docs/proceedings/2012/Jenny_Jenny_AutoCarto2012.pdf
- Kartensammlung, Imhof. https://www.kartensammlung.ch/Imhof/imhof16engl.html
- HLS, Xaver Imfeld. https://hls-dhs-dss.ch/de/articles/031187/
- Dufour map summary. https://kartengeschichte.ch/ch/summaries/e04a.html
- Wikipedia: Terrain cartography; Labeling (map design); Typography (cartography); Eduard Imhof.

### Swiss typography and book design

- Müller-Brockmann, *Grid Systems*. https://thamesandhudson.com.au/?p=93182
- Ruder, "Basel 1965". https://neugraphic.com/ruder/ruder-text2.html
- Gerstner, *Designing Programmes*. https://www.lars-mueller-publishers.com/designing-programmes and https://runemadsen.com/blog/karl-gerstner-designing-programmes/
- Canons of page construction. https://en.wikipedia.org/wiki/Canons_of_page_construction
- Penguin Composition Rules. https://en.wikipedia.org/wiki/Penguin_Composition_Rules
- Hochuli. https://www.typotheque.com/books/detail-in-typography and https://eyemagazine.com/review/article/on-a-clear-day-you-can-read-between-the-lines
- The Most Beautiful Swiss Books 2025. https://www.bak.admin.ch/en/the-most-beautiful-swiss-books-of-2025-have-been-announced
- NORM. https://editionpatrickfrey.com/en/norm
- Elektrosmog. https://www.editionpatrickfrey.com/en/elektrosmog
- Frutiger. https://en.wikipedia.org/wiki/Frutiger_(typeface)
- Foundries: https://www.swisstypefaces.com/fonts/suisse/ · https://www.grillitype.com/typeface/gt-alpina · https://abcdinamo.com/typefaces/diatype · https://www.lineto.com/typefaces/unica77 · https://www.optimo.ch/typefaces
- Open faces: https://github.com/Instrument/instrument-sans · https://fonts.google.com/specimen/Hanken+Grotesk · https://rsms.me/inter/ · https://github.com/vercel/geist-font · https://github.com/playbeing/dinish/ · https://github.com/adobe-fonts/source-serif · https://github.com/productiontype/Newsreader · https://github.com/undercasetype/Fraunces · https://github.com/evilmartians/mono · https://fontsource.org/fonts/architects-daughter/about · https://fedoraproject.org/wiki/OSI_fonts · https://shantellsans.com
- Butterick, *Practical Typography*. https://practicaltypography.com/summary-of-key-rules.html

### Notebook and editorial web

- Grinnell method. https://mvz.berkeley.edu/the-grinnell-method
- Darwin, "I think". https://darwinproject.ac.uk/darwin-s-species-notebooks-i-think
- Humboldt diaries. https://www.preussischer-kulturbesitz.de/en/news-detail/article/2014/12/01/alexander-von-humboldt-s-american-travel-diaries.html
- Cajal. https://greyartgallery.nyu.edu/exhibition/beautiful-brainthe-drawings-santiago-ramon-y-cajal/
- Wainwright. https://en.wikipedia.org/wiki/Pictorial_Guide_to_the_Lakeland_Fells · https://mapdesign.icaci.org/tag/guidebook/ · https://amystewart.substack.com/p/imagine-writing-forty-books-by-hand · https://www.lrb.co.uk/v18/n03/david-craig/true-grit
- Gipfelbuch. https://www.indenbergen.de/weblog/gipfelbuch/ · https://www.bergwelten.com/a/was-schreibe-ich-ins-gipfelbuch
- Siegfried map. https://oldmapsonline.org/maps/b27f3ff6-ffac-4cf9-8152-121e570a7a9c
- Tufte. https://edwardtufte.github.io/tufte-css/
- Ciechanowski. https://ciechanow.ski/
- Red Blob Games. https://www.redblobgames.com/making-of/little-things/
- Gwern. https://gwern.net/design and https://gwern.net/sidenote
- Distill. https://distill.pub/2017/research-debt/
- Bret Victor. https://worrydream.com/ExplorableExplanations/
- Maggie Appleton. https://maggieappleton.com/
- The Pudding. https://www.storybench.org/?p=8613
- Swiss Viz Award 2023. https://visualcommunication.zhdk.ch/news/swiss-viz-award-2023
- swisstopo, *Journey through time*. https://www.swisstopo.admin.ch/en/a-journey-through-time-maps
- Comeau, shadows. https://www.joshwcomeau.com/css/designing-shadows/
- Wood et al. (2012), Sketchy rendering. https://openaccess.city.ac.uk/id/eprint/1274/
- Boukhelifa et al. (2012). https://www.aviz.fr/Research/UncertaintySketchy
- Excalifont. https://plus.excalidraw.com/excalifont
- rough-notation. https://roughnotation.com
- d3-annotation. https://d3-annotation.susielu.com
- Dyslexia fonts. https://link.springer.com/article/10.1007/s11881-016-0127-1
- WCAG contrast. https://webaim.org/articles/contrast/

### Rendering

- rough.js. https://github.com/rough-stuff/rough and https://github.com/rough-stuff/rough/wiki
- perfect-freehand. https://github.com/steveruizok/perfect-freehand
- Winkenbach & Salesin (1994). https://grail.cs.washington.edu/projects/cg-illus
- Hertzmann (2003), stroke-based rendering. https://www.dgp.toronto.edu/~hertzman/sbr02/hertzmann-cga03.pdf
- Sousa & Buchanan (1999). https://diglib.eg.org/handle/10.2312/8565
- Praun et al. (2001), real-time hatching. https://gfx.cs.princeton.edu/proj/hatching
- Secord (2002), weighted Voronoi stippling. https://www.cs.ubc.ca/labs/imager/tr/2002/secord2002b/secord.2002b.pdf
- Bridson (2007), Poisson-disk sampling. https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf
- Void-and-cluster blue noise. https://blog.demofox.org/2019/06/25/generating-blue-noise-textures-with-void-and-cluster/
- Ostromoukhov (1999), digital facial engraving. https://lspwww.epfl.ch/publications/microstructureimaging/dfe.html
- Curtis et al. (1997), watercolour. https://grail.cs.washington.edu/projects/watercolor/
- Bousseau et al. (2006). https://artis.inrialpes.fr/Publications/2006/BKTS06
- Montesdeoca, MNPR. https://diglib.eg.org/items/908efe9f-fb6a-4d3e-98b6-bda5d952c71e/full
- Hobbs (2017), watercolour. https://www.tylerxhobbs.com/words/a-guide-to-simulating-watercolor-paint-with-generative-art
- Kyprianidis et al. (2013). https://tobias.isenberg.cc/p/Kyprianidis2013SAT
- Quilez, domain warping. https://iquilezles.org/articles/warp
- Visvalingam–Whyatt. https://en.wikipedia.org/wiki/Visvalingam%E2%80%93Whyatt_algorithm
- WebKit filter tiling bug. https://bugs.webkit.org/show_bug.cgi?id=266295
- MDN feDisplacementMap. https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap
- bryc, PRNGs. https://github.com/bryc/code/blob/master/jshash/PRNGs.md

### Web platform

- MDN `text-box-trim`. https://developer.mozilla.org/en-US/docs/Web/CSS/text-box-trim
- web.dev platform digests. https://web.dev/blog/web-platform-08-2026 · https://web.dev/blog/web-platform-01-2026
- WebKit line-height units. https://webkit.org/blog/16831/line-height-units/
- Bernat, CSS vertical rhythm. https://vincent.bernat.ch/en/blog/2026-css-vertical-rhythm
- WebKit `text-wrap: pretty`. https://webkit.org/blog/16547/better-typography-with-text-wrap-pretty/
- MDN `hanging-punctuation`. https://developer.mozilla.org/en-US/docs/Web/CSS/hanging-punctuation
- MDN `hyphenate-limit-chars`. https://developer.mozilla.org/en-US/docs/Web/CSS/hyphenate-limit-chars
- Chrome, font fallbacks. https://developer.chrome.com/blog/font-fallbacks
- web.dev font best practices. https://web.dev/articles/font-best-practices
- Utopia. https://utopia.fyi/type/
- Smashing, editorial design with grid and subgrid. https://www.smashingmagazine.com/2019/10/editorial-design-patterns-css-grid-subgrid-naming/
- Comeau, full bleed. https://joshwcomeau.com/css/full-bleed/
- Viget, fluid breakout layout. https://www.viget.com/articles/fluid-breakout-layout-css-grid/
- Every Layout, Sidebar. https://every-layout.dev/layouts/sidebar/
- MDN `anchor-name`. https://developer.mozilla.org/en-US/docs/Web/CSS/anchor-name
- Chrome, cross-document view transitions. https://developer.chrome.com/docs/web-platform/view-transitions/cross-document
- Chrome, print margins. https://developer.chrome.com/blog/print-margins
- MDN `@page`. https://developer.mozilla.org/en-US/docs/Web/CSS/@page
- MDN `mix-blend-mode`. https://developer.mozilla.org/en-US/docs/Web/CSS/mix-blend-mode
- MDN `forced-colors`. https://developer.mozilla.org/docs/Web/CSS/@media/forced-colors
- Stamen, dark map materials. https://stamen.com/stamens-dark-map-materials/
- W3C, WCAG 3 news. https://www.w3.org/WAI/news/2026-03-03/wcag3
- MDN `paint-order`. https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/paint-order
- MDN `textPath`. https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/textPath
- MDN `feColorMatrix`. https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feColorMatrix
- MDN CSS Painting API. https://developer.mozilla.org/en-US/docs/Web/API/CSS_Painting_API

**Not reached or blocked:** Imhof's books (paywalled), shadedrelief.com/Imhof and Banff (403), and the Paged.js docs (404). Not researched: the NYT, Reuters, FT, Bloomberg and SRF graphics desks, Observable, Studio Feixen and Hubertus Design.
